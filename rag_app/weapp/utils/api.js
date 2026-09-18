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
      timeout: 90000,
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
    data: payload
  });
}

// 流式问答（使用 enableChunked）
function streamQueryRag(payload, onChunk, onError, onComplete) {
  const requestTask = wx.request({
    url: `${getBaseURL()}/rag/query/stream`,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    data: payload,
    enableChunked: true,
    timeout: 120000,
    success: (res) => {
      // 流式响应在 onHeadersReceived 和 onChunkReceived 中处理
      if (res.statusCode >= 200 && res.statusCode < 300) {
        onComplete && onComplete();
      } else {
        onError && onError(new Error(`HTTP ${res.statusCode}`));
      }
    },
    fail: (err) => {
      onError && onError(new Error(err.errMsg || '流式请求失败'));
    }
  });

  let buffer = '';

  requestTask.onChunkReceived((res) => {
    // 将 ArrayBuffer 转为字符串
    const chunk = arrayBufferToString(res.data);
    buffer += chunk.replace(/\r/g, '');
    
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const evt = parseSSEBlock(block);
      if (!evt) continue;
      
      let data = {};
      try {
        data = JSON.parse(evt.data);
      } catch {
        continue;
      }
      
      onChunk && onChunk(evt.event, data);
    }
  });

  return requestTask;
}

// ArrayBuffer 转字符串
function arrayBufferToString(buffer) {
  const uint8Array = new Uint8Array(buffer);
  let result = '';
  // 使用 TextDecoder 如果可用
  if (typeof TextDecoder !== 'undefined') {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(uint8Array);
  }
  // 降级方案
  for (let i = 0; i < uint8Array.length; i++) {
    result += String.fromCharCode(uint8Array[i]);
  }
  return decodeURIComponent(escape(result));
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

module.exports = {
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
  stripRagArtifacts,
  stripMarkdown,
  formatText,
};
