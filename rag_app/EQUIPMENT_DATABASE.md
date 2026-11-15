# 设备业务数据库与 Text-to-SQL

设备台账、参数、检修记录、独立故障和报警事件存入关系型 SQLite 数据库。聊天入口可把自然语言转换为 SQL，执行只读查询并展示实际结果；维修手册与知识图谱问答继续使用原有 RAG。

## 使用入口

启动后端与网页后，点击网页右上角 **设备数据**：

1. 下载设备台账模板，填入真实设备编号和名称，使用管理员账号的密码导入。
2. 再下载对应模板，导入设备参数、报警、故障或检修记录。关联字段 `equipment_code` 必须对应已存在的设备。
3. 在聊天中输入“最近一个月哪个设备报警最多？”、“各设备故障次数”、“ME01上次检修日期”或“ME01额定功率是多少”。编号需替换为实际设备编号。
4. 默认自动选择回答来源；需要明确查询业务数据时，在右侧 **回答来源** 选择 **设备数据**。选择 **维修手册与知识图谱** 则强制走原有 RAG。
5. 回答下方可展开 **设备数据库 · 查看查询依据**，查看返回表格、SQL、绑定参数和查询时间。

小程序复用原有问答入口，自动识别支持的设备数据问题，并显示数据库来源。数据导入可通过网页、API 或 CLI 完成。

初始业务库为空，不会自动装入模拟设备或统计数值。没有符合条件的记录时明确返回无记录，不能将此理解为设备从未发生过报警/故障。

## 演示展示

显式加载的模拟数据包含 **6 台设备、24 项参数、77 条报警、19 条故障、18 条检修**，覆盖发动机、泵、液压、电气和气动设备。所有设备和结果均带演示标记，不作为实际维修依据。

- 欢迎页提供“设备数据 · 演示体验”快捷问题，点击后直接查询本地模拟记录，不等待在线模型，也不会更改全局在线/离线设置。
- “设备数据”面板显示近30天报警排名条形图、故障次数及最近/下次检修日期，并提供相同的快捷问题。
- 按载入时刻生成的近30天报警次数依次为：主柴油机18、海水泵12、辅柴油机8、液压泵6、发电机4、空压机0；独立故障最多的是液压泵4次。
- 示例参数：演示主柴油机额定功率500 kW；日期查询使用实际载入时刻生成的日期。
- `GET /equipment/overview` 提供动态近30天概览；`status` 和 `overview` 在演示库中还返回 `seeded_at`、`demo_questions`。

在空的当前业务库中显式加载演示数据，可从 `rag_app/` 执行 `python equipment_cli.py --db data/equipment.db demo`。该操作拒绝覆盖已有记录；另一种方式是下文的独立演示库。模拟事件按载入日期生成，不会自动每天改写，较久以后展示前应在新的空演示库中重新生成。

## 数据模型

默认路径为 `rag_app/data/equipment.db`，可通过 `RAG_EQUIPMENT_DB` 指定绝对路径，与保存用户、聊天和天气的 `deepblue_rag.db` 分开。数据库文件已被仓库的 `*.db` 规则忽略。

| 数据集/表 | 含义 | CSV 必填字段 |
|---|---|---|
| `equipment` | 设备台账 | `code`、`name` |
| `equipment_parameters` | 每台设备各参数的当前值 | `equipment_code`、`name`、`value` |
| `alarm_events` | 每行一次报警 | `record_id`、`equipment_code`、`occurred_at` |
| `fault_events` | 每行一次独立故障 | `record_id`、`equipment_code`、`occurred_at` |
| `maintenance_records` | 实际检修及下次计划 | `record_id`、`equipment_code`、`performed_at` |

完整列名见 [CSV 模板](equipment_templates/) 或 `GET /equipment/schema`。内部用 `equipment_id` 外键关联，CSV 和录入 API 使用便于维护的设备编号。

- 设备台账还可记录 `category/model/manufacturer/location/commissioned_on/notes`。
- 参数另有 `unit/updated_at`。`value` 保存原始文本，如 `500`、`0.4～0.6`，数值运算需显式转换；单位不会被自动换算。相同设备、相同参数名更新当前值，不保存参数变更历史。
- 报警另有 `alarm_code/severity/description/resolved_at`，严重度为 `info/warning/critical`，缺省 `warning`。
- 故障另有 `fault_code/description/resolved_at`。报警和独立故障分别统计，不会根据报警自动认定一次故障。
- 检修另有 `maintenance_type/description/technician/next_due_at`，类型缺省“检修”。最近检修日期取已发生记录的最大 `performed_at`；下次计划读取最近已完成检修记录的 `next_due_at`。

相同 `code` 更新设备，相同 `equipment_code + name` 更新参数，相同 `record_id` 更新事件/检修记录。重复导入同一记录编号不会增加次数；源系统应提供稳定且唯一的记录编号。这里只统计已导入的数据行，不自动对不同编号的重复报警去重。

## 日期与统计口径

业务日期使用 **Asia/Shanghai（UTC+8）**。支持 `YYYY-MM-DD` 或 ISO 日期时间；导入带时区的时间会转换为上海时间。无时区时间按上海时间解释，数据库统一保存为 `YYYY-MM-DD HH:MM:SS`。

- “最近一个月/近一个月”：查询时刻向前 **30 天**。
- “上个月”：前一个完整自然月，不等同于最近 30 天。
- “本月”：当月 1 日至查询时刻。
- 离线规则还支持最近 N 天、一周、今天、昨天、今年、去年和 `YYYY-MM-DD 至 YYYY-MM-DD`。
- 无范围的次数查询读取全部已记录历史，排除未来事件；明确日期范围包含首尾日期。
- “哪个设备报警最多”：返回所有并列第一；全为零或库为空时不虚构第一名。
- 各设备次数统计保留零次设备；使用 `COUNT(事件ID)`，避免外连接误计为一次。

未知设备或离线规则不支持的筛选条件会报错，不会悄悄去掉条件后统计全部设备。复杂问题可开启在线模式；模型生成的 SQL 仍需结合查询依据核对业务口径。

## CSV 导入

模板仅含表头，没有演示数据。使用 UTF-8 编码（允许 BOM），每文件最多 **5 MiB / 5000 行**。不支持未知字段、重复表头和不等长的行。整批校验失败时回滚该批写入，并返回出错的记录序号；先前已成功导入的批次不会回滚。

只包含必填字段也可以导入。更新时，未提交的可选字段保留原值（参数 `updated_at` 缺省刷新为当前时间）；提交了空单元格则按空值/默认值更新。以下是格式示例，不是真实运维数据：

```csv
code,name,category,model,location
ME01,示例主柴油机,发动机,D16,机舱
```

```csv
record_id,equipment_code,occurred_at,alarm_code,severity,description
ALARM-0001,ME01,2026-10-25 10:30:00,LOW-OIL-PRESSURE,warning,示例滑油压力报警
```

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/equipment/status` | 各表数量、时区和演示标记 |
| GET | `/equipment/overview` | 近30天报警/故障次数及最近、下次检修日期 |
| GET | `/equipment/schema` | 设备业务表结构及 CSV 字段 |
| GET | `/equipment/templates/{dataset}` | 下载 UTF-8 CSV 模板 |
| GET | `/equipment/records/{dataset}?limit=50` | 预览记录，limit 为 1～200 |
| POST | `/equipment/records/{dataset}` | 录入/更新一条 JSON 记录，需管理员 HTTP Basic |
| POST | `/equipment/import/{dataset}` | multipart 的 `file` 字段上传 CSV，需管理员 HTTP Basic |
| POST | `/equipment/query` | 设备数据专用自然语言查询 |

写接口通过现有账号服务校验身份和管理员角色，未登录返回 401，普通用户返回 403；网页不会保存用于导入的管理员密码。部署时通过 HTTPS 传输认证信息。读取接口与现有业务接口保持同样的共享数据访问方式，当前未实现船舶/租户级权限隔离。

```bash
# curl 会提示输入管理员密码；先导入设备，再导入关联数据。
curl -u admin http://localhost:8000/equipment/import/equipment \
  -F 'file=@equipment.csv'
```

```bash
curl http://localhost:8000/equipment/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"最近一个月哪个设备报警最多？","use_llm":false}'
```

普通问答和 SSE 也支持 `query_mode`：`auto`（默认）、`equipment`、`knowledge`。

```bash
curl -N http://localhost:8000/rag/query/stream \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"demo_chat1","question":"最近一个月哪个设备报警最多？","query_mode":"equipment","use_llm":false}'
```

普通问答返回原有答案结构并增加 `sql_result`，其中包含 `sql/parameters/columns/rows/row_count/truncated/generated_by/executed_at/timezone/data_kind`；内置规则按需增加 `period`。`row_count` 是本次返回行数，不是被截断查询的完整总行数。

设备查询 SSE 为 `meta → trace(sql_generate) → trace(sql_query) → sql_result → token → done`；失败时返回 `error`，不再发送 `done`。不伪造文档引用和图谱结果。`sql_result` 中的 `generated_by` 区分 `llm` 与 `template`；模型失败并成功使用规则时还会返回 `notice`。

## 在线与离线

`use_llm=true` 使用现有后端模型配置，将设备表结构、字段含义和当前上海时间交给模型生成 SQL JSON，再执行受限只读查询。不会把账号和聊天表结构交给模型。

`use_llm=false` 完全跳过 SQL 模型，使用内置规则支持参数、台账列表、检修日期/记录、报警/故障次数与排名。在线 SQL 生成或校验失败时也会尝试这些规则，并明确标注回退；不支持的条件会返回错误。

查询执行连接为 SQLite `mode=ro`，另有操作/业务表/函数白名单、单语句限制、3 秒 SQL 执行限时和最多 100 行结果。禁止写入、系统表、附加数据库、扩展加载及递归查询。这些限制不表示模型生成的业务语义一定正确。设备查询不初始化 RAG 索引，也不使用历史对话推断省略的设备名称；每个问题应写明设备或统计范围。

## CLI 与独立演示库

以下从 `rag_app/` 执行。建库、导入和规则查询只需 Python 标准库，不需要加载嵌入模型。

```bash
python equipment_cli.py init
python equipment_cli.py import equipment equipment.csv
python equipment_cli.py import alarm_events alarms.csv
python equipment_cli.py query "最近一个月哪个设备报警最多？"
```

若要验证样例，手动创建单独的演示库：

```bash
python equipment_cli.py demo
python equipment_cli.py --db data/equipment_demo.db query "最近一个月哪个设备报警最多？"
```

`demo` 默认只写 `data/equipment_demo.db`，不会修改正式 `data/equipment.db`，且拒绝向已有数据的库混入演示事件。结果明确标注“演示数据，非真实运维记录”。如需网页连接演示库，可设置 `RAG_EQUIPMENT_DB` 指向演示库绝对路径后重启；切回真实业务库时恢复该配置。

CLI 的 `--db` 优先于已导出的 `RAG_EQUIPMENT_DB`。CLI 默认规则查询，增加 `query ... --llm` 才启用模型；后端会按原有规则读取 `.env`，CLI 建库/导入不主动读取 `.env`。

## 验证

```bash
python -m unittest discover -s test -p test_equipment.py -v
```

测试包含真实 SQLite 查询、日期边界、并列和零次、报警/故障独立统计、模型生成接口替身、CSV 事务与去重、只读约束、管理员权限、普通/SSE 接口及 RAG 路由保留。在线模型的可用性和复杂 SQL 的业务准确率需在实际模型和数据集上另行验证。
