$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$source=Join-Path $PSScriptRoot 'CallPanel.cs'
$output=Join-Path $PSScriptRoot 'DafeiyuCall.exe'
& $compiler /nologo /target:winexe ('/out:'+$output) ('/win32manifest:'+(Join-Path $PSScriptRoot 'CallPanel.manifest')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0) {throw 'Call panel build failed'}
Write-Output $output
