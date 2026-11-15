import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeChats } from './chatSync';

// Persist an account-scoped outbox; retry it on focus, reconnect, and the normal sync timer.
export function useAccountSync({ baseURL, userId, setChats, setSettings, deletedIds, onDeleted }) {
  const [status, setStatus] = useState('正在同步');
  const context = useRef(null);

  useEffect(() => {
    const key = `ship-sync:${baseURL}:${userId}`;
    let cached = {};
    try { cached = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* empty cache */ }
    const state = { pending: cached.pending || null, patch: cached.patch || {}, running: null, revision: 0, disposed: false, remoteSnapshot: '' };
    context.current = state;
    const persist = () => {
      try { localStorage.setItem(key, JSON.stringify({ pending: state.pending, patch: state.patch })); }
      catch { setStatus('本机缓存已满，请保持页面打开并连接网络'); }
    };
    const request = async (path, body) => {
      const response = await fetch(`${baseURL}/users/${encodeURIComponent(userId)}/${path}`, {
        ...(body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('同步失败，联网后自动重试');
      return response.json();
    };
    const apply = data => {
      if (state.disposed) return;
      for (const id of data.deleted_chat_ids || []) deletedIds.current.add(id);
      const ids = [...deletedIds.current];
      setChats(prev => {
        const next = mergeChats(prev, data.chats || [], ids);
        state.remoteSnapshot = JSON.stringify(next);
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
      if (data.settings) setSettings(prev => {
        const next = { ...prev, ...data.settings, ...state.patch };
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
      onDeleted(ids);
    };
    const run = async () => {
      setStatus('正在同步');
      try {
        const [remote, prefs] = await Promise.all([request('chats'), request('settings')]);
        apply({ ...remote, settings: prefs.settings });
        for (let pass = 0; pass < 3 && !state.disposed && (state.pending || Object.keys(state.patch).length); pass++) {
          const revision = state.revision;
          const patch = state.patch, pending = state.pending;
          if (Object.keys(patch).length) apply(await request('settings', { settings: patch, changed_by: userId }));
          if (pending) apply(await request('chats', { chats: pending.filter(chat => !deletedIds.current.has(chat.id)) }));
          if (revision === state.revision) { state.pending = null; state.patch = {}; persist(); }
        }
        if (!state.disposed) setStatus(state.pending || Object.keys(state.patch).length ? '有待补传记录' : '已与小程序同步');
      } catch (error) { if (!state.disposed) setStatus(error.message || '同步失败，联网后自动重试'); }
    };
    state.sync = () => {
      if (state.disposed) return Promise.resolve();
      if (!state.running) state.running = run().finally(() => { state.running = null; });
      return state.running;
    };
    state.queue = (nextChats, patch = {}) => {
      if (nextChats && JSON.stringify(nextChats) === state.remoteSnapshot && !Object.keys(patch).length) return;
      if (nextChats) state.pending = nextChats;
      state.patch = { ...state.patch, ...patch }; state.revision++; persist();
    };
    if (state.pending) setChats(prev => mergeChats(prev, state.pending, [...deletedIds.current]));
    if (Object.keys(state.patch).length) setSettings(prev => ({ ...prev, ...state.patch }));
    state.sync();
    const timer = setInterval(() => { if (!document.hidden) state.sync(); }, 15000);
    const refresh = () => state.sync();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      state.disposed = true; clearInterval(timer);
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh);
    };
  }, [baseURL, userId, setChats, setSettings, deletedIds, onDeleted]);

  const queueChats = useCallback(next => { context.current?.queue(next); }, []);
  const saveSettings = useCallback(patch => { context.current?.queue(null, patch); return context.current?.sync(); }, []);
  const syncNow = useCallback(() => context.current?.sync(), []);
  return { status, queueChats, saveSettings, syncNow };
}
