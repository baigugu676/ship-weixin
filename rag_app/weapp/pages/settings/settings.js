// pages/settings/settings.js
const api = require('../../utils/api.js');
const app = getApp();

Page({
  data: {
    settings: {},
    userAvatarText: 'CP',
    apiBaseURL: '',
    showLogoutModal: false,
  },

  onShow() {
    if (!app.globalData.userInfo) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.loadSettings();
  },

  loadSettings() {
    const settings = api.normalizeSettings(app.globalData.settings);
    const nickname = settings.nickname || 'Captain Park';
    const avatarText = nickname.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    
    this.setData({
      settings,
      userAvatarText: avatarText,
      apiBaseURL: app.globalData.apiBaseURL,
    });
  },

  onSwitchChange(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    
    const settings = { ...this.data.settings, [key]: value };
    this.setData({ settings });
    
    app.setSettings(settings);
    this.saveSettings(settings);
  },

  onInputBlur(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    
    const settings = { ...this.data.settings, [key]: value };
    this.setData({ settings });
    
    app.setSettings(settings);
    this.saveSettings(settings);
  },

  async saveSettings(settings) {
    try {
      const userId = app.globalData.userInfo.user_id;
      await api.saveUserSettings(userId, settings, userId);
    } catch (err) {
      console.warn('保存设置失败:', err.message);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  showLogoutModal() {
    this.setData({ showLogoutModal: true });
  },

  hideLogoutModal() {
    this.setData({ showLogoutModal: false });
  },

  preventBubble() {},

  confirmLogout() {
    this.setData({ showLogoutModal: false });
    app.clearUserData();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
