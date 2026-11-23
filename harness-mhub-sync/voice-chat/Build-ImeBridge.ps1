$ErrorActionPreference='Stop'
$buildFile=Join-Path $PSScriptRoot ('cache/ImeBridge-build-'+[guid]::NewGuid().ToString('N')+'.exe')
Add-Type -Path (Join-Path $PSScriptRoot 'ImeBridge.cs') -ReferencedAssemblies 'System.Windows.Forms','System.Drawing','System.Web.Extensions','System.Net.Http' -OutputAssembly $buildFile -OutputType WindowsApplication
Move-Item -LiteralPath $buildFile -Destination (Join-Path $PSScriptRoot 'ImeBridge.exe') -Force
