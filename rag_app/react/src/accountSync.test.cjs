const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = (id, content) => ({ id, messages: [{ id: `${id}-ai`, role: 'ai', content }] });
const plain = value => JSON.parse(JSON.stringify(value));
async function harness(fetch, storage = new Map()) {
  const { mergeChats } = await import('./chatSync.js');
  let chats = [], settings = {}, effect, status;
  const deps = { baseURL: '', userId: 'captain', deletedIds: { current: new Set() }, onDeleted() {},
    setChats: next => { chats = typeof next === 'function' ? next(chats) : next; },
    setSettings: next => { settings = typeof next === 'function' ? next(settings) : next; } };
  const source = fs.readFileSync(path.join(__dirname, 'useAccountSync.js'), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  const scope = { useCallback: cb => cb, useEffect: cb => { effect = cb; }, useRef: value => ({ current: value }), useState: () => ['', value => { status = value; }], mergeChats,
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) }, fetch,
    window: { addEventListener() {}, removeEventListener() {} }, document: { hidden: false },
    setInterval: () => 1, clearInterval() {}, AbortSignal, Promise, JSON, Object, Error };
  vm.runInNewContext(source+'\nthis.mount = useAccountSync;', scope);
  const hook = scope.mount(deps); const cleanup = effect(); await hook.syncNow();
  return { hook, cleanup, storage, get chats() { return chats; }, get settings() { return settings; }, get status() { return status; } };
}
const response = value => ({ ok: true, json: async () => value });
test('web outbox survives an offline reload, retries, and merges mini-program chats', async () => {
  const first = await harness(async () => { throw Error('offline'); });
  first.hook.queueChats([chat('web', '网页离线回答')]);
  await first.hook.syncNow(); first.cleanup();
  const writes = [];
  const second = await harness(async (url, options) => {
    if (options.method === 'PUT') { const data = JSON.parse(options.body); writes.push(data); return response(data); }
    return response(url.endsWith('/chats') ? { chats: [chat('wx', '小程序回答')] } : { settings: { theme: 'light' } });
  }, first.storage);
  assert.equal(writes.length, 1);
  assert.deepEqual(second.chats.map(c => c.id).sort(), ['web', 'wx']);
  assert.equal(JSON.parse([...second.storage.values()][0]).pending, null);
  second.cleanup();
});
test('web settings actually reach the backend as a partial patch', async () => {
  const writes = [];
  const state = await harness(async (url, options) => {
    if (options.method === 'PUT') { const data=JSON.parse(options.body); writes.push(data); return response(data); }
    return response(url.endsWith('/settings') ? { settings: { theme: 'dark', fontSize: 16 } } : { chats: [] });
  });
  await state.hook.saveSettings({ fontSize: 20 });
  assert.deepEqual(writes, [{ settings: { fontSize: 20 }, changed_by: 'captain' }]);
  assert.equal(state.settings.theme, 'dark'); assert.equal(state.settings.fontSize, 20);
  state.cleanup();
});
test('web retry filters deleted offline chats before sending', async () => {
  const sent = [];
  const state = await harness(async (url, options) => {
    if (options.method === 'PUT') { const data=JSON.parse(options.body); sent.push(data); return response(data); }
    return response(url.endsWith('/chats') ? { chats: [], deleted_chat_ids: ['deleted'] } : { settings: {} });
  });
  state.hook.queueChats([chat('deleted', '旧内容'), chat('keep', '保留')]);
  await state.hook.syncNow();
  assert.deepEqual(sent[0].chats.map(c=>c.id), ['keep']); state.cleanup();
});
