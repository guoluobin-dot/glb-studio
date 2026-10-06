# 列出当前所有"可见且有标题"的顶层窗口，输出 JSON。
# 用来验证 spawn 子进程时会不会弹出控制台窗口 —— 黑框是可见窗口，必然被列出来。
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
}
"@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$list = New-Object System.Collections.ArrayList
$cb = [WinEnum+EnumWindowsProc] {
  param($hWnd, $lParam)
  if ([WinEnum]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinEnum]::GetWindowTextW($hWnd, $sb, 512)
    $title = $sb.ToString()
    if ($title) {
      $ownerPid = 0
      [void][WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
      [void]$list.Add([pscustomobject]@{ Title = $title; Pid = $ownerPid })
    }
  }
  return $true
}
[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)
$list | ConvertTo-Json -Compress
