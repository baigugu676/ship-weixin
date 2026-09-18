# 启动 Neo4j 容器（Community 5.x）
# 数据持久化到项目目录 data/neo4j，方便离线迁移

param(
    [string]$Neo4jPassword = "neo4j1234"
)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataDir = "$ProjectRoot\data\neo4j"
$DataData = "$DataDir\data"
$DataLogs = "$DataDir\logs"
$DataImport = "$DataDir\import"
$DataConf = "$DataDir\conf"

# 确保目录存在
New-Item -ItemType Directory -Path $DataData -Force | Out-Null
New-Item -ItemType Directory -Path $DataLogs -Force | Out-Null
New-Item -ItemType Directory -Path $DataImport -Force | Out-Null
New-Item -ItemType Directory -Path $DataConf -Force | Out-Null

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  启动 Neo4j (Community 5.x) Docker 容器" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "数据目录: $DataDir" -ForegroundColor Gray
Write-Host "Bolt 端口: 7687" -ForegroundColor Gray
Write-Host "HTTP 端口: 7474 (浏览器访问 http://localhost:7474)" -ForegroundColor Gray
Write-Host "用户名 : neo4j" -ForegroundColor Gray
Write-Host "密码   : $Neo4jPassword" -ForegroundColor Gray
Write-Host "==================================================" -ForegroundColor Cyan

# 检查是否已有同名容器
$existing = docker ps -a --format "{{.Names}}" | Select-String "^neo4j-rag$"
if ($existing) {
    Write-Host "检测到已有 neo4j-rag 容器，先停止并移除..." -ForegroundColor Yellow
    docker stop neo4j-rag 2>$null | Out-Null
    docker rm neo4j-rag 2>$null | Out-Null
}

docker run -d `
  --name neo4j-rag `
  --restart unless-stopped `
  -p 7474:7474 `
  -p 7687:7687 `
  -v "${DataData}:/data" `
  -v "${DataLogs}:/logs" `
  -v "${DataImport}:/var/lib/neo4j/import" `
  -v "${DataConf}:/conf" `
  -e NEO4J_AUTH=neo4j/${Neo4jPassword} `
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT=yes `
  -e NEO4J_dbms_default__database=neo4j `
  neo4j:5-community

if ($LASTEXITCODE -ne 0) {
    Write-Host "启动失败，请检查 Docker 是否正常运行。" -ForegroundColor Red
    exit 1
}

Write-Host "容器已启动，正在等待服务就绪..." -ForegroundColor Green

# 等待 Neo4j Bolt 端口可用
$maxWait = 60
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
    Write-Host "." -NoNewline -ForegroundColor Gray
}

if ($waited -ge $maxWait) {
    Write-Host "`n等待超时，但容器可能仍在启动中，请稍后手动检查。" -ForegroundColor Yellow
}

Write-Host "`n访问方式:" -ForegroundColor Cyan
Write-Host "  - 浏览器: http://localhost:7474 (默认连接选 Bolt，Host: localhost:7687)" -ForegroundColor White
Write-Host "  - 项目连接地址: bolt://localhost:7687" -ForegroundColor White
