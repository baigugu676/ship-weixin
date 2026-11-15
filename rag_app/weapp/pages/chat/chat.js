// pages/chat/chat.js
const api = require('../../utils/api.js');
const markdown = require('../../utils/markdown.js');
const app = getApp();
const sync = require('../../utils/chat-sync.js');
const exporter = require('../../utils/export.js');

const QUICK_CARDS = [
  { title: "主机故障诊断", desc: "分析推进系统异常", icon: "⚙️" },
  { title: "电气系统咨询", desc: "电路故障排查建议", icon: "⚡" },
  { title: "液压系统分析", desc: "压力与流量优化", icon: "💧" },
  { title: "维护周期建议", desc: "基于历史数据分析", icon: "🔧" },
];

Page({
  data: {
    appearance: 'dark',
    fontSize: 16,
    queryMode: 'auto',
    queryModes: ['自动识别', '设备数据库', '知识库'],
    queryModeIndex: 0,
    demoQuestions: [],
    syncError: '',
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
    showQueryDetails: false,
    queryRecords: [],
    quickCards: QUICK_CARDS,
    graphEnabled: true,
    offlineMode: false,
    activeStreamingPaused: false,
    // 图片识别（上传 → 在线VL描述 → 故障诊断）
    pendingImage: null,
    visionHint: '',
    visionBusy: false,
    visionDesc: '',
    visionError: '',
    visionCollapsed: false,
  },

  streamingSessions: new Map(),

  onLoad() {
    this.streamingSessions = new Map();
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
    if (!app.globalData.userInfo) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.initUserData();
    this.setData(app.appearance());
    if (app.globalData.selectedChatId) {
      const id = app.globalData.selectedChatId;
      app.globalData.selectedChatId = null;
      this.setData({ currentChatId: id, currentChat: this.data.chats.find(c => c.id === id) || null });
    }
    this.syncFromServer();
    if (this.unsubscribeSync) this.unsubscribeSync();
    this.unsubscribeSync = app.subscribeSync(() => this.applyCloudState());
    api.getEquipmentOverview().then(data => this.setData({ demoQuestions: data.demo_questions || [] })).catch(() => {});
    if (app.globalData.pendingQuestion && !this.data.isAnswering) {
      const question = app.globalData.pendingQuestion;
      app.globalData.pendingQuestion = null;
      this.confirmNewChat();
      this.setData({ queryMode: 'equipment', queryModeIndex: 1 });
      this.handleSend(question, null, { useLlm: false });
    }
  },

  onHide() {
    this.setData({ showQueryDetails: false });
    if (this.unsubscribeSync) this.unsubscribeSync();
    if (app.globalData.userInfo) app.setChats(this.snapshotChats(this.data.chats));
  },

  async retrySync() { await this.saveChatsToServer(this.data.chats); await this.syncFromServer(); },

  applyCloudState() {
    if (app.globalData.userInfo?.user_id !== this.data.userId) return;
    if ((app.globalData.deletedChatIds || []).includes(this.data.currentChatId)) this.stopStreams();
    this.initUserData();
    this.setData({ ...app.appearance(), syncError: app.globalData.syncStatus.error || '' });
  },

  async syncFromServer() {
    const userId = this.data.userId;
    if (!userId || this.syncBusy) return;
    this.syncBusy = true;
    try {
      await app.syncNow();
      if (app.globalData.userInfo?.user_id !== userId) return;
      const chats = this.mergeChats(this.data.chats, app.globalData.chats || []);
      const currentChat = chats.find(c => c.id === this.data.currentChatId) || null;
      if (!currentChat && this.data.currentChatId) this.stopStreams();
      this.setData({ chats, currentChat, currentChatId: currentChat ? currentChat.id : null, syncError: '' });
      this.initUserData();
      app.setChats(this.snapshotChats(chats));
    } catch (err) { this.setData({ syncError: '同步失败，记录已保存在本机。点此重试' }); }
    finally { this.syncBusy = false; }
  },

  goToEquipment() { wx.navigateTo({ url: '/pages/equipment/equipment' }); },
  onQueryModeChange(e) {
    if (this.data.isAnswering) return;
    const index = Number(e.detail.value);
    this.setData({ queryModeIndex: index, queryMode: ['auto', 'equipment', 'knowledge'][index] });
  },
  onDemoQuestion(e) {
    if (this.data.isAnswering) return;
    this.setData({ queryMode: 'equipment', queryModeIndex: 1 });
    this.handleSend(e.currentTarget.dataset.question, null, { useLlm: false });
  },
  exportCurrentChat() {
    if (this.data.currentChat) exporter.exportChats([this.data.currentChat]).catch(() => wx.showToast({ title: '导出失败', icon: 'none' }));
  },
  copyMessage(e) {
    const msg = this.data.currentChat?.messages.find(m => m.id === e.currentTarget.dataset.msgid);
    if (msg) wx.setClipboardData({ data: msg.content || '' });
  },
  toggleSql(e) { this.toggleMessageFlag(e.currentTarget.dataset.msgid, 'sqlOpen'); },
  openQueryDetails() {
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this.refreshQueryDetails();
    this.setData({ showQueryDetails: true });
  },
  closeQueryDetails() { this.setData({ showQueryDetails: false }); },
  refreshQueryDetails() {
    let question = '';
    const records = [];
    for (const message of this.data.currentChat?.messages || []) {
      if (message.role === 'user') question = message.content;
      else if (message.databaseResult) {
        const result = message.databaseResult;
        records.push({
          id: message.id || `query-${records.length}`, question, result,
          parametersText: JSON.stringify(result.parameters || {}, null, 2),
          generatedBy: result.generated_by === 'llm' ? '模型生成' : ['template', 'rule'].includes(result.generated_by) ? '内置规则' : '未记录',
          rows: (result.rows || []).map(row => (result.columns || []).map(column => row[column] == null ? '未记录' : String(row[column]))),
        });
      }
    }
    this.setData({ queryRecords: records });
  },
  copyQuerySQL(e) {
    const record = this.data.queryRecords.find(record => record.id === e.currentTarget.dataset.id);
    if (record) wx.setClipboardData({ data: `${record.result.sql || ''}\n\n绑定参数：\n${record.parametersText}` });
  },
  toggleMessageFlag(id, key) {
    const chats = this.data.chats.map(c => c.id !== this.data.currentChatId ? c : {
      ...c, messages: c.messages.map(m => m.id !== id ? m : { ...m, [key]: !m[key] }),
    });
    this.setData({ chats, currentChat: chats.find(c => c.id === this.data.currentChatId) });
  },
  exportSqlResult(e) {
    const msg = this.data.currentChat?.messages.find(m => m.id === e.currentTarget.dataset.msgid);
    const result = msg?.databaseResult;
    if (result) exporter.exportFile(`equipment-query-${Date.now()}.csv`, exporter.csvText(result.columns || [], result.rows || []))
      .catch(() => wx.showToast({ title: '导出失败', icon: 'none' }));
  },

  initUserData() {
    const userInfo = app.globalData.userInfo;
    if (this.data.userId && this.data.userId !== userInfo.user_id) {
      for (const session of this.streamingSessions.values()) {
        if (session.requestTask) session.requestTask.abort();
        clearInterval(session.typeTimer);
      }
      this.streamingSessions.clear();
      this.setData({ chats: [], currentChat: null, currentChatId: null, isAnswering: false,
        activeStreamingPaused: false, activeStreamingMsgId: null, pendingImage: null,
        visionDesc: '', visionHint: '', visionError: '', recentUploads: [], syncError: '' });
    }
    const settings = api.normalizeSettings(app.globalData.settings);

    // 关键：合并而不是覆盖。
    // onShow 每次切回本页都会走到这里，若直接拿 globalData.chats 覆盖，
    // 会把"本轮对话还没保存的会话"从列表里抹掉；之后 handleSend 按 chatId
    // 找不到会话，新消息和流式回答就全部追加到虚空（表现为没有回答 + 输入框永久锁死）。
    const chats = this.mergeChats(this.data.chats, app.globalData.chats || []);

    let currentChat = this.data.currentChat;
    let currentChatId = this.data.currentChatId;
    if (currentChatId) {
      const found = chats.find(c => c.id === currentChatId);
      if (found) {
        currentChat = found;
      } else if (currentChat && currentChat.id === currentChatId && !(app.globalData.deletedChatIds || []).includes(currentChatId)) {
        // 会话只在内存里（还没落库），就地登记回来
        chats.unshift(currentChat);
      } else {
        // 彻底找不到，避免停在"空白消息区 + 锁死输入框"的死状态
        currentChat = null;
        currentChatId = null;
      }
    }

    const nickname = settings.nickname || 'Captain Park';
    const avatarText = nickname.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

    this.setData({
      userId: userInfo.user_id || '',
      userSettings: settings,
      userAvatarText: avatarText,
      chats: chats,
      currentChatId,
      currentChat,
      graphEnabled: settings.graphOn ?? true,
      offlineMode: settings.offlineOn ?? false,
    });
    if (this.data.showQueryDetails) this.refreshQueryDetails();
  },

  // 按 id 合并会话列表：本地优先（可能正在流式输出），远端只补本地没有的
  mergeChats(localChats, remoteChats) {
    return sync.mergeChats(localChats, remoteChats, app.globalData.deletedChatIds || []).map(markdown.decorateChat);
  },

  // 给消息补上渲染字段：content 保留原始 Markdown（存档用），
  // displayText 是去标记的纯文本（流式阶段显示），renderedContent 是富文本 HTML（收尾后显示）
  decorateMessage(msg) {
    return markdown.decorateMessage(msg);
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
    } else if (isAnswering && activeStreamingPaused) {
      this.resumeStreaming({ currentTarget: { dataset: { msgid: activeStreamingMsgId } } });
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
  async handleSend(text, imagePath, options = {}) {
    // bindconfirm 会把事件对象传进来，做一层保护
    if (text && typeof text !== 'string') text = this.data.inputValue;
    text = (text || this.data.inputValue || '').trim();
    if (!text) return;

    if (this.data.isAnswering) {
      wx.showToast({ title: '请等待当前回答完成', icon: 'none' });
      return;
    }

    this.setData({ inputValue: '' });

    let chatId = this.data.currentChatId;
    let chats = [...this.data.chats];
    let sessionUserId = '';

    // 兜底：currentChatId 指向的会话不在列表里（被覆盖、或从历史页带进来），
    // 先把它登记回列表，否则下面的 map 找不到目标，消息会全部丢失。
    if (chatId && !chats.some(c => c.id === chatId)) {
      if (this.data.currentChat && this.data.currentChat.id === chatId) {
        chats = [this.data.currentChat, ...chats];
      } else {
        chatId = null; // 彻底找不到就按新会话处理
      }
    }

    if (!chatId) {
      chatId = sync.uniqueId('wx');
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

    const userMsg = { id: sync.uniqueId('user'), role: 'user', content: text };
    if (imagePath) userMsg.image = imagePath;
    const msgId = sync.uniqueId('ai');
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
      isOffline: options.useLlm === false || this.data.offlineMode,
      isGraphEnabled: this.data.graphEnabled,
      traceOpen: true,
      citationsOpen: false,
      kgOpen: false,
      renderedContent: '',
      displayText: '',
    };

    const existingMessages = chats.find(c => c.id === chatId)?.messages || [];
    chats = chats.map(c =>
      c.id === chatId
        ? { ...c, messages: [...existingMessages, userMsg, aiMsg] }
        : c
    );

    const updatedChat = chats.find(c => c.id === chatId);
    if (!updatedChat) {
      // 理论上不该发生；真发生也别让输入框永久锁死
      this.setData({ isAnswering: false, activeStreamingMsgId: null });
      wx.showToast({ title: '会话状态异常，请新建对话', icon: 'none' });
      return;
    }

    this.setData({ 
      chats, 
      isAnswering: true, 
      activeStreamingPaused: false,
      activeStreamingMsgId: msgId,
      currentChat: updatedChat
    }, () => {
      this.scrollToBottom();
    });

    app.setChats(this.snapshotChats(chats));
    this.startStreaming(chatId, msgId, text, sessionUserId, options);
  },

  // 开始流式输出
  startStreaming(chatId, msgId, question, sessionUserId, options = {}) {
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
        use_llm: options.useLlm ?? !this.data.offlineMode,
        ...(!(options.useLlm ?? !this.data.offlineMode) ? { enable_decompose: false } : {}),
        query_mode: this.data.queryMode,
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
    } else if (event === 'sql_result') {
      msg.databaseResult = data;
      msg.databaseRows = (data.rows || []).map(row => (data.columns || []).map(col => row[col] == null ? '—' : String(row[col])));
      msg.sqlOpen = true;
      msg.isGraphEnabled = false;
      msg.searchProcess = `设备数据库查询完成，返回 ${data.row_count} 条记录`;
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
    this.setData({ chats, ...(this.data.currentChatId === chatId ? { currentChat: chat } : {}) });
    if (this.data.showQueryDetails && event === 'sql_result') this.refreshQueryDetails();
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
    // 流式阶段只显示去标记的纯文本，富文本留给收尾时一次性渲染（每帧转换太贵）
    msg.displayText = markdown.toPlainText(text);
    msg.renderedContent = '';

    chat.messages[msgIndex] = msg;
    this.setData({ chats, ...(this.data.currentChatId === chatId ? { currentChat: chat } : {}) });
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
    if (this.data.userSettings.notify && typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light', fail() {} });

    const chats = [...this.data.chats];
    const chat = chats.find(c => c.id === chatId);
    if (!chat) {
      // 会话不在了也别让 isAnswering 卡在 true（否则输入框永久禁用，只能杀进程重进）
      this.setData({
        isAnswering: false,
        activeStreamingPaused: false,
        activeStreamingMsgId: null,
      });
      return;
    }
    
    const msgIndex = chat.messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) {
      this.setData({
        isAnswering: false,
        activeStreamingPaused: false,
        activeStreamingMsgId: null,
      });
      return;
    }

    const msg = chat.messages[msgIndex];
    // 把还没来得及打字机渲染的尾巴（含错误提示）也收进最终内容，避免收尾时丢文本
    const rawText = (session.renderedText || '') + (session.pendingText || '');
    // 后端一个 token 都没吐时，原来是留一条空白气泡（看着像"没有结果"），这里给出明确提示
    const finalText = rawText.trim() ? rawText : '（本次没有返回内容，请重试或换一种问法）';
    msg.content = finalText;
    msg.fullText = finalText;
    msg.displayText = markdown.toPlainText(finalText);
    msg.renderedContent = markdown.toRichNodes(finalText);
    msg.isStreaming = false;
    msg.isPaused = false;
    if (!rawText.trim()) {
      msg.traceSteps = [
        ...(msg.traceSteps || []),
        { stage: 'empty', text: '后端未返回任何内容（可能是模型侧空响应或超时）' },
      ];
    }

    chat.messages[msgIndex] = msg;
    
    this.setData({ 
      chats, 
      ...(this.data.currentChatId === chatId ? { currentChat: chat } : {}),
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
        msg.kgEdges = msg.kgTriplets || [];
        msg.kgFilter = '';
        this.setData({ chats, currentChat: chat });
      }
    }
  },

  filterKg(e) {
    const msgId = e.currentTarget.dataset.msgid;
    const term = String(e.currentTarget.dataset.entity ?? e.detail?.value ?? '').trim();
    const chats = this.data.chats.map(chat => chat.id !== this.data.currentChatId ? chat : {
      ...chat, messages: chat.messages.map(msg => msg.id !== msgId ? msg : {
        ...msg, kgFilter: term,
        kgEdges: (msg.kgTriplets || []).filter(edge => [edge.head, edge.tail, edge.rel || edge.relation].some(value => String(value || '').toLowerCase().includes(term.toLowerCase()))),
      }),
    });
    this.setData({ chats, currentChat: chats.find(chat => chat.id === this.data.currentChatId) });
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
    this.stopStreams();

    // 被打断的消息不能再带着 isStreaming，否则回到该会话时光标会一直闪
    const chats = this.snapshotChats(this.data.chats);

    const settings = this.data.userSettings;
    this.setData({
      chats,
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

    // 弹窗里承诺了"当前会话内容将自动保存"：原来这里什么都没做，
    // 中途打断/没答完的会话就永远不会出现在历史里。
    this.saveChatsToServer(chats);
  },

  // 存档快照：消息去掉流式中间态，避免写入 isStreaming 之类的临时字段
  snapshotChats(chats) {
    return (chats || []).map(chat => ({
      ...chat,
      messages: (chat.messages || []).map(msg => ({
        ...msg,
        isStreaming: false,
        isPaused: false,
      })),
    }));
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

  // ===================== 图片识别（在线VL描述 → 故障诊断） =====================

  // 选择设备图片
  chooseImage() {
    if (this.data.visionBusy) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          this.setData({ visionError: '图片过大，请选择 10MB 以内的图片' });
          return;
        }
        this.setData({
          pendingImage: { path: file.tempFilePath },
          visionDesc: '',
          visionError: '',
          visionHint: '',
          visionCollapsed: false,
        });
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '选择图片失败', icon: 'none' });
        }
      },
    });
  },

  onVisionHintInput(e) {
    this.setData({ visionHint: e.detail.value });
  },

  onVisionDescInput(e) {
    this.setData({ visionDesc: e.detail.value });
  },

  // 调用在线视觉模型，把图片描述成一段话
  async runVisionDescribe() {
    const { pendingImage, visionBusy, visionHint } = this.data;
    if (!pendingImage?.path || visionBusy) return;
    this.setData({ visionBusy: true, visionError: '' });
    wx.showLoading({ title: '识别中…', mask: true });
    try {
      const data = await api.describeImage(this.data.userId, pendingImage.path, (visionHint || '').trim());
      this.setData({ visionDesc: data.description || '' });
    } catch (err) {
      this.setData({ visionError: err.message || '图片识别失败，请稍后重试' });
    } finally {
      wx.hideLoading();
      this.setData({ visionBusy: false });
    }
  },

  // 用（可编辑后的）描述发起故障诊断，走常规流式问答
  // 诊断后折叠而不是清除：回答期间可展开回看/修改后重新诊断
  diagnoseFromVision() {
    const desc = (this.data.visionDesc || '').trim();
    if (!desc || this.data.isAnswering) return;
    const imagePath = this.data.pendingImage?.path;
    this.setData({ visionCollapsed: true });
    this.handleSend(desc, imagePath);
  },

  expandVisionPanel() {
    this.setData({ visionCollapsed: false });
  },

  collapseVisionPanel() {
    if (this.data.visionBusy) return;
    this.setData({ visionCollapsed: true });
  },

  dismissPendingImage() {
    if (this.data.visionBusy) return;
    this.setData({ pendingImage: null, visionDesc: '', visionHint: '', visionError: '', visionCollapsed: false });
  },

  // 保存聊天记录：先落本地（历史页立刻可见，不再被网络往返卡住），再同步服务端
  async saveChatsToServer(chats) {
    if (!this.data.userId || app.globalData.userInfo?.user_id !== this.data.userId) return;
    const snapshot = this.snapshotChats(chats);

    // 本地缓存一定要更新：原来只在服务端保存成功后才 setChats，
    // 一旦这个 PUT 失败（断网/超时/后端 500），历史页就永远是空的。
    app.setChats(snapshot);

    if (!this.data.userSettings.autoSave) return;

    // user_id 缺失时绝不能发请求：encodeURIComponent(undefined) === "undefined"，
    // 记录会被写到 /users/undefined/chats 这个"幽灵账号"下，当前账号自然查不到。
    const userId = this.data.userId || app.globalData.userInfo?.user_id || '';
    if (!userId) {
      console.warn('未登录或 user_id 缺失，跳过服务端保存');
      return;
    }

    try {
      await app.persistChats(snapshot);
      if (app.globalData.userInfo?.user_id !== userId) return;
      const merged = this.mergeChats(this.data.chats, app.globalData.chats || []);
      app.setChats(this.snapshotChats(merged));
      const currentChat = merged.find(c => c.id === this.data.currentChatId) || null;
      this.setData({ chats: merged, currentChat, currentChatId: currentChat?.id || null, syncError: '' });
    } catch (err) {
      this.setData({ syncError: '云端保存失败，记录已保存在本机。点此重试' });
    }
  },

  // 滚动到底部
  scrollToBottom() {
    this.setData({ scrollToMessage: 'msg-bottom' });
  },

  // 格式化离线文本（统一走 markdown 工具，保持在线/离线一致）
  formatOfflineText(text = '') {
    return markdown.toPlainText(text);
  },

  stopStreams() {
    for (const [msgId, session] of [...this.streamingSessions.entries()]) {
      const chat = this.data.chats.find(c => (c.messages || []).some(m => m.id === msgId));
      if (session.requestTask) session.requestTask.abort();
      if (chat) this.finalizeStreaming(chat.id, msgId);
      else { clearInterval(session.typeTimer); this.streamingSessions.delete(msgId); }
    }
    this.setData({ isAnswering: false, activeStreamingPaused: false, activeStreamingMsgId: null });
  },
  onUnload() {
    if (this.unsubscribeSync) this.unsubscribeSync();
    clearInterval(this.syncTimer);
    this.stopStreams();
  },
});
