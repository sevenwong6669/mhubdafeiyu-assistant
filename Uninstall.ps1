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

# Stop only the panel guard and panel server that belong to this directory.
$guardState = Join-Path $panel 'state/panel-guard.json'
if (Test-Path -LiteralPath $guardState -PathType Leaf) {
    try {
        $guard = Get-Content -LiteralPath $guardState -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($proc in (Get-CimInstance Win32_Process -Filter "ProcessId=$($guard.pid) OR ProcessId=$($guard.serverPid)" -ErrorAction SilentlyContinue)) {
            $cmd = [string]$proc.CommandLine
            if ($cmd -and $cmd.StartsWith('"', [StringComparison]::Ordinal)) { $cmd = $cmd.Trim('"') }
            $belongs = $cmd -match [regex]::Escape((Join-Path $root 'mhub-community-assistant'))
            if ($belongs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue; "Stopped process belonging to this install: $($proc.ProcessId)" }
        }
    } catch { "Panel guard stop skipped: $($_.Exception.Message)" }
}

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

$harnessOwned = $false
if (Test-Path -LiteralPath $profileJson -PathType Leaf) {
    $package = Get-Content -LiteralPath $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $registered = [string]$package.dependencies.PSObject.Properties['dsh-mhub-community-v11'].Value
    $harnessOwned = $registered -eq ('file:' + $expectedPanel)
    if (!$linkedHere.harness) { 'Harness was not linked by this install; leaving its registration untouched.' }
    elseif (!$harnessOwned) { "Harness registration points at a different install ($registered); leaving it untouched." }
    else {
        $changed = $false
        if ($package.dsh.profile.bundles) {
            $kept = @($package.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-mhub-community-v11' })
            if ($kept.Count -ne @($package.dsh.profile.bundles).Count) { $package.dsh.profile.bundles = $kept; $changed = $true }
        }
        $package.dependencies.PSObject.Properties.Remove('dsh-mhub-community-v11')
        $changed = $true
        if ($changed) {
            $backup = $profileJson + '.backup-' + [guid]::NewGuid().ToString('N')
            Copy-Item -LiteralPath $profileJson -Destination $backup
            [IO.File]::WriteAllText($profileJson, ($package | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
            "Harness profile updated; backup: $backup"
        }
    }
}
if (Test-Path -LiteralPath $profilePatch -PathType Leaf) {
    $patch = [IO.File]::ReadAllText($profilePatch)
    $ownedBlock = $patch -match [regex]::Escape("stateDir: `"$expectedState`"") -or $patch -match [regex]::Escape("stateDir: $expectedState")
    if (!$linkedHere.harness -or !$harnessOwned -or !$ownedBlock) {
        if (!$ownedBlock) { 'Harness patch stateDir does not point at this install; leaving it untouched.' }
    } else {
        $updated = $patch -replace '(?ms)\r?\n- id: mhub-community-assistant\r?\n  name: dsh-mhub-community-v11\r?\n  config:\r?\n    stateDir: [^\r\n]+\r?\n?', "`n"
        if ($updated -ne $patch) {
            $backup = $profilePatch + '.backup-' + [guid]::NewGuid().ToString('N')
            Copy-Item -LiteralPath $profilePatch -Destination $backup
            [IO.File]::WriteAllText($profilePatch, $updated, [Text.UTF8Encoding]::new($false))
            "Harness patch updated; backup: $backup"
        }
    }
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
        if ($pair[1] -eq 'harness' -and !$harnessOwned -and !$owned) { "Module $directory is not proven to belong here; leaving it." ; continue }
        if ($pair[1] -eq 'aurabot' -and !$owned) { "Module $directory is not proven to belong here; leaving it." ; continue }
        Remove-Item -LiteralPath $directory -Recurse -Force
        "Removed module: $directory"
    }
}
if ($RemoveVenv) {
    $venv = Join-Path $root '.venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force; "Removed Python environment: $venv" }
}
'Done. User state under mhub-community-assistant/state, runtime.settings.json, device backups and wallpapers were left untouched.'
