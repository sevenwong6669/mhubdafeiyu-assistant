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

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Close DeepSeek Harness before unlinking its profile.' }

if (Test-Path -LiteralPath $profileJson -PathType Leaf) {
    $package = Get-Content -LiteralPath $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $changed = $false
    if ($package.dsh.profile.bundles) {
        $kept = @($package.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-mhub-community-v11' })
        if ($kept.Count -ne @($package.dsh.profile.bundles).Count) { $package.dsh.profile.bundles = $kept; $changed = $true }
    }
    if ($package.dependencies.PSObject.Properties['dsh-mhub-community-v11']) {
        $package.dependencies.PSObject.Properties.Remove('dsh-mhub-community-v11'); $changed = $true
    }
    if ($changed) {
        $backup = $profileJson + '.backup-' + [guid]::NewGuid().ToString('N')
        Copy-Item -LiteralPath $profileJson -Destination $backup
        [IO.File]::WriteAllText($profileJson, ($package | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
        "Harness profile updated; backup: $backup"
    }
}
if (Test-Path -LiteralPath $profilePatch -PathType Leaf) {
    $patch = [IO.File]::ReadAllText($profilePatch)
    $updated = $patch -replace '(?ms)\r?\n- id: mhub-community-assistant\r?\n  name: dsh-mhub-community-v11\r?\n  config:\r?\n    stateDir: [^\r\n]+\r?\n?', "`n"
    if ($updated -ne $patch) {
        $backup = $profilePatch + '.backup-' + [guid]::NewGuid().ToString('N')
        Copy-Item -LiteralPath $profilePatch -Destination $backup
        [IO.File]::WriteAllText($profilePatch, $updated, [Text.UTF8Encoding]::new($false))
        "Harness patch updated; backup: $backup"
    }
}
foreach ($directory in @($module, $auraModule)) {
    $expected = [IO.Path]::GetFullPath($directory)
    if (Test-Path -LiteralPath $expected) {
        Remove-Item -LiteralPath $expected -Recurse -Force
        "Removed module: $expected"
    }
}
if ($RemoveVenv) {
    $venv = Join-Path $root '.venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force; "Removed Python environment: $venv" }
}
'Done. User state under mhub-community-assistant/state, runtime.settings.json, device backups and wallpapers were left untouched.'
