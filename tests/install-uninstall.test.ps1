param(
    [Parameter(Mandatory)][string]$PythonPath,
    [Parameter(Mandatory)][string]$PackageZip
)

$ErrorActionPreference = 'Stop'
$PackageZip = (Resolve-Path -LiteralPath $PackageZip).ProviderPath
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ('mhub-install-test-' + [guid]::NewGuid().ToString('N'))
$extracted = Join-Path $testRoot 'extracted release'
$bundle = Join-Path $extracted ([IO.Path]::GetFileNameWithoutExtension($PackageZip))
$panel = Join-Path $bundle 'mhub-community-assistant'
$sync = Join-Path $bundle 'harness-mhub-sync'
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

function Assert-DeviceWorkersExitBeforePanel {
    $guardFile = Join-Path $state 'panel-guard.json'
    $instanceFile = Join-Path $state 'panel-instance.json'
    $supervisorFile = Join-Path $sync 'supervisor.pid'
    $controllerFile = Join-Path $sync 'run.pid'
    $panelScript = Join-Path $panel 'scripts/start-panel.mjs'
    $panelGuard = Join-Path $panel 'scripts/watch-panel.ps1'
    $processes = @{
        43220 = [pscustomobject]@{ ProcessId = 43220; Name = 'node.exe'; CommandLine = ('node.exe "' + (Join-Path $sync 'supervisor.mjs') + '"') }
        43221 = [pscustomobject]@{ ProcessId = 43221; Name = 'node.exe'; CommandLine = ('node.exe "' + (Join-Path $sync 'optimized.mjs') + '" --hold') }
        43222 = [pscustomobject]@{ ProcessId = 43222; Name = 'powershell.exe'; CommandLine = ('powershell.exe -File "' + $panelGuard + '"') }
        43223 = [pscustomobject]@{ ProcessId = 43223; Name = 'node.exe'; CommandLine = 'node.exe scripts/start-panel.mjs' }
    }
    $order = [Collections.Generic.List[string]]::new()
    function Get-CimInstance {
        [CmdletBinding()]
        param([string]$ClassName, [string]$Filter)
        $processes.Values | Where-Object { !$Filter -or "ProcessId=$($_.ProcessId)" -eq $Filter }
    }
    function Get-Process {
        [CmdletBinding()]
        param([string]$Name, [int]$Id)
        $processes[$Id]
    }
    function Invoke-RestMethod {
        param([string]$Uri, [int]$TimeoutSec)
        Assert-That ($Uri -eq 'http://127.0.0.1:18782/health') 'Relative panel was not verified through its health endpoint.'
        return @{ service = 'dafeiyu-panel'; pid = 43223; instanceId = 'fixture-panel' }
    }
    function Stop-Process {
        [CmdletBinding()]
        param([int]$Id, [switch]$Force)
        Assert-That ($Id -in @(43222, 43223)) 'Uninstall attempted to force-stop a device worker.'
        $order.Add("stop:$Id")
        $processes.Remove($Id)
    }
    function Wait-Process {
        [CmdletBinding()]
        param([int[]]$Id, [int]$Timeout)
        if ($Id -contains 43220 -or $Id -contains 43221) {
            Assert-That ($Id -contains 43220 -and $Id -contains 43221) 'Uninstall did not wait for both device workers.'
            Assert-That ([IO.File]::ReadAllText((Join-Path $sync 'stop.request')) -eq 'stop') 'Uninstall did not request restoration before waiting.'
            $order.Add('release:sync')
            $processes.Remove(43220)
            $processes.Remove(43221)
        }
    }

    [IO.File]::WriteAllText($supervisorFile, '43220', $utf8)
    [IO.File]::WriteAllText($controllerFile, '43221', $utf8)
    [IO.File]::WriteAllText($guardFile, '{"pid":43222,"serverPid":0}', $utf8)
    [IO.File]::WriteAllText($instanceFile, (@{pid=43223; script=$panelScript; instanceId='fixture-panel'} | ConvertTo-Json), $utf8)
    $null = Invoke-Uninstall
    Assert-That (($order -join ',') -eq 'release:sync,stop:43222,stop:43223') 'Uninstall did not release sync before stopping the guard and the relative-path panel.'
    foreach ($file in @($guardFile, $instanceFile, $supervisorFile, $controllerFile)) { Remove-Item -LiteralPath $file }
}

function Assert-RestrictedCimUninstall {
    function Get-CimInstance { throw 'Simulated CIM access denied (0x80041003)' }
    $null = Invoke-Uninstall
    Assert-HarnessUnlinked

    Reset-HarnessRegistration
    $guardFile = Join-Path $state 'panel-guard.json'
    [IO.File]::WriteAllText($guardFile, '{"pid":43224}', $utf8)
    function Get-Process {
        [CmdletBinding()]
        param([string]$Name, [int]$Id)
        if ($Id -eq 43224) { @{ Id = $Id } }
    }
    function powershell.exe { throw 'Simulated native process query failure' }
    $failure = $null
    try { $null = Invoke-Uninstall } catch { $failure = $_ }
    Assert-That ($null -ne $failure) 'Uninstall accepted a live process with unverifiable ownership.'
    Assert-That ([IO.File]::ReadAllText($profileJson) -ceq $installedProfile) 'Uninstall unlinked a profile while its guard could not be verified.'
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
    $zipName = [IO.Path]::GetFileName($PackageZip)
    $expectedSum = [IO.File]::ReadAllText("$PackageZip.sha256").Trim()
    $zipHash = (Get-FileHash -LiteralPath $PackageZip -Algorithm SHA256).Hash
    Assert-That ($expectedSum -eq "$zipHash  $zipName") 'Release ZIP checksum mismatch.'
    Expand-Archive -LiteralPath $PackageZip -DestinationPath $extracted
    $manifest = [IO.File]::ReadAllLines((Join-Path $bundle 'SHA256SUMS.txt'))
    Assert-That ($manifest.Count + 1 -eq @(Get-ChildItem -LiteralPath $bundle -Force -File -Recurse).Count) 'The archive contains files outside its manifest.'
    'PASS: extracted and verified the release ZIP'
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

    Assert-DeviceWorkersExitBeforePanel
    Assert-HarnessUnlinked
    'PASS: device workers exit before the guard and relative-path panel'
    Reset-HarnessRegistration
    Assert-RestrictedCimUninstall
    'PASS: restricted CIM permits idle cleanup and preserves an unverified live guard'

    Remove-FixtureTree $module
    $originalSettings = '{"mhub":"fixture","userPreference":"keep"}'
    $originalRecord = '{"hosts":[],"previous":"keep"}'
    [IO.File]::WriteAllText($settings, $originalSettings, $utf8)
    [IO.File]::WriteAllText($record, $originalRecord, $utf8)
    [IO.File]::WriteAllText($profileJson, $originalProfile, $utf8)
    [IO.File]::WriteAllText($profilePatch, $originalPatch, $utf8)
    Assert-LockedRecordRollback ([IO.FileShare]::None)
    Assert-LockedRecordRollback ([IO.FileShare]::Read)

    # Simulate another installer changing all three host entries while pip runs.
    $pipStub = @'
import json
import os
from pathlib import Path

profile = Path(os.environ["USERPROFILE"]) / ".dsh" / "profiles" / "desktop"
manifest = profile / "package.json"
package = json.loads(manifest.read_text(encoding="utf-8"))
package["dependencies"]["concurrent-plugin"] = "2.0.0"
package["dsh"]["profile"]["bundles"].append("concurrent-plugin")
manifest.write_text(json.dumps(package), encoding="utf-8")
with (profile / "cordis.patch.yml").open("a", encoding="utf-8") as patch:
    patch.write("- id: concurrent-plugin\n  name: concurrent-plugin\n")
'@
    [IO.File]::WriteAllText((Join-Path $env:PYTHONPATH 'pip.py'), $pipStub, $utf8)
    $null = & $install -PythonPath $PythonPath -MhubPath $mhub -LinkHarness
    $concurrentPackage = [IO.File]::ReadAllText($profileJson) | ConvertFrom-Json
    Assert-That ($concurrentPackage.dependencies.'concurrent-plugin' -eq '2.0.0') 'Installation lost a dependency added during pip.'
    Assert-That ('concurrent-plugin' -in $concurrentPackage.dsh.profile.bundles) 'Installation lost a bundle added during pip.'
    Assert-That ([IO.File]::ReadAllText($profilePatch) -match '(?m)^- id: concurrent-plugin\r?$') 'Installation lost a patch added during pip.'
    'PASS: installation preserves Harness configuration added during dependency preparation'

    $null = Invoke-Uninstall
    $conflictingStub = $pipStub.Replace('concurrent-plugin', 'dsh-mhub-community-v11')
    [IO.File]::WriteAllText((Join-Path $env:PYTHONPATH 'pip.py'), $conflictingStub, $utf8)
    $failure = $null
    try { $null = & $install -PythonPath $PythonPath -MhubPath $mhub -LinkHarness } catch { $failure = $_ }
    Assert-That ($failure.Exception.Message -like '*Existing MCHose plugin detected*') 'Installation did not reject a conflicting link added during pip.'
    $conflictingPackage = [IO.File]::ReadAllText($profileJson) | ConvertFrom-Json
    Assert-That ($conflictingPackage.dependencies.'dsh-mhub-community-v11' -eq '2.0.0') 'A conflicting installation lost its dependency.'
    Assert-That (!(Test-Path -LiteralPath $module)) 'Installer wrote a module after a conflicting link appeared.'
    'PASS: installation rejects a conflicting link added during dependency preparation'
} finally {
    $env:USERPROFILE = $oldUserProfile
    $env:PYTHONPATH = $oldPythonPath
    Remove-FixtureTree $testRoot
}
