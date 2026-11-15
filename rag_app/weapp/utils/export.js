function csvText(columns, rows) {
  const cell = (value) => {
    let text = String(value == null ? '' : value);
    if (/^[=+@\t\r-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return '\ufeff' + [columns.map(cell).join(','), ...rows.map(row => columns.map(col => cell(row[col])).join(','))].join('\r\n');
}
function exportFile(name, content) {
  return new Promise((resolve, reject) => {
    const filePath = `${wx.env.USER_DATA_PATH}/${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    wx.getFileSystemManager().writeFile({
      filePath, data: content, encoding: 'utf8',
      success() {
        if (typeof wx.shareFileMessage === 'function') wx.shareFileMessage({
          filePath, fileName: name, success: resolve,
          fail(error) {
            if ((error.errMsg || '').includes('cancel')) resolve();
            else wx.setClipboardData({ data: content, success: resolve, fail: reject });
          },
        });
        else wx.setClipboardData({ data: content, success: resolve, fail: reject });
      }, fail: reject,
    });
  });
}
function exportChats(chats) {
  return exportFile(`ship-chats-${Date.now()}.md`, chats.map(chat =>
    `# ${chat.title}\n${chat.createdAt || ''}\n\n` + (chat.messages || []).map(msg => {
      let text = `## ${msg.role === 'user' ? '提问' : '回答'}\n${msg.content || ''}`;
      if (msg.databaseResult) text += `\n\n数据类型：${msg.databaseResult.data_kind}\n查询时间：${msg.databaseResult.executed_at}\nSQL：\n${msg.databaseResult.sql || ''}\n\n${csvText(msg.databaseResult.columns || [], msg.databaseResult.rows || [])}`;
      return text;
    }).join('\n\n')
  ).join('\n\n---\n\n'));
}
module.exports = { csvText, exportFile, exportChats };
