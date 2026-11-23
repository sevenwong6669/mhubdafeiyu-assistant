// Windows fallback for a release swallowed by another keyboard hook.
// The worker checks only the function key for the current push-to-talk turn.
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Name Live2DKeyRelease -Namespace Native -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
    public static bool WaitForRelease(int key) {
        int up = 0;
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < 60000) {
            up = (GetAsyncKeyState(key) & 0x8000) == 0 ? up + 1 : 0;
            if (up >= 3) return true;
            System.Threading.Thread.Sleep(25);
        }
        return false;
    }
'@
while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -match '^(\d+) (11[2-9]|12[0-3])$') {
        if ([Native.Live2DKeyRelease]::WaitForRelease([int]$Matches[2])) {
            [Console]::WriteLine($Matches[1])
        }
    }
}
`

function watchFunctionKeyRelease(onRelease, log) {
  if (process.platform !== 'win32') return null
  const root = process.env.SystemRoot || 'C:\\Windows'
  const shell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const cmd = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', cmd], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = createInterface({ input: child.stdout })
  output.on('line', (line) => {
    if (/^\d+$/.test(line)) onRelease(Number(line))
  })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  child.once('error', (error) => log('耳朵：Windows 松键检测无法启动', error.message))
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    child.kill()
  }
  process.once('exit', close)
  child.once('close', (code) => {
    process.off('exit', close)
    if (!closed && code !== 0) log('耳朵：Windows 松键检测停止', code)
  })
  return {
    arm(key, turn) {
      const vk = key >= 59 && key <= 68 ? key + 53 : key === 87 ? 122 : key === 88 ? 123 : 0
      if (vk && child.stdin.writable) child.stdin.write(`${turn} ${vk}\n`)
    },
    close,
  }
}

module.exports = { watchFunctionKeyRelease }
