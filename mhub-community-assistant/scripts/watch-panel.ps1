param([string]$NodePath)
$ErrorActionPreference = 'Stop'
$panelRoot = Split-Path $PSScriptRoot -Parent
$stateRoot = Join-Path $panelRoot 'state'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (-not $NodePath) { $NodePath = (Get-Command node.exe).Source }
$sha = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($panelRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) }
finally { $sha.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Local\DafeiyuPanel-' + $key))
$owned = $false
$panelChild = $null
$restarts = 0
$utf8 = [Text.UTF8Encoding]::new($false)
$statusPath = Join-Path $stateRoot 'panel-guard.json'
$logPath = Join-Path $stateRoot 'panel-guard.log'
function Write-GuardLog([string]$Message) {
    try { [IO.File]::AppendAllText($logPath, ((Get-Date).ToString('o') + ' ' + $Message + [Environment]::NewLine), $utf8) } catch {}
}
function Write-GuardState([string]$Phase, [int]$ServerId = 0) {
    $record = @{pid=$PID; at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); phase=$Phase; serverPid=$ServerId; restarts=$restarts}
    $tempPath = $statusPath + '.tmp'
    try {
        [IO.File]::WriteAllText($tempPath, ($record | ConvertTo-Json -Compress), $utf8)
        Move-Item -LiteralPath $tempPath -Destination $statusPath -Force
    } catch { Write-GuardLog ('Status write failed: ' + $_.Exception.Message) }
}
function Get-PanelIdentity([int]$ServerId) {
    if ($ServerId -le 0) { return $null }
    try {
        $raw = & (Join-Path $PSScriptRoot 'inspect-process.ps1') -TargetId $ServerId
        $process = if ($raw) { ($raw -join [Environment]::NewLine) | ConvertFrom-Json } else { $null }
        if (-not $process -or $process.Name -ne 'node.exe') { return $null }
        if (-not $process.command) { throw 'Cannot inspect process command' }
        $expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'start-panel.mjs'))
        $arguments = [regex]::Matches($process.command, '"([^"]+)"|(\S+)')
        if ($arguments.Count -ge 2 -and $arguments[1].Value.Trim('"') -eq $expected) { return @{pid=$ServerId; created=$process.startedAt} }
        return $null
    } catch { throw 'Cannot verify panel process identity' }
}
function Get-PanelPortOwner {
    foreach($line in (& netstat.exe -ano -p tcp)){
        if($line -match '^\s*TCP\s+127\.0\.0\.1:18782\s+\S+\s+LISTENING\s+(\d+)\s*$'){return [int]$Matches[1]}
    }
    return 0
}
function Stop-OwnedPanel($Identity) {
    $current = Get-PanelIdentity $Identity.pid
    if ($current -and $current.created -eq $Identity.created) { Stop-Process -Id $Identity.pid -ErrorAction Stop }
}
try {
    try { $owned = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { return }
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1048576) {
        Move-Item -LiteralPath $logPath -Destination ($logPath + '.previous') -Force
    }
    Write-GuardLog 'Independent panel guard started.'
    $failures = 0
    $nextStartAt = [DateTime]::MinValue
    $startedAt = [DateTime]::MinValue
    $unrecognized = $false
    while ($true) {
        try {
        $health = $null
        try { $health = Invoke-RestMethod 'http://127.0.0.1:18782/health' -TimeoutSec 2 }
        catch {}
        if ($health -and $health.service -eq 'dafeiyu-panel' -and $health.ok -eq $true) {
            $failures = 0
            if ($startedAt -ne [DateTime]::MinValue -and ((Get-Date) - $startedAt).TotalSeconds -ge 60) { $restarts = 0 }
            $verified = Get-PanelIdentity ([int]$health.pid)
            if (-not $verified) { Write-GuardState 'port-in-use'; continue }
            Write-GuardState 'running' ([int]$health.pid)
        } elseif ($health) {
            if (-not $unrecognized) { Write-GuardLog 'Port 18782 returned an unrecognized service; it will not be replaced.' }
            $unrecognized = $true
            Write-GuardState 'port-in-use'
        } else {
            $failures++
            $portOwner = Get-PanelPortOwner
            if ($portOwner -gt 0) {
                $identity = Get-PanelIdentity $portOwner
                if (-not $identity) { Write-GuardState 'port-in-use'; continue }
                if ($failures -ge 3) {
                    Write-GuardLog 'Verified old panel is unresponsive; restarting it.'
                    Stop-OwnedPanel $identity
                }
                Write-GuardState 'recovering' $portOwner
                continue
            }
            if ($panelChild -and -not $panelChild.HasExited) {
                if ($failures -ge 3 -and ((Get-Date) - $startedAt).TotalSeconds -ge 10) {
                    Write-GuardLog 'Owned panel stopped responding; restarting it.'
                    $identity = Get-PanelIdentity $panelChild.Id
                    if ($identity) { Stop-OwnedPanel $identity }
                    $null = $panelChild.WaitForExit(2000)
                }
                Write-GuardState 'recovering' $panelChild.Id
            } elseif ((Get-Date) -ge $nextStartAt) {
                $restarts++
                $delay = [Math]::Min(30, [Math]::Pow(2, [Math]::Min($restarts, 5)))
                $nextStartAt = (Get-Date).AddSeconds($delay)
                try {
                    foreach ($logName in @('panel.log', 'panel-error.log')) {
                        $oldLog = Join-Path $stateRoot $logName
                        if (Test-Path -LiteralPath $oldLog) { Copy-Item -LiteralPath $oldLog -Destination ($oldLog + '.previous') -Force }
                    }
                    $panelChild = Start-Process -FilePath $NodePath -ArgumentList @('"' + (Join-Path $PSScriptRoot 'start-panel.mjs') + '"') -WorkingDirectory $panelRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateRoot 'panel.log') -RedirectStandardError (Join-Path $stateRoot 'panel-error.log') -PassThru
                    $startedAt = Get-Date
                    $failures = 0
                    Write-GuardLog ('Panel started; pid=' + $panelChild.Id)
                    Write-GuardState 'starting' $panelChild.Id
                } catch {
                    Write-GuardLog ('Panel start failed: ' + $_.Exception.Message)
                    Write-GuardState 'retrying'
                }
            } else { Write-GuardState 'retrying' }
        }
        } catch {
            Write-GuardLog ('Guard iteration failed; retrying: ' + $_.Exception.Message)
            Write-GuardState 'retrying'
        } finally { Start-Sleep -Seconds 3 }
    }
} finally {
    if ($owned) { Write-GuardState 'stopped'; $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
