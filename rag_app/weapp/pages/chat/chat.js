// pages/chat/chat.js
const api = require('../../utils/api.js');
const app = getApp();

const QUICK_CARDS = [
  { title: "主机故障诊断", desc: "分析推进系统异常", icon: "⚙️" },
  { title: "电气系统咨询", desc: "电路故障排查建议", icon: "⚡" },
  { title: "液压系统分析", desc: "压力与流量优化", icon: "💧" },
  { title: "维护周期建议", desc: "基于历史数据分析", icon: "🔧" },
];

Page({
  data: {
    statusBarHeight: 44,
    userId: '',
    userSettings: {},
    userAvatarText: 'CP',
    chats: [],
    currentChatId: null,
    currentChat: null,
    inputValue: '',
    isAnswering: false,
    isUploading: false,
    uploadStatus: null,
    recentUploads: [],
    scrollToMessage: '',
    showNewChatModal: false,
    quickCards: QUICK_CARDS,
    graphEnabled: true,
    offlineMode: false,
    activeStreamingPaused: false,
  },

  streamingSessions: new Map(),

  onLoad() {
    // 获取状态栏高度
    const systemInfo = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: systemInfo.statusBarHeight });

    // 检查登录状态
    if (!app.globalData.userInfo) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    this.initUserData();
  },

  onShow() {
    if (app.globalData.userInfo) {
      this.initUserData();
    }
  },

  initUserData() {
    const userInfo = app.globalData.userInfo;
    const settings = api.normalizeSettings(app.globalData.settings);
    const chats = app.globalData.chats || [];
    
    const nickname = settings.nickname || 'Captain Park';
    const avatarText = nickname.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

    this.setData({
      userId: userInfo.user_id || '',
      userSettings: settings,
      userAvatarText: avatarText,
      chats: chats,
      graphEnabled: settings.graphOn ?? true,
      offlineMode: settings.offlineOn ?? false,
    });
  },

  // 输入处理
  onInputChange(e) {
    this.setData({ inputValue: e.detail.value });
  },

  // 发送按钮点击
  onSendBtnTap() {
    const { isAnswering, activeStreamingPaused, activeStreamingMsgId } = this.data;
    
    if (isAnswering && !activeStreamingPaused && activeStreamingMsgId) {
      // 暂停流式输出
      this.pauseStreaming(activeStreamingMsgId);
    } else {
      this.handleSend();
    }
  },

  // 快捷卡片点击
  onQuickCardTap(e) {
    const title = e.currentTarget.dataset.title;
    this.setData({ inputValue: title });
    this.handleSend(title);
  },

  // 发送消息
  async handleSend(text) {
    text = (text || this.data.inputValue || '').trim();
    if (!text) return;

    if (this.data.isAnswering && !this.data.activeStreamingPaused) {
      wx.showToast({ title: '请等待当前回答完成', icon: 'none' });
      return;
    }

    this.setData({ inputValue: '' });

    let chatId = this.data.currentChatId;
    let chats = [...this.data.chats];
    let sessionUserId = '';

    if (!chatId) {
      chatId = Date.now().toString();
      const title = text.length > 12 ? text.substring(0, 12) + '...' : text;
      sessionUserId = api.getSessionUserId(this.data.userId, chatId);
      chats = [{ 
        id: chatId, 
        title, 
        sessionUserId, 
        messages: [], 
        createdAt: new Date().toISOString() 
      }, ...chats];
      this.setData({ currentChatId: chatId, chats });
    } else {
      const current = chats.find(c => c.id === chatId);
      sessionUserId = current?.sessionUserId || api.getSessionUserId(this.data.userId, chatId);
      if (!current?.sessionUserId) {
        chats = chats.map(c => c.id === chatId ? { ...c, sessionUserId } : c);
      }
    }

    const userMsg = { role: 'user', content: text };
    const msgId = `ai-${Date.now()}`;
    const aiMsg = {
      id: msgId,
      role: 'ai',
      content: '',
      fullText: '',
      searchProcess: `正在检索，模式: ${this.data.graphEnabled ? '知识图谱' : '常规检索'}${this.data.offlineMode ? ' [离线]' : ' [在线]'}`,
      traceSteps: [{ stage: 'queued', text: `请求已提交（${this.data.offlineMode ? '离线' : '在线'}模式）` }],
      citations: [],
      kgTriplets: [],
      isStreaming: true,
      isPaused: false,
      isOffline: this.data.offlineMode,
      isGraphEnabled: this.data.graphEnabled,
      traceOpen: true,
      citationsOpen: false,
      kgOpen: false,
      renderedContent: '',
    };

    chats = chats.map(c => 
      c.id === chatId 
        ? { ...c, messages: [...c.messages, userMsg, aiMsg] } 
        : c
    );

    this.setData({ 
      chats, 
      isAnswering: true, 
      activeStreamingPaused: false,
      activeStreamingMsgId: msgId,
      currentChat: chats.find(c => c.id === chatId)
    }, () => {
      this.scrollToBottom();
    });

    this.startStreaming(chatId, msgId, text, sessionUserId);
  },

  // 开始流式输出
  startStreaming(chatId, msgId, question, sessionUserId) {
    const streamSession = {
      pendingText: '',
      renderedText: '',
      streamDone: false,
      finished: false,
      isPaused: false,
      typeTimer: null,
    };
    this.streamingSessions.set(msgId, streamSession);

    const settings = this.data.userSettings;
    const speed = settings.streamSpeed || 50;
    const tickRate = Math.max(10, 70 - speed);
    const chunkSize = speed > 80 ? 3 : (speed > 50 ? 2 : 1);

    // 打字机效果定时器
    streamSession.typeTimer = setInterval(() => {
      if (streamSession.finished || streamSession.isPaused) return;
      
      if (!streamSession.pendingText.length) {
        if (streamSession.streamDone) {
          this.finalizeStreaming(chatId, msgId);
        }
        return;
      }

      streamSession.renderedText += streamSession.pendingText.slice(0, chunkSize);
      streamSession.pendingText = streamSession.pendingText.slice(chunkSize);
      
      this.updateMessageContent(chatId, msgId, streamSession.renderedText);
    }, tickRate);

    // 发起 SSE 请求
    const requestTask = api.streamQueryRag(
      {
        user_id: sessionUserId || api.getSessionUserId(this.data.userId, chatId),
        question: question,
        top_k: 5,
        use_kg: this.data.graphEnabled,
        use_llm: !this.data.offlineMode,
        use_history: true,
        enable_retrieval_optimization: true,
        neo4j_uri: String(settings?.neo4jUri || '').trim(),
        neo4j_user: String(settings?.neo4jUser || '').trim(),
        neo4j_password: String(settings?.neo4jPassword || '').trim(),
      },
      (event, data) => {
        this.handleStreamEvent(chatId, msgId, event, data, streamSession);
      },
      (error) => {
        streamSession.pendingText += `\n\n连接异常：${error.message}`;
        streamSession.streamDone = true;
        this.finalizeStreaming(chatId, msgId);
      },
      () => {
        streamSession.streamDone = true;
        if (!streamSession.pendingText.length) {
          this.finalizeStreaming(chatId, msgId);
        }
      }
    );

    streamSession.requestTask = requestTask;
  },

  // 处理流式事件
  handleStreamEvent(chatId, msgId, event, data, streamSession) {
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    
    const msgIndex = chat.messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;

    const msg = chat.messages[msgIndex];

    if (event === 'meta') {
      msg.traceSteps = [...msg.traceSteps, { 
        stage: 'meta', 
        text: `请求已发送（${msg.isOffline ? '离线' : '在线'}模式）` 
      }];
    } else if (event === 'trace') {
      const stage = data.stage || 'trace';
      let traceText = data.message || '处理中';
      if (stage === 'retrieve') {
        traceText = `已检索知识库（命中 ${data.context_count ?? 0} 条）${typeof data.elapsed_ms === 'number' ? `，耗时 ${data.elapsed_ms}ms` : ''}`;
      } else if (stage === 'kg') {
        traceText = `已查询知识图谱（命中 ${data.kg_triplet_count ?? 0} 条）${typeof data.elapsed_ms === 'number' ? `，耗时 ${data.elapsed_ms}ms` : ''}`;
      } else if (stage === 'generate') {
        traceText = `开始生成答案（${data.mode === 'online' ? '在线模型' : '离线抽取'}）`;
      }
      msg.searchProcess = traceText;
      msg.traceSteps = [...msg.traceSteps, { stage, text: traceText }];
    } else if (event === 'token' && data.text) {
      streamSession.pendingText += data.text;
    } else if (event === 'references') {
      msg.citations = (data.citations || []).map(cit => ({
        name: cit.source || cit.doc_id || 'unknown',
        source: cit.source || '未知来源',
        docId: cit.doc_id || '',
        score: typeof cit.score === 'number' ? Math.round(cit.score * 100) : null,
        text: String(cit.text || '').trim(),
      }));
      msg.searchProcess = `检索完成，共 ${msg.citations.length} 篇参考文档`;
    } else if (event === 'kg') {
      msg.kgTriplets = data.triplets || [];
    } else if (event === 'error') {
      streamSession.pendingText += `\n\n连接失败：${data.message || 'unknown'}`;
      streamSession.streamDone = true;
    } else if (event === 'done') {
      const doneText = `回答完成（总耗时 ${data.elapsed_ms ?? '-'}ms）`;
      msg.traceSteps = [...msg.traceSteps, { stage: 'done', text: doneText }];
      msg.searchProcess = doneText;
      streamSession.streamDone = true;
    }

    chat.messages[msgIndex] = msg;
    this.setData({ chats, currentChat: chat });
  },

  // 更新消息内容到 UI
  updateMessageContent(chatId, msgId, text) {
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    
    const msgIndex = chat.messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;

    const msg = chat.messages[msgIndex];
    msg.content = text;
    msg.fullText = text;
    
    if (msg.isOffline) {
      msg.renderedContent = this.formatOfflineText(text);
    }

    chat.messages[msgIndex] = msg;
    this.setData({ chats, currentChat: chat });
  },

  // 结束流式输出
  finalizeStreaming(chatId, msgId) {
    const session = this.streamingSessions.get(msgId);
    if (!session || session.finished) return;
    
    session.finished = true;
    if (session.typeTimer) {
      clearInterval(session.typeTimer);
    }
    this.streamingSessions.delete(msgId);

    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    
    const msgIndex = chat.messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;

    const msg = chat.messages[msgIndex];
    msg.content = session.renderedText || ' ';
    msg.fullText = session.renderedText || ' ';
    msg.isStreaming = false;
    msg.isPaused = false;
    
    if (msg.isOffline) {
      msg.renderedContent = this.formatOfflineText(session.renderedText || '');
    }

    chat.messages[msgIndex] = msg;
    
    this.setData({ 
      chats, 
      currentChat: chat,
      isAnswering: false,
      activeStreamingPaused: false,
      activeStreamingMsgId: null,
    }, () => {
      this.saveChatsToServer(chats);
      this.scrollToBottom();
    });
  },

  // 暂停流式输出
  pauseStreaming(msgId) {
    const session = this.streamingSessions.get(msgId);
    if (!session) return;
    
    session.isPaused = true;
    
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === this.data.currentChatId);
    if (chat) {
      const msg = chat.messages.find(m => m.id === msgId);
      if (msg) {
        msg.isPaused = true;
        this.setData({ chats, currentChat: chat, activeStreamingPaused: true });
      }
    }
  },

  // 恢复流式输出
  resumeStreaming(e) {
    const msgId = e.currentTarget.dataset.msgid;
    const session = this.streamingSessions.get(msgId);
    if (!session) return;
    
    session.isPaused = false;
    
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === this.data.currentChatId);
    if (chat) {
      const msg = chat.messages.find(m => m.id === msgId);
      if (msg) {
        msg.isPaused = false;
        this.setData({ chats, currentChat: chat, activeStreamingPaused: false });
      }
    }
  },

  // 切换追踪面板
  toggleTrace(e) {
    const msgId = e.currentTarget.dataset.msgid;
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === this.data.currentChatId);
    if (chat) {
      const msg = chat.messages.find(m => m.id === msgId);
      if (msg) {
        msg.traceOpen = !msg.traceOpen;
        this.setData({ chats, currentChat: chat });
      }
    }
  },

  // 切换参考文献
  toggleCitations(e) {
    const msgId = e.currentTarget.dataset.msgid;
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === this.data.currentChatId);
    if (chat) {
      const msg = chat.messages.find(m => m.id === msgId);
      if (msg) {
        msg.citationsOpen = !msg.citationsOpen;
        this.setData({ chats, currentChat: chat });
      }
    }
  },

  // 切换知识图谱
  toggleKg(e) {
    const msgId = e.currentTarget.dataset.msgid;
    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === this.data.currentChatId);
    if (chat) {
      const msg = chat.messages.find(m => m.id === msgId);
      if (msg) {
        msg.kgOpen = !msg.kgOpen;
        this.setData({ chats, currentChat: chat });
      }
    }
  },

  // 新建会话
  showNewChatConfirm() {
    this.setData({ showNewChatModal: true });
  },

  hideNewChatModal() {
    this.setData({ showNewChatModal: false });
  },

  preventBubble() {},

  confirmNewChat() {
    // 中断所有流式会话
    this.streamingSessions.forEach((session) => {
      if (session.requestTask) {
        session.requestTask.abort();
      }
      if (session.typeTimer) {
        clearInterval(session.typeTimer);
      }
    });
    this.streamingSessions.clear();

    const settings = this.data.userSettings;
    this.setData({
      currentChatId: null,
      currentChat: null,
      inputValue: '',
      isAnswering: false,
      activeStreamingPaused: false,
      activeStreamingMsgId: null,
      showNewChatModal: false,
      graphEnabled: settings.graphOn ?? true,
      offlineMode: settings.offlineOn ?? false,
    });
  },

  // 文件上传
  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['md', 'pdf', 'txt'],
      success: (res) => {
        const file = res.tempFiles[0];
        this.handleUpload(file);
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '选择文件失败', icon: 'none' });
        }
      }
    });
  },

  async handleUpload(file) {
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = file.name || '未命名文件';
    
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!['md', 'pdf', 'txt'].includes(ext)) {
      this.setData({ 
        uploadStatus: { type: 'error', text: '仅支持 md / pdf / txt 文档' },
        recentUploads: [{ id: uploadId, name: fileName, status: 'error', detail: '格式不支持' }]
      });
      return;
    }

    this.setData({ 
      isUploading: true,
      uploadStatus: { type: 'info', text: `正在上传：${fileName}` },
      recentUploads: [{ id: uploadId, name: fileName, status: 'uploading', detail: '上传中...' }]
    });

    try {
      const data = await api.uploadFile(this.data.userId, file.path, fileName);
      
      this.setData({ 
        uploadStatus: { type: 'success', text: `上传成功：${fileName}` },
        recentUploads: [{ id: uploadId, name: fileName, status: 'success', detail: '索引已完成' }]
      });

      if (!this.data.isAnswering) {
        this.handleSend(`[文件已上传: ${fileName}] 已完成索引，请基于该增量数据回答。`);
      }
    } catch (err) {
      this.setData({ 
        uploadStatus: { type: 'error', text: `上传失败：${err.message}` },
        recentUploads: [{ id: uploadId, name: fileName, status: 'error', detail: err.message }]
      });
    } finally {
      this.setData({ isUploading: false });
      setTimeout(() => {
        this.setData({ uploadStatus: null });
      }, 5000);
    }
  },

  // 保存聊天记录到服务器
  async saveChatsToServer(chats) {
    if (!this.data.userSettings.autoSave) return;
    
    try {
      await api.saveUserChats(this.data.userId, chats);
      app.setChats(chats);
    } catch (err) {
      console.warn('保存聊天记录失败:', err.message);
    }
  },

  // 滚动到底部
  scrollToBottom() {
    this.setData({ scrollToMessage: 'msg-bottom' });
  },

  // 格式化离线文本（简化版）
  formatOfflineText(text = '') {
    if (!text) return '';
    return api.stripMarkdown(text)
      .replace(/\\leq/g, '≤')
      .replace(/\\geq/g, '≥')
      .replace(/\\pm/g, '±')
      .replace(/\\sim/g, '~')
      .replace(/\\times/g, '×')
      .replace(/\\%/g, '%')
      .replace(/\^\{\\circ\}/g, '°')
      .replace(/\\circ/g, '°')
      .replace(/\\mathrm\{([^}]*)\}/g, '$1')
      .replace(/\\text\{([^}]*)\}/g, '$1')
      .replace(/\\left|\\right/g, '')
      .replace(/[{}]/g, '')
      .replace(/\\/g, '')
      .replace(/\s+([,.;:，。；：])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  onUnload() {
    // 清理所有流式会话
    this.streamingSessions.forEach((session) => {
      if (session.requestTask) {
        session.requestTask.abort();
      }
      if (session.typeTimer) {
        clearInterval(session.typeTimer);
      }
    });
    this.streamingSessions.clear();
  },
});
