// utils/api.js
const app = getApp();

const DEFAULT_SETTINGS = {
  nickname: "Captain Park",
  avatar: "",
  imo: "9876543",
  email: "captain.park@deepblue.com",
  emergency: "+86 13800138000",
  theme: "dark",
  fontSize: 16,
  notify: true,
  autoSave: true,
  graphOn: true,
  offlineOn: false,
  streamSpeed: 50,
  dbPath: "/mnt/data/local_kb",
  model: "hybrid",
  retention: "30",
  neo4jUri: "bolt://127.0.0.1:7687",
  neo4jUser: "neo4j",
  neo4jPassword: "",
};

function getBaseURL() {
  return app.globalData.apiBaseURL;
}

function normalizeSettings(settings = {}) {
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function sanitizeUserId(value = "") {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getSessionUserId(baseUserId, chatId) {
  return `${sanitizeUserId(baseUserId || "captain_park")}_${String(chatId || "session").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// 通用请求封装
function request(options) {
  return new Promise((resolve, reject) => {
    const { url, method = 'GET', data, header = {}, ...rest } = options;
    
    wx.request({
      url: `${getBaseURL()}${url}`,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        ...header,
      },
      timeout: 300000, /* 非流式问答在大模型下要 40s+，原来 90s 容易踩线 */
      ...rest,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error(res.data?.detail || `请求失败: ${res.statusCode}`));
        }
      },
      fail: (err) => {
        reject(new Error(err.errMsg || '网络请求失败'));
      }
    });
  });
}

// 登录
function login(userId, password) {
  return request({
    url: '/auth/login',
    method: 'POST',
    data: { user_id: userId, password }
  });
}

// 获取用户设置
function getUserSettings(userId) {
  return request({
    url: `/users/${encodeURIComponent(userId)}/settings`,
    method: 'GET'
  });
}

// 保存用户设置
function saveUserSettings(userId, settings, changedBy) {
  return request({
    url: `/users/${encodeURIComponent(userId)}/settings`,
    method: 'PUT',
    data: { settings, changed_by: changedBy || userId }
  });
}

// 获取聊天记录
function getUserChats(userId) {
  return request({
    url: `/users/${encodeURIComponent(userId)}/chats`,
    method: 'GET'
  });
}

// 保存聊天记录
function saveUserChats(userId, chats) {
  return request({
    url: `/users/${encodeURIComponent(userId)}/chats`,
    method: 'PUT',
    data: { chats }
  });
}

// 普通问答（非流式）
function queryRag(payload) {
  return request({
    url: '/rag/query',
    method: 'POST',
    data: { ...payload, session_id: payload.session_id || payload.user_id }
  });
}

// 流式问答（优先 enableChunked；不生效时自动退化为"整包解析"）
function streamQueryRag(payload, onChunk, onError, onComplete) {
  let buffer = '';
  let finished = false;
  let chunked = false;
  let terminal = false;
  const decode = createStreamingDecoder();
  const dispatch = (block) => {
    const evt = parseSSEBlock(block);
    if (!evt) return;
    let data;
    try { data = JSON.parse(evt.data); }
    catch { return; }
    if (evt.event === 'done' || evt.event === 'error') terminal = true;
    if (onChunk) onChunk(evt.event, data);
  };
  const feed = (raw) => {
    if (finished || raw === undefined || raw === null) return;
    buffer += (typeof raw === 'string' ? raw : decode(raw)).replace(/\r/g, '');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatch(block);
    }
  };
  const fail = (error) => {
    if (finished) return;
    finished = true;
    if (onError) onError(error);
  };
  const task = wx.request({
    url: `${getBaseURL()}/rag/query/stream`, method: 'POST',
    header: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    data: payload, enableChunked: true, timeout: 600000,
    dataType: 'text', responseType: 'text',
    success: (res) => {
      if (finished) return;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        fail(new Error(`请求失败 HTTP ${res.statusCode}`));
        return;
      }
      // Some runtimes return the entire body after also delivering chunks.
      if (!chunked && res.data) feed(res.data);
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
      if (!terminal) { fail(new Error('连接提前结束，请重试')); return; }
      finished = true;
      if (onComplete) onComplete();
    },
    fail: (err) => fail(new Error(err.errMsg || '流式请求失败')),
  });
  if (task && typeof task.onChunkReceived === 'function') {
    task.onChunkReceived((res) => {
      if (res.data && (res.data.byteLength || res.data.length)) chunked = true;
      feed(res.data);
    });
  }
  return { abort() { finished = true; if (task) task.abort(); } };
}

// 增量 UTF-8 解码器：正确处理被切分到两个 chunk 里的多字节中文字符
function createStreamingDecoder() {
  const hasTextDecoder = typeof TextDecoder !== 'undefined';
  const decoder = hasTextDecoder ? new TextDecoder('utf-8') : null;
  let pending = new Uint8Array(0);

  return (buffer) => {
    const incoming = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    if (!incoming || !incoming.length) return '';

    const merged = new Uint8Array(pending.length + incoming.length);
    merged.set(pending);
    merged.set(incoming, pending.length);

    // 找到最后一个"完整 UTF-8 序列"的边界，把不完整尾巴留到下一块
    let cut = merged.length;
    let k = merged.length - 1;
    while (k >= 0 && (merged[k] & 0xc0) === 0x80 && merged.length - k <= 3) k -= 1;
    if (k >= 0) {
      const lead = merged[k];
      let need = 1;
      if (lead >= 0xf0) need = 4;
      else if (lead >= 0xe0) need = 3;
      else if (lead >= 0xc0) need = 2;
      if (merged.length - k < need) cut = k;
    }

    const complete = merged.subarray(0, cut);
    pending = merged.slice(cut);
    if (!complete.length) return '';

    if (decoder) return decoder.decode(complete);

    // 老基础库降级方案：按字节做百分号转义再解码
    let escaped = '';
    for (let i = 0; i < complete.length; i += 1) {
      escaped += `%${complete[i].toString(16).padStart(2, '0')}`;
    }
    try {
      return decodeURIComponent(escaped);
    } catch {
      return '';
    }
  };
}

// 解析 SSE 数据块
function parseSSEBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const raw of block.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

// 文件上传
function uploadFile(userId, filePath, fileName) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getBaseURL()}/rag/incremental/upload`,
      filePath,
      name: 'file',
      formData: {
        user_id: userId,
      },
      timeout: 120000,
      success: (res) => {
        try {
          const data = JSON.parse(res.data);
          if (res.statusCode >= 200 && res.statusCode < 300 && data.ok) {
            resolve(data);
          } else {
            reject(new Error(data.detail || data.message || '上传失败'));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      },
      fail: (err) => {
        reject(new Error(err.errMsg || '上传失败'));
      }
    });
  });
}

// ===================== 海上天气 =====================

// 获取某经纬度最近几天的海上天气（后端已合并海浪+气象并生成中文文案）
function getWeatherForecast(lat, lon, days = 5) {
  return request({
    url: `/weather/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&days=${days}`,
    method: 'GET'
  });
}

// 按名称搜索地点（手动添加关注海域/港口）
function searchWeatherLocations(name, count = 8) {
  return request({
    url: `/weather/geocode?name=${encodeURIComponent(name)}&count=${count}`,
    method: 'GET'
  });
}

// 经纬度反查地名（定位后展示位置名）
function reverseGeocode(lat, lon) {
  return request({
    url: `/weather/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
    method: 'GET'
  });
}

// 按年+月查询历史天气（本地库优先，缺失自动从归档API回补）
function getWeatherHistory(lat, lon, year, month) {
  return request({
    url: `/weather/history?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&year=${year}&month=${month}`,
    method: 'GET',
    timeout: 120000
  });
}

// ===================== 图片识别（在线VL描述） =====================

// 上传设备图片，返回在线视觉模型生成的一段中文描述
function describeImage(userId, filePath, hint = '') {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getBaseURL()}/vision/describe`,
      filePath,
      name: 'file',
      formData: {
        user_id: userId,
        hint,
      },
      timeout: 180000,
      success: (res) => {
        try {
          const data = JSON.parse(res.data);
          if (res.statusCode >= 200 && res.statusCode < 300 && data.ok) {
            resolve(data);
          } else {
            reject(new Error(data.detail || data.message || '图片识别失败'));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      },
      fail: (err) => {
        reject(new Error(err.errMsg || '图片识别失败'));
      }
    });
  });
}

// 文本处理工具
function stripRagArtifacts(text = '') {
  return text
    .replace(/^\s*基于检索到的资料，建议如下[：:]\s*/g, '')
    .replace(/\[(?:H\d+|h\d+)\]\s*/g, '')
    .replace(/\[\s*(?:IMG|img)[^\]\n\r]*(?:\]|$)/g, '')
    .replace(/\b(?:IMG|img)\s*path\s*=\s*(?:data\/KG\/images|images)\/[^\n\r]*/g, '')
    .replace(/\b(?:images|data\/KG\/images)\/\S+\.(?:png|jpe?g|gif|webp|bmp)\b/gi, '')
    .replace(/\b(?:images|data\/KG\/images)\/[a-f0-9]{64}(?:\.(?:png|jpe?g|gif|webp|bmp))?\b/gi, '')
    .replace(/\[图片附件[^\]]*\]/g, '')
    .replace(/[【】]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripMarkdown(text = '') {
  return stripRagArtifacts(text)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function formatText(text) {
  if (!text) return '';
  const plain = stripMarkdown(text);
  return plain.replace(/\n/g, '\n');
}


function deleteUserChat(userId, chatId) {
  return request({ url: `/users/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}`, method: 'DELETE' });
}
function clearUserChats(userId, chatIds = []) {
  return request({ url: `/users/${encodeURIComponent(userId)}/chats`, method: 'DELETE', data: { chat_ids: chatIds } });
}
function getEquipmentOverview() { return request({ url: '/equipment/overview' }); }
function getEquipmentSchema() { return request({ url: '/equipment/schema' }); }
function getEquipmentRecords(dataset) { return request({ url: `/equipment/records/${dataset}?limit=100` }); }
function getEquipmentTemplate(dataset) { return request({ url: `/equipment/templates/${dataset}`, dataType: 'text' }); }
function adminHeader(userId, password) {
  const bytes = [];
  const encoded = encodeURIComponent(`${userId}:${password}`);
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  return { Authorization: `Basic ${wx.arrayBufferToBase64(new Uint8Array(bytes).buffer)}` };
}
function saveEquipmentRecord(dataset, record, userId, password) {
  return request({ url: `/equipment/records/${dataset}`, method: 'POST', data: record, header: adminHeader(userId, password) });
}
function importEquipmentCSV(dataset, filePath, userId, password) {
  return new Promise((resolve, reject) => wx.uploadFile({
    url: `${getBaseURL()}/equipment/import/${dataset}`, filePath, name: 'file',
    header: adminHeader(userId, password), timeout: 120000,
    success(res) {
      try {
        const data = JSON.parse(res.data);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(data.detail || '导入失败'));
      } catch (error) { reject(error); }
    }, fail(err) { reject(new Error(err.errMsg || '导入失败')); },
  }));
}

module.exports = {
  deleteUserChat, clearUserChats, getEquipmentOverview, getEquipmentSchema, getEquipmentRecords,
  getEquipmentTemplate, saveEquipmentRecord, importEquipmentCSV,
  DEFAULT_SETTINGS,
  normalizeSettings,
  sanitizeUserId,
  getSessionUserId,
  request,
  login,
  getUserSettings,
  saveUserSettings,
  getUserChats,
  saveUserChats,
  queryRag,
  streamQueryRag,
  uploadFile,
  getWeatherForecast,
  searchWeatherLocations,
  reverseGeocode,
  getWeatherHistory,
  describeImage,
  stripRagArtifacts,
  stripMarkdown,
  formatText,
};
