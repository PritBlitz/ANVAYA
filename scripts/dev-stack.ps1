<#
  Runs the local Anvaya stack as independent background processes, everything from Z:.

    .\scripts\dev-stack.ps1 start     Ollama, AI service, API, worker, web, webhook relay
    .\scripts\dev-stack.ps1 status    health of each service and free memory
    .\scripts\dev-stack.ps1 stop      stops what `start` launched
    .\scripts\dev-stack.ps1 live -Task "..." -Description "..."   live governed run (real pull request)

  Build first (docs/HANDOFF.md §3). The webhook relay needs the App's smee URL in
  Z:\anvaya-cache\tmp\hook.txt and is skipped without it. Logs and PIDs go to Z:\anvaya-cache\tmp.
#>
param(
  [Parameter(Position = 0)][ValidateSet('start', 'stop', 'status', 'live', 'live-run')][string]$Action = 'status',
  [string]$Task,
  [string]$Description,
  [string]$Log = 'governed-run.log'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Frontend = Join-Path (Split-Path -Parent $Root) 'frontend\apps\web'
$Api = Join-Path $Root 'apps\api'
$Ai = Join-Path $Root 'services\ai-service'
$Tmp = 'Z:\anvaya-cache\tmp'
$PidFile = Join-Path $Tmp 'stack.pids'
$MinFreeGb = 5

$env:TEMP = $Tmp
$env:TMP = $Tmp

function Get-FreeGb { [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1) }

function Test-Url([string]$Url) {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $Url).StatusCode -eq 200 } catch { $false }
}

function Start-Service2([string]$Name, [string]$Dir, [string]$File, [string[]]$Arguments) {
  $p = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $Dir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Tmp "$Name.log") -RedirectStandardError (Join-Path $Tmp "$Name.err.log")
  Add-Content -Path $PidFile -Value "$($p.Id) $Name"
  Write-Output "started $Name ($($p.Id))"
}

function Wait-Url([string]$Name, [string]$Url, [int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $Url) { Write-Output "$Name is up"; return }
    Start-Sleep -Seconds 2
  }
  throw "$Name did not come up; see the logs in $Tmp"
}

switch ($Action) {
  'start' {
    if (Test-Path $PidFile) { throw "Already started; run stop first ($PidFile exists)." }
    $free = Get-FreeGb
    if ($free -lt $MinFreeGb) { throw "Only $free GB free; the 7B model needs about $MinFreeGb GB." }
    docker start anvaya-dev-postgres-1 anvaya-dev-redis-1 | Out-Null

    Start-Service2 'ollama' $Tmp 'wsl.exe' @('-e', 'env', 'OLLAMA_MODELS=/mnt/z/ollama/models', 'OLLAMA_HOST=127.0.0.1:11435', 'OLLAMA_MAX_LOADED_MODELS=1', 'OLLAMA_NUM_PARALLEL=1', '/usr/local/bin/ollama', 'serve')

    $env:AI_SERVICE_TOKEN = ((Get-Content (Join-Path $Api '.env') | Where-Object { $_ -match '^AI_SERVICE_TOKEN=' }) -replace '^AI_SERVICE_TOKEN=', '')
    $env:NODE_ENV = 'development'
    $env:OLLAMA_BASE_URL = 'http://127.0.0.1:11435'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    Start-Service2 'ai-service' $Ai (Join-Path $Ai '.venv\Scripts\python.exe') @('-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', '8001')
    Remove-Item Env:AI_SERVICE_TOKEN, Env:NODE_ENV

    Start-Service2 'api' $Api 'node' @('--env-file=.env', 'dist/main.js')
    Wait-Url 'API' 'http://localhost:3001/api/v1/health/live'
    Start-Service2 'worker' $Api 'node' @('--env-file=.env', 'dist/main.worker.js')

    $env:NEXT_PUBLIC_API_MODE = 'http'
    $env:ANVAYA_API_ORIGIN = 'http://localhost:3001'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    Start-Service2 'web' $Frontend 'node' @('node_modules/next/dist/bin/next', 'start', '-p', '3000')
    Wait-Url 'web' 'http://localhost:3000/api/v1/health/ready'

    $hook = Join-Path $Tmp 'hook.txt'
    if (Test-Path $hook) {
      $smee = Get-ChildItem 'Z:\anvaya-cache\npm-cache\_npx' -Recurse -Filter 'smee.js' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($smee) { Start-Service2 'smee' $Tmp 'node' @($smee.FullName, '--url', (Get-Content $hook -Raw).Trim(), '--target', 'http://localhost:3001/api/v1/webhooks/github') }
      else { Write-Output 'smee-client is not cached; run it once with npx' }
    }
    Wait-Url 'AI service' 'http://localhost:8001/health/live'
    Write-Output "free memory: $(Get-FreeGb) GB"
  }

  'stop' {
    if (-not (Test-Path $PidFile)) { Write-Output 'Nothing recorded as running.'; return }
    foreach ($line in Get-Content $PidFile) {
      $id, $name = $line -split ' ', 2
      & taskkill.exe /T /F /PID $id 2>$null | Out-Null
      Write-Output "stopped $name"
    }
    Remove-Item $PidFile
  }

  'status' {
    Write-Output "free memory: $(Get-FreeGb) GB"
    Write-Output "ollama: $(Test-Url 'http://localhost:11435/api/tags')"
    Write-Output "ai service: $(Test-Url 'http://localhost:8001/health/live')"
    Write-Output "api: $(Test-Url 'http://localhost:3001/api/v1/health/live')"
    Write-Output "web: $(Test-Url 'http://localhost:3000/api/v1/health/ready')"
  }

  'live' {
    if (-not $Task -or -not $Description) { throw 'live needs -Task and -Description.' }
    $env:LIVE_TASK = $Task
    $env:LIVE_TASK_DESCRIPTION = $Description
    $self = Join-Path $PSScriptRoot 'dev-stack.ps1'
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, 'live-run', '-Log', $Log) -WindowStyle Hidden -PassThru
    Write-Output "live run started ($($p.Id)); log: $(Join-Path $Tmp $Log)"
  }

  'live-run' {
    $out = Join-Path $Tmp $Log
    $env:PLAYWRIGHT_BROWSERS_PATH = 'Z:\anvaya-cache\ms-playwright'
    $env:LIVE_BASE_URL = 'http://localhost:3000'
    $env:LIVE_RUN = '1'
    $env:LIVE_MODE = 'local'
    $env:LIVE_WORKSPACE = 'pritblitz'
    $env:LIVE_REPO = 'PritBlitz/testRepo'
    Set-Location $Frontend
    $ErrorActionPreference = 'Continue'
    cmd /c "npx playwright test -c playwright.live.config.ts -g `"governed run`" > `"$out`" 2>&1"
    Add-Content -Path $out -Value "playwright_exit=$LASTEXITCODE"
  }
}
