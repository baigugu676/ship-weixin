// pages/login/login.js
const api = require('../../utils/api.js');
const app = getApp();

Page({
  data: {
    userId: '',
    password: '',
    showPassword: false,
    loading: false,
    error: '',
  },

  onLoad() {
    // 如果已登录，直接跳转到聊天页
    if (app.globalData.userInfo) {
      wx.switchTab({ url: '/pages/chat/chat' });
    }
  },

  onUserIdInput(e) {
    this.setData({ userId: e.detail.value, error: '' });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value, error: '' });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  async handleLogin() {
    const { userId, password } = this.data;
    
    if (!userId.trim() || !password) {
      this.setData({ error: '请输入用户名和密码' });
      return;
    }

    this.setData({ loading: true, error: '' });

    try {
      const data = await api.login(userId.trim(), password);
      
      if (data.ok && data.user) {
        // 保存用户数据
        app.setUserInfo(data.user);
        app.setSettings(api.normalizeSettings(data.settings));
        app.setChats(data.chats || []);

        wx.showToast({
          title: '登录成功',
          icon: 'success',
          duration: 1500,
        });

        setTimeout(() => {
          wx.switchTab({ url: '/pages/chat/chat' });
        }, 500);
      } else {
        this.setData({ error: data.detail || '登录失败' });
      }
    } catch (err) {
      this.setData({ error: err.message || '网络错误，请检查后端服务' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
