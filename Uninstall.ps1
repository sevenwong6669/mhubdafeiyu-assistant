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
$module = Join-Path $profile 'node_modules/dsh-mhub-community-v11'
$auraModule = Join-Path $DshRoot 'plugins-data/aurabot/modules/mhub-companion'
$expectedPanel = $panel.Replace('\','/')
$expectedState = (Join-Path $panel 'state').Replace('\','/')
$scriptDir = Join-Path $panel 'scripts'

function Stop-OwnedProcess([int]$Pid, [string]$ScriptName, [string]$Role) {
    if ($Pid -le 0) { return $true }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$Pid" -ErrorAction SilentlyContinue
    if (!$proc) { "${Role}: pid $Pid is not running."; return $true }
    $expected = Join-Path $scriptDir $ScriptName
    $cmd = [string]$proc.CommandLine
    if ($cmd -notmatch [regex]::Escape($expected)) {
        "Skipped pid ${Pid}: it does not run this install's ${ScriptName}."
        return $false
    }
    try {
        Stop-Process -Id $Pid -Force -ErrorAction Stop
        $null = Wait-Process -Id $Pid -Timeout 10 -ErrorAction SilentlyContinue
        if (Get-Process -Id $Pid -ErrorAction SilentlyContinue) { "${Role}: pid $Pid did not exit within 10s."; return $false }
        "Stopped ${Role}: pid $Pid."
        return $true
    } catch { "Could not stop ${Role} (pid ${Pid}): $($_.Exception.Message)"; return $false }
}

# Stop this install's panel guard first so it cannot respawn the panel, then
# the panel itself. Both are verified by script path before stopping.
$guardState = Join-Path $panel 'state/panel-guard.json'
$guardPid = 0; $panelPid = 0
if (Test-Path -LiteralPath $guardState -PathType Leaf) {
    try {
        $guard = Get-Content -LiteralPath $guardState -Raw -Encoding UTF8 | ConvertFrom-Json
        $guardPid = [int]$guard.pid; $panelPid = [int]$guard.serverPid
    } catch { "Panel guard record unreadable: $($_.Exception.Message)" }
} else {
    # Without a guard record, find stray processes still running our scripts.
    foreach ($name in @('watch-panel.ps1','start-panel.mjs')) {
        $expected = Join-Path $scriptDir $name
        $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.CommandLine -match [regex]::Escape($expected) } |
            Select-Object -First 1
        if ($proc) { if ($name -eq 'watch-panel.ps1') { $guardPid = $proc.ProcessId } else { $panelPid = $proc.ProcessId } }
    }
}
$guardStopped = Stop-OwnedProcess $guardPid 'watch-panel.ps1' 'Panel guard'
$null = Stop-OwnedProcess $panelPid 'start-panel.mjs' 'Panel server'

$record = $null
$recordFile = Join-Path $panel 'state/install-record.json'
if (Test-Path -LiteralPath $recordFile -PathType Leaf) {
    try { $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$linkedHere = @{ harness = $true; aurabot = $true }
if ($record -and $record.hosts) {
    $linkedHere.harness = @($record.hosts) -contains 'harness'
    $linkedHere.aurabot = @($record.hosts) -contains 'aurabot'
}

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Close DeepSeek Harness before unlinking its profile.' }

# Harness ownership is only proven when every artifact points at this
# install: the profile dependency, the patch block's stateDir and (for the
# module directory) the entry file's URI. Conflicting evidence keeps
# everything registered.
$package = $null; $harnessOwned = $false
if (Test-Path -LiteralPath $profileJson -PathType Leaf) {
    $package = Get-Content -LiteralPath $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $harnessOwned = [string]$package.dependencies.PSObject.Properties['dsh-mhub-community-v11'].Value -eq ('file:' + $expectedPanel)
}
$harnessConflict = $false; $patchBlockPattern = '(?ms)\r?\n- id: mhub-community-assistant\r?\n  name: dsh-mhub-community-v11\r?\n  config:\r?\n    stateDir: "?([^"\r\n]+?)"?\r?\n?'
$patch = $null
if (Test-Path -LiteralPath $profilePatch -PathType Leaf) { $patch = [IO.File]::ReadAllText($profilePatch) }
$patchMatch = $null; if ($patch) { $patchMatch = [regex]::Match($patch, $patchBlockPattern) }
if ($patchMatch -and $patchMatch.Success -and $patchMatch.Groups[1].Value -ne $expectedState) { $harnessConflict = $true }

if (!$linkedHere.harness) { 'Harness was not linked by this install; leaving its registration untouched.' }
elseif ($harnessOwned -and $harnessConflict) { "Harness evidence conflicts: the profile dependency points here but the patch block points at $($patchMatch.Groups[1].Value). Leaving the Harness registration untouched." }
elseif (!$harnessOwned -and $patch -and $patchMatch.Success) { "Harness registration points at a different install; leaving it untouched." }
else {
    if ($package -and $harnessOwned) {
        $kept = @($package.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-mhub-community-v11' })
        if ($kept.Count -ne @($package.dsh.profile.bundles).Count) { $package.dsh.profile.bundles = $kept }
        $package.dependencies.PSObject.Properties.Remove('dsh-mhub-community-v11')
        $backup = $profileJson + '.backup-' + [guid]::NewGuid().ToString('N')
        Copy-Item -LiteralPath $profileJson -Destination $backup
        [IO.File]::WriteAllText($profileJson, ($package | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
        "Harness profile updated; backup: $backup"
    }
    if ($patchMatch -and $patchMatch.Success) {
        $updated = $patch.Substring(0, $patchMatch.Index) + $patch.Substring($patchMatch.Index + $patchMatch.Length)
        if ($updated -ne $patch) {
            $backup = $profilePatch + '.backup-' + [guid]::NewGuid().ToString('N')
            Copy-Item -LiteralPath $profilePatch -Destination $backup
            [IO.File]::WriteAllText($profilePatch, $updated, [Text.UTF8Encoding]::new($false))
            "Harness patch updated; backup: $backup"
        }
    }
    $harnessOwned = $harnessOwned -or ($patchMatch -and $patchMatch.Success)
}
$entries = @(@($module, 'harness', 'native-host.mjs'), @($auraModule, 'aurabot', 'aurabot-adapter.mjs'))
foreach ($pair in $entries) {
    $directory = [IO.Path]::GetFullPath($pair[0])
    if (!$linkedHere[$pair[1]]) { continue }
    if (Test-Path -LiteralPath $directory) {
        $indexFile = Join-Path $directory 'index.mjs'
        $owned = $false
        if (Test-Path -LiteralPath $indexFile -PathType Leaf) {
            $expectedUri = ([uri](Join-Path $panel $pair[2])).AbsoluteUri
            $owned = ([IO.File]::ReadAllText($indexFile)) -match [regex]::Escape($expectedUri)
        }
        # The entry file is the only proof a module directory belongs to this
        # install. Anything else may belong to a newer install.
        if (!$owned) { "Module $directory is not proven to belong here; leaving it." ; continue }
        Remove-Item -LiteralPath $directory -Recurse -Force
        "Removed module: $directory"
    }
}
if ($RemoveVenv) {
    $venv = Join-Path $root '.venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force; "Removed Python environment: $venv" }
}
'Done. User state under mhub-community-assistant/state, runtime.settings.json, device backups and wallpapers were left untouched.'
