# 船舶装备故障诊断智能问答系统

面向船舶发动机、液压和电气设备的运维问答系统。项目提供 React 网页端和微信小程序，共用 FastAPI 后端，结合维修手册、混合检索与知识图谱生成带引用的回答，并支持图片辅助诊断、海上天气预报及历史查询。

本文依据 2026-11-02 的仓库实现整理。表中的默认值来自 `rag/config.py`；实际运行时以环境变量和 `.env` 为准。演示中的历史耗时记录见 [DEMO_QUESTIONS.md](DEMO_QUESTIONS.md)，不作为性能保证。

## 系统组成

| 模块 | 当前实现 |
|---|---|
| 网页端 | React 19、Vite 8、Tailwind CSS 4，支持登录、SSE 问答、引用与图谱展示、设置、图片诊断、天气 |
| 微信小程序 | 原生 JS/WXML/WXSS，包含登录、问答、天气、历史、设置页面 |
| 后端 | FastAPI + LangServe，提供业务 API，并可托管 `react/dist` |
| 检索 | ChromaDB + HuggingFace 嵌入 + BM25，支持查询改写、问题分解、父子检索、领域路由、重排序 |
| 生成 | 默认 ModelScope 在线模型；可在后端切换 Ollama，或通过请求关闭 LLM 使用抽取式回答 |
| 知识图谱 | Neo4j 查询增强；LangGraph 管理清洗、切块、抽取、合并、导入、可视化和发布 |
| 持久化 | SQLite + SQLAlchemy，保存账号、聊天、设置变更和逐日天气；生成上下文另存于工作目录的 `history/*.json` |
| 辅助入口 | CLI 和 Streamlit，可独立调用 RAG 核心 |

问答主流程：问题改写/分解 → 父文档与向量/BM25 混合检索 → 重排序 → KG 关联事实与相邻片段补充 → 模型生成或抽取式回答 → 返回引用。

## 目录

```text
rag_app/
├── api_server.py                  # API、SSE、网页静态文件托管、后台预热
├── database_models.py             # SQLite 表结构
├── db_service.py                  # 登录、设置与聊天持久化
├── weather_service.py             # 天气、地理编码、缓存与历史归档
├── rag/                           # RAG 核心，含 config.py、pipeline.py、vision.py
├── react/                         # React 网页端
├── weapp/                         # 微信小程序
├── kg_pipeline/                   # KG 构建流水线
├── data/
│   ├── docs/                      # 手册及增量上传文档
│   ├── index/                     # Chroma 与父子检索索引
│   ├── KG_Build/<kg_name>/         # 各子图的构建中间结果、日志与状态
│   └── KG/                        # 发布后供问答使用的 chunks、extracted、delivery
├── run_langgraph_pipeline.py       # 七步 KG 流水线入口
├── package_kgs.py                  # 多子图合并发布
├── run_cli.py                     # 命令行问答及 A/B 对比
├── app_streamlit.py               # Streamlit 入口
├── bootstrap.py                   # 模型准备与应用启动辅助入口
├── scripts/                       # Windows PowerShell 启动脚本
├── test_sse.py / test_react.py     # 连接运行中后端的 SSE 联调脚本
└── test/                          # 数据集与 RAGAS 评测脚本
```

## 本地启动

环境准备从仓库根目录开始，进入 `rag_app/` 后执行后端命令。后端保持该工作目录：数据库地址为 `sqlite:///./deepblue_rag.db`，随当前工作目录变化。

### 1. 后端依赖与配置

```bash
cd rag_app
python -m venv .venv
```

激活环境，按终端选择一种：

```bash
# Linux / macOS / WSL
source .venv/bin/activate
```

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```bash
python -m pip install -r requirements.txt
```

将 `.env.example` 复制为 `rag_app/.env`，填入真实的模型密钥及 Neo4j 配置。示例中的密钥是占位符。RAG 配置读取此文件，已导出的环境变量优先；修改后重启后端。

上游提交 `c42797b` 将 `.env.example` 中的在线聊天模型示例更新为 `Qwen/Qwen3.8-Flash-Next`，并提供低内存环境关闭父子检索和重排序的配置建议。`rag/config.py` 未设置环境变量时仍默认使用 `Qwen/Qwen3.5-27B`；现有 `.env` 不会因模板更新而自动切换模型。关闭 `RAG_USE_PARENT_RETRIEVER` 会跳过父子索引初始化；关闭 `RAG_USE_RERANKER` 会跳过重排序模型预热，适合低内存部署。

Python 版本需同时满足锁定依赖。代码使用 Python 3.10+ 语法，现有 Dockerfile 基于 3.10；仓库尚未提供依赖安装兼容性矩阵。

首次使用还需准备嵌入模型。主向量索引可触发模型下载，父子检索的嵌入加载默认 `RAG_EMBEDDING_LOCAL_ONLY=true`。无缓存时可在联网准备阶段设置 `RAG_EMBEDDING_LOCAL_ONLY=false`，或把 `RAG_EMBEDDING_MODEL` 指向已下载的本地模型目录。完全离线运行前须准备好依赖、模型和索引。

### 2. 启动 API

```bash
python -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

- Swagger：`http://localhost:8000/docs`
- OpenAPI：`http://localhost:8000/openapi.json`
- 若已存在网页构建产物：`http://localhost:8000/`

后端启动时在后台初始化 RAG 并预热重排序器。API 文档可访问不代表模型已经就绪；查看控制台日志确认。Neo4j 不可用时可通过请求中的 `use_kg=false` 关闭图谱检索，继续使用普通检索。

### 3. 启动网页端

另开终端，进入 `rag_app/react/`：

```bash
npm install
npm run dev
```

访问 Vite 输出的地址，通常为 `http://localhost:5173`。网页开发默认请求当前主机的 8000 端口；生产构建使用同源 API，支持云端 HTTPS。可用 `VITE_API_BASE_URL` 指定独立后端地址，Vite 的 `/rag` 代理不影响上述开发默认值。

网页依赖清单已包含图谱展示所需的 `echarts` 和 PostCSS 配置所需的 `@tailwindcss/postcss`，与锁文件的根依赖声明保持一致。

构建网页后，可由 FastAPI 托管：

```bash
npm run build
```

输出位于 `react/dist/`。API 在模块加载时查找构建目录；若构建前已启动后端，应重启后端。HTTPS/反向代理部署默认使用同源 API，独立后端可通过 `VITE_API_BASE_URL` 配置，见 [部署文档](backend_docker_and_frontend_call.md)。

### 4. 其他入口

```bash
python run_cli.py
python run_cli.py --ab-decompose
python run_cli.py --ab-parent
streamlit run app_streamlit.py
```

小程序导入及地址配置见 [weapp/README.md](weapp/README.md)。Windows 的 `scripts/start-all.ps1` 会尝试启动 Docker、现有 `neo4j-rag` 容器、后端和 Vite，但写死了 `D:\29\rag_app` 路径，且不会安装依赖或首次创建 Neo4j 容器，使用前需核对脚本。

## 在线、本地模型与抽取式回答

| 用法 | 配置/请求 | 行为 |
|---|---|---|
| 默认在线问答 | `RAG_LLM_PROVIDER=modelscope`，配置密钥 | 默认模型 `Qwen/Qwen3.5-27B` |
| 本地生成 | `RAG_LLM_PROVIDER=ollama`，启动 Ollama 并准备 `RAG_LLM_MODEL` | 默认 `qwen2.5:3b`，请求保持 `use_llm=true` |
| 网页/小程序“离线模式” | 客户端发送 `use_llm=false` | 关闭答案生成模型，返回检索内容组成的抽取式回答，不会自动切换 Ollama |

关闭答案 LLM 后，默认的 LLM 问题分解仍可能发起模型请求。需要避免在线调用时，还应设置 `RAG_DECOMPOSER_METHOD=heuristic` 或关闭问题分解，使用本地重排序，并提前准备嵌入模型。图片识别和天气仍依赖外网。

`RAG_LLM_PROVIDER=none` 不是自动降级开关：当前模型构造函数会抛错。使用抽取式回答应明确发送 `use_llm=false`；不能保证所有 LLM 配置错误都会自动降级。

## 常用配置

下面是代码默认值，不代表本机 `.env` 的实际值。完整字段见 [rag/config.py](rag/config.py)。

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `RAG_LLM_PROVIDER` | `modelscope` | 答案生成提供者 |
| `RAG_MODELSCOPE_MODEL` | `Qwen/Qwen3.5-27B` | 在线聊天模型 |
| `RAG_MODELSCOPE_BASE_URL` | `https://api-inference.modelscope.cn/v1` | 在线模型接口 |
| `RAG_LLM_API_KEY` | 空 | 回退读取 `MODELSCOPE_API_KEY`、`LLM_API_KEY` |
| `RAG_LLM_MODEL` | `qwen2.5:3b` | Ollama 默认模型 |
| `RAG_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 地址 |
| `RAG_LLM_MAX_TOKENS` / `RAG_LLM_TEMPERATURE` | `512` / `0.2` | 生成参数 |
| `RAG_EMBEDDING_MODEL` | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | 嵌入模型，可使用本地目录 |
| `RAG_EMBEDDING_LOCAL_ONLY` | `true` | `build_embeddings` 加载时仅使用本地模型；主索引构建不经过此函数 |
| `RAG_EMBEDDING_CACHE_DIR` | 空 | `build_embeddings` 的缓存目录 |
| `RAG_TOP_K` / `RAG_HYBRID_TOP_K` | `6` / `24` | 最终上下文数量 / 混合召回候选数 |
| `RAG_BM25_WEIGHT` / `RAG_VECTOR_WEIGHT` | `0.60` / `0.40` | 检索融合权重 |
| `RAG_QUERY_REWRITE_ENABLED` / `RAG_QUERY_REWRITE_MAX_VARIANTS` | `true` / `2` | 查询改写及最多变体数 |
| `RAG_USE_QUERY_DECOMPOSITION` / `RAG_DECOMPOSER_METHOD` | `true` / `llm` | 问题分解开关及方法 |
| `RAG_DECOMPOSE_MIN_LENGTH` / `RAG_DECOMPOSE_MAX_SUBQUESTIONS` | `8` / `3` | 启发式分解参数 |
| `RAG_DECOMPOSE_MAX_SUBQUERIES` / `RAG_DECOMPOSE_PER_QUERY_TOP_K` | `4` / `6` | 检索查询数上限 / 每查询候选数 |
| `RAG_USE_PARENT_RETRIEVER` / `RAG_PARENT_RETRIEVER_K` | `true` / `6` | 父子检索开关及数量 |
| `RAG_PARENT_RETRIEVER_ROUTE_MODE` / `RAG_PARENT_PROMPT_MODE` | `soft` / `hybrid` | 父来源软加权及父片段上下文合并 |
| `RAG_DOMAIN_ROUTING_ENABLED` / `RAG_DOMAIN_ROUTE_MODE` | `true` / `soft` | 领域路由 |
| `RAG_USE_RERANKER` / `RAG_RERANKER_PROVIDER` | `true` / `local` | 重排序默认开启，亦支持 `dashscope` |
| `RAG_RERANKER_MODEL` / `RAG_RERANKER_TOP_K` | `BAAI/bge-reranker-v2-m3` / `6` | 本地重排序模型及保留数量 |
| `RAG_RERANKER_MAX_INPUT` / `RAG_RERANKER_SCORE_THRESHOLD` | `24` / `0.25` | 重排序输入上限及阈值 |
| `DASHSCOPE_API_KEY` / `RAG_DASHSCOPE_RERANKER_MODEL` | 空 / `gte-rerank-v2` | DashScope 重排序配置 |
| `RAG_CONTEXT_COMPRESSION_ENABLED` | `false` | 上下文压缩默认关闭 |
| `RAG_USE_HISTORY` | `true` | 生成时使用会话历史 |
| `NEO4J_URI` / `NEO4J_USER` | `bolt://localhost:7687` / `neo4j` | 图数据库地址及账号 |
| `NEO4J_PASSWORD` | `neo4j1234` | 开发默认密码，部署时覆盖 |
| `RAG_KG_REL_LIMIT` / `RAG_KG_TOP_K` / `RAG_KG_SCORE_THRESHOLD` | `50` / `12` / `0.1` | 图谱召回参数 |
| `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` | `1500` / `80` | RAG 文本切块；KG 构建使用另一套参数 |
| `RAG_HEADING_MERGE_ENABLED` / `RAG_HEADING_MERGE_LEVEL` | `true` / `3` | 标题合并 |

路径可通过 `RAG_DATA_DIR`、`RAG_DOCS_DIR`、`RAG_INDEX_DIR`、`RAG_PARENT_INDEX_CACHE_DIR`、`RAG_KG_DIR` 配置；默认均在应用的 `data/` 下。SQLite 地址目前写在 `database_models.py`，没有对应的环境变量。

## 文档与知识图谱

RAG 加载器优先使用 `data/KG/chunks/chunks.json`、`doc_source_map.json`、`chunk_to_kg.json`，其次才尝试 `data/` 等兼容位置。仅把文件放入 `data/docs/`，不会自动替换已经存在的发布切块及向量索引。

- 小规模追加：调用 `POST /rag/incremental/upload`，支持 `.txt/.md/.pdf`，同步更新索引并重载 RAG。
- 上传路径包含用户标识，但写入的是共享知识库，不提供用户级检索权限隔离。
- 增量脚本更新 Chroma 以及 `data/chunks.json`、`data/doc_source_map.json`，不会自动更新发布目录 `data/KG/chunks/`。存在 KG 发布数据时，重载仍优先读取发布切块，BM25 和父子检索不一定包含新文档；需统一发布切块与索引，不能将上传成功等同于所有检索通道已同步。
- 构建领域子图：原始 Markdown/TXT 文件放入 `data/KG_Build/<kg_name>/raw/`，使用七步流水线。
- 发布结果写入 `data/KG/`，包含切块映射、合并图谱、Neo4j CSV 和清单。实体/关系的导出格式以 `kg_pipeline/` 实现为准，不应按旧版四字段示意手工导入。

构建依赖与应用依赖分开维护：`kg_pipeline/requirements.txt` 包含可视化所需的 `networkx/pyvis/beautifulsoup4`，但其 `torch==2.3.1` 与应用的 `torch==2.10.0` 不同。使用独立虚拟环境安装构建依赖，避免在应用环境中直接覆盖。

```bash
# 在专用 KG 环境中，从 rag_app/ 执行
python -m pip install -r kg_pipeline/requirements.txt
python run_langgraph_pipeline.py --kg-name 发动机 --dry-run
python run_langgraph_pipeline.py --kg-name 发动机 --to 4
python run_langgraph_pipeline.py --kg-name 发动机 --only 3 --only-doc D8操作手册
python run_langgraph_pipeline.py --kg-name 发动机 --from 4 --to 6 --no-neo4j-import
```

| 步骤 | 操作 |
|---|---|
| 1 | 语料清洗 |
| 2 | 文本切块 |
| 3 | KG 三元组抽取，支持上下文注入和 checkpoint |
| 4 | 实体合并 |
| 5 | 生成 Neo4j CSV，按参数导入并导出 dump |
| 6 | 生成图谱可视化 HTML |
| 7 | Release：将选中的子图合并发布到 `data/KG/` |

多子图发布示例（会更新当前发布数据）：

```bash
python run_langgraph_pipeline.py --kg-name 发动机 --only 7 --release-kg 发动机 --release-kg 液压 --release-kg 电气 --no-neo4j-import --no-neo4j-dump
```

`--skip-neo4j` 只跳过步骤 5，不阻止步骤 7 内的发布导入。完全不连接 Neo4j 时，应同时传入 `--no-neo4j-import --no-neo4j-dump`。`--dry-run` 不执行步骤操作，但入口仍会创建目录、日志并尝试迁移旧布局文件，不是严格只读检查。

KG 抽取使用独立的 `API_KEY`、`API_BASE_URL`、`API_MODEL`（默认 `qwen3.5-plus`），不复用聊天密钥变量；流水线按仓库根目录 `.env`、`rag_app/.env` 的顺序补充未设置的变量，已导出的变量优先。构建切块参数位于 `kg_pipeline/config.py`，默认大小 `6000`、重叠 `360`、最小大小 `1200`。发布后需让问答端索引与新切块保持一致，并重启后端加载新数据。

## 设备业务数据与 Text-to-SQL

已新增独立的 SQLite 设备业务库（默认 `data/equipment.db`），包含设备台账、当前参数、报警、独立故障和检修记录。网页右上角“设备数据”可下载 CSV 模板、管理员导入并预览记录；数据库初始为空，不自动填入模拟数据。

聊天默认自动识别设备参数、检修日期、报警/故障统计；网页右侧可明确选择“设备数据”或“维修手册与知识图谱”。例如“最近一个月哪个设备报警最多？”会转为只读 SQL，基于真实入库记录返回结果；“最近一个月”按近30天、“上个月”按完整自然月处理，并列第一全部保留。结果可展开表格和 SQL 查询依据。

在线模式使用现有模型生成 SQL，常见问题也可关闭 LLM 使用内置规则；数据库查询不依赖 RAG 索引初始化。设备写接口单独校验管理员 HTTP Basic 身份，读接口仍为共享访问。新配置 `RAG_EQUIPMENT_DB` 可指定业务库路径。

显式载入模拟记录后，欢迎页和设备数据面板提供可点击的示例问题，并显示近30天报警排名、独立故障与检修概览。演示集包含6台设备、24项参数、77条报警、19条故障和18条检修，均有演示标记。

完整操作、表字段、CSV 模板、API 和独立演示库见 [EQUIPMENT_DATABASE.md](EQUIPMENT_DATABASE.md)。

## 图片辅助诊断

上传图片 → 在线视觉模型生成中文描述 → 用户编辑确认 → 把描述作为问题提交常规 RAG。

`POST /vision/describe` 接受 multipart 的 `file`、可选 `user_id` 和 `hint`。支持 `.jpg/.jpeg/.png/.webp/.bmp`，大小上限 10 MiB，处理时将长边缩至最多 1568 像素。主视觉模型失败后会尝试备用模型；该接口只返回描述，不直接返回诊断答案。

| 配置 | 默认值 |
|---|---|
| `RAG_VISION_PROVIDER` | `modelscope` |
| `RAG_VISION_MODEL` | `nex-agi/Nex-N2.5-Pro` |
| `RAG_VISION_FALLBACK_MODEL` | `nex-agi/Nex-N2.5-mini` |
| `RAG_VISION_BASE_URL` | 空，复用 ModelScope 地址 |
| `RAG_VISION_MAX_TOKENS` / `RAG_VISION_TEMPERATURE` | `512` / `0.2` |

视觉模型复用 `RAG_LLM_API_KEY`。模型名是代码默认配置，实际可用性取决于上游账号与服务。

## 海上天气

`weather_service.py` 合并 Open-Meteo 气象及海洋接口，地点搜索使用 Open-Meteo 地理编码，位置反查使用 BigDataCloud。网页侧栏和小程序天气页共用后端生成的中文文案。

- `GET /weather/forecast?lat=...&lon=...&days=5`：默认 5 天，代码限制为 1～7 天，预报缓存 15 分钟。
- `GET /weather/geocode?name=舟山&count=8`：地点搜索，地理编码缓存 24 小时。
- `GET /weather/reverse?lat=...&lon=...`：位置反查。
- `GET /weather/history?lat=...&lon=...&year=2026&month=10`：逐月查库并尝试回补缺失日期。

预报会写入 SQLite 的 `weather_daily` 表。历史海浪回补按代码配置最多请求最近 92 天，历史字段可能缺失；不保证每个地点都有海洋数据。天气查询需要联网，历史接口也可能尝试上游回补。浏览器定位需安全上下文及用户授权，受限时可手动搜索地点。

## 联调与当前限制

```bash
# 后端已启动时，从 rag_app/ 执行
python test_sse.py --user-id demo --question "主机滑油压力低怎么处理" --raw-events
```

`test_react.py` 也是 SSE 联调入口，不是 React 单元测试。`test/ragas_eval.py` 为独立评测脚本，还依赖应用依赖清单未列出的 `ragas/datasets` 等包及评测模型配置。暂无可据此宣称已达到的准确率、响应时间或内存指标。

当前 `/auth/login` 只验证账号密码并返回数据，不签发 token；原有用户设置、聊天及文档上传等接口未校验登录身份。初始化包含 `admin` 和 `captain_park` 两个演示账号，默认密码均为 `123456`。部署到公开网络前需要补齐服务端鉴权；目前的登录界面和用户目录划分不能提供访问权限隔离。

更多说明：

- [项目简介](项目简介.md)
- [网页端说明](react/README.md) / [本地启动速查](react/recommend.md)
- [API 与 SSE 协议](react/frontend_api.md)
- [Docker 与反向代理部署](backend_docker_and_frontend_call.md)
- [微信小程序说明](weapp/README.md) / [小程序部署](weapp/DEPLOY.md)

## 网页与小程序同时运行（2026-11-04）

2026-11-15 已补充应用级跨页面同步、断网自动补传、网页设置持久化、同步状态与连接检测、图谱筛选和个人备份，交付范围与验证见 [双端交付说明](DUAL_CLIENT_DELIVERY.md)。

两端可共用同一个 `api_server.py` 进程、账号和设备数据库。会话采用唯一标识和增量合并，显式删除会保留服务端删除标记；在前台约每 15 秒同步。长问答不再占用全局查询锁，问答历史使用原子写入。相关回归测试见 `test/test_concurrency.py`。

小程序已补齐设备总览、模拟记录快捷提问、三种查询模式、SQL 和表格依据、五类业务记录查看、管理员表单/CSV 导入、模板/结果/聊天导出、历史搜索与删除同步、主题/字号/速度设置。登录页可配置本机、局域网或云端后端地址，本地默认 `http://127.0.0.1:8000`。导入与联调见 [小程序说明](weapp/README.md)。
