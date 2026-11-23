function New-HarnessStartupBody([string]$Target) {
 $quotedTarget = $Target.Replace('"','""')
 $quotedCommand = ('"'+$Target+'"').Replace('"','""')
 $lines = @(
  "' Dafeiyu managed Harness startup"
  'Set taskFiles = CreateObject("Scripting.FileSystemObject")'
  ('taskTarget = "'+$quotedTarget+'"')
  'For taskAttempt = 1 To 30'
  '  If taskFiles.FileExists(taskTarget) Then'
  ('    CreateObject("WScript.Shell").Run "'+$quotedCommand+'", 0, False')
  '    WScript.Quit 0'
  '  End If'
  '  WScript.Sleep 2000'
  'Next'
  'WScript.Quit 1'
 )
 return ($lines -join [Environment]::NewLine)+[Environment]::NewLine
}
