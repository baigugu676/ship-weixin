function mergeChats(local = [], remote = [], deletedIds = []) {
  const deleted = new Set(deletedIds);
  const out = new Map();
  for (const chat of local || []) if (chat && chat.id && !deleted.has(chat.id)) out.set(chat.id, chat);
  for (const chat of remote || []) {
    if (!chat || !chat.id || deleted.has(chat.id)) continue;
    const own = out.get(chat.id);
    if (!own) { out.set(chat.id, chat); continue; }
    const messages = [...(own.messages || [])];
    for (const [index, incoming] of (chat.messages || []).entries()) {
      let pos = incoming.id ? messages.findIndex(m => m.id === incoming.id) : -1;
      if (pos < 0 && messages[index] && (!incoming.id || !messages[index].id) &&
          messages[index].role === incoming.role && messages[index].content === incoming.content) pos = index;
      if (pos < 0) messages.push(incoming);
      else {
        const current = messages[pos];
        if (!current.isStreaming && String(incoming.content || '').length >= String(current.content || '').length)
          messages[pos] = { ...current, ...incoming, renderedContent: '', displayText: '' };
      }
    }
    out.set(chat.id, { ...chat, ...own, messages });
  }
  return [...out.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
function uniqueId(prefix = 'wx') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { mergeChats, uniqueId };
