$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'ImeReceiver.cs') -ReferencedAssemblies 'System.Windows.Forms','System.Drawing','System.Web.Extensions' -OutputAssembly (Join-Path $PSScriptRoot 'ImeReceiver.exe') -OutputType WindowsApplication
