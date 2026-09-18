// pages/history/history.js
const app = getApp();

Page({
  data: {
    chats: [],
    showClearModal: false,
  },

  onShow() {
    if (!app.globalData.userInfo) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.loadChats();
  },

  loadChats() {
    const chats = app.globalData.chats || [];
    const formattedChats = chats.map(chat => {
      const messageCount = chat.messages?.length || 0;
      const date = chat.createdAt ? new Date(chat.createdAt) : new Date();
      const now = new Date();
      const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
      
      let dateText;
      if (diffDays === 0) {
        dateText = '今天';
      } else if (diffDays === 1) {
        dateText = '昨天';
      } else if (diffDays < 7) {
        dateText = `${diffDays} 天前`;
      } else {
        dateText = `${date.getMonth() + 1}月${date.getDate()}日`;
      }

      return {
        ...chat,
        messageCount,
        dateText,
      };
    });

    this.setData({ chats: formattedChats });
  },

  loadChat(e) {
    const chatId = e.currentTarget.dataset.id;
    const chat = this.data.chats.find(c => c.id === chatId);
    if (!chat) return;

    // 将选中的聊天标记为当前聊天，然后跳转到聊天页
    const chatPage = getCurrentPages().find(p => p.route === 'pages/chat/chat');
    if (chatPage) {
      chatPage.setData({
        currentChatId: chatId,
        currentChat: chat,
      });
    }

    wx.switchTab({ url: '/pages/chat/chat' });
  },

  goToChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },

  showClearModal() {
    this.setData({ showClearModal: true });
  },

  hideClearModal() {
    this.setData({ showClearModal: false });
  },

  preventBubble() {},

  async confirmClear() {
    this.setData({ showClearModal: false });
    
    try {
      const api = require('../../utils/api.js');
      await api.saveUserChats(app.globalData.userInfo.user_id, []);
      app.setChats([]);
      this.setData({ chats: [] });
      
      wx.showToast({ title: '已清空', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: '清空失败', icon: 'none' });
    }
  },
});
