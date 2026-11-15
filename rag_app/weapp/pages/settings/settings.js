// pages/settings/settings.js
const api = require('../../utils/api.js');
const exporter = require('../../utils/export.js');
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
    syncText: '尚未同步', connectionStatus: '', testingConnection: false,
  },

  onShow() {
    if (!app.globalData.userInfo) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.loadSettings();
    if (this.unsubscribeSync) this.unsubscribeSync();
    this.unsubscribeSync = app.subscribeSync(() => this.loadSettings());
    const userId = app.globalData.userInfo.user_id;
    const revision = this.settingsRevision || 0;
    app.syncNow().then(() => {
      if (app.globalData.userInfo?.user_id !== userId || (this.settingsRevision || 0) !== revision) return;
      this.loadSettings();
    }).catch(() => this.setData({ error: '无法加载云端设置，正在使用本机设置' }));
  },
  onHide() { if (this.unsubscribeSync) this.unsubscribeSync(); },
  onUnload() { if (this.unsubscribeSync) this.unsubscribeSync(); },

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
      syncText: ({ idle: '尚未同步', syncing: '正在同步', pending: '有待补传记录', synced: '已与网页端同步', offline: '离线保存，联网后自动补传' })[app.globalData.syncStatus.state],
      error: app.globalData.syncStatus.error || '',
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
      await app.persistSettings(settings);
      if (app.globalData.userInfo?.user_id !== userId) return;
      this.setData({ error: '' });
      this.loadSettings();
    } catch (err) {
      console.warn('保存设置失败:', err.message);
      this.setData({ error: '设置已保存在本机，联网后会自动补传' });
    }
  },
  async syncNow() {
    try { await app.syncNow(); wx.showToast({ title: '同步完成', icon: 'success' }); }
    catch (error) { this.setData({ error: error.message }); }
  },
  async exportPersonalData() {
    const { neo4jPassword, ...settings } = app.globalData.settings || {};
    try {
      await exporter.exportFile(`ship-personal-${Date.now()}.json`, JSON.stringify({
        exportTime: new Date().toISOString(), settings, chats: app.globalData.chats,
      }, null, 2));
    } catch (error) { this.setData({ error: error.message || '导出失败' }); }
  },
  copyServerURL() { wx.setClipboardData({ data: app.globalData.apiBaseURL }); },
  async testConnection() {
    if (this.data.testingConnection) return;
    this.setData({ testingConnection: true, connectionStatus: '' });
    try {
      const data = await api.getEquipmentOverview(10000);
      this.setData({ connectionStatus: `连接正常 · ${data.counts?.equipment || 0} 台设备` });
    } catch (error) { this.setData({ connectionStatus: `连接失败：${error.message}` }); }
    finally { this.setData({ testingConnection: false }); }
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
