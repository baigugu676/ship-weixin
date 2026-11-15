// app.js
App({
  globalData: {
    userInfo: null,
    settings: null,
    chats: [],
    deletedChatIds: [],
    selectedChatId: null,
    pendingQuestion: null,
    apiBaseURL: 'http://127.0.0.1:8000', // 本地开发；真机或云端地址可在登录页配置
  },

  onLaunch() {
    const apiBaseURL = wx.getStorageSync('apiBaseURL');
    if (apiBaseURL) this.globalData.apiBaseURL = apiBaseURL;
    // 尝试从本地存储恢复登录状态
    const userInfo = wx.getStorageSync('userInfo');
    const settings = wx.getStorageSync('settings');
    const chats = wx.getStorageSync('chats') || [];
    
    if (userInfo) {
      this.globalData.userInfo = userInfo;
      this.globalData.settings = settings;
      this.globalData.chats = chats;
      this.globalData.deletedChatIds = wx.getStorageSync('deletedChatIds') || [];
    }
    
    console.log('智能船舶问答小程序已启动');
  },

  setAPIBaseURL(value) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+(?::\d+)?(?:\/[^\s?#]*)?$/i.test(url)) throw new Error('请输入有效的 HTTP / HTTPS 后端地址');
    this.globalData.apiBaseURL = url;
    wx.setStorageSync('apiBaseURL', url);
  },

  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
    wx.setStorageSync('userInfo', userInfo);
  },

  setSettings(settings) {
    this.globalData.settings = settings;
    wx.setStorageSync('settings', settings);
  },

  setChats(chats) {
    this.globalData.chats = chats;
    wx.setStorageSync('chats', chats);
  },

  setDeletedChatIds(ids) {
    this.globalData.deletedChatIds = [...new Set([...(this.globalData.deletedChatIds || []), ...(ids || [])])];
    wx.setStorageSync('deletedChatIds', this.globalData.deletedChatIds);
    this.setChats(this.globalData.chats.filter(c => !this.globalData.deletedChatIds.includes(c.id)));
  },

  appearance() {
    const settings = this.globalData.settings || {};
    let theme = settings.theme || 'dark';
    if (theme === 'system') theme = wx.getSystemInfoSync().theme || 'dark';
    return { appearance: theme === 'light' ? 'light' : 'dark', fontSize: Number(settings.fontSize) || 16 };
  },

  clearUserData() {
    this.globalData.userInfo = null;
    this.globalData.settings = null;
    this.globalData.chats = [];
    this.globalData.deletedChatIds = [];
    this.globalData.selectedChatId = null;
    this.globalData.pendingQuestion = null;
    wx.removeStorageSync('deletedChatIds');
    wx.removeStorageSync('userInfo');
    wx.removeStorageSync('settings');
    wx.removeStorageSync('chats');
  }
});
