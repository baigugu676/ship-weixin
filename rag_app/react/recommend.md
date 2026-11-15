# 本地启动速查

完整的模型准备、默认配置和限制统一维护在 [主 README](../README.md)，网页详情见 [网页端 README](README.md)。下面是当前代码的启动入口，不需要另建 API 服务。

## 后端

从仓库根目录执行：

```bash
cd rag_app
python -m venv .venv
```

激活虚拟环境（Linux/macOS/WSL 使用 `source .venv/bin/activate`；Windows PowerShell 使用 `.\.venv\Scripts\Activate.ps1`），然后执行：

```bash
python -m pip install -r requirements.txt
```

复制 `.env.example` 为本目录 `.env`，配置模型密钥及 Neo4j；提前准备嵌入模型缓存，具体步骤见主 README。随后启动：

```bash
python -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

接口文档在 `http://localhost:8000/docs`。后台预热模型期间，API 文档可访问不代表问答已经就绪。保持后端工作目录为 `rag_app/`，避免相对 SQLite 路径产生另一份数据库。

## 网页开发

另开终端进入 `rag_app/react/`：

```bash
npm install
npm run dev
```

网页包清单已包含 ECharts 和 Tailwind PostCSS 依赖，参见 [网页端 README](README.md)。访问 Vite 输出的地址，通常为 `http://localhost:5173`；网页请求 `http://<当前主机名>:8000`。

## 合并托管与辅助入口

在 `react/` 执行 `npm run build`，然后从 `rag_app/` 重启后端，通过 `http://localhost:8000/` 访问。生产构建默认使用同源 API，独立后端可用 `VITE_API_BASE_URL` 配置。

从 `rag_app/` 可运行 `python run_cli.py`、`streamlit run app_streamlit.py`。Windows 的 `scripts/start-all.ps1` 依赖本机 Docker、已有 Neo4j 容器与固定 `D:\29` 路径，使用前应按实际环境核对。
