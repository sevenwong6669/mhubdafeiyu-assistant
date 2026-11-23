param([Parameter(Mandatory=$true)][int]$ParentId)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FishKeys {
 [StructLayout(LayoutKind.Sequential)] public struct MSG {public IntPtr hwnd;public uint message;public UIntPtr wParam;public IntPtr lParam;public uint time;public int x;public int y;public uint extra;}
 [DllImport("user32.dll",SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hwnd,int id,uint mods,uint key);
 [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hwnd,int id);
 [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG msg,IntPtr hwnd,uint min,uint max,uint remove);
 delegate IntPtr KeyboardHook(int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int type,KeyboardHook callback,IntPtr module,uint thread);
 [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("kernel32.dll",CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 static readonly KeyboardHook callback=OnKey;
 static readonly bool[] down=new bool[12];
 static readonly bool[] suppressed=new bool[12];
 static IntPtr hook;
 static int next,completed,last,started,mouseSweepUntil;
 static bool markerDown;
 public static bool ShortcutCapture;
 public static int SweepProgress {get{return next;}}
 public static int SweepLastKey {get;private set;}
 public static int SweepCount {get;private set;}
 public static string SweepReset {get;private set;}
 public static bool StartSweep(){hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);return hook!=IntPtr.Zero;}
 public static void StopSweep(){if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);hook=IntPtr.Zero;}
 public static bool TakeSweep(){if(completed==0)return false;completed=0;return true;}
 // Pure event logic is also exercised without installing a Windows hook.
 public static bool ProcessSweep(int key,int msg,int flags,int modifiers,int now){
   if(ShortcutCapture){next=completed=mouseSweepUntil=0;markerDown=false;Array.Clear(down,0,down.Length);Array.Clear(suppressed,0,suppressed.Length);return false;}
   int index=key-112;
   bool released=msg==0x101||msg==0x105,pressed=msg==0x100||msg==0x104;
   if(!released&&!pressed)return false;
   // The board's Ctrl+Shift+Alt+F12 prefix identifies the F1–F12 macro.
   // Swallow its function keys so an active browser or editor cannot act on them.
   if(key==123&&pressed&&(modifiers&7)==7){
    mouseSweepUntil=unchecked(now+2000);markerDown=true;next=0;return true;
   }
   if(key==123&&released&&markerDown){markerDown=false;return true;}
   bool mouseSweep=mouseSweepUntil!=0&&unchecked(mouseSweepUntil-now)>0;
   if(!mouseSweep)mouseSweepUntil=0;
   if(released){if(index>=0&&index<12){down[index]=false;bool consumed=suppressed[index]||mouseSweep;suppressed[index]=false;if(index==11)mouseSweepUntil=0;return consumed;}}
   else if(pressed){
    if(index<0||index>=12){next=0;SweepReset="other-key";}
    else if(!down[index]){
     SweepLastKey=index+1;
     down[index]=true;
     // F10 produces WM_SYSKEYDOWN even without Alt. Only actual modifier
     // state / LLKHF_ALTDOWN can establish a modified function key.
     bool modified=modifiers!=0||(flags&0x20)!=0;
     if(modified){next=0;SweepReset="modifier";}
     else if(index==0){next=1;last=started=now;SweepReset=null;}
     else if(index==next&&unchecked(now-last)<=1500&&unchecked(now-started)<=15000){
      suppressed[index]=true;next++;last=now;
      if(next==12){completed=1;SweepCount++;next=0;SweepReset=null;}
     }else{SweepReset=next==0||index!=next?"out-of-order":"timeout";next=0;}
    }
   }
   if(index>=0&&index<12){if(mouseSweep)suppressed[index]=true;return suppressed[index];}
   return false;
 }
 static IntPtr OnKey(int code,IntPtr message,IntPtr data){
  if(code>=0){
   int modifiers=(GetAsyncKeyState(17)<0?1:0)|(GetAsyncKeyState(18)<0?2:0)|(GetAsyncKeyState(16)<0?4:0)|((GetAsyncKeyState(91)<0||GetAsyncKeyState(92)<0)?8:0);
   if(ProcessSweep(Marshal.ReadInt32(data),message.ToInt32(),Marshal.ReadInt32(data,8),modifiers,Environment.TickCount))return new IntPtr(1);
  }
  return CallNextHookEx(hook,code,message,data);
 }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint size;public uint tick;}
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct MONITOR {public uint size;public RECT monitor;public RECT work;public uint flags;}
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref INPUT info);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window,int index);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr monitor,ref MONITOR info);
 public static uint IdleMilliseconds(){var i=new INPUT{size=8};return GetLastInputInfo(ref i)?unchecked((uint)Environment.TickCount-i.tick):uint.MaxValue;}
 public static bool Fullscreen(){var h=GetForegroundWindow();if(h==IntPtr.Zero)return true;if((GetWindowLong(h,-16)&0xC00000)!=0)return false;RECT r;var m=new MONITOR{size=(uint)Marshal.SizeOf(typeof(MONITOR))};if(!GetWindowRect(h,out r)||!GetMonitorInfo(MonitorFromWindow(h,2),ref m))return true;return r.left<=m.monitor.left&&r.top<=m.monitor.top&&r.right>=m.monitor.right&&r.bottom>=m.monitor.bottom;}
}
'@
$utf8=New-Object Text.UTF8Encoding($false)
$status=Join-Path $PSScriptRoot 'pet-hotkey-status.json'
$configFile=Join-Path $PSScriptRoot 'hotkeys.settings.json'
$gameFile=Join-Path $PSScriptRoot 'game-keys.request'
$inbox=Join-Path $PSScriptRoot 'interaction-inbox'
$null=New-Item -ItemType Directory -Path $inbox -Force
$defaults=@{pet='Ctrl+Alt+F9';gameToggle='Ctrl+Alt+G';gameReplay='Ctrl+Alt+R';color1='Ctrl+Alt+1';color2='Ctrl+Alt+2';color3='Ctrl+Alt+3';color4='Ctrl+Alt+4';mouseFrontAction='game-toggle';mouseRearAction='pet'}
$script:registered=@();$script:actions=@{};$script:unavailableChords=@()
$current=$defaults.Clone();$appliedVersion=$null;$requestedVersion=$null;$configError=$null
$lastRead=0L;$lastStatus=0L;$lastMode=$null;$nextRetry=0L;$sequence=0
$captureFile=Join-Path $PSScriptRoot 'shortcut-capture.json'
$captureId=$null;$lastCaptureRead=0L
function Add-Spec($list,$chord,$kind,$value){
 $pieces=$chord.Split('+');$key=$pieces[-1];$mods=0x4000
 foreach($part in $pieces[0..($pieces.Length-2)]){switch($part){'Ctrl'{$mods=$mods -bor 2};'Alt'{$mods=$mods -bor 1};'Shift'{$mods=$mods -bor 4};default{throw 'Invalid shortcut modifier'}}}
 $vk=if($key -match '^F([1-9]|1\d|2[0-4])$'){0x6F+[int]$Matches[1]}elseif($key -match '^[A-Z0-9]$'){[int][char]$key}else{throw 'Invalid shortcut key'}
 $old=@($list | Where-Object {$_.chord -eq $chord})
 if($old.Count){if($old[0].kind -ne $kind -or $old[0].value -ne $value){throw ('Shortcut conflict: '+$chord)};return}
 $list.Add(@{chord=$chord;mods=$mods;vk=$vk;kind=$kind;value=$value})
}
function Specs($settings,$mode,$probeAll){
 $list=New-Object 'System.Collections.Generic.List[object]'
 Add-Spec $list 'Ctrl+Alt+G' $settings.mouseFrontAction 0
 Add-Spec $list 'Ctrl+Alt+F9' $settings.mouseRearAction 0
 Add-Spec $list $settings.pet 'pet' 0
 Add-Spec $list $settings.gameToggle 'game-toggle' 0
 if($mode -or $probeAll){
  Add-Spec $list $settings.gameReplay 'game-replay' 0
  for($i=1;$i -le 4;$i++){Add-Spec $list $settings[('color'+$i)] 'color' ($i-1)}
 }
 return ,($list.ToArray())
}
function Set-Bindings($wanted,[switch]$RequireAll){
 $kept=@{};$created=@();$missing=@()
 foreach($entry in $wanted){
  # Give each physical chord a stable Win32 ID across game phases and edits.
  $id=0x2000+(($entry.mods -band 15)*256)+$entry.vk
  if(-not $script:actions.ContainsKey($id)){
   if(-not [FishKeys]::RegisterHotKey([IntPtr]::Zero,$id,$entry.mods,$entry.vk)){
    $missing+=$entry.chord
    if($RequireAll){break}
    continue
   }
   $created+=$id
  }
  $entry.id=$id
  $kept[$id]=$entry
 }
 $script:unavailableChords=$missing
 if($RequireAll -and $missing.Count){
  foreach($id in $created){$null=[FishKeys]::UnregisterHotKey([IntPtr]::Zero,$id)}
  return $false
 }
 foreach($entry in $script:registered){
  if(-not $kept.ContainsKey($entry.id)){$null=[FishKeys]::UnregisterHotKey([IntPtr]::Zero,$entry.id)}
 }
 $script:actions=$kept
 $script:registered=@($kept.Values)
 return ($missing.Count -eq 0)
}
function Send-Event($kind,$value){
 if($kind -eq 'none'){return}
 $script:sequence++;$at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$id=[Guid]::NewGuid().ToString()
 $name=('{0:D13}-{1:D6}-{2}.json' -f $at,$script:sequence,$id);$tmp=Join-Path $inbox ($name+'.tmp')
 [IO.File]::WriteAllText($tmp,(@{id=$id;at=$at;kind=$kind;value=$value}|ConvertTo-Json -Compress),$utf8)
 Move-Item -LiteralPath $tmp -Destination (Join-Path $inbox $name)
}
try{
 $sweepReady=[FishKeys]::StartSweep()
 $msg=New-Object FishKeys+MSG
 while(Get-Process -Id $ParentId -ErrorAction SilentlyContinue){
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$mode=''
  if($now-$lastCaptureRead -gt 80){
   $lastCaptureRead=$now;$nextCapture=$null
   try{$lease=[IO.File]::ReadAllText($captureFile)|ConvertFrom-Json;if($lease.expiresAt -gt $now -and $lease.expiresAt -le ($now+6500)){$nextCapture=$lease.id}}catch{}
   if($nextCapture -ne $captureId){$captureId=$nextCapture;[FishKeys]::ShortcutCapture=[bool]$captureId;$lastMode=$null;$lastStatus=0}
  }
  if(Test-Path -LiteralPath $gameFile){try{$mode=[IO.File]::ReadAllText($gameFile).Trim()}catch{$mode='game'}}
  if(!$captureId -and $now-$lastRead -gt 350){
   $lastRead=$now;$candidate=$defaults.Clone();$version='defaults'
   if(Test-Path -LiteralPath $configFile){$parsed=[IO.File]::ReadAllText($configFile)|ConvertFrom-Json;$version=$parsed.controlVersion;foreach($key in @($defaults.Keys)){if($null -ne $parsed.$key){$candidate[$key]=$parsed.$key}}}
   if($version -ne $requestedVersion){
    $startup=($null -eq $requestedVersion)
    $requestedVersion=$version
    # A saved configuration is authoritative on boot. Only probe every game
    # chord when acknowledging a new settings edit; inactive games own none.
    if($startup -or (Set-Bindings (Specs $candidate $mode $true) -RequireAll)){
     $current=$candidate;$appliedVersion=$version;$configError=$null
    }else{$configError='Shortcut occupied: '+($script:unavailableChords -join ', ')}
    $lastMode=$null
    $lastStatus=0
   }
  }
  if($lastMode -ne $mode -or ($script:unavailableChords.Count -gt 0 -and $now -ge $nextRetry)){
   if($captureId){$null=Set-Bindings @()}else{$null=Set-Bindings (Specs $current $mode $false)}
   $lastMode=$mode;$nextRetry=$now+1500;$lastStatus=0
  }
  if($now-$lastStatus -gt 800){
   $colorKeys=@($script:registered|Where-Object {$_.kind -eq 'color'})
   $replayReady=@($script:registered|Where-Object {$_.chord -eq $current.gameReplay -and $_.kind -eq 'game-replay'}).Count -gt 0
   $bindingError=$configError
   if(-not $bindingError -and $script:unavailableChords.Count){$bindingError='Shortcut occupied: '+($script:unavailableChords -join ', ')}
   $data=@{ready=($script:registered.Count -gt 0);pid=$PID;parent=$ParentId;sweepReady=$sweepReady;sweepProgress=[FishKeys]::SweepProgress;sweepLastKey=[FishKeys]::SweepLastKey;sweepCount=[FishKeys]::SweepCount;sweepReset=[FishKeys]::SweepReset;hotkey=$current.pet;gameHotkey=$current.gameToggle;replayHotkey=$current.gameReplay;gameKeysReady=([bool]$mode -and $colorKeys.Count -eq 4);gameKeysError=([bool]$mode -and $colorKeys.Count -lt 4);gameReplayReady=$replayReady;unavailableChords=$script:unavailableChords;inputIdleMs=[FishKeys]::IdleMilliseconds();fullscreen=[FishKeys]::Fullscreen();observedAt=$now;bindings=$current;requestedVersion=$requestedVersion;appliedVersion=$appliedVersion;bindingError=$bindingError}
   $data.shortcutCaptureId=$captureId
   $tmp=$status+'.tmp';[IO.File]::WriteAllText($tmp,($data|ConvertTo-Json -Compress),$utf8)
   for($retry=0;$retry -lt 8;$retry++){try{Move-Item -LiteralPath $tmp -Destination $status -Force;break}catch{Start-Sleep -Milliseconds 25}}
   $lastStatus=$now
  }
  while([FishKeys]::PeekMessage([ref]$msg,[IntPtr]::Zero,0,0,1)){
   if(!$captureId -and $msg.message -eq 0x0312){$id=[int]$msg.wParam.ToUInt64();$entry=$script:actions[$id];if($entry){Send-Event $entry.kind $entry.value}}
  }
  if([FishKeys]::TakeSweep() -and !$mode){Send-Event 'pet-sweep' 0}
  Start-Sleep -Milliseconds 30
 }
}finally{[FishKeys]::StopSweep();foreach($entry in $script:registered){$null=[FishKeys]::UnregisterHotKey([IntPtr]::Zero,$entry.id)}}
