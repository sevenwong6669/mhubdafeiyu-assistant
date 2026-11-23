param([Parameter(Mandatory)][string]$PythonPath)

$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ('mhub-install-test-' + [guid]::NewGuid().ToString('N'))
$bundle = Join-Path $testRoot 'plugin with spaces'
$panel = Join-Path $bundle 'mhub-community-assistant'
$install = Join-Path $bundle 'Install.ps1'
$uninstall = Join-Path $bundle 'Uninstall.ps1'
$testHome = Join-Path $testRoot 'test user'
$dshRoot = Join-Path $testHome '.dsh'
$profile = Join-Path $dshRoot 'profiles/desktop'
$profileJson = Join-Path $profile 'package.json'
$profilePatch = Join-Path $profile 'cordis.patch.yml'
$module = Join-Path $profile 'node_modules/dsh-mhub-community-v11'
$index = Join-Path $module 'index.mjs'
$auraModules = Join-Path $dshRoot 'plugins-data/aurabot/modules'
$auraModule = Join-Path $auraModules 'mhub-companion'
$settings = Join-Path $bundle 'runtime.settings.json'
$state = Join-Path $panel 'state'
$record = Join-Path $state 'install-record.json'
$mhub = Join-Path $testRoot 'MCHOSE HUB.exe'
$utf8 = [Text.UTF8Encoding]::new($false)
$powerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$oldUserProfile = $env:USERPROFILE
$oldPythonPath = $env:PYTHONPATH

function Assert-That([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

# Treat the isolated Harness profile as closed independently of any real
# desktop instance. Process ID checks still use the real cmdlet.
function Get-Process {
    [CmdletBinding()]
    param([string]$Name, [int]$Id)
    if ($Name -eq 'DeepSeek Harness') { return }
    Microsoft.PowerShell.Management\Get-Process @PSBoundParameters
}

function Remove-FixtureTree([string]$Directory) {
    $resolved = (Resolve-Path -LiteralPath $Directory).ProviderPath
    $prefix = $testRoot + [IO.Path]::DirectorySeparatorChar
    if (($resolved -ne $testRoot -and !$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
        ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Invalid test cleanup path: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-Uninstall {
    $output = @(& $uninstall -DshRoot $dshRoot)
    if (!($output -like 'Done.*')) { throw "Uninstall failed: $($output -join [Environment]::NewLine)" }
    return $output
}

function Reset-HarnessRegistration {
    $null = New-Item -Force -ItemType Directory -Path $module
    [IO.File]::WriteAllText($profileJson, $installedProfile, $utf8)
    [IO.File]::WriteAllText($profilePatch, $installedPatch, $utf8)
    [IO.File]::WriteAllText($index, $installedEntry, $utf8)
}

function Assert-HarnessUnlinked {
    $package = [IO.File]::ReadAllText($profileJson) | ConvertFrom-Json
    Assert-That (!$package.dependencies.PSObject.Properties['dsh-mhub-community-v11']) 'Harness dependency survived uninstall.'
    Assert-That (($package.dsh.profile.bundles -join ',') -eq 'existing-plugin') 'Uninstall changed unrelated bundles or left its own bundle.'
    Assert-That ($package.dependencies.'existing-plugin' -eq '1.0.0') 'Uninstall changed a different dependency.'
    Assert-That (!(Test-Path -LiteralPath $module)) 'Harness module survived uninstall.'
}

function Assert-GuardFailureStopsUninstall {
    $guardFile = Join-Path $state 'panel-guard.json'
    $guardCommand = 'powershell.exe -NoProfile -File "' + (Join-Path $panel 'scripts/watch-panel.ps1') + '"'
    $serverCommand = 'node.exe "' + (Join-Path $panel 'scripts/start-panel.mjs') + '"'
    $processes = @(
        [pscustomobject]@{ ProcessId = 43210; Name = 'powershell.exe'; CommandLine = $guardCommand }
        [pscustomobject]@{ ProcessId = 43211; Name = 'node.exe'; CommandLine = $serverCommand }
    )
    $attempts = [Collections.Generic.List[int]]::new()
    function Get-CimInstance {
        [CmdletBinding()]
        param([string]$ClassName, [string]$Filter)
        $processes | Where-Object { !$Filter -or "ProcessId=$($_.ProcessId)" -eq $Filter }
    }
    function Stop-Process {
        [CmdletBinding()]
        param([int]$Id, [switch]$Force)
        $attempts.Add($Id)
        throw 'Simulated stop failure'
    }

    $guardJson = '{"pid":43210,"serverPid":43211}'
    [IO.File]::WriteAllText($guardFile, $guardJson, $utf8)
    $failure = $null
    try { $null = & $uninstall -DshRoot $dshRoot } catch { $failure = $_ }
    Assert-That ($failure.Exception.Message -like '*Panel guard stopped*') 'Uninstall did not report the guard failure.'
    Assert-That (($attempts -join ',') -eq '43210') 'Uninstall attempted to stop the server after the guard failed to stop.'
    Assert-That ([IO.File]::ReadAllText($guardFile) -ceq $guardJson) 'Failed uninstall changed the guard record.'
    Assert-That ([IO.File]::ReadAllText($profileJson) -ceq $installedProfile) 'Failed stop changed the Harness dependency.'
    Assert-That ([IO.File]::ReadAllText($profilePatch) -ceq $installedPatch) 'Failed stop changed the Harness patch.'
    Assert-That ([IO.File]::ReadAllText($index) -ceq $installedEntry) 'Failed stop changed the Harness module.'
    Remove-Item -LiteralPath $guardFile
}

function Assert-LockedRecordRollback([IO.FileShare]$Sharing) {
    $priorBackups = @(Get-ChildItem -LiteralPath $bundle -Directory -Filter 'harness-install-backup-*').Count
    $lock = [IO.File]::Open($record, [IO.FileMode]::Open, [IO.FileAccess]::Read, $Sharing)
    $failure = $null
    try {
        $null = & $install -PythonPath $PythonPath -MhubPath $mhub -LinkHarness -LinkAuraBot
    } catch { $failure = $_ }
    finally { $lock.Dispose() }
    Assert-That ($null -ne $failure) "Installation succeeded with a locked record ($Sharing)."
    Assert-That (@(Get-ChildItem -LiteralPath $bundle -Directory -Filter 'harness-install-backup-*').Count -gt $priorBackups) 'Installation never reached the registration changes.'
    Assert-That ($failure.Exception.Message -notmatch 'Rollback needs review') "Rollback reported a failure: $($failure.Exception.Message)"
    Assert-That ([IO.File]::ReadAllText($record) -ceq $originalRecord) 'Failed install changed the record.'
    Assert-That ([IO.File]::ReadAllText($settings) -ceq $originalSettings) 'Failed install did not restore runtime settings.'
    Assert-That ([IO.File]::ReadAllText($profileJson) -ceq $originalProfile) 'Failed install did not restore the Harness profile.'
    Assert-That ([IO.File]::ReadAllText($profilePatch) -ceq $originalPatch) 'Failed install did not restore the Harness patch.'
    Assert-That (!(Test-Path -LiteralPath $module) -and !(Test-Path -LiteralPath $auraModule)) 'Failed install left a new module.'
    Assert-That (!@(Get-ChildItem -LiteralPath $state -Filter 'install-record.json.install-*').Count) 'Failed install left a temporary record.'
    "PASS: installation rolled back with FileShare.$Sharing"
}

$null = New-Item -ItemType Directory -Path $testRoot
try {
    $fixtureFiles = @(
        'Install.ps1', 'Uninstall.ps1', 'mhub-community-assistant/package.json',
        'mhub-community-assistant/client.js', 'mhub-community-assistant/cordis.bundle.yml',
        'mhub-community-assistant/panel/icon.svg', 'mhub-community-assistant/aurabot-panel.js'
    )
    $manifest = foreach ($relative in $fixtureFiles) {
        $destination = Join-Path $bundle $relative
        $null = New-Item -Force -ItemType Directory -Path (Split-Path -Parent $destination)
        Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative
    }
    [IO.File]::WriteAllLines((Join-Path $bundle 'SHA256SUMS.txt'), [string[]]$manifest, $utf8)
    $null = New-Item -ItemType File -Path $mhub
    # Use the real interpreter and venv but replace the dependency download in this fixture.
    $env:PYTHONPATH = Join-Path $testRoot 'python-stubs'
    $null = New-Item -ItemType Directory -Path $env:PYTHONPATH
    [IO.File]::WriteAllText((Join-Path $env:PYTHONPATH 'pip.py'), 'raise SystemExit(0)', $utf8)
    $env:USERPROFILE = $testHome

    $emptyOutput = @(& $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $uninstall -DshRoot $dshRoot)
    Assert-That ($LASTEXITCODE -eq 0 -and ($emptyOutput -like 'Done.*')) 'Uninstall failed on an empty profile.'
    'PASS: uninstall on an empty profile'

    $null = New-Item -Force -ItemType Directory -Path $profile, $auraModules
    $originalProfile = '{"dependencies":{"existing-plugin":"1.0.0"},"dsh":{"profile":{"bundles":["existing-plugin"]}}}'
    $originalPatch = "- id: existing-plugin`r`n  name: existing-plugin`r`n"
    [IO.File]::WriteAllText($profileJson, $originalProfile, $utf8)
    [IO.File]::WriteAllText($profilePatch, $originalPatch, $utf8)
    $null = & $install -PythonPath $PythonPath -MhubPath $mhub -LinkHarness -LinkAuraBot
    Assert-That (Test-Path -LiteralPath (Join-Path $auraModule 'index.mjs')) 'Install did not register AuraBot.'
    $installedProfile = [IO.File]::ReadAllText($profileJson)
    $installedEntry = [IO.File]::ReadAllText($index)
    $nextPatch = "- id: another-plugin`n  name: another-plugin`n"
    $installedPatch = [IO.File]::ReadAllText($profilePatch) + $nextPatch
    [IO.File]::WriteAllText($profilePatch, $installedPatch, $utf8)
    $savedSettings = [IO.File]::ReadAllText($settings)
    $savedRecord = [IO.File]::ReadAllText($record)

    $null = Invoke-Uninstall
    Assert-HarnessUnlinked
    Assert-That ([IO.File]::ReadAllText($profilePatch) -ceq ($originalPatch + "`n" + $nextPatch)) 'Uninstall changed an unrelated patch.'
    Assert-That (!(Test-Path -LiteralPath $auraModule)) 'AuraBot module survived uninstall.'
    Assert-That ([IO.File]::ReadAllText($record) -ceq $savedRecord) 'Uninstall changed the install record.'
    Assert-That ([IO.File]::ReadAllText($settings) -ceq $savedSettings) 'Uninstall changed runtime settings.'
    $null = Invoke-Uninstall
    'PASS: install, uninstall and repeat uninstall'

    Reset-HarnessRegistration
    $foreignState = (Join-Path $testRoot 'other install/state').Replace('\','/')
    $ownState = $state.Replace('\','/')
    $mixedPatch = $installedPatch.Replace($ownState, $foreignState)
    [IO.File]::WriteAllText($profilePatch, $mixedPatch, $utf8)
    $null = Invoke-Uninstall
    Assert-That ([IO.File]::ReadAllText($profileJson) -ceq $installedProfile) 'A foreign patch caused the owned dependency to be removed.'
    Assert-That ([IO.File]::ReadAllText($profilePatch) -ceq $mixedPatch) 'Uninstall changed a foreign patch.'
    Assert-That ([IO.File]::ReadAllText($index) -ceq $installedEntry) 'A foreign patch caused the owned module to be removed.'

    Reset-HarnessRegistration
    Remove-Item -LiteralPath $profilePatch
    $foreignEntry = 'export {default} from "file:///C:/other-install/native-host.mjs";'
    [IO.File]::WriteAllText($index, $foreignEntry, $utf8)
    $null = Invoke-Uninstall
    Assert-That ([IO.File]::ReadAllText($profileJson) -ceq $installedProfile) 'A foreign module without a patch caused the dependency to be removed.'
    Assert-That ([IO.File]::ReadAllText($index) -ceq $foreignEntry) 'Uninstall changed a foreign module.'
    'PASS: mixed ownership preserves the Harness registration'

    Reset-HarnessRegistration
    Remove-Item -LiteralPath $profilePatch
    $null = Invoke-Uninstall
    Assert-HarnessUnlinked
    Reset-HarnessRegistration
    Remove-FixtureTree $module
    $null = Invoke-Uninstall
    Assert-HarnessUnlinked
    Assert-That ([IO.File]::ReadAllText($profilePatch) -ceq ($originalPatch + "`n" + $nextPatch)) 'Missing module prevented removal of the owned patch.'
    'PASS: uninstall of a partial owned registration'

    Reset-HarnessRegistration
    Assert-GuardFailureStopsUninstall
    'PASS: a failed guard stop preserves the panel and registration'

    $patchLock = [IO.File]::Open($profilePatch, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $failure = $null
    try { $null = Invoke-Uninstall } catch { $failure = $_ }
    finally { $patchLock.Dispose() }
    Assert-That ($null -ne $failure) 'Uninstall succeeded with a locked Harness patch.'
    Assert-That ([IO.File]::ReadAllText($profileJson) -ceq $installedProfile) 'Failed unlink did not restore the Harness profile.'
    Assert-That ([IO.File]::ReadAllText($profilePatch) -ceq $installedPatch) 'Failed unlink changed the locked patch.'
    Assert-That ([IO.File]::ReadAllText($index) -ceq $installedEntry) 'Failed unlink removed the module.'
    'PASS: a locked Harness patch rolls back the registration update'

    Remove-FixtureTree $module
    $originalSettings = '{"mhub":"fixture","userPreference":"keep"}'
    $originalRecord = '{"hosts":[],"previous":"keep"}'
    [IO.File]::WriteAllText($settings, $originalSettings, $utf8)
    [IO.File]::WriteAllText($record, $originalRecord, $utf8)
    [IO.File]::WriteAllText($profileJson, $originalProfile, $utf8)
    [IO.File]::WriteAllText($profilePatch, $originalPatch, $utf8)
    Assert-LockedRecordRollback ([IO.FileShare]::None)
    Assert-LockedRecordRollback ([IO.FileShare]::Read)
} finally {
    $env:USERPROFILE = $oldUserProfile
    $env:PYTHONPATH = $oldPythonPath
    Remove-FixtureTree $testRoot
}
