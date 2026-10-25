# 微信小程序部署指南

## 一、开发环境调试

### 1. 启动后端服务

确保后端服务在本地运行：

```bash
cd rag_app
python api_server.py
# 或
uvicorn api_server:app --host 0.0.0.0 --port 8000
```

### 2. 微信开发者工具设置

1. 打开微信开发者工具
2. 导入 `rag_app/weapp` 目录
3. 点击右上角 **"详情"** → **"本地设置"**
4. 勾选以下选项：
   - [x] 不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书
   - [x] 不校验请求域名
   - [x] 不校验 HTTPS 证书

### 3. 修改 API 地址

在 `weapp/app.js` 中确认：

```javascript
apiBaseURL: 'http://localhost:8000'
```

> 注意：如果后端不在本机，请修改为实际 IP 地址，如 `http://192.168.1.100:8000`

### 4. 真机调试

1. 点击开发者工具顶部的 **"真机调试"**
2. 扫描二维码在手机上预览
3. 确保手机和电脑在同一局域网

---

## 二、生产环境部署

### 1. 后端部署

#### 1.1 配置 HTTPS

微信小程序要求所有网络请求使用 HTTPS。可以使用以下方案：

**方案 A：Nginx 反向代理（推荐）**

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

**方案 B：使用云服务器 + 域名**

- 购买域名并备案（国内服务器必须备案）
- 申请 SSL 证书（Let's Encrypt 免费）
- 配置域名解析到服务器 IP

#### 1.2 确保 CORS 正常

后端 `api_server.py` 已配置：

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境建议改为具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

生产环境建议修改为：

```python
allow_origins=[
    "https://your-domain.com",
    "https://your-miniapp-domain.com",  # 如果有 H5 版
]
```

### 2. 小程序后台配置

登录 [微信公众平台](https://mp.weixin.qq.com/)：

1. 进入 **开发管理** → **开发设置**
2. 在 **服务器域名** 中添加：
   - **request 合法域名**：`https://your-domain.com`
   - **uploadFile 合法域名**：`https://your-domain.com`
   - **downloadFile 合法域名**：`https://your-domain.com`
3. 保存并等待生效（约 5 分钟）

### 3. 修改小程序 API 地址

修改 `weapp/app.js`：

```javascript
App({
  globalData: {
    apiBaseURL: 'https://your-domain.com',
  }
});
```

同时修改 `utils/api.js` 中的 `getBaseURL()` 函数，确保所有请求都使用 HTTPS。

### 4. 上传代码

1. 在微信开发者工具中点击 **"上传"**
2. 填写版本号和项目备注
3. 上传成功后，登录微信公众平台
4. 进入 **版本管理** → **开发版本**
5. 点击 **"提交审核"**
6. 审核通过后，点击 **"发布"**

---

## 三、内网穿透方案（快速测试）

如果没有公网服务器，可以使用内网穿透工具临时测试：

### 使用 ngrok

```bash
# 安装 ngrok
# 注册并获取 authtoken
ngrok config add-authtoken YOUR_TOKEN

# 启动穿透
ngrok http 8000
```

获取到的 `https://xxxx.ngrok-free.app` 地址可以临时填入小程序后台的合法域名中（需要是付费版 ngrok 才能绑定自定义域名）。

### 使用花生壳/FRP

配置类似，将本地 8000 端口映射到公网域名即可。

> ⚠️ 注意：免费内网穿透工具通常有流量限制和域名变动问题，仅适合临时测试。

---

## 四、同时支持电脑端和手机端

当前架构已天然支持多端：

```
用户访问方式：
├─ 电脑浏览器 → https://your-domain.com/ → 加载 React 前端
├─ 手机浏览器 → https://your-domain.com/ → 加载 React 前端（响应式）
└─ 微信小程序 → 打开小程序 → 调用同一套 API
```

### 可选：为电脑端添加手机端 H5 页面

如果希望手机浏览器也能获得更好的体验，可以：

1. 保持现有 React 代码不变（它已经是响应式的）
2. 或者单独构建一个手机端 H5 页面（如使用 Vue3 + Vant）
3. 部署到同一域名的 `/mobile` 路径下

### 可选：后端自动识别客户端

可以在 `api_server.py` 中添加：

```python
from fastapi import Request

@app.get("/client/detect")
def detect_client(request: Request):
    ua = request.headers.get("user-agent", "")
    if "MicroMessenger" in ua:
        if "miniProgram" in ua:
            return {"client": "weapp", "name": "微信小程序"}
        return {"client": "wechat", "name": "微信内置浏览器"}
    if "Mobile" in ua or "Android" in ua or "iPhone" in ua:
        return {"client": "mobile", "name": "手机浏览器"}
    return {"client": "desktop", "name": "电脑浏览器"}
```

---

## 五、安全建议

1. **HTTPS 必须**：微信小程序强制要求 HTTPS
2. **域名备案**：使用国内服务器必须备案
3. **API 鉴权**：建议为 API 添加 Token 鉴权（当前仅使用 user_id + password）
4. **数据加密**：敏感配置（如 neo4j 密码）不要在小程序前端暴露
5. **文件上传限制**：限制上传文件大小和类型
6. ** rate limiting**：为 API 添加请求频率限制

---

## 六、更新维护

### 更新小程序

1. 修改代码后，在微信开发者工具点击 **"上传"**
2. 在小程序后台提交审核
3. 审核通过后发布

### 更新后端

直接更新服务器上的后端代码，重启服务即可。小程序端无需改动。

### 更新电脑端

1. 修改 `rag_app/react/src/` 下的代码
2. 运行 `npm run build`
3. 将 `dist/` 目录部署到服务器
4. 小程序端完全不受影响
