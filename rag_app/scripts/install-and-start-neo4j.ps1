# Neo4j Community Edition Windows 快速安装与启动指南
# 由于 Docker Desktop 无法启动，改用 Windows 本地版 Neo4j

param(
    [string]$Neo4jPassword = "neo4j1234"
)

$ErrorActionPreference = "Stop"

# 1. 配置路径
$Neo4jVersion = "5.24.2"
$Neo4jZipUrl = "https://neo4j.com/artifact.php?name=neo4j-community-$Neo4jVersion-windows.zip"
$InstallDir = "D:\29\rag_app\data\neo4j-ce"
$ZipFile = "$InstallDir\neo4j-community-$Neo4jVersion-windows.zip"
$Neo4jHome = "$InstallDir\neo4j-community-$Neo4jVersion"
$DataDir = "$InstallDir\data"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Neo4j Community $Neo4jVersion Windows 本地安装" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# 2. 检查是否已安装
if (Test-Path "$Neo4jHome\bin\neo4j.bat") {
    Write-Host "检测到已安装 Neo4j，跳过下载。" -ForegroundColor Green
} else {
    Write-Host "开始下载 Neo4j Community $Neo4jVersion..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    # 使用 PowerShell 下载
    try {
        Invoke-WebRequest -Uri $Neo4jZipUrl -OutFile $ZipFile -MaximumRedirection 10
    } catch {
        Write-Host "下载失败，请手动访问以下链接下载：" -ForegroundColor Red
        Write-Host "https://neo4j.com/download-center/#community" -ForegroundColor White
        Write-Host "下载后解压到: $InstallDir" -ForegroundColor White
        exit 1
    }

    Write-Host "下载完成，正在解压..." -ForegroundColor Green
    Expand-Archive -Path $ZipFile -DestinationPath $InstallDir -Force
    Remove-Item $ZipFile
}

# 3. 设置环境变量（当前进程）
$env:NEO4J_HOME = $Neo4jHome
$env:PATH = "$Neo4jHome\bin;" + $env:PATH

# 4. 修改初始密码（Neo4j 5.x 首次启动要求改密码）
$AuthFile = "$Neo4jHome\data\dbms\auth.ini"
$InitialPasswordFile = "$Neo4jHome\data\dbms\auth.ini.initial_password_changed"
if (-not (Test-Path $InitialPasswordFile)) {
    Write-Host "设置 Neo4j 初始密码..." -ForegroundColor Yellow
    # Neo4j 5.x 默认密码是 neo4j，首次登录必须修改
    # 这里使用 neo4j-admin set-initial-password 命令
    & "$Neo4jHome\bin\neo4j-admin.bat" dbms set-initial-password $Neo4jPassword 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "密码设置命令执行失败（可能已设置过，不影响启动）" -ForegroundColor Gray
    }
    New-Item -ItemType File -Path $InitialPasswordFile -Force | Out-Null
}

# 5. 启动 Neo4j
Write-Host "正在启动 Neo4j..." -ForegroundColor Green
& "$Neo4jHome\bin\neo4j.bat" start

if ($LASTEXITCODE -ne 0) {
    Write-Host "启动失败，尝试用 console 模式查看详细错误..." -ForegroundColor Red
    & "$Neo4jHome\bin\neo4j.bat" console
    exit 1
}

# 6. 等待端口就绪
Write-Host "等待 Bolt 端口 7687 就绪..." -ForegroundColor Gray
$maxWait = 30
$waited = 0
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 2
    $waited += 2
    try {
        $conn = Test-NetConnection -ComputerName localhost -Port 7687 -WarningAction SilentlyContinue
        if ($conn.TcpTestSucceeded) {
            Write-Host "Neo4j 已就绪！($waited 秒)" -ForegroundColor Green
            break
        }
    } catch {}
}

if ($waited -ge $maxWait) {
    Write-Host "等待超时，但服务可能仍在启动中。" -ForegroundColor Yellow
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Neo4j 启动完成" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "浏览器控制台: http://localhost:7474" -ForegroundColor White
Write-Host "Bolt 连接  : bolt://localhost:7687" -ForegroundColor White
Write-Host "用户名    : neo4j" -ForegroundColor White
Write-Host "密码      : $Neo4jPassword" -ForegroundColor White
Write-Host "安装目录  : $Neo4jHome" -ForegroundColor White
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "项目 .env 已配置为上述连接参数。" -ForegroundColor Gray
Write-Host "停止命令  : & '$Neo4jHome\bin\neo4j.bat' stop" -ForegroundColor Gray
