# 智能船舶问答系统 · 网页端

网页端使用 React 19、Vite 8、Tailwind CSS 4，入口为 `src/App.jsx`，登录后进入 `src/components/Chat.jsx`。本说明依据 2026-11-02 的实现。

## 功能与目录

- `components/Login.jsx`：调用后端账号登录。
- `components/Chat.jsx`：会话管理、SSE 流式问答、参考文献、ECharts 图谱、文档上传和图片辅助诊断。
- `components/setting.jsx`：用户资料、主题、问答偏好与知识库上传。
- `components/EquipmentPanel.jsx`：设备数据预览、CSV 模板与管理员导入，回答中的 SQL 结果表格及查询依据。
- `components/WeatherPanel.jsx`：地点管理、天气预报与历史查询。
- `index.css`：公共样式；`main.jsx`：React 挂载入口。

## 开发启动

先按 [主 README](../README.md) 启动端口 8000 的后端，再从本目录执行：

```bash
npm install
npm run dev
```

Vite 默认显示 `http://localhost:5173`；端口占用时以终端实际输出为准。当前锁文件中 Vite 和 React 插件的 Node 要求为 `^20.19.0 || >=22.12.0`。

`package.json` 已声明网页使用的 `echarts` 与 `@tailwindcss/postcss`，与锁文件根依赖保持一致。

| 命令 | 用途 |
|---|---|
| `npm run dev` | Vite 开发服务器 |
| `npm run build` | 构建到 `dist/` |
| `npm run preview` | 预览构建产物 |
| `npm run lint` | 执行 ESLint |

## API 地址

登录、问答、设置和天气统一使用 `src/api.js` 的 API 基址。生产构建默认使用同源地址，因此 FastAPI 直连和 HTTPS 反向代理均无需修改代码；Vite 开发默认访问当前主机的 8000 端口。`vite.config.js` 的 `/rag` 代理不影响上述开发基址。

需要单独指定后端时，在构建环境设置 `VITE_API_BASE_URL`，例如 `https://api.example.com`，重新构建后生效。该变量属于网页公开配置，不能放模型密钥。浏览器必须能访问该地址，不能使用仅 Docker 容器内部可解析的服务名。

## 问答行为

网页默认调用 `POST /rag/query/stream`，按 `meta/trace/token/references/kg/done/error` 事件更新界面。一次会话的请求标识由用户与聊天 ID 组合，区别于保存聊天记录使用的账号 ID。

设置中的“离线模式”发送 `use_llm=false`，返回抽取式答案；要使用 Ollama，应在后端配置提供者并保留 LLM 开启。默认问题分解也可能调用模型，完全离线的准备条件见主 README。

图片上传先调用 `/vision/describe`，获得可编辑描述后再发起问答。天气依赖在线服务；浏览器定位需要安全上下文和用户授权。

## 构建与托管

```bash
npm run build
```

后端会在启动时依次寻找 `frontend/dist/` 和 `react/dist/`（打包程序还会先检查可执行文件旁的目录）。在构建完成后，从 `rag_app/` 启动或重启 FastAPI，即可通过 `http://localhost:8000/` 访问网页。

接口详情见 [frontend_api.md](frontend_api.md)，部署见 [后端与网页部署说明](../backend_docker_and_frontend_call.md)。当前登录返回用户、设置和聊天，不签发 token；后端业务接口尚未校验登录身份。

设备参数、检修日期、报警和故障统计自动进入设备数据库查询，也可在右侧“回答来源”明确选择。右上角“设备数据”用于导入真实记录，初始库为空。操作见 [设备数据库说明](../EQUIPMENT_DATABASE.md)。

演示库载入后，欢迎页显示“设备数据 · 演示体验”快捷问题；数据面板提供报警排名条形图和检修概览。点击示例按本次请求使用本地设备查询，不改变全局模式设置。
