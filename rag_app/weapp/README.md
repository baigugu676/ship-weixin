# 智能船舶问答系统 - 微信小程序端

本项目为智能船舶问答系统的微信小程序端，与原有电脑端（React）完全独立，共用同一套后端 API。

## 项目结构

```
weapp/
├── app.js              # 小程序全局逻辑
├── app.json            # 小程序全局配置
├── app.wxss            # 小程序全局样式
├── sitemap.json        # 小程序索引配置
├── utils/
│   └── api.js          # API 封装与工具函数
├── pages/
│   ├── login/          # 登录页
│   ├── chat/           # 聊天问答页（核心页面）
│   ├── history/        # 历史记录页
│   └── settings/       # 设置页
└── assets/
    └── icons/          # TabBar 图标（需自行准备）
```

## 功能特性

- ✅ 用户登录（复用后端 `/auth/login` 接口）
- ✅ 流式问答（SSE 兼容，支持打字机效果）
- ✅ 知识图谱开关、离线模式切换
- ✅ 文件上传（支持 md/pdf/txt）
- ✅ 聊天记录本地缓存 + 服务器同步
- ✅ 参考文献与知识图谱三元组展示
- ✅ 用户设置管理
- ✅ 历史记录浏览与加载

## 快速开始

### 1. 准备开发环境

1. 下载并安装 [微信开发者工具](https://developers.weixin.com/miniprogram/dev/devtools/download.html)
2. 注册微信小程序账号（个人或企业）
3. 获取小程序的 AppID

### 2. 导入项目

1. 打开微信开发者工具
2. 选择 "导入项目"
3. 选择 `rag_app/weapp` 目录
4. 填写你的 AppID
5. 点击确定

### 3. 准备 TabBar 图标

在 `assets/icons/` 目录下放置以下图标（建议尺寸 81x81px，PNG 格式）：

- `chat.png` / `chat-active.png`
- `history.png` / `history-active.png`
- `settings.png` / `settings-active.png`

> 如果没有图标，可以临时将 `app.json` 中的 `tabBar` 配置删除，使用无图标模式。

### 4. 配置后端地址

修改 `app.js` 中的 `apiBaseURL`：

```javascript
App({
  globalData: {
    // 开发环境（需要开启微信开发者工具的"不校验合法域名"）
    apiBaseURL: 'http://localhost:8000',
    
    // 生产环境（必须是 HTTPS + 已备案域名）
    // apiBaseURL: 'https://your-domain.com',
  }
});
```

### 5. 开发调试

在微信开发者工具中：

1. 点击右上角 "详情" → "本地设置"
2. 勾选 **"不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书"**
3. 这样就可以连接本地 `http://localhost:8000` 进行调试

## 后端适配说明

### 已有接口（无需修改）

微信小程序直接复用原有后端接口：

| 接口 | 方法 | 用途 |
|------|------|------|
| `/auth/login` | POST | 用户登录 |
| `/users/{id}/settings` | GET/PUT | 用户设置 |
| `/users/{id}/chats` | GET/PUT | 聊天记录 |
| `/rag/query/stream` | POST | 流式问答（SSE） |
| `/rag/query` | POST | 普通问答 |
| `/rag/incremental/upload` | POST | 文件上传 |

### 生产环境部署要点

1. **HTTPS**：微信小程序要求所有网络请求必须使用 HTTPS
2. **域名白名单**：在微信小程序后台 → 开发管理 → 开发设置 → 服务器域名中，添加：
   - request 合法域名：`https://your-domain.com`
   - uploadFile 合法域名：`https://your-domain.com`
3. **CORS**：后端已配置 `allow_origins=["*"]`，无需额外修改

### 可选：后端添加小程序专用接口

如果需要在后端区分小程序和电脑端，可以在 `api_server.py` 中添加请求头识别：

```python
@app.middleware("http")
async def identify_client(request, call_next):
    user_agent = request.headers.get("user-agent", "")
    is_weapp = "MicroMessenger" in user_agent and "miniProgram" in user_agent
    # 可根据 is_weapp 做不同处理
    response = await call_next(request)
    return response
```

## 与电脑端的关系

```
┌─────────────────┐      ┌─────────────────┐
│   电脑端 (React) │      │  微信小程序端    │
│  rag_app/react/  │      │ rag_app/weapp/  │
└────────┬────────┘      └────────┬────────┘
         │                        │
         └──────────┬─────────────┘
                    │
         ┌──────────▼──────────┐
         │   后端 API (FastAPI) │
         │   rag_app/api_server.py
         └─────────────────────┘
```

- 电脑端代码完全不变，继续独立维护
- 小程序端是全新代码，不依赖电脑端
- 两端共用同一套后端 API 和数据

## 注意事项

1. **SSE 流式响应**：微信小程序使用 `enableChunked: true` 来支持流式响应，需要基础库版本 2.10.0+
2. **文件上传**：微信小程序使用 `wx.chooseMessageFile` 选择文件，仅支持 md/pdf/txt
3. **本地存储**：聊天记录和设置会同时保存在本地（`wx.setStorageSync`）和服务器
4. **安全**：生产环境务必使用 HTTPS，并在小程序后台配置合法域名

## 常见问题

**Q: 请求失败，提示 "fail url not in domain list"？**
A: 在开发者工具中勾选 "不校验合法域名"，或确保后端域名已添加到小程序后台的服务器域名列表中。

**Q: 流式输出没有反应？**
A: 检查后端是否支持 chunked 传输，并确保微信基础库版本 >= 2.10.0。

**Q: 文件上传失败？**
A: 确保后端 `/rag/incremental/upload` 接口可访问，且文件大小不超过微信小程序限制（默认 200MB）。

**Q: 如何修改主题颜色？**
A: 修改 `app.wxss` 中的 CSS 变量：
```css
page {
  --primary: #14b8a6;
  --bg-dark: #041527;
  /* ... */
}
```
