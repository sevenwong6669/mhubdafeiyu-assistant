$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $root 'mhub-community-assistant/scripts/start-panel.mjs'
$address = 'http://127.0.0.1:18782'
if (!(Test-Path -LiteralPath (Join-Path $root 'runtime.settings.json') -PathType Leaf)) { throw 'Run Install.ps1 in this directory before starting the plugin.' }
& $node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(process.arch!=='x64'||major<22||(major===22&&minor<15))process.exit(1)"
if ($LASTEXITCODE) { throw 'Node.js 22.15 or later, Windows x64 build, is required.' }

function Read-Health {
    try { Invoke-RestMethod "$address/health" -TimeoutSec 2 }
    catch { return $null }
}

$health = Read-Health
if (!$health) {
    $probe = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $probe.BeginConnect('127.0.0.1',18782,$null,$null)
        if ($pending.AsyncWaitHandle.WaitOne(700) -and $probe.Connected) { throw 'Port 18782 is in use but did not return this plugin health endpoint. Keep the existing service and inspect the port owner.' }
    } catch [Net.Sockets.SocketException] {
        # No listener is the expected first-start condition.
    } finally { $probe.Dispose() }
    $guard = Join-Path $root 'mhub-community-assistant/scripts/watch-panel.ps1'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$guard`" -NodePath `"$node`""
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 500
        $health = Read-Health
    } until ($health -or (Get-Date) -ge $deadline)
}
if ($health.service -ne 'dafeiyu-panel' -or !$health.ok) { throw 'Panel did not start or port 18782 is already in use. Check the panel guard log.' }
$instanceFile = Join-Path $root 'mhub-community-assistant/state/panel-instance.json'
if (!(Test-Path -LiteralPath $instanceFile -PathType Leaf)) { throw 'Port 18782 belongs to another installation or the local instance record is missing.' }
$instance = Get-Content -LiteralPath $instanceFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($instance.instanceId -ne $health.instanceId -or $instance.script -ne $script) { throw 'Port 18782 belongs to another installation.' }
"$address/api/mhub-community/panel"
