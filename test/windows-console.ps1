param([Parameter(Mandatory)][string]$Entry, [Parameter(Mandatory)][string]$NodePath, [Parameter(Mandatory)][string]$AgentHome)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Linq;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
public static class JevConsoleProbe {
  delegate bool WindowCallback(IntPtr window, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  static ConcurrentDictionary<long,byte> seen = new ConcurrentDictionary<long,byte>();
  public static ConcurrentDictionary<long,string> Owners = new ConcurrentDictionary<long,string>();
  static System.Threading.Timer timer;
  public static long[] Snapshot() {
    var windows = new System.Collections.Generic.List<long>();
    EnumWindows((w,p) => {
      if (IsWindowVisible(w)) {
        var name = new StringBuilder(256); GetClassName(w,name,name.Capacity);
        if (name.ToString() == "ConsoleWindowClass" || name.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") {
          windows.Add(w.ToInt64()); uint pid; GetWindowThreadProcessId(w,out pid);
          try { Owners.TryAdd(w.ToInt64(), System.Diagnostics.Process.GetProcessById((int)pid).ProcessName + ":" + pid); } catch {}
        }
      }
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static void Start() { timer = new System.Threading.Timer(_ => { foreach(var w in Snapshot()) seen.TryAdd(w,0); },null,0,10); }
  public static long[] Stop() { timer.Dispose(); return seen.Keys.ToArray(); }
}
'@
function Invoke-Agent([string[]]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $NodePath
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['JEV_AGENT_HOME'] = $AgentHome
  $info.EnvironmentVariables['JEV_API_KEY'] = ''
  $info.EnvironmentVariables['TYPESAFE_API_KEY'] = ''
  # These arguments are fixed commands and file paths (no JSON or trailing separators).
  $info.Arguments = ((@($Entry, '--agent', 'console-check') + $Arguments) | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
  $child = [Diagnostics.Process]::Start($info)
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  if (-not $child.WaitForExit(40000)) { $child.Kill(); throw 'Agent command timed out.' }
  if ($child.ExitCode -ne 0) { throw "Agent command failed: $($stdout.Result) $($stderr.Result)" }
  return ($stdout.Result | ConvertFrom-Json)
}
$before = @([JevConsoleProbe]::Snapshot())
[JevConsoleProbe]::Start()
try {
  $opened = Invoke-Agent -Arguments @('open')
  $health = Invoke-Agent -Arguments @('call', 'health')
  $snapshot = Invoke-Agent -Arguments @('snapshot')
} finally {
  try { $closed = Invoke-Agent -Arguments @('close') } finally { $seen = @([JevConsoleProbe]::Stop()) }
}
$newWindows = @($seen | Where-Object { $_ -notin $before })
@{newVisibleConsoleWindows=$newWindows.Count;windowOwners=@($newWindows | ForEach-Object { [JevConsoleProbe]::Owners[$_] });opened=$opened.ok;healthy=$health.ok;snapshot=$snapshot.ok;closed=$closed.ok} | ConvertTo-Json -Compress
if ($newWindows.Count -gt 0) { exit 1 }
