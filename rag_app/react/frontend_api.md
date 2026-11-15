# 后端 API 与 SSE 协议

依据 2026-11-02 的 `api_server.py`、`rag/schema.py` 和业务服务整理。后端默认监听 8000 端口，Swagger 位于 `/docs`，OpenAPI 位于 `/openapi.json`。以下路径均相对于后端地址。

## 接口总览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/auth/login` | 验证账号并返回用户、设置、聊天 |
| GET / PUT | `/users/{user_id}/settings` | 读取 / 保存设置 |
| GET / PUT / DELETE | `/users/{user_id}/chats` | 读取 / 合并 / 显式清空聊天 |
| POST | `/rag/query` | 普通问答，直接接收 `QueryRequest` |
| POST | `/rag/query/stream` | 业务 SSE 问答，以 `user_id` 映射生成会话 |
| POST | `/rag/incremental/upload` | 文档上传并同步增量索引 |
| POST | `/vision/describe` | 图片生成描述，供后续问答使用 |
| GET | `/weather/forecast` | 气象与海洋预报 |
| GET | `/weather/geocode` | 搜索地点 |
| GET | `/weather/reverse` | 经纬度反查地名 |
| GET | `/weather/history` | 按年月查询逐日天气 |

另有 LangServe 在 `/rag` 下注册的 Runnable 接口，其协议与业务 `/rag/query/stream` 不同；网页和小程序主要使用上表中的业务接口。

当前没有 token、cookie 会话或服务端身份校验：`user_id/session_id` 是数据和上下文标识，不是认证凭证。登录成功不会给后续业务请求建立权限隔离，上传目录也不是私有知识库。

## 登录、设置与聊天

`POST /auth/login`：

```json
{"user_id":"admin","password":"123456"}
```

成功返回 `{"ok":true,"user":{...},"settings":{...},"chats":[...]}`。`user` 包含 `user_id`、`role`、`name`、`avatar`。缺少账号或密码返回 400，验证失败返回 401。初始化演示账号为 `admin`、`captain_park`，默认密码均为 `123456`；这些是开发默认值。

- `GET /users/{user_id}/settings` 返回 `{"ok":true,"settings":{...}}`。
- `PUT /users/{user_id}/settings` 接收 `{"settings":{...},"changed_by":"..."}`，`settings` 必须为对象。服务端只合并所传字段，未传字段保留原值；两端应仅提交本次修改的字段，避免覆盖另一端的设置。`changed_by` 可选，默认取路径中的用户 ID。
- 设置包括 `nickname/avatar/imo/email/emergency/theme/fontSize/notify/autoSave/graphOn/offlineOn/streamSpeed/dbPath/model/retention`。客户端还会维护 Neo4j 连接字段，但当前设置持久化服务不保存这些连接字段。
- `GET /users/{user_id}/chats` 返回 `{"ok":true,"chats":[...],"deleted_chat_ids":[...]}`。
- `PUT /users/{user_id}/chats` 接收 `{"chats":[...]}`，按会话和消息ID合并，遗漏的会话保留；返回合并后的聊天列表及删除标记。删除必须使用显式DELETE接口，不能用PUT空列表实现。

## 问答参数

`POST /rag/query/stream` 接收 JSON。网页和小程序通常把账号和聊天 ID 组合为 `user_id`，用于隔离同一账号下不同聊天的生成历史。

| 字段 | 默认/要求 | 说明 |
|---|---|---|
| `query_mode` | `auto` | `equipment` 强制设备 SQL，`knowledge` 强制原有 RAG；缺省自动识别 |
| `question` | 必填，去除空白后非空 | 问题文本，空值返回 400 |
| `user_id` | 可选，缺省映射为 `anonymous` | 清洗为字母、数字、下划线和连字符，截断至 64 字符，映射到 `session_id` |
| `top_k` | 缺省使用 `RAG_TOP_K=6` | 最终上下文数量 |
| `use_kg` | `true` | 是否查询知识图谱 |
| `use_llm` | `true` | `false` 使用抽取式回答，不自动切换本地模型 |
| `use_history` | `true` | 是否使用生成历史，同时受后端 `RAG_USE_HISTORY` 控制 |
| `enable_decompose` | 缺省按后端配置 | 是否分解问题，后端默认开启 |
| `enable_retrieval_optimization` | `true` | 控制问题分解和重排序；不同时关闭查询改写 |
| `enable_parent_retriever` | 缺省按后端配置 | 是否使用父子检索，后端默认开启 |
| `neo4j_uri` / `neo4j_user` / `neo4j_password` | 可选 | 覆盖本次图谱查询的后端连接配置 |

```bash
curl -N http://localhost:8000/rag/query/stream \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"user_id":"demo_chat001","question":"主机滑油压力低怎么处理","use_kg":true,"use_llm":true}'
```

`POST /rag/query` 直接接收 `QueryRequest`：使用 `session_id`，不是 `user_id`；支持同名的检索开关和 Neo4j 字段，还支持 `llm_provider/llm_model/llm_api_key/llm_api_base` 覆盖生成配置。业务 SSE 的请求转换目前不转发这四个 LLM 覆盖字段，应在后端配置模型。

```json
{
  "question": "主机滑油压力低怎么处理",
  "session_id": "demo_chat001",
  "top_k": 6,
  "use_kg": true,
  "use_llm": true,
  "use_history": true
}
```

普通问答返回 `question`、`answer`、`citations`、`retrieved_chunks`、`kg_chunks`、`kg_triplets`、`meta`。三类文档片段字段的每项都是 `{"doc_id":"...","source":"...","score":0.82,"text":"..."}`，不是 `chunk_id`；`meta` 为字符串值字典，具体键由流水线产生。

## SSE 事件

HTTP 响应的媒体类型为 `text/event-stream`，一个事件由 `event:`、`data:` 和空行组成；`data` 内容是 JSON。成功流程为 `meta → trace（若干）→ token（若干）→ references（可选）→ kg（可选）→ done`。

| 事件 | `data` 字段 | 客户端处理 |
|---|---|---|
| `meta` | `user_id`、`question`、`stream:true` | 保存请求元信息 |
| `trace`，检索 | `stage:"retrieve"`、`message`、`context_count`、`elapsed_ms` | 展示检索阶段进度；耗时可为 null |
| `trace`，图谱 | `stage:"kg"`、`message`、`kg_triplet_count`、`elapsed_ms` | `use_kg=true` 时产生 |
| `trace`，生成 | `stage:"generate"`、`message`、`mode` | `mode` 根据 `use_llm` 标为 `online/offline`，不是实际模型服务位置 |
| `token` | `text` | 按顺序追加答案片段 |
| `references` | `citations:[{doc_id,source,score,text}]` | 替换引用列表；没有引用时不发送 |
| `kg` | `triplets:[{...}]` | 替换图谱列表；没有三元组时不发送 |
| `done` | `finish_reason:"stop"`、`elapsed_ms`、`citation_count` | 结束加载 |
| `error` | `message`、`type` | 显示错误并结束加载；错误后不发送 `done` |

```text
event: meta
data: {"user_id":"demo_chat001","question":"主机滑油压力低怎么处理","stream":true}

event: trace
data: {"stage":"retrieve","message":"完成知识库检索","context_count":6,"elapsed_ms":1200}

event: token
data: {"text":"先核对报警及仪表读数。"}

event: references
data: {"citations":[{"doc_id":"example::chunk_1","source":"manual.md","score":0.82,"text":"示例引用"}]}

event: done
data: {"finish_reason":"stop","elapsed_ms":3200,"citation_count":1}

```

以上值仅用于说明协议。`trace` 在检索/图谱准备完成后发出，不是这些阶段执行过程中的实时心跳。`meta` 到达后仍可能等待模型或检索初始化。

使用 `fetch` POST 加可读流（小程序为分块请求），不能直接用原生 `EventSource` 发送此 JSON POST。传输块不等于 SSE 事件边界：需保留未完成文本，并以空行切分事件，再解析 JSON。反向代理应关闭缓冲。

## 文档增量上传

`POST /rag/incremental/upload`，`multipart/form-data`：

| 字段 | 要求 |
|---|---|
| `user_id` | 必填，作为目录标识并经服务端清洗 |
| `file` | 必填，后缀 `.txt/.md/.pdf`，非空 |

```bash
curl http://localhost:8000/rag/incremental/upload \
  -F 'user_id=demo' \
  -F 'file=@./data/docs/new_case.md'
```

成功返回 `ok`、`user_id`、`file_name`、`saved_path`、`indexed_docs`、`indexed_chunks`、`message`。文件写入 `RAG_DOCS_DIR/incremental/<user_id>/`，索引更新和 RAG 重载完成后才返回。增量脚本写入 `data/chunks.json` 与 `data/doc_source_map.json`，但不更新 `data/KG/chunks/`；若存在发布切块，重载仍优先读取它们，不能假定上传后所有检索通道均已包含新文档。

不支持的后缀或空文件返回 400，索引失败返回 500。当前此接口没有服务端文档大小上限，不应套用图片的 10 MiB 限制，也不能保证索引失败时回滚已保存的文件。检索使用共享索引，目录按用户划分不代表访问隔离。

## 图片描述

`POST /vision/describe`，`multipart/form-data`：`file` 必填，`user_id` 默认空，`hint` 默认空。

支持 `.jpg/.jpeg/.png/.webp/.bmp`，非空且不超过 10 MiB，图像处理长边上限 1568 像素。返回 `{"ok":true,"user_id":"...","file_name":"...","description":"..."}`。空文件、大小/类型或图像内容错误返回 400，上游识别失败返回 502。

该接口只生成描述。用户编辑后，将描述作为 `question` 调用问答接口。默认主模型 `nex-agi/Nex-N2.5-Pro`，失败后尝试 `nex-agi/Nex-N2.5-mini`，实际配置见主 README。

## 天气与地点

参数均放在查询字符串中：

| 接口 | 参数 | 行为 |
|---|---|---|
| `/weather/forecast` | `lat`、`lon` 必填；`days=5` | 天数夹到 1～7，合并气象与海洋数据，缓存 15 分钟并尝试逐日入库 |
| `/weather/geocode` | `name` 必填；`count=8` | 返回 `{"ok":true,"results":[...]}`，数量限制为 1～20 |
| `/weather/reverse` | `lat`、`lon` 必填 | 反查位置名称 |
| `/weather/history` | `lat`、`lon`、`year`、`month` 必填 | 按年月读取归档并尝试回补，未来月份返回 400 |

经纬度非法时，预报、位置反查、历史接口返回 400；上游调用失败通常返回 502，具体以各路由异常处理为准。海洋数据可能缺失，历史海浪回补按代码设置最多请求最近 92 天。后端未提供离线天气服务保证。

## 联调

从 `rag_app/` 执行，需已有运行中的后端：

```bash
python test_sse.py --user-id demo --question "主机滑油压力低怎么处理" --raw-events
python test_react.py --user-id demo --question "主机报警如何排查" --final-json-only
```

两个脚本均为 Python SSE 客户端，并非自动化端到端验收或 React 单元测试。

## 设备数据库查询

新增 `/equipment/status`、`/equipment/overview`、`/equipment/schema`、`/equipment/templates/{dataset}`、`/equipment/records/{dataset}`（GET/POST）、`/equipment/import/{dataset}` 和 `/equipment/query`。设备写接口使用管理员 HTTP Basic 验证；读取仍为共享数据访问。详见 [设备数据库接口](../EQUIPMENT_DATABASE.md)。

普通和 SSE 问答的 `query_mode` 均接受 `auto/equipment/knowledge`。设备查询返回原有答案字段并增加 `sql_result`；流式分支为 `meta → trace(sql_generate) → trace(sql_query) → sql_result → token → done`，没有文档 references 和图谱 kg 事件。`sql_result` 包含 SQL、参数、列名、行数据、返回行数、截断标志、生成方式、上海查询时间与演示标记；常见规则还返回统计时间范围。

设备查询的 `use_llm=false` 使用确定的内置查询规则，`true` 调用现有模型生成 SQL，失败时尝试规则并标注 notice。SQL 分支不读取/生成历史对话上下文，用户每次需写明设备和范围。

## 双端聊天同步（2026-11-04）

`PUT /users/{user_id}/chats` 的 `{ "chats": [...] }` 现为按会话和消息 ID 合并；遗漏旧会话不会删除。新增消息应提供唯一 ID，旧的无 ID 消息按内容与位置兼容。较短的旧 AI 答案不会截断已保存内容。GET/PUT 结果包含 `deleted_chat_ids`，客户端合并缓存时必须过滤这些 ID。

- `DELETE /users/{user_id}/chats/{chat_id}`：显式删除单个会话。
- `DELETE /users/{user_id}/chats`：清空服务端会话，可传 `{ "chat_ids": ["本机尚未同步的会话ID"] }` 一并保留删除标记。
- DELETE 返回 `{ "ok": true, "deleted_chat_ids": [...] }`。不能再用 PUT 空数组实现清空。
- 设置 PUT 接受局部字段，只更新传入的偏好；网页和小程序共用相同字段。

网页与小程序在前台约每 15 秒拉取聊天记录。消息正在流式输出时保留本机的生成状态；切换客户端不要求退出另一端。
