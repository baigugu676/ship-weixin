const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudSync } = require('../utils/cloud-sync');
const clone = value => JSON.parse(JSON.stringify(value));
const chat = (id, text) => ({ id, messages: [{ id: `${id}-ai`, role: 'ai', content: text }] });
function setup(overrides = {}, stored = null) {
  let current = { chats: [], settings: { fontSize: 16 }, deletedChatIds: [] }, pending = stored, active = true;
  const writes = [], statuses = [];
  const api = {
    getUserChats: async () => ({ chats: [], deleted_chat_ids: [] }),
    getUserSettings: async () => ({ settings: { fontSize: 16, theme: 'light' } }),
    saveUserChats: async (uid, chats) => { writes.push(clone(chats)); return { chats }; },
    saveUserSettings: async (uid, settings) => ({ settings }), ...overrides,
  };
  const options = { api, userId: 'captain', read: () => current, write: next => { current = next; },
    load: () => pending, save: next => { pending = clone(next); }, active: () => active, status: next => statuses.push(next) };
  return { manager: createCloudSync(options), options, writes, statuses, get current() { return current; }, get pending() { return pending; }, stop() { active = false; } };
}
test('offline writes survive recreation and are uploaded without opening chat page', async () => {
  const state = setup({ getUserChats: async () => { throw Error('offline'); } });
  await assert.rejects(state.manager.chats([chat('wx', '离线回答')]));
  assert.equal(state.pending.chats[0].messages[0].content, '离线回答');
  const restored = setup({}, state.pending);
  await restored.manager.sync();
  assert.equal(restored.writes.length, 1); assert.equal(restored.current.chats[0].id, 'wx');
  assert.equal(restored.manager.hasPending(), false);
});
test('a new edit while uploading is not cleared by an older acknowledgement', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const sent = [];
  const state = setup({ saveUserChats: async (uid, chats) => {
    sent.push(clone(chats));
    if (sent.length === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { chats };
  } });
  const first = state.manager.chats([chat('wx', '第一段')]);
  await waiting;
  const second = state.manager.chats([chat('wx', '第一段后还有第二段')]);
  release(); await Promise.all([first, second]);
  assert.equal(sent.length, 2); assert.equal(sent[1][0].messages[0].content, '第一段后还有第二段');
  assert.equal(state.manager.hasPending(), false);
});
test('server deletion is applied before an offline snapshot is uploaded', async () => {
  const state = setup({ getUserChats: async () => ({ chats: [chat('web', '网页')], deleted_chat_ids: ['deleted'] }) });
  await state.manager.chats([chat('deleted', '不能恢复'), chat('wx', '本机')]);
  assert.deepEqual(state.writes[0].map(c => c.id), ['wx']);
  assert.deepEqual(state.current.chats.map(c => c.id).sort(), ['web', 'wx']);
});
test('pending settings merge with remote preferences and save only changed fields', async () => {
  const sent = [];
  const state = setup({ saveUserSettings: async (uid, patch) => { sent.push(clone(patch)); return { settings: patch }; } });
  await state.manager.settings({ fontSize: 21 });
  assert.deepEqual(sent, [{ fontSize: 21 }]);
  assert.equal(state.current.settings.theme, 'light'); assert.equal(state.current.settings.fontSize, 21);
});
test('switching account while a request is in flight cannot update the new account', async () => {
  let release;
  const state = setup({ getUserChats: () => new Promise(resolve => { release = resolve; }) });
  const request = state.manager.sync(); state.stop(); release({ chats: [chat('other', '旧账号')] });
  await request;
  assert.equal(state.current.chats.length, 0); assert.equal(state.writes.length, 0);
});
