# 停止 Neo4j 容器

Write-Host "正在停止 neo4j-rag 容器..." -ForegroundColor Yellow
$existing = docker ps -a --format "{{.Names}}" | Select-String "^neo4j-rag$"
if (-not $existing) {
    Write-Host "容器 neo4j-rag 不存在，无需操作。" -ForegroundColor Gray
    exit 0
}

docker stop neo4j-rag
if ($LASTEXITCODE -eq 0) {
    Write-Host "容器已停止。" -ForegroundColor Green
} else {
    Write-Host "停止失败。" -ForegroundColor Red
}
