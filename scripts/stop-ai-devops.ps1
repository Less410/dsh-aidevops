$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path (Join-Path $projectRoot "data") "server.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "No AI DevOps launch record was found." -ForegroundColor Yellow
  exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile
  Write-Host "The control plane is already stopped." -ForegroundColor Yellow
  exit 0
}

if ($process.ProcessName -ne "node") {
  throw "PID $serverPid is not the expected Node.js process. No action was taken."
}

Stop-Process -Id $serverPid
Remove-Item -LiteralPath $pidFile
Write-Host "AI DevOps control plane stopped." -ForegroundColor Green
