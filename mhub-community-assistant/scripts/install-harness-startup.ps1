param([string]$HarnessPath,[switch]$Remove)
$ErrorActionPreference='Stop'
$startupFile=Join-Path ([Environment]::GetFolderPath('Startup')) 'DafeiyuHarness.vbs'
$marker="' Dafeiyu managed Harness startup"
if(Test-Path -LiteralPath $startupFile){
 $previous=Get-Content -LiteralPath $startupFile -Raw
 if(-not $previous.StartsWith($marker)){throw 'A different startup entry already uses this name; it was preserved.'}
}
if($Remove){
 if(Test-Path -LiteralPath $startupFile){Remove-Item -LiteralPath $startupFile}
 [pscustomobject]@{enabled=$false;path=$startupFile}|ConvertTo-Json -Compress
 return
}
if(-not $HarnessPath){throw 'Provide the installed DeepSeek Harness.exe path.'}
$item=Get-Item -LiteralPath $HarnessPath
if($item.PSIsContainer -or $item.Name -ne 'DeepSeek Harness.exe'){throw 'Select DeepSeek Harness.exe.'}
if($item.VersionInfo.ProductName -ne 'DeepSeek Harness'){throw 'The executable is not identified as DeepSeek Harness.'}
. (Join-Path $PSScriptRoot 'harness-startup-body.ps1')
$content=New-HarnessStartupBody $item.FullName
[IO.File]::WriteAllText($startupFile,$content,[Text.Encoding]::Unicode)
[pscustomobject]@{enabled=$true;path=$startupFile;target=$item.FullName}|ConvertTo-Json -Compress
