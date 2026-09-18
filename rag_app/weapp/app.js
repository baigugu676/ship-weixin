// app.js
App({
  globalData: {
    userInfo: null,
    settings: null,
    chats: [],
    apiBaseURL: 'http://localhost:8000', // 开发环境默认地址，生产环境请修改为实际域名
  },

  onLaunch() {
    // 尝试从本地存储恢复登录状态
    const userInfo = wx.getStorageSync('userInfo');
    const settings = wx.getStorageSync('settings');
    const chats = wx.getStorageSync('chats') || [];
    
    if (userInfo) {
      this.globalData.userInfo = userInfo;
      this.globalData.settings = settings;
      this.globalData.chats = chats;
    }
    
    console.log('智能船舶问答小程序已启动');
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

  clearUserData() {
    this.globalData.userInfo = null;
    this.globalData.settings = null;
    this.globalData.chats = [];
    wx.removeStorageSync('userInfo');
    wx.removeStorageSync('settings');
    wx.removeStorageSync('chats');
  }
});
