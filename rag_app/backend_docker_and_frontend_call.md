# 后端、Docker 与网页部署

项目已经包含 `api_server.py`、`Dockerfile.backend` 和 React 网页，无需重新创建 API 层。以下依据 2026-11-02 的仓库实现；接口协议统一见 [frontend_api.md](react/frontend_api.md)，本地依赖和模型准备见 [README.md](README.md)。

## 直接运行

从 `rag_app/` 执行：

```bash
python -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

数据库为当前工作目录的 `deepblue_rag.db`；嵌入、重排序及索引需预先准备，在线模式还需要模型密钥。启动会后台预热，`/docs` 或 `/openapi.json` 可访问仅表明 HTTP 服务已启动。

网页开发在 `react/` 运行 `npm run dev`；构建运行 `npm run build`，输出 `react/dist/`，然后重启后端即可由 `/` 托管。网页依赖与构建入口见 [网页说明](react/README.md)。

## Docker 构建

现有 Dockerfile 基于 `python:3.10-slim`，安装 `requirements.txt` 后执行 `COPY . /app`，工作目录 `/app`，监听端口 8000。它不会执行 npm 构建；若需要镜像附带网页，先在主机生成 `rag_app/react/dist/`。

仓库当前未提供 `rag_app/.dockerignore`。构建前应在构建上下文中添加排除规则，至少排除真实配置、数据库、虚拟环境、前端依赖和 Neo4j 运行数据，避免 `COPY .` 将它们复制进镜像：

```text
.env
.env.*
!.env.example
.venv/
venv/
__pycache__/
*.pyc
deepblue_rag.db*
data/equipment*.db*
history/
react/node_modules/
data/neo4j/
```

该文件是待准备的构建配置，不是当前仓库已具备的能力。保留 `react/dist/`，才能在镜像中托管网页。然后从仓库根目录执行：

```bash
docker build -t rag-backend -f rag_app/Dockerfile.backend ./rag_app
```

锁定依赖能否在目标平台/Python 版本安装需实际验证；本文不代表已完成镜像构建验收。

## 容器运行与持久化

下面是 Bash 示例，从仓库根目录执行，先准备好 `rag_app/.env` 和 `rag_app/data/`。命名卷分别保存 SQLite、生成历史和模型缓存，绑定挂载保存知识数据及索引：

```bash
docker run --rm --name rag-backend -p 8000:8000 \
  --env-file rag_app/.env \
  --workdir /state \
  --mount type=volume,source=rag-db,target=/state \
  --mount type=volume,source=rag-model-cache,target=/root/.cache/huggingface \
  --mount "type=bind,source=$(pwd)/rag_app/data,target=/app/data" \
  rag-backend \
  python -m uvicorn api_server:app --app-dir /app --host 0.0.0.0 --port 8000
```

这里显式将工作目录改为 `/state`，使相对 SQLite 文件和 `history/` 生成历史落在持久卷内，`--app-dir /app` 保证能导入代码。没有该处理时，默认 `/app/deepblue_rag.db` 位于容器可写层，删除容器会丢失数据。命名卷最初为空；迁移已有数据库需另行复制，示例不会自动导入主机数据库。

首次启动前仍需准备模型缓存，或在联网准备阶段覆盖 `RAG_EMBEDDING_LOCAL_ONLY=false`。如果 `RAG_EMBEDDING_MODEL` 指向主机路径，需要把模型挂载到容器并改用容器内路径。`--env-file` 将文件交给 Docker 解析，不依赖应用在镜像内读取真实 `.env`。

### 连接 Neo4j 或 Ollama

容器内的 `localhost` 指容器自身，不能直接使用主机 `.env` 中的本机地址。

- Neo4j 在同一 Docker 自定义网络中时，加入 `--network <网络名>`，并覆盖 `-e NEO4J_URI=bolt://<Neo4j容器名>:7687`；提供正确账号密码。
- 连接主机服务时，可按 Docker 环境使用 `host.docker.internal`；Linux 需要时添加 `--add-host host.docker.internal:host-gateway`。
- 主机 Ollama 示例覆盖：`-e RAG_LLM_PROVIDER=ollama -e RAG_OLLAMA_BASE_URL=http://host.docker.internal:11434 -e RAG_LLM_MODEL=qwen2.5:3b`。需提前准备模型，并确保该服务可从容器访问。
- 不使用图谱时，通过请求 `use_kg=false` 关闭。仅使用抽取式回答时，通过请求 `use_llm=false` 关闭答案 LLM；若要避免在线分解，再设置 `RAG_DECOMPOSER_METHOD=heuristic`。仅设置 `RAG_LLM_PROVIDER=none` 不会自动把请求改成抽取式模式。

PowerShell 使用反引号续行和相应的绝对挂载路径；不要把 Bash 的 `$(pwd)` 示例原样套用到 Windows CMD。

## 网页地址与反向代理

网页的登录、问答、设置、天气和设备数据统一使用 `react/src/api.js`。生产构建默认调用同源 API，HTTPS 托管不再请求明文 HTTP 8000 端口。开发模式默认访问当前主机的 8000 端口；独立后端通过构建时的 `VITE_API_BASE_URL` 指定，修改后重新构建。浏览器不能解析 Docker 内部服务名。

反向代理需关闭 SSE 缓冲。下面是接在已配置 HTTPS 的 Nginx `server` 中的示例，假设代理和后端在同一主机：

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

示例覆盖网页和所有 API 前缀，包括 `/auth`、`/users`、`/rag`、`/vision`、`/weather`。实际模型可能长时间等待首段数据，应结合超时设置验证。

## 部署前的现状核对

- 登录没有签发 token，后续业务接口未校验身份；演示默认账号与密码不能作为公开部署的权限保护。
- 上传会修改共享知识库。文档上传接口当前未限制服务端文件大小，图片接口单独限制 10 MiB。
- CORS 当前允许所有来源且启用 credentials，它不是接口鉴权机制。
- KG 构建依赖与应用依赖的 torch 固定版本不同，构建子图应使用独立环境，不要在服务环境直接覆盖安装。

小程序配置及发布流程见 [weapp/DEPLOY.md](weapp/DEPLOY.md)。

设备业务库默认位于 `/app/data/equipment.db`，上述 data 挂载会将其持久化；自定义 `RAG_EQUIPMENT_DB` 时需同步挂载对应位置。设备 CSV 写接口需要管理员 HTTP Basic，代理应保留 Authorization 请求头。详见 [设备数据库说明](EQUIPMENT_DATABASE.md)。
