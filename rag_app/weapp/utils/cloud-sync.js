const { mergeChats } = require('./chat-sync');

// One account and server per instance. Pending writes survive page changes and restarts.
function createCloudSync({ api, userId, read, write, load, save, active, status }) {
  let pending = load() || { chats: null, settings: {} };
  let revision = 0;
  let running = null;
  const publish = () => save(pending);
  const apply = (data) => {
    if (!active()) return;
    const current = read();
    const deleted = [...new Set([...(current.deletedChatIds || []), ...(data.deleted_chat_ids || [])])];
    write({
      chats: mergeChats(current.chats, data.chats || [], deleted),
      deletedChatIds: deleted,
      settings: { ...current.settings, ...(data.settings || {}), ...pending.settings },
    });
  };
  const hasPending = () => pending.chats !== null || Object.keys(pending.settings).length > 0;
  async function run() {
    status({ state: 'syncing', error: '' });
    try {
      // Pull deletions first; an offline snapshot must never restore a deleted chat.
      const [chats, settings] = await Promise.all([api.getUserChats(userId), api.getUserSettings(userId)]);
      if (!active()) return;
      apply({ ...chats, settings: settings.settings });
      for (let pass = 0; pass < 3 && hasPending() && active(); pass++) {
        const sentRevision = revision;
        const batch = pending;
        if (Object.keys(batch.settings).length) {
          const result = await api.saveUserSettings(userId, batch.settings, userId);
          if (!active()) return;
          apply({ settings: result.settings });
        }
        if (batch.chats !== null) {
          const deleted = read().deletedChatIds || [];
          const result = await api.saveUserChats(userId, batch.chats.filter(chat => !deleted.includes(chat.id)));
          if (!active()) return;
          apply(result);
        }
        if (sentRevision === revision) {
          pending = { chats: null, settings: {} };
          publish();
        }
      }
      if (active()) status({ state: hasPending() ? 'pending' : 'synced', error: '', lastSyncedAt: Date.now() });
    } catch (error) {
      if (active()) status({ state: 'offline', error: error.message || '同步失败，已保存在本机' });
      throw error;
    }
  }
  return {
    hasPending,
    sync() {
      if (!active()) return Promise.resolve();
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    chats(chats) {
      pending = { ...pending, chats: mergeChats(pending.chats || [], chats, read().deletedChatIds || []) };
      revision++; publish();
      return this.sync();
    },
    settings(patch) {
      pending = { ...pending, settings: { ...pending.settings, ...patch } };
      revision++; publish();
      return this.sync();
    },
  };
}
module.exports = { createCloudSync };
