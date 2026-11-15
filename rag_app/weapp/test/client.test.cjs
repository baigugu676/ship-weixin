const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sync = require('../utils/chat-sync.js');
const exporter = require('../utils/export.js');
const markdown = require('../utils/markdown.js');
const plain = value => JSON.parse(JSON.stringify(value));
function transport(useDecoder = true) {
  let options, chunk, aborted = false;
  const context = { module: { exports: {} }, getApp: () => ({ globalData: { apiBaseURL: 'https://example.invalid' } }),
    wx: { request(opts) { options = opts; return { onChunkReceived(cb) { chunk = cb; }, abort() { aborted = true; options.fail({ errMsg: 'abort' }); } }; } },
    TextDecoder: useDecoder ? TextDecoder : undefined, Uint8Array, ArrayBuffer,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8'), context);
  return { api: context.module.exports, success(data) { options.success({ statusCode: 200, data }); },
    chunk(data) { chunk({ data }); }, get aborted() { return aborted; }, get options() { return options; } };
}
const sse = 'event: token\ndata: {"text":"设备报警🚢"}\n\nevent: sql_result\ndata: {"row_count":1}\n\nevent: done\ndata: {}\n\n';
for (const decoder of [true, false]) test(`SSE split UTF-8 and whole-body duplicate suppression (TextDecoder=${decoder})`, () => {
  const mock = transport(decoder), events = [], errors = [];
  let complete = 0;
  mock.api.streamQueryRag({}, (event, data) => events.push({ event, data }), error => errors.push(error), () => complete++);
  const bytes = new TextEncoder().encode(sse);
  for (const byte of bytes) mock.chunk(Uint8Array.of(byte).buffer);
  mock.success(sse);
  assert.equal(events.length, 3);
  assert.equal(events[0].data.text, '设备报警🚢');
  assert.equal(complete, 1);
  assert.equal(errors.length, 0);
});
test('SSE falls back to whole-body response and flushes final block', () => {
  const mock = transport(), events = [];
  mock.api.streamQueryRag({}, (event) => events.push(event), assert.fail, () => events.push('complete'));
  mock.success(sse.trimEnd());
  assert.deepEqual(events, ['token', 'sql_result', 'done', 'complete']);
});
test('SSE reports premature EOF and intentional abort stays silent', () => {
  const mock = transport(); let errors = 0, complete = 0;
  mock.api.streamQueryRag({}, () => {}, () => errors++, () => complete++);
  mock.success('event: token\ndata: {"text":"partial"}\n\n');
  assert.equal(errors, 1); assert.equal(complete, 0);
  const other = transport();
  const task = other.api.streamQueryRag({}, () => {}, () => errors++, () => complete++);
  task.abort(); other.success(sse);
  assert.equal(other.aborted, true); assert.equal(errors, 1); assert.equal(complete, 0);
});
test('chat merge keeps other device, active answer, remote messages and deletions', () => {
  const local = [{ id: 'one', messages: [{ id: 'a', role: 'ai', content: '本机流式', isStreaming: true }] }, { id: 'deleted', messages: [] }];
  const remote = [{ id: 'one', messages: [{ id: 'a', role: 'ai', content: '旧内容' }, { id: 'b', role: 'user', content: '远端追加' }] }, { id: 'web', messages: [] }];
  const merged = sync.mergeChats(local, remote, ['deleted']);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(c => c.id === 'one').messages[0].content, '本机流式');
  assert.equal(merged.find(c => c.id === 'one').messages.length, 2);
});
test('legacy messages receive server IDs without duplicates', () => {
  const merged = sync.mergeChats([{ id: 'one', messages: [{ role: 'user', content: '问题' }] }], [{ id: 'one', messages: [{ id: 'server', role: 'user', content: '问题' }] }]);
  assert.equal(merged[0].messages.length, 1); assert.equal(merged[0].messages[0].id, 'server');
});
test('restored SQL result renders rows with zero and null values', () => {
  const msg = markdown.decorateMessage({ role: 'ai', content: '**完成**', databaseResult: { columns: ['报警', '日期'], rows: [{ 报警: 0, 日期: null }] } });
  assert.deepEqual(msg.databaseRows, [['0', '—']]); assert.match(msg.renderedContent, /完成/);
});
test('CSV export handles quotes, newlines and spreadsheet formulas', () => {
  const csv = exporter.csvText(['名称', '值'], [{ 名称: 'a,"b', 值: '=1+2' }, { 名称: '换\n行', 值: 0 }]);
  assert.ok(csv.startsWith('\ufeff')); assert.match(csv, /a,""b/); assert.ok(csv.includes("'=1+2")); assert.ok(csv.includes('"0"'));
});
function page(relative, api, app, wxExtra = {}) {
  let instance;
  const context = { Page(value) { instance = value; }, getApp: () => app,
    require(name) { if (name.includes('api.js')) return api; if (name.includes('chat-sync')) return sync; if (name.includes('markdown')) return markdown; if (name.includes('export')) return exporter; throw Error(name); },
    wx: { showToast() {}, switchTab() {}, reLaunch() {}, ...wxExtra },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, console, Map,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), context);
  instance.data = plain(instance.data);
  instance.setData = (values, callback) => { Object.assign(instance.data, values); if (callback) callback(); };
  return instance;
}
function appMock(chats = []) {
  return { globalData: { userInfo: { user_id: 'captain', role: 1 }, chats, deletedChatIds: [], settings: {} },
    setChats(chats) { this.globalData.chats = chats; },
    setDeletedChatIds(ids) { this.globalData.deletedChatIds.push(...ids); this.globalData.chats = this.globalData.chats.filter(c => !ids.includes(c.id)); },
    appearance() { return { appearance: 'dark', fontSize: 16 }; },
  };
}
test('mini chat forwards query mode, pause resumes and stopping saves pending text', async () => {
  const app = appMock(); let payload, receive, aborted = false;
  const api = { getSessionUserId: (u, c) => `${u}_${c}`, streamQueryRag(data, cb) { payload = data; receive = cb; return { abort() { aborted = true; } }; } };
  const chat = page('pages/chat/chat.js', api, app);
  chat.data.userId = 'captain'; chat.data.userSettings = { autoSave: false }; chat.data.queryMode = 'equipment';
  await chat.handleSend('最近一个月哪个设备报警最多？', null, { useLlm: false });
  assert.equal(payload.query_mode, 'equipment'); assert.equal(payload.use_llm, false);
  const id = chat.data.activeStreamingMsgId;
  receive('token', { text: '主柴油机报警18次' });
  receive('sql_result', { columns: ['次数'], rows: [{ 次数: 18 }], row_count: 1 });
  chat.pauseStreaming(id); chat.onSendBtnTap();
  assert.equal(chat.data.activeStreamingPaused, false); assert.equal(chat.data.currentChat.messages.length, 2);
  chat.confirmNewChat();
  assert.equal(aborted, true); assert.equal(chat.data.currentChatId, null);
  const saved = app.globalData.chats[0].messages[1];
  assert.equal(saved.content, '主柴油机报警18次'); assert.equal(saved.isStreaming, false);
  assert.deepEqual(plain(saved.databaseRows), [['18']]);
});
test('mini history honors remote deletion even with an empty remote list', async () => {
  const app = appMock([{ id: 'deleted', messages: [] }]);
  const history = page('pages/history/history.js', { getUserChats: async () => ({ chats: [], deleted_chat_ids: ['deleted'] }) }, app);
  await history.loadChats(); assert.equal(history.data.chats.length, 0); assert.equal(app.globalData.chats.length, 0);
});
test('equipment overview supplies counters, bars and typed input fields', async () => {
  const app = appMock();
  const equipment = page('pages/equipment/equipment.js', {
    getEquipmentOverview: async () => ({ counts: { equipment: 1 }, devices: [{ code: 'ME01', alarm_count: 18, fault_count: 2 }] }),
    getEquipmentSchema: async () => ({ datasets: { equipment: ['code', 'name'] } }),
    getEquipmentRecords: async () => ({ records: [{ id: 1, code: 'ME01', name: '主机' }] }),
  }, app);
  await equipment.refresh();
  assert.equal(equipment.data.counters[0].count, 1); assert.equal(equipment.data.devices[0].alarmWidth, 100);
  assert.equal(equipment.data.fields[0].required, true); assert.equal(equipment.data.recordCards[0].title, '主机');
});
test('switching accounts clears old page state and cannot save it to the new account', async () => {
  const app = appMock([{ id: 'new-chat', messages: [] }]);
  app.globalData.userInfo = { user_id: 'new-user' };
  let writes = 0;
  const chat = page('pages/chat/chat.js', { normalizeSettings: value => ({ nickname: 'Captain', ...value }), saveUserChats: async () => { writes++; } }, app);
  chat.data.userId = 'old-user';
  chat.data.chats = [{ id: 'old-chat', messages: [] }];
  chat.data.userSettings.autoSave = true;
  await chat.saveChatsToServer(chat.data.chats);
  assert.equal(writes, 0); assert.equal(app.globalData.chats[0].id, 'new-chat');
  chat.initUserData();
  assert.equal(chat.data.userId, 'new-user');
  assert.deepEqual(plain(chat.data.chats.map(c => c.id)), ['new-chat']);
});
test('local server address is persisted and rejects non-HTTP schemes', () => {
  let app;
  const storage = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App(value) { app = value; }, wx: { setStorageSync: (k, v) => storage.set(k, v) },
  });
  assert.equal(app.globalData.apiBaseURL, 'http://127.0.0.1:8000');
  app.setAPIBaseURL(' http://192.168.1.100:8000/ ');
  assert.equal(storage.get('apiBaseURL'), 'http://192.168.1.100:8000');
  assert.throws(() => app.setAPIBaseURL('javascript:alert(1)'));
});
