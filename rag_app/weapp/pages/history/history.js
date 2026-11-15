const api = require('../../utils/api.js');
const sync = require('../../utils/chat-sync.js');
const exporter = require('../../utils/export.js');
const app = getApp();
Page({
  data: { chats: [], allChats: [], search: '', showClearModal: false, loading: false, error: '', busy: false, appearance: 'dark', fontSize: 16 },
  onShow() {
    if (!app.globalData.userInfo) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.setData(app.appearance());
    if (this.unsubscribeSync) this.unsubscribeSync();
    this.unsubscribeSync = app.subscribeSync(() => {
      this.setData(app.appearance());
      this.renderChats(app.globalData.chats || []);
    });
    this.loadChats();
  },
  onHide() { if (this.unsubscribeSync) this.unsubscribeSync(); },
  onUnload() { if (this.unsubscribeSync) this.unsubscribeSync(); },
  async onPullDownRefresh() { await this.loadChats(); wx.stopPullDownRefresh(); },
  async loadChats() {
    if (this.data.loading) return;
    this.renderChats(app.globalData.chats || []);
    const userId = app.globalData.userInfo?.user_id;
    if (!userId) return;
    this.setData({ loading: true, error: '' });
    try {
      await app.syncNow();
      if (app.globalData.userInfo?.user_id !== userId) return;
      const chats = sync.mergeChats(app.globalData.chats, [], app.globalData.deletedChatIds);
      app.setChats(chats);
      this.renderChats(chats);
    } catch (err) { this.setData({ error: '同步失败，正在显示本机记录。点击重试' }); }
    finally { this.setData({ loading: false }); }
  },
  renderChats(chats) {
    const allChats = (chats || []).map(chat => ({ ...chat,
      messageCount: chat.messages?.length || 0,
      dateText: chat.createdAt ? String(chat.createdAt).slice(0, 10) : '',
    }));
    this.setData({ allChats });
    this.filterChats();
  },
  onSearch(e) { this.setData({ search: e.detail.value }); this.filterChats(); },
  filterChats() {
    const term = this.data.search.toLowerCase().trim();
    this.setData({ chats: this.data.allChats.filter(c => !term || String(c.title).toLowerCase().includes(term) || (c.messages || []).some(m => String(m.content).toLowerCase().includes(term))) });
  },
  loadChat(e) {
    app.globalData.selectedChatId = e.currentTarget.dataset.id;
    wx.switchTab({ url: '/pages/chat/chat' });
  },
  goToChat() { wx.switchTab({ url: '/pages/chat/chat' }); },
  showClearModal() { this.setData({ showClearModal: true }); },
  hideClearModal() { this.setData({ showClearModal: false }); },
  preventBubble() {},
  exportAll() { exporter.exportChats(this.data.chats).catch(() => wx.showToast({ title: '导出失败', icon: 'none' })); },
  deleteChat(e) {
    if (this.data.busy) return;
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '删除此会话？', content: '网页端也会同步删除。', success: async (res) => {
      if (!res.confirm) return;
      this.setData({ busy: true, error: '' });
      try {
        await api.deleteUserChat(app.globalData.userInfo.user_id, id);
        app.setDeletedChatIds([id]);
        this.renderChats(app.globalData.chats);
        wx.showToast({ title: '已删除', icon: 'success' });
      } catch (err) { this.setData({ error: `删除失败：${err.message}` }); }
      finally { this.setData({ busy: false }); }
    } });
  },
  async confirmClear() {
    if (this.data.busy) return;
    this.setData({ showClearModal: false, busy: true, error: '' });
    try {
      const localIds = app.globalData.chats.map(c => c.id);
      // Include local-only sessions so an old in-memory snapshot cannot reappear.
      const result = await api.clearUserChats(app.globalData.userInfo.user_id, localIds);
      app.setDeletedChatIds([...localIds, ...(result.deleted_chat_ids || [])]);
      app.setChats([]);
      this.renderChats([]);
      wx.showToast({ title: '已清空', icon: 'success' });
    } catch (err) { this.setData({ error: `清空失败：${err.message}` }); await this.loadChats(); }
    finally { this.setData({ busy: false }); }
  },
});
