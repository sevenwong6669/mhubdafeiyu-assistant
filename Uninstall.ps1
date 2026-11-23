param(
    [switch]$RemoveVenv,
    [string]$DshRoot = (Join-Path $env:USERPROFILE '.dsh')
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$panel = Join-Path $root 'mhub-community-assistant'

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }

$DshRoot = [IO.Path]::GetFullPath($DshRoot)
$profile = Join-Path $DshRoot 'profiles/desktop'
$profileJson = Join-Path $profile 'package.json'
$profilePatch = Join-Path $profile 'cordis.patch.yml'
$harnessName = 'dsh-mhub-community-v11'
$module = Join-Path $profile "node_modules/$harnessName"
$auraModule = Join-Path $DshRoot 'plugins-data/aurabot/modules/mhub-companion'
$expectedPanel = $panel.Replace('\','/')
$expectedState = (Join-Path $panel 'state').Replace('\','/')
$scriptDir = Join-Path $panel 'scripts'
$utf8 = [Text.UTF8Encoding]::new($false)

function Test-ProcessScript($Process, [string]$ScriptName) {
    $expected = Join-Path $scriptDir $ScriptName
    $arguments = [regex]::Matches([string]$Process.CommandLine, '"[^"]*"|\S+')
    if ($ScriptName -eq 'start-panel.mjs') {
        return ($Process.Name -eq 'node.exe' -and $arguments.Count -ge 2 -and $arguments[1].Value.Trim('"') -eq $expected)
    }
    if ($Process.Name -notin @('powershell.exe', 'pwsh.exe')) { return $false }
    for ($i = 1; $i -lt $arguments.Count - 1; $i++) {
        if ($arguments[$i].Value -eq '-File') { return ($arguments[$i + 1].Value.Trim('"') -eq $expected) }
    }
    return $false
}

function Stop-OwnedProcess([int]$TargetProcessId, [string]$ScriptName, [string]$Role) {
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId" -ErrorAction Stop
        if (!$proc) { return $true }
        if (!$proc.CommandLine) {
            Write-Warning "Could not read the command line for $Role (pid $TargetProcessId)."
            return $false
        }
        if (!(Test-ProcessScript $proc $ScriptName)) {
            Write-Warning "Ignoring stale $Role pid ${TargetProcessId}: it does not run this install's $ScriptName."
            return $true
        }
        Stop-Process -Id $TargetProcessId -Force -ErrorAction Stop
        $null = Wait-Process -Id $TargetProcessId -Timeout 10 -ErrorAction SilentlyContinue
        if (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
            Write-Warning "${Role}: pid $TargetProcessId did not exit within 10s."
            return $false
        }
        Write-Host "Stopped ${Role}: pid $TargetProcessId."
        return $true
    } catch {
        Write-Warning "Could not stop $Role (pid ${TargetProcessId}): $($_.Exception.Message)"
        return $false
    }
}

function Stop-InstallProcesses([int]$RecordedProcessId, [string]$ScriptName, [string]$Role) {
    $processIds = @(Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { Test-ProcessScript $_ $ScriptName } |
        ForEach-Object { [int]$_.ProcessId })
    if ($RecordedProcessId -gt 0 -and $RecordedProcessId -notin $processIds) { $processIds += $RecordedProcessId }
    foreach ($targetProcessId in $processIds) {
        if (!(Stop-OwnedProcess $targetProcessId $ScriptName $Role)) {
            throw "Could not confirm that $Role stopped. Close it and retry. Registration and user state were preserved."
        }
    }
}

function Test-OwnedModule([string]$Directory, [string]$ScriptName) {
    $item = Get-Item -LiteralPath $Directory -Force
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    $indexFile = Join-Path $Directory 'index.mjs'
    if (!(Test-Path -LiteralPath $indexFile -PathType Leaf)) { return $false }
    $expectedUri = ([uri](Join-Path $panel $ScriptName)).AbsoluteUri
    $pattern = '\A\s*export\s*\{[^{}\r\n]+\}\s*from\s+(["''])' + [regex]::Escape($expectedUri) + '\1[ \t]*;?\s*\z'
    return ([IO.File]::ReadAllText($indexFile) -match $pattern)
}

function Update-HarnessRegistration($Changes) {
    $applied = @()
    try {
        foreach ($change in $Changes) {
            $path = $change.path
            $id = [guid]::NewGuid().ToString('N')
            $backup = "$path.backup-$id"
            $temp = "$path.uninstall-$id.tmp"
            try {
                [IO.File]::WriteAllText($temp, $change.content, $utf8)
                [IO.File]::Replace($temp, $path, $backup)
                $applied += @{path = $path; backup = $backup}
            } finally {
                [IO.File]::Delete($temp)
            }
        }
    } catch {
        $failure = $_
        $rollbackErrors = @()
        for ($i = $applied.Count - 1; $i -ge 0; $i--) {
            try { Copy-Item -LiteralPath $applied[$i].backup -Destination $applied[$i].path -Force }
            catch { $rollbackErrors += "$($applied[$i].path): $($_.Exception.Message)" }
        }
        if ($rollbackErrors.Count) {
            throw "Could not update the Harness registration: $($failure.Exception.Message). Rollback needs review: $($rollbackErrors -join '; ')"
        }
        throw $failure
    }
    foreach ($change in $applied) { "Updated $($change.path); backup: $($change.backup)" }
}

# Confirm the guard has exited before scanning for its panel server.
$guardState = Join-Path $panel 'state/panel-guard.json'
$guardPid = 0; $panelPid = 0
if (Test-Path -LiteralPath $guardState -PathType Leaf) {
    try {
        $guard = Get-Content -LiteralPath $guardState -Raw -Encoding UTF8 | ConvertFrom-Json
        $guardPid = [int]$guard.pid; $panelPid = [int]$guard.serverPid
    } catch {
        Write-Warning "Panel guard record unreadable: $($_.Exception.Message)"
        $guardPid = 0; $panelPid = 0
    }
}
Stop-InstallProcesses $guardPid 'watch-panel.ps1' 'Panel guard'
Stop-InstallProcesses $panelPid 'start-panel.mjs' 'Panel server'

$record = $null
$recordFile = Join-Path $panel 'state/install-record.json'
if (Test-Path -LiteralPath $recordFile -PathType Leaf) {
    try { $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$linkedHere = @{ harness = $true; aurabot = $true }
if ($record -and $record.PSObject.Properties['hosts']) {
    $linkedHere.harness = @($record.hosts) -contains 'harness'
    $linkedHere.aurabot = @($record.hosts) -contains 'aurabot'
}

# A missing artifact does not disqualify a partial install. Conflicting
# ownership in any existing artifact keeps the whole Harness group intact.
if ($linkedHere.harness) {
    $conflicts = @()
    $package = $null; $dependency = $null
    if (Test-Path -LiteralPath $profileJson -PathType Leaf) {
        $package = Get-Content -LiteralPath $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($package.dependencies) { $dependency = $package.dependencies.PSObject.Properties[$harnessName] }
        if ($dependency -and [string]$dependency.Value -ne ('file:' + $expectedPanel)) { $conflicts += 'profile dependency' }
    }

    $patchMatch = $null
    if (Test-Path -LiteralPath $profilePatch -PathType Leaf) {
        $patch = [IO.File]::ReadAllText($profilePatch)
        $marker = '(?m)(?:^[ \t]*(?:-[ \t]+)?|[{,][ \t]*)(?:id:[ \t]*["'']?mhub-community-assistant|name:[ \t]*["'']?dsh-mhub-community-v11)["'']?(?=[ \t\r\n#,}]|\z)'
        $markers = [regex]::Matches($patch, $marker)
        if ($markers.Count) {
            $block = '(?m)^- id: mhub-community-assistant[ \t]*\r?\n  name: dsh-mhub-community-v11[ \t]*\r?\n  config:[ \t]*\r?\n    stateDir:[ \t]*(?<value>[^\r\n]+)(?:\r?\n|\z)(?!(?:[ \t]*\r?\n)*[ \t]+\S)'
            $patchMatch = [regex]::Match($patch, $block)
            $stateValue = $null
            if ($patchMatch.Success) {
                $stateValue = $patchMatch.Groups['value'].Value.Trim()
                if ($stateValue.StartsWith('"')) {
                    try { $stateValue = ConvertFrom-Json -InputObject $stateValue } catch { $stateValue = $null }
                }
            }
            if ($markers.Count -ne 2 -or ([string]$stateValue).Replace('\','/') -ne $expectedState) { $conflicts += 'patch block' }
        }
    }

    $moduleExists = Test-Path -LiteralPath $module
    if ($moduleExists -and !(Test-OwnedModule $module 'native-host.mjs')) { $conflicts += 'module entry' }

    if ($conflicts.Count) {
        Write-Warning "Harness ownership could not be verified ($($conflicts -join ', ')). Leaving all Harness files untouched."
    } elseif ($dependency -or $patchMatch.Success -or $moduleExists) {
        if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Close DeepSeek Harness before unlinking its profile.' }
        $changes = @()
        $bundles = @($package.dsh.profile.bundles)
        if ($dependency -or $bundles -contains $harnessName) {
            if ($dependency) { $package.dependencies.PSObject.Properties.Remove($harnessName) }
            if ($bundles -contains $harnessName) {
                $package.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $harnessName })
            }
            $changes += @{path = $profileJson; content = ($package | ConvertTo-Json -Depth 30)}
        }
        if ($patchMatch.Success) {
            $changes += @{path = $profilePatch; content = $patch.Remove($patchMatch.Index, $patchMatch.Length)}
        }
        Update-HarnessRegistration $changes
        if ($moduleExists) {
            Remove-Item -LiteralPath $module -Recurse -Force
            "Removed module: $module"
        }
    }
}
if ($linkedHere.aurabot -and (Test-Path -LiteralPath $auraModule)) {
    if (Test-OwnedModule $auraModule 'aurabot-adapter.mjs') {
        Remove-Item -LiteralPath $auraModule -Recurse -Force
        "Removed module: $auraModule"
    } else {
        Write-Warning "Module $auraModule is not proven to belong here; leaving it."
    }
}

if ($RemoveVenv) {
    $venv = Join-Path $root '.venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force; "Removed Python environment: $venv" }
}
'Done. User state under mhub-community-assistant/state, runtime.settings.json, device backups and wallpapers were left untouched.'
