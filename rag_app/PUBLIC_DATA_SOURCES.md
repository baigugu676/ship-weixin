# 公开真实来源数据与查询依据（2026-11-15）

本次导入是官方厂家参数和已公开的海事调查案例，不是模拟样本，也不是某船完整的设备运行、报警和检修日志。原演示库单独备份，不与本次记录混合。

## 收录范围

| 内容 | 数量 | 含义 |
|---|---:|---|
| 机型配置 | 4 | Wärtsilä W20系列4L/6L/8L/9L，统一取50Hz、1000rpm配置 |
| 案例设备/机位 | 9 | Wight Sky、Wight Light、Windcat 8、Finlandia Seaways和Finnmaster公开案例中识别的机位或系统 |
| 参数 | 24 | 每个机型6个参数，未推断具体船载设备序列号 |
| 故障记录 | 10 | 2017—2021年官方报告收录的事件，按机位记录；同一次缺陷跨报告出现只计一次 |
| 报警记录 | 1 | Windcat 8报告明确提到的失效前高油温报警，不代表全船历史只有一次报警 |
| 检修记录 | 0 | 未取得足以验证的工单及下次计划，不补造 |

## 原始来源

1. [Wärtsilä官方船用机组页面](https://www.wartsila.com/marine/products/engines-and-generating-sets/generating-sets/wartsila-gensets)：W20 / Genset 20, Rated power 表的50Hz、1000rpm列及缸径、行程栏。4L20/6L20/8L20/9L20发动机功率分别800/1200/1600/1800kW，发电机功率分别760/1140/1520/1710kW；不能把机械功率与发电机电功率混用。
2. [MAIB报告4/2022：Wight Sky](https://www.gov.uk/maib-reports/two-catastrophic-engine-failures-one-resulting-in-a-fire-on-board-ro-ro-passenger-ferry-wight-sky)，[原报告PDF](https://assets.publishing.service.gov.uk/media/6267cc85e90e071690c1b679/2022-4-WightSky-Report.pdf#page=23)：印刷页13/PDF第23页表4的五起事件。包含Wight Sky ME2两起、ME4一起，以及Wight Light ME1、ME2各一起。ME2更换前后仍按同一机位统计，不等于同一发动机序列号发生两次故障。
3. [MAIB报告1/2018：Windcat 8](https://www.gov.uk/maib-reports/catastrophic-engine-failure-resulting-in-a-fire-on-crew-transfer-vessel-windcat-8)：Date of occurrence、Summary、Safety lessons；左舷主机轴瓦失效及此前高油温报警。
4. [MAIB报告2/2021：Finlandia Seaways](https://www.gov.uk/maib-reports/engine-failure-and-subsequent-fire-on-ro-ro-cargo-vessel-finlandia-seaways-with-1-person-injured)：事故日2018-04-16，主机灾难性失效与火灾。
5. [MAIB报告13/2025：Finnmaster](https://www.gov.uk/maib-reports/auxiliary-engine-room-fire-on-board-the-ro-ro-cargo-ship-finnmaster)：事故日2021-09-19；辅机机械故障、应急发电机断路器失效、固定CO2系统未完全动作。
6. [MAIB安全通报1/2022：Finnmaster](https://www.gov.uk/maib-reports/safety-warning-issued-after-discovery-of-blocked-fixed-co2-fire-extinquishing-system-pilot-hoses)：先导软管堵塞和只有一半气瓶动作，作为同一CO2缺陷的交叉来源，不重复计数。

厂家事实数据注明Wärtsilä出处；MAIB材料注明Marine Accident Investigation Branch及Crown copyright，并按报告/政府页面所列再利用条件准确转述，不复用第三方照片或机构标识。

## 字段与时间处理

- `CAT-`编号代表公开机型目录，`PUB-`编号代表公开案例中的设备/机位；均为本系统分配的稳定查询键，不是厂家序列号。
- `record_id`、`fault_code`和`alarm_code`为本系统分配的稳定记录键或归一化类别，不冒充原船工单号、原厂诊断码。
- 设备型号、制造商、投用日期等字段没有充分依据时留空；不把目录参数映射到未经证实的船载设备。
- 参数的`updated_at`为采集时间，不是传感器测量时刻。
- 事件统一仅保留原报告的日历日期；`00:00:00`是数据库日精度占位，不是报告给出的真实发生时刻，也没有将未知时区强行换成上海时间。不能用来做精确小时级分析。
- Windcat报警的`severity=warning`是本系统把报告中的alarm归类为warning，不是调查报告给出的严重程度；这项转换在记录与溯源中均注明。
- 故障与报警分别计数；Finnmaster同一事故的三个独立设备/系统故障分别关联各自机位。计数不是事故总数，也不是故障率。

## 可复现查询

- `CAT-W20-6L-1000额定功率是多少`：读取equipment与equipment_parameters，按设备编号关联并筛选参数名称包含“功率”，返回发动机1200kW、发电机1140kW。依据厂家50Hz/1000rpm列。
- `PUB-WIGHTSKY-ME2故障记录`：读取equipment与fault_events，按机位编号关联，返回2017-09-12和2018-08-26两条。依据MAIB表4的Event 1、Event 4。
- `2017-01-01至2021-12-31各设备故障次数`：COUNT(事件ID)按机位分组，包含零条机位，左右日期范围按源报告日历日期解释。保留零条不能理解为实际从未故障。
- `PUB-WINDCAT8-PORT报警记录`：只返回被公开报告明确提及的那一条高油温报警。

点击两端提问区域的“查询语句与结果”，可核对实际SQL、绑定参数、读取表、官方链接及来源位置。网页还可展开“记录溯源”查看记录键、source ID和具体表格/段落。源匹配优先使用读取表和结果设备编号；聚合结果未带设备编号时仅给出相关表候选来源，不宣称逐行精确血缘。

## 数据文件与导入

完整的人工核对记录、原始字段映射、48条逐记录溯源、6份来源文档的SHA256与采集时间，均在 [来源数据包](public_data/marine_reference_20261115.json)。本次未采用C-MAPSS、AI4I等仿真或合成数据冒充真实船舶记录。

从rag_app运行：

```powershell
.\.venv\Scripts\python.exe equipment_public_import.py --db data/equipment.db --replace-demo
```

`--replace-demo`仅允许替换已核验的原始6台模拟设备库，并先备份到data/backups；含其他业务记录的库会拒绝覆盖。导入空库无需此参数。重复导入同一SHA256的数据包不增加记录。
