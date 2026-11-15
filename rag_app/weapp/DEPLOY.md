# 微信小程序部署与联调

本指南依据 2026-11-04 的仓库实现。小程序结构见 [README.md](README.md)，后端运行与持久化见 [部署文档](../backend_docker_and_frontend_call.md)，API 见 [接口协议](../react/frontend_api.md)。

## 本地开发

先按主 README 安装依赖、配置 `.env` 和模型缓存，再从 `rag_app/` 执行：

```bash
python -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

`python api_server.py` 不是启动命令：该文件当前没有直接运行 Uvicorn 的入口。

在微信开发者工具中导入 `rag_app/weapp/`，核对自己的 AppID，将 `app.js` 中的 `globalData.apiBaseURL` 改为调试后端。本地版本默认使用 `http://127.0.0.1:8000`，也可在登录页的“后端连接设置”保存真机或云端地址。

| 场景 | 地址 |
|---|---|
| 开发者工具和后端在同一电脑 | `http://localhost:8000` |
| 真机访问局域网电脑 | `http://<电脑局域网IP>:8000`，手机需能访问该端口 |
| 云端/发布部署 | 实际可达的 HTTPS API 地址 |

本地调试时可使用开发工具的“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”选项。真机不能用 `localhost` 访问电脑；切换网络后应重新核对地址与端口。

`utils/api.js` 已从 `app.globalData.apiBaseURL` 读取地址，可在登录页保存当前设备地址，或修改 `app.js` 默认值。Cloud Studio 演示还需确保工作区和后端服务已启动。

## HTTPS 与流式代理

部署时配置实际的 HTTPS 后端及证书，按微信公众平台当前的服务器域名要求配置 request 和 uploadFile 域名；如使用下载接口，再配置相应 downloadFile 域名。具体账号权限、审核和位置能力要求以平台控制台为准。

代理需要同时转发 `/auth`、`/users`、`/rag`、`/vision`、`/weather`、`/equipment`。下面片段放入已配置 TLS 的 Nginx `server`，假设代理和 API 位于同一主机：

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

关闭缓冲以避免 SSE 积累到末尾才显示。后端检索和模型初始化期间可能没有后续事件，代理超时应结合实际模型延迟验证。CORS 与微信平台域名配置是不同机制；后端当前允许所有 CORS 来源，并不替代域名配置或鉴权。

将 `app.js` 中的地址改为实际部署地址后，测试登录、流式问答、三种查询模式、设备总览、SQL 表格、CSV 导入/导出、文档上传、图片识别、天气及历史查询。`app.json` 已声明定位权限和 `getLocation` 隐私接口，但仍需核对平台配置与用户授权。

## 更新与发布

1. 使用自己的 AppID 和后端地址，在开发工具及真机完成联调。
2. 通过开发工具上传代码，在平台版本管理中按当前流程提交审核、发布。
3. 后端更新后重启服务，配置和数据目录按后端部署文档持久化；API 不兼容变更需同步更新两端。
4. React 网页单独在 `react/` 构建并部署。网页生产构建使用同源 API，支持 HTTPS 托管；独立后端可在构建时通过 `VITE_API_BASE_URL` 指定。

## 当前实现边界

- 登录接口仅校验账号密码，不签发 token；后续设置、聊天、上传等业务接口没有登录身份校验，公开部署前需完善服务端鉴权。
- 默认演示账号为 `admin` 和 `captain_park`，密码均为 `123456`；不能依赖登录界面隔离数据。
- 文档上传追加到共享知识库，用户目录不提供私有检索权限；文档接口暂无显式服务端大小上限，图片单独限制为 10 MiB。
- 设置的“离线模式”是抽取式答案，不是自动切换 Ollama；问题分解也需要核对后端配置。图片和天气需要联网。
- 临时公网映射或云工作区地址变化后，要同时核对 `app.js` 和平台配置；本指南不保证某一演示地址持续可用。

## 双端升级顺序

先部署同版本后端和网页构建，再在开发者工具导入此小程序目录。数据库启动时自动新增 `chat_deletions` 表，保留账号、旧会话、天气和设备记录，不需要清库。验证同一账号两端各建一个会话、互相刷新都能看见，再删除其中一个并确认另一端不会恢复。模拟记录不会在启动或升级时重复填入。

小程序源代码同步到服务器不等于微信平台版本已更新：开发工具编译、真机预览和上传体验版是独立步骤。本次改动没有代替用户提交审核或发布正式版。
