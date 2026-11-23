param([Parameter(Mandatory=$true)][int]$ParentId, [switch]$Once)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PetFullscreen {
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct Monitor { public int Size; public Rect Area, Work; public int Flags; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint options);
    [DllImport("user32.dll", EntryPoint="GetMonitorInfoW")] static extern bool GetMonitorInfo(IntPtr monitor, ref Monitor info);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attr, out Rect rect, int size);

    public static bool IsForegroundFullscreen(int ownPid) {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero || window == GetShellWindow() || IsIconic(window)) return false;
        int pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid == ownPid) return false;
        var name = new StringBuilder(64);
        GetClassName(window, name, name.Capacity);
        string kind = name.ToString();
        if (kind == "Progman" || kind == "WorkerW" || kind == "Shell_TrayWnd" || kind == "Shell_SecondaryTrayWnd") return false;
        if (IsZoomed(window) && (GetWindowLong(window, -16) & 0x00C00000) == 0x00C00000) return false;
        var monitor = new Monitor { Size = Marshal.SizeOf(typeof(Monitor)) };
        if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) return false;
        Rect rect;
        if (DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(window, out rect)) return false;
        // Match one monitor, allowing for a thin invisible resize border.
        const int tolerance = 6;
        return Math.Abs(rect.Left - monitor.Area.Left) <= tolerance &&
               Math.Abs(rect.Top - monitor.Area.Top) <= tolerance &&
               Math.Abs(rect.Right - monitor.Area.Right) <= tolerance &&
               Math.Abs(rect.Bottom - monitor.Area.Bottom) <= tolerance;
    }

    public static void UsePhysicalCoordinates() {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
    }
}
'@
[PetFullscreen]::UsePhysicalCoordinates()
$parentProcess = Get-Process -Id $ParentId
do {
    if ([PetFullscreen]::IsForegroundFullscreen($ParentId)) { [Console]::WriteLine('1') }
    else { [Console]::WriteLine('0') }
    if ($Once) { break }
    Start-Sleep -Milliseconds 300
} while (!$parentProcess.HasExited)
