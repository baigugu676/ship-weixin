# 船舶故障诊断 RAG 系统 - 一键启动脚本
# 当前配置：在线模式（ModelScope） + GPU 加速

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  船舶装备故障诊断智能问答系统 - 启动脚本" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# 1. 启动 Docker Desktop（如果未运行）
Write-Host "`n[1/4] 检查 Docker Desktop..." -ForegroundColor Yellow
try {
    docker ps >$null 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "正在启动 Docker Desktop..." -ForegroundColor Gray
        Start-Process -FilePath "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Hidden
        $waited = 0
        while ($waited -lt 120) {
            Start-Sleep 5
            $waited += 5
            docker ps >$null 2>&1
            if ($LASTEXITCODE -eq 0) { break }
        }
    }
    Write-Host "Docker 就绪" -ForegroundColor Green
} catch {
    Write-Host "Docker 检查失败，请手动启动 Docker Desktop" -ForegroundColor Red
}

# 2. 启动 Neo4j
Write-Host "`n[2/4] 启动 Neo4j..." -ForegroundColor Yellow
docker start neo4j-rag 2>$null
if ($?) {
    Write-Host "Neo4j 已启动" -ForegroundColor Green
    Write-Host "  浏览器: http://localhost:7474" -ForegroundColor Gray
} else {
    Write-Host "Neo4j 启动失败，请检查容器状态" -ForegroundColor Red
}

# 3. 启动后端 API
Write-Host "`n[3/4] 启动后端 API..." -ForegroundColor Yellow
$backend = Start-Process -FilePath "python" -ArgumentList "-m","uvicorn","api_server:app","--host","0.0.0.0","--port","8000" -WorkingDirectory "D:\29\rag_app" -PassThru -WindowStyle Hidden
Write-Host "后端进程 ID: $($backend.Id)" -ForegroundColor Green

# 等待后端就绪
$waited = 0
while ($waited -lt 30) {
    Start-Sleep 2
    $waited += 2
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8000/openapi.json" -Method GET -TimeoutSec 2 -ErrorAction Stop
        Write-Host "后端 API 已就绪" -ForegroundColor Green
        break
    } catch {}
}
if ($waited -ge 30) {
    Write-Host "后端启动超时，请检查日志" -ForegroundColor Red
}

# 4. 启动 React 前端
Write-Host "`n[4/4] 启动 React 前端..." -ForegroundColor Yellow
$frontend = Start-Process -FilePath "npm" -ArgumentList "run","dev" -WorkingDirectory "D:\29\rag_app\react" -PassThru -WindowStyle Hidden
Write-Host "前端进程 ID: $($frontend.Id)" -ForegroundColor Green

Write-Host "`n==================================================" -ForegroundColor Cyan
Write-Host "  系统启动完成！" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "`n访问地址:" -ForegroundColor White
Write-Host "  - React 前端: http://localhost:5173" -ForegroundColor Cyan
Write-Host "  - API 文档:   http://localhost:8000/openapi.json" -ForegroundColor Cyan
Write-Host "  - Neo4j 浏览器: http://localhost:7474" -ForegroundColor Cyan
Write-Host "`n配置信息:" -ForegroundColor White
Write-Host "  - LLM 模式:   在线（ModelScope Qwen3-VL-8B）" -ForegroundColor Gray
Write-Host "  - GPU 加速:   RTX 4050 CUDA（Embedding + Reranker）" -ForegroundColor Gray
Write-Host "  - 知识图谱:   Neo4j（bolt://localhost:7687）" -ForegroundColor Gray
Write-Host "`n按 Enter 键关闭此窗口..." -ForegroundColor DarkGray
Read-Host
