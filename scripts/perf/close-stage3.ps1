[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$TargetPid,
      [Parameter(Mandatory=$true)][string]$ExePath,
      [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$Name='perf3', [switch]$ConfirmOnly, [long]$WindowHandle=0)
$ErrorActionPreference = 'Stop'
$row = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
if (-not $row -or $row.ExecutablePath -ne $ExePath -or $row.CommandLine -notmatch ('--profile ' + [regex]::Escape($Name) + '(?:\s|$)')) { throw "Refusing to close a process outside $Name" }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Perf3Close {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  public static uint Owner(long h) { uint owner; GetWindowThreadProcessId(new IntPtr(h),out owner); return owner; }
  public static bool OwnedWindowAlive(long h,int pid) { return IsWindow(new IntPtr(h)) && Owner(h)==(uint)pid; }
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int command);
  public static int RestoreOwnMinimized(int pid) {
    int count=0;
    EnumWindows((h,p)=>{
      uint owner; GetWindowThreadProcessId(h,out owner);
      if(owner==(uint)pid && IsIconic(h)) {
        // SW_SHOWNOACTIVATE: restore only the verified test PID, without focus.
        ShowWindowAsync(h,4); count++;
      }
      return true;
    },IntPtr.Zero);
    return count;
  }
  public static int ConfirmOwnQuit(int pid) {
    int count=0;
    EnumWindows((h,p)=>{
      uint owner; GetWindowThreadProcessId(h,out owner);
      var cls=new StringBuilder(256); GetClassName(h,cls,256);
      var title=new StringBuilder(256); GetWindowText(h,title,256);
      if(owner!=(uint)pid || !IsWindowVisible(h) || cls.ToString()!="#32770" || (title.ToString()!="mycmux \u3092\u7d42\u4e86\u3057\u307e\u3059" && title.ToString()!="\u3053\u306e\u30a6\u30a3\u30f3\u30c9\u30a6\u3092\u9589\u3058\u307e\u3059")) return true;
      EnumChildWindows(h,(button,unused)=>{
        var text=new StringBuilder(256); GetWindowText(button,text,256);
        var kind=new StringBuilder(256); GetClassName(button,kind,256);
        if(kind.ToString()=="Button" && text.ToString()=="\u9589\u3058\u308b") {
          // BM_CLICK is delivered to this test dialog only; no mouse or focus move.
          PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero); count++;
        }
        return true;
      },IntPtr.Zero);
      return true;
    },IntPtr.Zero);
    return count;
  }
}
'@
if ($ConfirmOnly) {
  if ($WindowHandle -eq 0) { throw 'ConfirmOnly requires the previously observed isolated window handle' }
  $owner = [Perf3Close]::Owner($WindowHandle)
  if ($owner -ne 0 -and $owner -ne $TargetPid) { throw 'Refusing a window owned by another process' }
  $confirmed = 0
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ([Perf3Close]::OwnedWindowAlive($WindowHandle,$TargetPid) -and $timer.Elapsed.TotalSeconds -lt 40) {
    $confirmed += [Perf3Close]::ConfirmOwnQuit($TargetPid)
    Start-Sleep -Milliseconds 100
  }
  $closed = -not [Perf3Close]::OwnedWindowAlive($WindowHandle,$TargetPid)
  [ordered]@{pid=$TargetPid; windowHandle=$WindowHandle; windowClosed=$closed; dialogButtonMessages=$confirmed; elapsedMs=$timer.Elapsed.TotalMilliseconds; method='CDP window close; PID-scoped background dialog confirmation'} | ConvertTo-Json -Compress
  if (-not $closed) { exit 1 }
  return
}
$proc = Get-Process -Id $TargetPid
$restored = [Perf3Close]::RestoreOwnMinimized($TargetPid)
if ($restored -gt 0) { Start-Sleep -Milliseconds 250; $proc.Refresh() }
$closedHandles = [Collections.Generic.HashSet[long]]::new()
[void]$closedHandles.Add($proc.MainWindowHandle.ToInt64())
$accepted = $proc.CloseMainWindow()
$confirmed = 0
$timer = [Diagnostics.Stopwatch]::StartNew()
while (-not $proc.HasExited -and $timer.Elapsed.TotalSeconds -lt 40) {
  $confirmed += [Perf3Close]::ConfirmOwnQuit($TargetPid)
  Start-Sleep -Milliseconds 100
  $proc.Refresh()
  if (-not $proc.HasExited -and $confirmed -gt 0 -and $timer.Elapsed.TotalSeconds -gt 2) {
    $handle = $proc.MainWindowHandle.ToInt64()
    if ($handle -ne 0 -and -not $closedHandles.Contains($handle)) {
      [void]$closedHandles.Add($handle)
      [void]$proc.CloseMainWindow()
    }
  }
}
[ordered]@{pid=$TargetPid; closeMainWindowAccepted=$accepted; exitedGracefully=$proc.HasExited; dialogButtonMessages=$confirmed; minimizedWindowsRestored=$restored; closeWindowHandles=@($closedHandles); elapsedMs=$timer.Elapsed.TotalMilliseconds; method='CloseMainWindow; PID-scoped background quit-dialog confirmation'} | ConvertTo-Json -Compress
if (-not $accepted -or -not $proc.HasExited) { exit 1 }
