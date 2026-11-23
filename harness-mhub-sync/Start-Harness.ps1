$ErrorActionPreference = 'Stop'
$nodeProgram = (Get-Command node.exe).Source
& $nodeProgram (Join-Path $PSScriptRoot 'startup.mjs')
exit $LASTEXITCODE
