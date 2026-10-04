import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// libuv's non-detached children die with their parent. Detached console processes can
// summon Windows Terminal even with windowsHide. A hidden .NET launcher creates the
// persistent worker without a console or libuv's kill-on-parent-exit job assignment.
// Configuration travels over stdin; only paths are passed in the environment.
const launcher = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
public static class JevPipeReader {
  public static System.Threading.Tasks.Task<string> ReadLine(System.IO.TextReader reader) {
    return System.Threading.Tasks.Task.Factory.StartNew(() => reader.ReadLine(),
      System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning,
      System.Threading.Tasks.TaskScheduler.Default);
  }
}
'@
$utf8 = [Text.UTF8Encoding]::new($false)
$inputPipe = [IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
$outputPipe = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$outputPipe.AutoFlush = $true
$child = $null
$released = $false
try {
  $configuration = $inputPipe.ReadLine()
  if ($null -eq $configuration) { exit 1 }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $env:JEV_WORKER_NODE
  $info.Arguments = '"' + $env:JEV_WORKER_FILE + '" --stdio-bootstrap'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.StandardOutputEncoding = $utf8
  $info.EnvironmentVariables.Remove('JEV_WORKER_NODE')
  $info.EnvironmentVariables.Remove('JEV_WORKER_FILE')
  $child = [Diagnostics.Process]::Start($info)
  $bytes = $utf8.GetBytes($configuration)
  $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $child.StandardInput.BaseStream.Close()
  $control = [JevPipeReader]::ReadLine($inputPipe)
  $ready = [JevPipeReader]::ReadLine($child.StandardOutput)
  while (-not $ready.IsCompleted) {
    if ($control.IsCompleted) { exit 1 }
    Start-Sleep -Milliseconds 20
  }
  if ($null -eq $ready.Result) { exit 1 }
  $outputPipe.WriteLine($ready.Result)
  $released = $control.GetAwaiter().GetResult() -eq 'release'
} finally {
  if ($null -ne $child) {
    if (-not $released -and -not $child.HasExited) { $child.Kill() }
    $child.Dispose()
  }
}
`;

export function launchWindowsWorker() {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', launcher], {
    cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, JEV_WORKER_NODE: process.execPath, JEV_WORKER_FILE: fileURLToPath(new URL('./session-worker.js', import.meta.url)) },
  });
}
