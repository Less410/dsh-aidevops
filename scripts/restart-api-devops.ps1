$ErrorActionPreference = "Continue"
$root = "D:\AI-DevOps"
$pidFile = Join-Path $root "data\server.pid"
$stdoutFile = Join-Path $root "data\server.stdout.log"
$stderrFile = Join-Path $root "data\server.stderr.log"

if (Test-Path -LiteralPath $pidFile) {
  $pidValue = [string](Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue)
  $pidValue = $pidValue.Trim()
  if ($pidValue -match '^\d+$') {
    $old = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    $command = [string]$old.CommandLine
    if ($old -and $command -like '*services/api/dist/index.js*') {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
    }
  }
}

$process = Start-Process -FilePath (Join-Path $root "runtime\node\node.exe") `
  -ArgumentList "services/api/dist/index.js" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutFile `
  -RedirectStandardError $stderrFile `
  -PassThru
$process.Id | Out-File -Encoding ascii $pidFile
Write-Output "NEW_PID=$($process.Id)"
