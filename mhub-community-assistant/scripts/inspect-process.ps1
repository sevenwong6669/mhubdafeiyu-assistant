param([int]$TargetId)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FishProcessQuery {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int kind,IntPtr data,int size,out int needed);
 public static string Command(int pid) {
  IntPtr handle=OpenProcess(0x1000,false,pid);
  if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  IntPtr buffer=IntPtr.Zero;
  try {
   int size;NtQueryInformationProcess(handle,60,IntPtr.Zero,0,out size);
   if(size<=0||size>1048576)throw new Exception("Command metadata unavailable");
   buffer=Marshal.AllocHGlobal(size);
   if(NtQueryInformationProcess(handle,60,buffer,size,out size)!=0)throw new Exception("Command query denied");
   int length=(ushort)Marshal.ReadInt16(buffer);
   IntPtr text=Marshal.ReadIntPtr(buffer,IntPtr.Size==8?8:4);
   return Marshal.PtrToStringUni(text,length/2);
  }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);CloseHandle(handle);}
 }
}
"@
try {$target=Get-Process -Id $TargetId -ErrorAction Stop} catch { exit 0 }
@{pid=$TargetId;name=$target.ProcessName+'.exe';command=[FishProcessQuery]::Command($TargetId);startedAt=([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress
