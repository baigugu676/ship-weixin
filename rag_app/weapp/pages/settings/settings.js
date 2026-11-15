// pages/settings/settings.js
const api = require('../../utils/api.js');
const app = getApp();

Page({
  data: {
    settings: {},
    appearance: 'dark',
    fontSize: 16,
    themes: ['深色', '浅色', '跟随系统'],
    themeIndex: 0,
    userRole: 0,
    error: '',
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
    const userId = app.globalData.userInfo.user_id;
    const revision = this.settingsRevision || 0;
    api.getUserSettings(userId).then(data => {
      if (app.globalData.userInfo?.user_id !== userId || (this.settingsRevision || 0) !== revision) return;
      app.setSettings(api.normalizeSettings(data.settings)); this.loadSettings();
    }).catch(() => this.setData({ error: '无法加载云端设置，正在使用本机设置' }));
  },

  loadSettings() {
    const settings = api.normalizeSettings(app.globalData.settings);
    const nickname = settings.nickname || 'Captain Park';
    const avatarText = nickname.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    
    this.setData({
      settings,
      ...app.appearance(),
      themeIndex: Math.max(0, ['dark', 'light', 'system'].indexOf(settings.theme)),
      userRole: Number(app.globalData.userInfo?.role || 0),
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
    this.saveSettings({ [key]: value });
  },

  onInputBlur(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    
    const settings = { ...this.data.settings, [key]: value };
    this.setData({ settings });
    
    app.setSettings(settings);
    this.saveSettings({ [key]: value });
  },

  async saveSettings(settings) {
    this.settingsRevision = (this.settingsRevision || 0) + 1;
    try {
      const userId = app.globalData.userInfo.user_id;
      await api.saveUserSettings(userId, settings, userId);
      this.setData({ error: '' });
      this.loadSettings();
    } catch (err) {
      console.warn('保存设置失败:', err.message);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  onThemeChange(e) {
    const value = ['dark', 'light', 'system'][Number(e.detail.value)];
    app.setSettings({ ...this.data.settings, theme: value });
    this.loadSettings(); this.saveSettings({ theme: value });
  },
  onSliderChange(e) {
    const key = e.currentTarget.dataset.key;
    const value = Number(e.detail.value);
    app.setSettings({ ...this.data.settings, [key]: value });
    this.loadSettings(); this.saveSettings({ [key]: value });
  },
  goToEquipment() { wx.navigateTo({ url: '/pages/equipment/equipment' }); },
  goToHistory() { wx.switchTab({ url: '/pages/history/history' }); },
  showLogoutModal() {
    this.setData({ showLogoutModal: true });
  },

  hideLogoutModal() {
    this.setData({ showLogoutModal: false });
  },

  preventBubble() {},

  confirmLogout() {
    this.setData({ showLogoutModal: false });
    const chatPage = getCurrentPages().find(p => p.route === 'pages/chat/chat');
    if (chatPage) chatPage.stopStreams();
    app.clearUserData();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
