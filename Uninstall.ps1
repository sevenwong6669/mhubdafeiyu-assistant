param(
    [switch]$RemoveVenv,
    [switch]$ConfirmDeviceRestored,
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
. (Join-Path $scriptDir 'local-text-transaction.ps1')

$sync = Join-Path $root 'harness-mhub-sync'
$state = Join-Path $panel 'state'
$inspectionScript = Join-Path $scriptDir 'inspect-process.ps1'
$cimUnavailable = $false
$unreadableProcessRecord = $false

function Read-ProcessRecord([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        return (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)))
    } catch {
        $script:unreadableProcessRecord = $true
        Write-Warning "Cannot read process record $Path. $($_.Exception.Message)"
        return $null
    }
}

function Test-ProcessScript($Process, [string]$Expected, $PanelInstance) {
    $arguments = [regex]::Matches([string]$Process.CommandLine, '"[^"]*"|\S+')
    $argument = $null
    if ($Expected.EndsWith('.ps1')) {
        if ($Process.Name -notin @('powershell.exe', 'pwsh.exe')) { return $false }
        for ($i = 1; $i -lt $arguments.Count - 1; $i++) {
            if ($arguments[$i].Value -eq '-File') { $argument = $arguments[$i + 1].Value.Trim('"'); break }
        }
    } elseif ($Process.Name -eq 'node.exe' -and $arguments.Count -ge 2) {
        $argument = $arguments[1].Value.Trim('"')
    }
    if (!$argument) { return $false }
    if ($argument -match '^(?:[a-z]:[\\/]|\\\\)') {
        try { return ([IO.Path]::GetFullPath($argument) -eq $Expected) }
        catch { return $false }
    }

    # npm can start the panel with a relative script argument. The loopback
    # instance ID ties the live process to this install's absolute script path.
    if ($argument.Replace('\','/') -notin @('scripts/start-panel.mjs', './scripts/start-panel.mjs') -or
        !$PanelInstance -or $PanelInstance.pid -ne $Process.ProcessId -or $PanelInstance.script -ne $Expected) { return $false }
    try { $health = Invoke-RestMethod 'http://127.0.0.1:18782/health' -TimeoutSec 2 }
    catch { throw 'Cannot verify the relative-path panel instance. Stop it and retry.' }
    if ($health.service -ne 'dafeiyu-panel' -or $health.pid -ne $Process.ProcessId -or
        !$PanelInstance.instanceId -or $health.instanceId -ne $PanelInstance.instanceId) {
        throw 'Cannot verify the relative-path panel instance. Stop it and retry.'
    }
    return $true
}

function Get-InstallProcessIds([string]$ScriptPath, [int[]]$RecordedIds) {
    $processIds = @()
    if (!$script:cimUnavailable) {
        try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
        catch {
            $script:cimUnavailable = $true
            Write-Warning "Windows process scanning through CIM is unavailable. Only recorded processes can be verified. $($_.Exception.Message)"
        }
        if (!$script:cimUnavailable) {
            $processIds = @($processes | Where-Object { Test-ProcessScript $_ $ScriptPath } |
                ForEach-Object { [int]$_.ProcessId })
        }
    }
    if ($script:cimUnavailable -and $script:unreadableProcessRecord) {
        throw 'A process record is unreadable and Windows process scanning is unavailable. Close the plugin processes and retry with access to the records.'
    }
    return @(@($processIds) + @($RecordedIds) | Where-Object { $_ -gt 0 } | Select-Object -Unique)
}

function Read-InstallProcess([int]$TargetProcessId) {
    if (!$script:cimUnavailable) {
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId" -ErrorAction Stop
            if (!$proc -or $proc.CommandLine) { return $proc }
        } catch {
            Write-Warning "Cannot read pid $TargetProcessId through CIM. Trying the native process query."
        }
    }
    if (!(Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) { return $null }
    try { $raw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $inspectionScript -TargetId $TargetProcessId }
    catch { throw "Cannot verify pid $TargetProcessId. Close the process and retry. $($_.Exception.Message)" }
    if ($LASTEXITCODE -ne 0 -or !$raw) { throw "Cannot verify pid $TargetProcessId. Close the process and retry." }
    $info = ConvertFrom-Json -InputObject ($raw -join [Environment]::NewLine)
    if ($info.pid -ne $TargetProcessId -or !$info.command) { throw "Cannot verify pid $TargetProcessId. Close the process and retry." }
    return [pscustomobject]@{ProcessId = $info.pid; Name = $info.name; CommandLine = $info.command}
}

function Get-OwnedProcessIds([string]$ScriptPath, [int[]]$RecordedIds, $PanelInstance) {
    foreach ($targetProcessId in @(Get-InstallProcessIds $ScriptPath $RecordedIds)) {
        $proc = Read-InstallProcess $targetProcessId
        if ($proc -and (Test-ProcessScript $proc $ScriptPath $PanelInstance)) { $targetProcessId }
    }
}

function Stop-InstallProcesses([string]$ScriptPath, [int[]]$RecordedIds, [string]$Role, $PanelInstance) {
    foreach ($targetProcessId in @(Get-OwnedProcessIds $ScriptPath $RecordedIds $PanelInstance)) {
        try {
            Stop-Process -Id $targetProcessId -Force -ErrorAction Stop
            $null = Wait-Process -Id $targetProcessId -Timeout 10 -ErrorAction SilentlyContinue
            if (Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue) { throw 'The process did not exit within 10 seconds.' }
            Write-Host "Stopped ${Role}: pid $targetProcessId."
        } catch {
            throw "Could not confirm that $Role stopped (pid ${targetProcessId}). $($_.Exception.Message) Close it and retry."
        }
    }
}

function Read-DeviceRecoveryFile([string]$Path) {
    $snapshot = Read-LocalTextSnapshot $Path
    $record = if ($snapshot.existed) { ConvertFrom-Json -InputObject $snapshot.text } else { $null }
    return @{snapshot = $snapshot; record = $record}
}

function Save-DeviceRecoveryState([string]$Path, $Expected, $Requests, $Confirmation) {
    $null = [IO.Directory]::CreateDirectory($state)
    $change = @{
        path = $Path
        expected = $Expected
        content = (@{requests = @($Requests); confirmation = $Confirmation} | ConvertTo-Json -Depth 5)
        backup = "$Path.backup-$([guid]::NewGuid().ToString('N'))"
    }
    try { Write-CheckedText $change }
    catch { Undo-CheckedText $change; throw }
    [IO.File]::Delete($change.backup)
    return $change.written
}

function Test-DeviceReleaseReceipt($Receipt, $Request) {
    return ($Receipt -and $Receipt.issues -is [Array] -and $Receipt.issues.Count -eq 0 -and
        $Receipt.pid -gt 0 -and $Receipt.pid -eq $Request.pid -and
        $Request.at -gt 0 -and $Receipt.at -ge $Request.at)
}

function Stop-DeviceSync {
    if (!(Test-Path -LiteralPath $sync -PathType Container)) { return }
    $pendingPath = Join-Path $sync 'shutdown-pending.json'
    $receiptPath = Join-Path $sync 'device-link-release.json'
    $journalPath = Join-Path $state 'uninstall-device-recovery.json'
    $journal = Read-DeviceRecoveryFile $journalPath
    $requests = @($journal.record.requests | Where-Object { $_ })
    $confirmation = $journal.record.confirmation
    $pendingBefore = Read-DeviceRecoveryFile $pendingPath
    $receiptBefore = Read-DeviceRecoveryFile $receiptPath

    $supervisor = Join-Path $sync 'supervisor.mjs'
    $controller = Join-Path $sync 'optimized.mjs'
    $supervisorStatus = Read-ProcessRecord (Join-Path $sync 'supervisor-status.json')
    $controllerStatus = Read-ProcessRecord (Join-Path $sync 'controller-health.json')
    $supervisorIds = @((Read-ProcessRecord (Join-Path $sync 'supervisor.pid')), $supervisorStatus.pid)
    $controllerIds = @((Read-ProcessRecord (Join-Path $sync 'run.pid')), $supervisorStatus.childPid, $controllerStatus.pid)
    $runningControllers = @(Get-OwnedProcessIds $controller $controllerIds)
    $owned = @(@(Get-OwnedProcessIds $supervisor $supervisorIds) + $runningControllers | Select-Object -Unique)
    $requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($runningControllers.Count) {
        foreach ($controllerId in $runningControllers) {
            if ($controllerId -notin @($requests.pid)) { $requests += @{pid = $controllerId; at = $requestedAt} }
        }
        # Record the restoration expectation before requesting process exit.
        $journal.snapshot = Save-DeviceRecoveryState $journalPath $journal.snapshot $requests $confirmation
    }
    [IO.File]::WriteAllText((Join-Path $sync 'stop.request'), 'stop', $utf8)
    if ($owned.Count) {
        Write-Host 'Waiting for device sync to restore the previous scene and exit.'
        # Match the observation budget in harness-mhub-sync/release-policy.mjs.
        $null = Wait-Process -Id $owned -Timeout 180 -ErrorAction SilentlyContinue
    }
    if (@(Get-OwnedProcessIds $supervisor $supervisorIds).Count -or @(Get-OwnedProcessIds $controller $controllerIds).Count) {
        throw 'Device sync is still releasing control. Wait for the supervisor and controller to exit, then retry.'
    }

    $pending = Read-DeviceRecoveryFile $pendingPath
    $receipt = Read-DeviceRecoveryFile $receiptPath
    $waiting = @($requests | Where-Object { !(Test-DeviceReleaseReceipt $receipt.record $_) })
    $unresolved = ($pending.snapshot.existed -and !(Test-DeviceReleaseReceipt $receipt.record $pending.record)) -or
        ($receipt.snapshot.existed -and (!$receipt.record -or $receipt.record.issues -isnot [Array] -or $receipt.record.issues.Count -gt 0))
    $matchingConfirmation = $confirmation -and $confirmation.pendingDigest -ceq $pending.snapshot.digest -and
        $confirmation.receiptDigest -ceq $receipt.snapshot.digest
    $recordConfirmation = $false
    if ($waiting.Count -or ($unresolved -and !$matchingConfirmation)) {
        if (!$ConfirmDeviceRestored -or $owned.Count -or
            $pending.snapshot.digest -cne $pendingBefore.snapshot.digest -or
            $receipt.snapshot.digest -cne $receiptBefore.snapshot.digest) {
            throw 'Device restoration has not been confirmed. Review shutdown-pending.json and device-link-release.json, then retry. Use -ConfirmDeviceRestored only after verifying the devices with sync stopped.'
        }
        $confirmation = @{
            pendingDigest = $pending.snapshot.digest
            receiptDigest = $receipt.snapshot.digest
            at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        $recordConfirmation = $true
    }
    if ($requests.Count -or $recordConfirmation) {
        $null = Save-DeviceRecoveryState $journalPath $journal.snapshot @() $confirmation
    }
}

function Stop-VoiceService {
    $voiceRoot = Join-Path $sync 'voice-chat'
    $voiceScript = Join-Path $voiceRoot 'server.mjs'
    $recordedId = Read-ProcessRecord (Join-Path $voiceRoot 'server.pid')
    $owned = @(Get-OwnedProcessIds $voiceScript @($recordedId))
    if (!$owned.Count) { return }
    $voiceConfig = Read-ProcessRecord (Join-Path $voiceRoot 'config.json')
    $voicePort = 0
    if ($owned.Count -ne 1 -or ![int]::TryParse([string]$voiceConfig.port, [ref]$voicePort) -or
        $voicePort -lt 1 -or $voicePort -gt 65535) { throw 'Cannot identify the local voice service endpoint. Stop voice manually and retry.' }
    $targetId = $owned[0]
    try {
        $status = Invoke-RestMethod "http://127.0.0.1:$voicePort/status" -TimeoutSec 4 -MaximumRedirection 0
        if ($status.pid -ne $targetId) { throw 'The local voice listener does not match the verified process.' }
        $request = @{
            Method = 'Post'; ContentType = 'application/json'; TimeoutSec = 4; MaximumRedirection = 0
            Body = (@{expectedPid = $targetId} | ConvertTo-Json -Compress)
        }
        $shutdown = Invoke-RestMethod "http://127.0.0.1:$voicePort/shutdown" @request
        if ($shutdown.ok -ne $true) { throw 'The voice service did not acknowledge shutdown.' }
    } catch { throw "Could not shut down voice pid ${targetId}: $($_.Exception.Message) Stop voice manually and retry." }
    $null = Wait-Process -Id $targetId -Timeout 45 -ErrorAction SilentlyContinue
    if (@(Get-OwnedProcessIds $voiceScript @($targetId, $recordedId)).Count) {
        throw 'The voice service is still cleaning up audio. Wait for it to exit and retry.'
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

function Update-HarnessRegistration($Changes, $ExpectedFiles) {
    try {
        foreach ($path in $ExpectedFiles.Keys) { Assert-LocalTextSnapshot $path $ExpectedFiles[$path] }
        foreach ($change in $Changes) { Write-CheckedText $change }
        foreach ($change in $Changes) { $ExpectedFiles[$change.path] = $change.written }
        foreach ($path in $ExpectedFiles.Keys) { Assert-LocalTextSnapshot $path $ExpectedFiles[$path] }
    } catch {
        $failure = $_
        $rollbackErrors = @()
        for ($i = $Changes.Count - 1; $i -ge 0; $i--) {
            try { Undo-CheckedText $Changes[$i] }
            catch { $rollbackErrors += "$($Changes[$i].path): $($_.Exception.Message)" }
        }
        if ($rollbackErrors.Count) {
            throw "Could not update the Harness registration: $($failure.Exception.Message). Rollback needs review: $($rollbackErrors -join '; ')"
        }
        throw $failure
    }
    foreach ($change in $Changes) { "Updated $($change.path); backup: $($change.backup)" }
}

# Wait for anything that can relaunch the panel, then stop its guard and server.
Stop-DeviceSync
Stop-VoiceService
$guard = Read-ProcessRecord (Join-Path $state 'panel-guard.json')
$instance = Read-ProcessRecord (Join-Path $state 'panel-instance.json')
Stop-InstallProcesses (Join-Path $scriptDir 'watch-panel.ps1') @($guard.pid) 'Panel guard'
$serverIds = @($guard.serverPid)
$serverScript = Join-Path $scriptDir 'start-panel.mjs'
if ($instance.script -eq $serverScript) { $serverIds += $instance.pid }
Stop-InstallProcesses $serverScript $serverIds 'Panel server' $instance

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
    $profileSnapshot = Read-LocalTextSnapshot $profileJson
    $patchSnapshot = Read-LocalTextSnapshot $profilePatch
    if ($profileSnapshot.existed) {
        $package = ConvertFrom-Json -InputObject $profileSnapshot.text
        if ($package.dependencies) { $dependency = $package.dependencies.PSObject.Properties[$harnessName] }
        if ($dependency -and [string]$dependency.Value -ne ('file:' + $expectedPanel)) { $conflicts += 'profile dependency' }
    }

    $patchMatch = $null
    if ($patchSnapshot.existed) {
        $patch = $patchSnapshot.text
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
    $entryPath = Join-Path $module 'index.mjs'
    $entrySnapshot = Read-LocalTextSnapshot $entryPath
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
            $changes += @{path = $profileJson; content = ($package | ConvertTo-Json -Depth 30); expected = $profileSnapshot; backup = "$profileJson.backup-$([guid]::NewGuid().ToString('N'))"}
        }
        if ($patchMatch.Success) {
            $changes += @{path = $profilePatch; content = $patch.Remove($patchMatch.Index, $patchMatch.Length); expected = $patchSnapshot; backup = "$profilePatch.backup-$([guid]::NewGuid().ToString('N'))"}
        }
        Update-HarnessRegistration $changes @{$profileJson = $profileSnapshot; $profilePatch = $patchSnapshot; $entryPath = $entrySnapshot}
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
'Done. User settings, device backups and wallpapers were preserved.'
