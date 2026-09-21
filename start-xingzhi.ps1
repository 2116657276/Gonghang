param(
    [switch]$Seed,
    [switch]$BackendOnly,
    [switch]$NoBrowser,
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-WithError([string]$Message) {
    Write-Host ""
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

function Test-TcpPort([int]$Port, [string]$HostName = "127.0.0.1") {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($connection)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Test-HttpReady([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    catch {
        return $false
    }
}

function Invoke-Pnpm([string[]]$Arguments, [string]$FailureMessage) {
    & pnpm @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError $FailureMessage
    }
}

function Stop-XingzhiDevProcesses([string]$RootPath) {
    $escapedRoot = [Regex]::Escape($RootPath)
    $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq "node.exe" -and
        $_.CommandLine -match $escapedRoot -and
        $_.CommandLine -match '(concurrently|tsx.+watch|taro.+--watch|pnpm.+(--filter|--dir).+(dev|worker|dev:h5))'
    }
    foreach ($target in $targets) {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($targets) {
        Start-Sleep -Milliseconds 800
        Write-Host "已停止 $($targets.Count) 个旧的行止开发进程。" -ForegroundColor Yellow
    }
}

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $projectDir "pnpm-workspace.yaml"))) {
    Stop-WithError "找不到 pnpm-workspace.yaml，请将脚本放在 Gonghang 仓库根目录。"
}

$serverDir = Join-Path $projectDir "xingzhi\apps\server"
$miniappDir = Join-Path $projectDir "xingzhi\apps\miniapp"
$adminWebDir = Join-Path $projectDir "xingzhi\apps\web"
$envFile = Join-Path $projectDir "xingzhi\.env"
$concurrentlyCommand = Join-Path $projectDir "node_modules\.bin\concurrently.cmd"
$serverTsxCommand = Join-Path $serverDir "node_modules\.bin\tsx.cmd"
$miniappTaroCommand = Join-Path $miniappDir "node_modules\.bin\taro.cmd"
$adminViteCommand = Join-Path $adminWebDir "node_modules\.bin\vite.cmd"

Set-Location $projectDir

Write-Host "========================================" -ForegroundColor Green
Write-Host "        行止 Xingzhi 一键启动" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "项目目录: $projectDir"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithError "未检测到 Node.js。"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Stop-WithError "未检测到 pnpm。"
}
if (-not (Test-Path $envFile)) {
    Stop-WithError "找不到 xingzhi\.env，请先从 xingzhi\.env.example 复制并填写本地配置。"
}
if (-not (Select-String -Path $envFile -Pattern '^PORT=8877\s*$' -Quiet)) {
    Stop-WithError "请在 xingzhi\.env 中设置 PORT=8877。"
}
if (-not (Select-String -Path $envFile -Pattern '^WEB_ORIGIN=http://localhost:5173\s*$' -Quiet)) {
    Stop-WithError "请在 xingzhi\.env 中设置 WEB_ORIGIN=http://localhost:5173。"
}

$databaseUrlLine = Select-String -Path $envFile -Pattern '^DATABASE_URL=(.+)$' | Select-Object -First 1
if (-not $databaseUrlLine) {
    Stop-WithError "xingzhi\.env 中缺少 DATABASE_URL。"
}
try {
    $databaseUri = [Uri]$databaseUrlLine.Matches[0].Groups[1].Value.Trim()
    $databasePort = if ($databaseUri.Port -gt 0) { $databaseUri.Port } else { 5432 }
}
catch {
    Stop-WithError "xingzhi\.env 中的 DATABASE_URL 格式不正确。"
}
if (-not (Test-TcpPort $databasePort $databaseUri.Host)) {
    Stop-WithError "无法连接 PostgreSQL ($($databaseUri.Host):$databasePort)。请先启动 PostgreSQL；如果使用 Docker Desktop，请先打开 Docker Desktop。"
}

if ($Restart) {
    Write-Step "清理旧的行止开发进程"
    Stop-XingzhiDevProcesses $projectDir
}

$dependenciesReady =
    (Test-Path $concurrentlyCommand) -and
    (Test-Path $serverTsxCommand) -and
    (Test-Path $miniappTaroCommand) -and
    (Test-Path $adminViteCommand)

if ($dependenciesReady) {
    Write-Step "依赖已就绪"
}
else {
    Write-Step "首次运行：安装项目依赖"
    Invoke-Pnpm @("install") "依赖安装失败，请查看上方第一条 pnpm 错误信息。"
}

$frontendRunning = Test-TcpPort 5173
$adminFrontendRunning = Test-TcpPort 5174
$backendRunning = Test-TcpPort 8877

if ($BackendOnly -and $backendRunning) {
    if (Test-HttpReady "http://127.0.0.1:8877/api/health") {
        Write-Step "后端已经在 http://localhost:8877 运行且数据库连接正常，无需重复启动"
        exit 0
    }
    Stop-WithError "8877 端口已有进程，但行止健康检查未通过。请使用 .\start-xingzhi.ps1 -Restart 重启。"
}

if (-not $BackendOnly) {
    if ($frontendRunning -and $adminFrontendRunning -and $backendRunning) {
        if (-not (Test-HttpReady "http://127.0.0.1:8877/api/health")) {
            Stop-WithError "行止端口已占用，但后端或数据库未就绪。请使用 .\start-xingzhi.ps1 -Restart 重启。"
        }
        Write-Step "行止已经启动，后端与数据库健康检查通过"
        if (-not $NoBrowser) {
            Start-Process "http://localhost:5173"
        }
        exit 0
    }
    if ($frontendRunning -or $adminFrontendRunning -or $backendRunning) {
        $occupiedPort = if ($frontendRunning) { "5173" } elseif ($adminFrontendRunning) { "5174" } else { "8877" }
        Stop-WithError "端口 $occupiedPort 已被其他进程占用。请先关闭之前的行止窗口，再重新运行本脚本。"
    }
}

Write-Step "执行数据库增量迁移"
Invoke-Pnpm @("db:migrate") "数据库迁移失败，请检查 PostgreSQL 和 xingzhi\.env 中的 DATABASE_URL。"

if ($Seed) {
    Write-Step "初始化本地测试数据"
    Write-Host "仅在全新的隔离测试数据库中使用 -Seed；日常启动不要添加该参数。" -ForegroundColor Yellow
    Invoke-Pnpm @("db:seed") "测试账号初始化失败。"

    & pnpm --filter @xingzhi/server db:seed:consumer-finance
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[WARN] A00 资金样例未写入。现有账户或预算受保护，不会被脚本覆盖；项目仍将继续启动。" -ForegroundColor Yellow
    }
}

if ($BackendOnly) {
    Write-Step "启动后端 Server"
    Write-Host "后端地址: http://localhost:8877" -ForegroundColor Green
    Write-Host "按 Ctrl+C 停止服务。" -ForegroundColor Yellow
    & pnpm --dir $serverDir dev
    exit $LASTEXITCODE
}

Write-Step "启动行止（Server / Worker / 消费者端 / 管理端 / 微信小程序编译）"
Write-Host "消费者端: http://localhost:5173" -ForegroundColor Green
Write-Host "商户/审核端: http://localhost:5174" -ForegroundColor Green
Write-Host "后端地址: http://localhost:8877" -ForegroundColor Green
Write-Host "微信产物: xingzhi\apps\miniapp\dist\weapp" -ForegroundColor Green
Write-Host "测试账号: consumer-a@xingzhi.local" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止全部服务。" -ForegroundColor Yellow

if (-not $NoBrowser) {
    Write-Host "页面就绪后会自动打开默认浏览器。" -ForegroundColor Yellow
$browserOpener = @'
$url = "http://localhost:5173"
$healthUrl = "http://127.0.0.1:8877/api/health"
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1
        $health = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500 -and $health.StatusCode -eq 200) {
            Start-Process $url
            exit 0
        }
    }
    catch {
        Start-Sleep -Seconds 1
    }
}
'@
    $encodedOpener = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($browserOpener))
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", $encodedOpener) `
        -WindowStyle Hidden
}

$serverCommand = "pnpm --dir `"$serverDir`" dev"
$workerCommand = "pnpm --dir `"$serverDir`" worker"
$miniappCommand = "pnpm --dir `"$miniappDir`" dev:h5"
$weappCommand = "pnpm --dir `"$miniappDir`" dev:weapp"
$adminWebCommand = "pnpm --dir `"$adminWebDir`" dev"
$env:TARO_APP_API_BASE = "http://127.0.0.1:8877"

& $concurrentlyCommand `
    --names "server,worker,h5,admin,weapp" `
    --prefix-colors "green,yellow,cyan,blue,magenta" `
    --kill-others-on-fail `
    $serverCommand `
    $workerCommand `
    $miniappCommand `
    $adminWebCommand `
    $weappCommand
