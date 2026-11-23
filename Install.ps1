param(
    [string]$PythonPath,
    [string]$MhubPath,
    [switch]$LinkHarness,
    [switch]$LinkAuraBot,
    [switch]$PrepareVoice,
    [switch]$PrepareDesktop,
    [switch]$PrepareCompatibilityDesktop,
    [string]$IndexTtsRoot,
    [string]$VoiceReference,
    [string]$AsrPython,
    [string]$DshRoot = (Join-Path $env:USERPROFILE '.dsh')
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$panel = Join-Path $root 'mhub-community-assistant'
$sync = Join-Path $root 'harness-mhub-sync'
$utf8 = [Text.UTF8Encoding]::new($false)
$installBackup = $null
$savedFiles = @{}
$fileChanges = [Collections.Generic.List[hashtable]]::new()
$createdModules = [Collections.Generic.List[string]]::new()

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }

function Test-PackageIntegrity {
    $manifest = Join-Path $root 'SHA256SUMS.txt'
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'SHA256SUMS.txt is missing. Use the complete original release archive.' }
    $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $lines = [IO.File]::ReadAllLines($manifest)
    if ($lines.Count -eq 0) { throw 'SHA256SUMS.txt is empty.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $lines) {
        if ($line -notmatch '^([a-fA-F0-9]{64})  (.+)$') { throw 'Invalid SHA256SUMS.txt entry.' }
        $expected = $Matches[1]
        $relative = $Matches[2]
        $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The checksum manifest contains an unsafe path.' }
        if (!$seen.Add($target)) { throw 'The checksum manifest contains duplicate paths.' }
        if (!(Test-Path -LiteralPath $target -PathType Leaf) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expected) { throw "Package checksum mismatch: $relative" }
    }
}

function Resolve-File([string]$Path) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) { throw "Expected a file: $Path" }
    return $item.FullName
}

function Write-LocalText([string]$Path, [string]$Content, $Expected) {
    if (!$Expected) { $Expected = Read-LocalTextSnapshot $Path }
    if (!$script:installBackup) {
        $script:installBackup = Join-Path $root ('install-backup-' + [guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $script:installBackup
    }
    $backup = Join-Path $script:installBackup ($fileChanges.Count.ToString() + '.original')
    $change = @{path = $Path; content = $Content; expected = $Expected; backup = $backup}
    $savedFiles[$Path] = @{existed = $Expected.existed; backup = $backup}
    [IO.File]::WriteAllText((Join-Path $script:installBackup 'files.json'), ($savedFiles | ConvertTo-Json -Depth 5), $utf8)
    $fileChanges.Add($change)
    Write-CheckedText $change
}

function Read-HarnessRegistration {
    if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Close DeepSeek Harness before linking its profile.' }
    if (!(Test-Path -LiteralPath $profileJson -PathType Leaf)) { throw 'Open and initialize DeepSeek Harness first.' }
    $profileSnapshot = Read-LocalTextSnapshot $profileJson
    $patchSnapshot = Read-LocalTextSnapshot $profilePatch
    $package = ConvertFrom-Json -InputObject $profileSnapshot.text
    $patchText = $patchSnapshot.text
    if (!$package.dsh.profile -or !$package.dependencies) { throw 'Unsupported Harness profile layout.' }
    if ((Test-Path -LiteralPath $module) -or $package.dependencies.PSObject.Properties['dsh-mhub-community-v11'] -or
        @($package.dsh.profile.bundles) -contains 'dsh-mhub-community-v11' -or
        $patchText -match '(?m)^\s*-\s*id:\s*["'']?mhub-community-assistant["'']?\s*(?:#.*)?$') {
        throw 'Existing MCHose plugin detected. Preserve it and follow the upgrade notes.'
    }
    return @{
        package = $package
        profile = $profileSnapshot
        patch = $patchSnapshot
    }
}

function New-OwnedModule([string]$Path) {
    if (Test-Path -LiteralPath $Path) { throw 'A module appeared during installation. It was not overwritten.' }
    $null = New-Item -ItemType Directory -Path $Path
    $createdModules.Add([IO.Path]::GetFullPath($Path))
}

function Prepare-DesktopRuntime([string]$Directory) {
    Push-Location -LiteralPath $Directory
    try {
        & npm.cmd ci
        if ($LASTEXITCODE) { throw "Desktop runtime installation failed; check network and retry npm ci in $Directory." }
        # Electron's npm package may not contain an automatic download hook.
        # Package installation is not complete until its verified binary exists.
        $electronInstaller = Join-Path $Directory 'node_modules/electron/install.js'
        if (!(Test-Path -LiteralPath $electronInstaller -PathType Leaf)) { throw "Electron installer is missing in $Directory." }
        & node.exe $electronInstaller
        if ($LASTEXITCODE) { throw "Electron binary download failed in $Directory; retry installation after checking network access." }
        if (!(Test-Path -LiteralPath (Join-Path $Directory 'node_modules/electron/dist/electron.exe') -PathType Leaf)) { throw "Electron executable is missing in $Directory after installation." }
    } finally { Pop-Location }
}

function Undo-Installation {
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    $keepHarnessModule = $false
    for ($i = $fileChanges.Count - 1; $i -ge 0; $i--) {
        $change = $fileChanges[$i]
        if ($keepHarnessModule -and $change.path.StartsWith($module + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
        try { Undo-CheckedText $change }
        catch {
            if ($change.path -in @($profilePatch, $profileJson)) { $keepHarnessModule = $true }
            $rollbackErrors.Add("$($change.path): $($_.Exception.Message)")
        }
    }
    # Only the exact module directories created in this transaction are removed.
    $allowed = @($module,$voiceModule,$auraModule) | ForEach-Object { [IO.Path]::GetFullPath($_) }
    foreach ($directory in $createdModules) {
        if ($keepHarnessModule -and $directory -eq $module) { continue }
        try {
            if ($directory -notin $allowed) { throw 'Rollback target identity changed.' }
            if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
        } catch { $rollbackErrors.Add("${directory}: $($_.Exception.Message)") }
    }
    if ($rollbackErrors.Count) { throw ($rollbackErrors -join [Environment]::NewLine) }
}

Test-PackageIntegrity
. (Join-Path $panel 'scripts/local-text-transaction.ps1')

$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(process.arch!=='x64'||major<22||(major===22&&minor<15))process.exit(1)"
if ($LASTEXITCODE) { throw 'Node.js 22.15 or later, Windows x64 build, is required.' }
if ($MhubPath) {
    $MhubPath = Resolve-File $MhubPath
    if ([IO.Path]::GetFileName($MhubPath) -ne 'MCHOSE HUB.exe') { throw 'Select MCHOSE HUB.exe.' }
}
if (!$MhubPath) {
    $settingsFile = Join-Path $root 'runtime.settings.json'
    $saved = if (Test-Path -LiteralPath $settingsFile -PathType Leaf) { Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if ($saved.mhub) { $MhubPath = Resolve-File $saved.mhub }
    else {
        foreach ($base in @($env:ProgramW6432,$env:ProgramFiles,${env:ProgramFiles(x86)}) | Select-Object -Unique) {
            if (!$base) { continue }
            $candidate = Join-Path $base 'M HUB/MCHOSE HUB.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $MhubPath = Resolve-File $candidate; break }
        }
    }
    if (!$MhubPath) { throw 'M HUB was not found. Pass its actual MCHOSE HUB.exe path with -MhubPath.' }
}
if ([IO.Path]::GetFileName($MhubPath) -ne 'MCHOSE HUB.exe') { throw 'Select MCHOSE HUB.exe.' }
if ($IndexTtsRoot -or $VoiceReference) {
    if (!$IndexTtsRoot -or !$VoiceReference) { throw 'IndexTtsRoot and VoiceReference must be provided together.' }
    $IndexTtsRoot = (Resolve-Path -LiteralPath $IndexTtsRoot).Path
    $VoiceReference = Resolve-File $VoiceReference
    $indexPython = Resolve-File (Join-Path $IndexTtsRoot '.venv/Scripts/python.exe')
}
if ($AsrPython) { $AsrPython = Resolve-File $AsrPython }

$DshRoot = [IO.Path]::GetFullPath($DshRoot)
$standardDsh = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dsh'))
if (($LinkHarness -or $LinkAuraBot) -and !$DshRoot.Equals($standardDsh,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'This release supports linked integrations in the current user standard .dsh directory. A custom DshRoot requires additional channel adaptation.'
}
$profile = Join-Path $DshRoot 'profiles/desktop'
$profileJson = Join-Path $profile 'package.json'
$profilePatch = Join-Path $profile 'cordis.patch.yml'
$module = Join-Path $profile 'node_modules/dsh-mhub-community-v11'
$voiceModule = Join-Path $profile 'node_modules/dsh-fish-voice'
$auraRoot = Join-Path $DshRoot 'plugins-data/aurabot'
$auraModule = Join-Path $auraRoot 'modules/mhub-companion'
if ($LinkHarness) {
    $null = Read-HarnessRegistration
}
if ($LinkAuraBot) {
    if (!(Test-Path -LiteralPath (Join-Path $auraRoot 'modules') -PathType Container)) { throw 'Initialize AuraBot first.' }
    if (Test-Path -LiteralPath $auraModule) { throw 'Existing AuraBot MCHose module detected. No files were overwritten.' }
}

$python = Join-Path $root '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python -PathType Leaf)) {
    if (!$PythonPath) {
        $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($launcher) {
            foreach ($version in @('-3.13','-3.12','-3.11','-3')) {
                $candidate = & $launcher.Source $version -c "import sys;print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $candidate) { $PythonPath = $candidate; break }
            }
        }
    }
    if (!$PythonPath) { throw 'Pass the full path to a Python 3.11-3.13 x64 executable with -PythonPath.' }
    $PythonPath = Resolve-File $PythonPath
    & $PythonPath -c "import sys,struct;sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) and struct.calcsize('P')==8 else 1)"
    if ($LASTEXITCODE) { throw 'Python 3.11-3.13 x64 is required.' }
    & $PythonPath -m venv (Join-Path $root '.venv')
    if ($LASTEXITCODE) { throw 'Could not create the isolated Python environment.' }
}
& $python -c "import sys,struct;sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) and struct.calcsize('P')==8 else 1)"
if ($LASTEXITCODE) { throw 'The existing package virtual environment must use Python 3.11-3.13 x64.' }
$dependencies = @('psutil','hidapi','Pillow','numpy','sounddevice','soundfile')
if ($PrepareVoice) { $dependencies += @('sherpa-onnx','requests','websocket-client','httpx','scipy','imageio-ffmpeg') }
& $python -m pip install --disable-pip-version-check --only-binary=:all: -i https://pypi.tuna.tsinghua.edu.cn/simple @dependencies
if ($LASTEXITCODE) {
    & $python -m pip install --disable-pip-version-check --only-binary=:all: @dependencies
    if ($LASTEXITCODE) { throw 'Python dependency installation failed on both the Tsinghua mirror and the official index. Check your network or proxy and run Install again.' }
}
if ($PrepareDesktop) {
    # Install local dependencies before committing settings or linking a host.
    # A failed npm download must leave existing Harness/profile files untouched.
    Prepare-DesktopRuntime (Join-Path $panel 'live2d-pet')
}
if ($PrepareCompatibilityDesktop) {
    Prepare-DesktopRuntime (Join-Path $panel 'desktop-pet')
}
$settingsPath = Join-Path $root 'runtime.settings.json'
$settingsSnapshot = Read-LocalTextSnapshot $settingsPath
$settings = if ($settingsSnapshot.existed) { ConvertFrom-Json -InputObject $settingsSnapshot.text } else { [pscustomobject]@{} }
$settings | Add-Member -NotePropertyName python -NotePropertyValue $python -Force
if ($MhubPath) { $settings | Add-Member -NotePropertyName mhub -NotePropertyValue $MhubPath -Force }
if ($AsrPython) { $settings | Add-Member -NotePropertyName asrPython -NotePropertyValue $AsrPython -Force }
if ($IndexTtsRoot) {
    $settings | Add-Member -NotePropertyName indexTtsRoot -NotePropertyValue $IndexTtsRoot -Force
    $settings | Add-Member -NotePropertyName voiceReference -NotePropertyValue $VoiceReference -Force
    $settings | Add-Member -NotePropertyName ttsPython -NotePropertyValue $indexPython -Force
}
try {
Write-LocalText $settingsPath ($settings | ConvertTo-Json -Depth 30) $settingsSnapshot
if ($PrepareVoice) {
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $sync 'voice-chat/cache')
    & (Join-Path $sync 'phone/Build-CallPanel.ps1')
}

if ($LinkHarness) {
    $registration = Read-HarnessRegistration
    $package = $registration.package
    $patch = $registration.patch.text
    $backup = Join-Path $root ('harness-install-backup-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $backup
    Copy-Item -LiteralPath $profileJson -Destination $backup
    if (Test-Path -LiteralPath $profilePatch) { Copy-Item -LiteralPath $profilePatch -Destination $backup }
    $package.dsh.profile.bundles = @($package.dsh.profile.bundles) + 'dsh-mhub-community-v11'
    $package.dependencies | Add-Member -NotePropertyName 'dsh-mhub-community-v11' -NotePropertyValue ('file:' + $panel.Replace('\','/'))
    New-OwnedModule $module
    $uri = ([uri](Join-Path $panel 'native-host.mjs')).AbsoluteUri | ConvertTo-Json -Compress
    $pkg = Get-Content -LiteralPath (Join-Path $panel 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $pkg.exports.'.' = './index.mjs'
    Write-LocalText (Join-Path $module 'package.json') ($pkg | ConvertTo-Json -Depth 15)
    Write-LocalText (Join-Path $module 'index.mjs') "export {name, inject, apply, default} from $uri;`n"
    Copy-Item -LiteralPath (Join-Path $panel 'client.js'),(Join-Path $panel 'cordis.bundle.yml') -Destination $module
    $null = New-Item -ItemType Directory -Path (Join-Path $module 'panel')
    Copy-Item -LiteralPath (Join-Path $panel 'panel/icon.svg') -Destination (Join-Path $module 'panel')
    $stateJson = (Join-Path $panel 'state').Replace('\','/') | ConvertTo-Json -Compress
    $patch += "`n- id: mhub-community-assistant`n  name: dsh-mhub-community-v11`n  config:`n    stateDir: $stateJson`n"
    Write-LocalText $profilePatch $patch $registration.patch
    Write-LocalText $profileJson ($package | ConvertTo-Json -Depth 30) $registration.profile
    "Harness profile backup: $backup"
}
if ($LinkAuraBot) {
    New-OwnedModule $auraModule
    $uri = ([uri](Join-Path $panel 'aurabot-adapter.mjs')).AbsoluteUri | ConvertTo-Json -Compress
    Copy-Item -LiteralPath (Join-Path $panel 'aurabot-panel.js') -Destination (Join-Path $auraModule 'panel.js')
    Write-LocalText (Join-Path $auraModule 'index.mjs') "export {default} from $uri;`n"
}
$record = [ordered]@{
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    root = $root
    dshRoot = $DshRoot
    hosts = @()
}
if ($LinkHarness) { $record.hosts += 'harness' }
if ($LinkAuraBot) { $record.hosts += 'aurabot' }
$stateDir = Join-Path $panel 'state'
$recordFile = Join-Path $stateDir 'install-record.json'
$recordSnapshot = Read-LocalTextSnapshot $recordFile
if ($recordSnapshot.existed) {
    $prior = ConvertFrom-Json -InputObject $recordSnapshot.text
    if ($prior.hosts) { $record.hosts = @(@($prior.hosts) + @($record.hosts) | Select-Object -Unique) }
}
$null = New-Item -ItemType Directory -Force -Path $stateDir
Write-LocalText $recordFile ($record | ConvertTo-Json) $recordSnapshot
} catch {
    $failure = $_
    try { Undo-Installation } catch {
        throw "Installation failed: $($failure.Exception.Message)`nRollback needs review. Keep the install-backup directory.`n$($_.Exception.Message)"
    }
    throw $failure
}
'Installed. Run Start.ps1, then open http://127.0.0.1:18782/api/mhub-community/panel'
if ($installBackup) { "Installation backup: $installBackup" }
'No recording, calls, automatic startup, LAN exposure or hardware configuration writes were started by this installer.'
