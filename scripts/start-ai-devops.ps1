param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectRoot "data"
$runtimeDirectory = Join-Path $projectRoot "runtime"
$nodeDirectory = Join-Path $runtimeDirectory "node"
$nodeExecutable = Join-Path $nodeDirectory "node.exe"
$npmToolsDirectory = Join-Path $runtimeDirectory "npm-tools"
$pnpmExecutable = Join-Path $npmToolsDirectory "pnpm.cmd"
$pidFile = Join-Path $dataDirectory "server.pid"
$stdoutFile = Join-Path $dataDirectory "server.stdout.log"
$stderrFile = Join-Path $dataDirectory "server.stderr.log"
$localUrl = "http://127.0.0.1:8787"
$healthUrl = "$localUrl/api/health"

Set-Location -LiteralPath $projectRoot

function Test-ControlPlane {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    return $response.status -eq "ok"
  } catch {
    return $false
  }
}

function Get-PortOwner {
  param([int]$Port)
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) {
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener.OwningProcess) -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    Id = $listener.OwningProcess
    Name = $process.Name
    CommandLine = $process.CommandLine
  }
}

function New-RandomSecret {
  param([int]$ByteLength)
  $bytes = New-Object byte[] $ByteLength
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Write-Utf8WithoutBom {
  param(
    [string]$Path,
    [string]$Content
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Resolve-NodeExecutable {
  if (Test-Path -LiteralPath $nodeExecutable) {
    return (Resolve-Path -LiteralPath $nodeExecutable).Path
  }
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) {
    return $systemNode.Source
  }
  return $null
}

function Resolve-PnpmExecutable {
  if (Test-Path -LiteralPath $pnpmExecutable) {
    return (Resolve-Path -LiteralPath $pnpmExecutable).Path
  }
  $systemPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($systemPnpm) {
    return $systemPnpm.Source
  }
  if (-not (Test-Path -LiteralPath (Join-Path $nodeDirectory "npm.cmd"))) {
    throw "Project-local Node runtime is incomplete. Check runtime\node\npm.cmd."
  }
  Write-Host "First run: preparing project-local pnpm on the D drive..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $npmToolsDirectory -Force | Out-Null
  $env:npm_config_cache = Join-Path $runtimeDirectory "npm-cache"
  & (Join-Path $nodeDirectory "npm.cmd") install --global --prefix $npmToolsDirectory "pnpm@11.19.0"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to prepare project-local pnpm."
  }
  if (-not (Test-Path -LiteralPath $pnpmExecutable)) {
    throw "Project-local pnpm was not created as expected."
  }
  return (Resolve-Path -LiteralPath $pnpmExecutable).Path
}

$nodeExe = Resolve-NodeExecutable
if (-not $nodeExe) {
  throw "Node.js was not found. Install Node.js 22.12 or newer."
}

$resolvedNodeDirectory = Split-Path -Parent $nodeExe
$env:PATH = "$resolvedNodeDirectory;$env:PATH"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".env"))) {
  Copy-Item -LiteralPath (Join-Path $projectRoot ".env.example") -Destination (Join-Path $projectRoot ".env")
}

$envPath = Join-Path $projectRoot ".env"
$envText = [System.IO.File]::ReadAllText($envPath)
$generatedPassword = $null
if ($envText -match "(?m)^ADMIN_PASSWORD=(ChangeMe123!|replace-with-a-strong-password)?\s*$") {
  $generatedPassword = "Adm-" + (New-RandomSecret -ByteLength 18)
  $generatedJwtSecret = New-RandomSecret -ByteLength 48
  $envText = $envText -replace "(?m)^ADMIN_PASSWORD=.*$", "ADMIN_PASSWORD=$generatedPassword"
  $envText = $envText -replace "(?m)^JWT_SECRET=.*$", "JWT_SECRET=$generatedJwtSecret"
  Write-Utf8WithoutBom -Path $envPath -Content $envText
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
  Write-Host "First run: installing dependencies..." -ForegroundColor Cyan
  $pnpmExecutablePath = Resolve-PnpmExecutable
  & $pnpmExecutablePath install
  if ($LASTEXITCODE -ne 0) {
    throw "Dependency installation failed."
  }
}

$builtApi = Join-Path $projectRoot "services\api\dist\index.js"
$builtWeb = Join-Path $projectRoot "apps\web\dist\index.html"
if (-not (Test-Path -LiteralPath $builtApi) -or -not (Test-Path -LiteralPath $builtWeb)) {
  Write-Host "First run: building the control plane..." -ForegroundColor Cyan
  $pnpmExecutablePath = Resolve-PnpmExecutable
  & $pnpmExecutablePath build
  if ($LASTEXITCODE -ne 0) {
    throw "Production build failed."
  }
}

if (-not (Test-Path -LiteralPath $dataDirectory)) {
  New-Item -ItemType Directory -Path $dataDirectory | Out-Null
}

if (-not (Test-ControlPlane)) {
  # A different program on 127.0.0.1:8787 makes every health check fail while the
  # control plane cannot claim the port; report the real cause instead of a timeout.
  $portOwner = Get-PortOwner -Port 8787
  if ($portOwner -and $portOwner.CommandLine -notlike "*services\api\dist\index.js*") {
    Write-Host "Port 8787 is already used by another program:" -ForegroundColor Red
    Write-Host ("  PID " + $portOwner.Id + " · " + $portOwner.Name) -ForegroundColor DarkGray
    if ($portOwner.CommandLine) {
      Write-Host ("  " + $portOwner.CommandLine) -ForegroundColor DarkGray
    }
    Write-Host "Stop that program (or let it listen on another port), then run this script again." -ForegroundColor Yellow
    throw ("Port 8787 is occupied by PID " + $portOwner.Id + "; AI DevOps cannot start.")
  }
  if ($portOwner) {
    throw ("AI DevOps is already listening on port 8787 (PID " + $portOwner.Id + ") but the health check failed. Check data\server.stderr.log.")
  }
  Write-Host "Starting the AI DevOps control plane..." -ForegroundColor Cyan
  $serverProcess = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList "services/api/dist/index.js" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru
  Set-Content -LiteralPath $pidFile -Value $serverProcess.Id -Encoding ascii

  $started = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 400
    if (Test-ControlPlane) {
      $started = $true
      break
    }
  }
  if (-not $started) {
    throw "The control plane did not start in time. Check data\server.stderr.log."
  }
} elseif (-not (Test-Path -LiteralPath $pidFile)) {
  $listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($owner -and $owner.ProcessName -eq "node") {
      Set-Content -LiteralPath $pidFile -Value $owner.Id -Encoding ascii
    }
  }
}

$lanAddresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.PrefixOrigin -ne "WellKnown"
  } |
  Select-Object -ExpandProperty IPAddress -Unique

Write-Host ""
Write-Host "AI DevOps is running" -ForegroundColor Green
Write-Host "Local URL: $localUrl"
foreach ($address in $lanAddresses) {
  Write-Host "LAN URL:   http://${address}:8787"
}
Write-Host ""
if ($generatedPassword) {
  Write-Host "Initial admin account: admin@aidevops.local" -ForegroundColor Yellow
  Write-Host "Initial admin password: $generatedPassword" -ForegroundColor Yellow
  Write-Host "The credential is stored only in the local .env file." -ForegroundColor Yellow
  Write-Host ""
}
Write-Host "Allow inbound TCP 8787 in Windows Firewall before accessing from another PC." -ForegroundColor DarkGray
Write-Host "Demo mode is active. Production runs remain simulated." -ForegroundColor DarkGray

if (-not $NoBrowser) {
  Start-Process $localUrl
}

