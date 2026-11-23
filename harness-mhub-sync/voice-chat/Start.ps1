param([switch]$Automatic)
$ErrorActionPreference='Stop'
function Test-AutomaticWanted([string]$VoiceRoot=$PSScriptRoot) {
  if (-not $Automatic) { return $true }
  try {
    $syncRoot=Split-Path $VoiceRoot -Parent
    $workspaceRoot=Split-Path $syncRoot -Parent
    $intent=Get-Content -LiteralPath (Join-Path $workspaceRoot 'mhub-community-assistant/state/runtime-intent.json') -Raw | ConvertFrom-Json
    $linkPath=Join-Path $syncRoot 'device-link-mode.json'
    $linkEnabled=$true # Same legacy fallback as readDeviceLink; invalid records remain disabled.
    if(Test-Path -LiteralPath $linkPath){$link=Get-Content -LiteralPath $linkPath -Raw | ConvertFrom-Json;$linkEnabled=$link.enabled -eq $true}
    return ($intent.voice -eq $true -and $linkEnabled -and -not (Test-Path -LiteralPath (Join-Path $syncRoot 'stop.request')))
  } catch { return $false }
}
if (-not (Test-AutomaticWanted)) { return }
& (Join-Path $PSScriptRoot '../Start-Harness.ps1')
if ($LASTEXITCODE -ne 0) { throw '设备联动未启动，语音服务未启动。' }
$running=$false
try {$null=Invoke-RestMethod 'http://127.0.0.1:18780/status' -TimeoutSec 2;$running=$true} catch {}
if (-not $running) {
  $pidFile=Join-Path $PSScriptRoot 'server.pid'
  $oldVoiceId=0
  if ((Test-Path -LiteralPath $pidFile) -and [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(),[ref]$oldVoiceId)) {
    $workspaceRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $inspectScript=Join-Path $workspaceRoot 'mhub-community-assistant/scripts/inspect-process.ps1'
    $metadata=& $inspectScript -TargetId $oldVoiceId
    $oldMeta=if($metadata){($metadata -join [Environment]::NewLine)|ConvertFrom-Json}else{$null}
    $oldVoice=if($oldMeta){[pscustomobject]@{CommandLine=$oldMeta.command;ProcessId=$oldMeta.pid;Name=$oldMeta.name}}else{$null}
    if ($oldVoice -and -not $oldVoice.CommandLine) {throw 'Windows 不允许核对旧语音进程，请通过诊断入口修复。'}
    $expectedScript=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.mjs'))
    if ($oldVoice) {
      $matchesVoice=$false
      foreach ($argument in [regex]::Matches($oldVoice.CommandLine,'"[^"]*"|[^\s]+')) {
        try {if ([IO.Path]::GetFullPath($argument.Value.Trim('"')) -eq $expectedScript) {$matchesVoice=$true}} catch {}
      }
      if ($matchesVoice) {throw '旧语音服务正在退出，请稍后重试。'}
    }
  }
  $node=(Get-Command node.exe).Source
  if (-not (Test-AutomaticWanted)) { return }
  Start-Process -FilePath $node -ArgumentList @('"'+(Join-Path $PSScriptRoot 'server.mjs')+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'voice.log') -RedirectStandardError (Join-Path $PSScriptRoot 'voice.error.log') | Out-Null
}
Write-Output '语音在后台运行。后侧键短按摸摸，按住说话；松开后大肥鱼从音箱回复，字幕在音箱屏幕显示。'
