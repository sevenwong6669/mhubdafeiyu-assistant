param([Parameter(Mandatory=$true)][string]$HarnessPath)
$ErrorActionPreference='Stop'
$panelRoot=Split-Path $PSScriptRoot -Parent
$backupRoot=Join-Path $panelRoot 'state/boot-backup'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
# One login entry: Harness loads native-host, which starts the existing panel
# guard; RuntimeResume then uses the existing single-flight M HUB startup.
& (Join-Path $PSScriptRoot 'install-harness-startup.ps1') -HarnessPath $HarnessPath
$entry=Join-Path ([Environment]::GetFolderPath('Startup')) 'DafeiyuPanel.vbs'
if(Test-Path -LiteralPath $entry){
 $body=Get-Content -LiteralPath $entry -Raw
 if($body.Contains((Join-Path $PSScriptRoot 'watch-panel.ps1'))){
  Copy-Item -LiteralPath $entry -Destination (Join-Path $backupRoot 'DafeiyuPanel.vbs') -Force
  Remove-Item -LiteralPath $entry
 }else{throw 'Unrecognized panel startup preserved; inspect it before disabling.'}
}
$task='Dafeiyu-LocalPanel-18782'
$raw=& schtasks.exe /Query /TN $task /XML 2>$null
if($LASTEXITCODE -eq 0){
 $text=$raw -join [Environment]::NewLine
 $xml=[xml]$text
 if(-not ([string]$xml.Task.Actions.Exec.Arguments).Contains((Join-Path $PSScriptRoot 'watch-panel.ps1'))){throw 'Unrecognized panel task preserved.'}
 [IO.File]::WriteAllText((Join-Path $backupRoot 'panel-task.xml'),$text,[Text.Encoding]::Unicode)
 & schtasks.exe /Change /TN $task /DISABLE | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not disable the duplicate managed panel task.'}
}
[pscustomobject]@{chain='Harness -> Dafeiyu plugin -> M HUB';standalonePanelLoginDisabled=$true;backup=$backupRoot} | ConvertTo-Json -Compress
