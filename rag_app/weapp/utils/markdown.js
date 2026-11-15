// utils/markdown.js
// 轻量 Markdown 转换器（小程序 rich-text 可用）
//
// 背景：大模型（Qwen 等）默认按 Markdown 输出，形如 "### 一、原因分析" + "**要点**"。
// WXML 的 <text> 只会把字符原样显示，于是用户会看到一堆 ### 和 **。
// 这里做两件事：
//   1) toPlainText —— 去掉标记符号，用于流式打字阶段（每帧都要跑，必须便宜）
//   2) toRichNodes —— 转成 rich-text 支持的 HTML 字符串，用于回答收尾后的正式渲染
// 注意：rich-text 内部不认 WXSS 类名，样式一律用行内 style。

const BLOCK = {
  h1: 'margin:14px 0 8px;font-size:17px;font-weight:700;color:#f1f5f9;line-height:1.5;',
  h2: 'margin:12px 0 6px;font-size:16px;font-weight:700;color:#f1f5f9;line-height:1.5;',
  h3: 'margin:10px 0 6px;font-size:15px;font-weight:700;color:#f1f5f9;line-height:1.5;',
  h4: 'margin:8px 0 4px;font-size:14px;font-weight:700;color:#f1f5f9;line-height:1.5;',
  p: 'margin:0 0 6px;',
  li: 'margin:0 0 4px;',
  ul: 'margin:4px 0 8px;padding-left:18px;list-style-type:disc;',
  ol: 'margin:4px 0 8px;padding-left:18px;list-style-type:decimal;',
  quote: 'margin:6px 0;padding:2px 0 2px 8px;border-left:3px solid #14b8a6;color:#cbd5e1;',
  pre: 'margin:6px 0;padding:8px 10px;background:rgba(255,255,255,0.06);border-radius:8px;font-size:12px;line-height:1.6;color:#cbd5e1;',
  hr: 'margin:10px 0;height:1px;background:rgba(255,255,255,0.12);',
  table: 'margin:4px 0;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;color:#cbd5e1;',
};

const INLINE = {
  strong: 'font-weight:700;color:#ffffff;',
  em: 'font-style:italic;color:#e2e8f0;',
  code: 'padding:1px 4px;border-radius:4px;background:rgba(20,184,166,0.16);color:#5eead4;font-size:13px;',
  del: 'text-decoration:line-through;color:#94a3b8;',
};

// LaTeX 残留符号 → 可读文本（沿用原 formatOfflineText 的处理）
function normalizeLatex(text = '') {
  return String(text)
    .replace(/\\leq/g, '≤')
    .replace(/\\geq/g, '≥')
    .replace(/\\neq/g, '≠')
    .replace(/\\pm/g, '±')
    .replace(/\\sim/g, '~')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\%/g, '%')
    .replace(/\^\{?\\circ\}?/g, '°')
    .replace(/\\circ/g, '°')
    .replace(/\\mathrm\{([^}]*)\}/g, '$1')
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\left|\\right/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/°\s+([CF])\b/g, '°$1')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '');
}

// 检索层带出来的噪音：[资料1]、[H1]、图片路径、【】等
function stripArtifacts(text = '') {
  return String(text)
    .replace(/^\s*基于检索到的资料，建议如下[：:]\s*/g, '')
    .replace(/\[(?:资料|H|h|图谱)\s*\d+\]\s*/g, '')
    .replace(/\[\s*(?:IMG|img)[^\]\n\r]*(?:\]|$)/g, '')
    .replace(/\b(?:IMG|img)\s*path\s*=\s*(?:data\/KG\/images|images)\/[^\n\r]*/g, '')
    .replace(/\b(?:images|data\/KG\/images)\/\S+\.(?:png|jpe?g|gif|webp|bmp)\b/gi, '')
    .replace(/\[图片附件[^\]]*\]/g, '')
    .replace(/[【】]/g, '');
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============ 流式阶段：去掉标记符号的纯文本 ============

function toPlainText(text = '') {
  if (!text) return '';
  let s = String(text).replace(/\r/g, '');

  // 代码围栏只去掉 ``` 本身，保留代码内容
  s = s.replace(/^[ \t]*```[a-zA-Z0-9_+-]*[ \t]*$/gm, '');
  s = s.replace(/`{1,3}/g, '');

  // 块级标记
  s = s.replace(/^[ \t]{0,8}#{1,6}[ \t]*/gm, '');          // 标题：### 或 ###标题
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');                    // 引用
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '· ');              // 无序列表
  s = s.replace(/^[ \t]*(\d+)[.、)][ \t]*/gm, '$1. ');      // 有序列表
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');       // 分隔线

  // 行内标记
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');               // 图片
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');            // 链接
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // 表格：| A | B | → A | B，分隔行整行丢掉
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (m, inner) =>
    inner.split('|').map((c) => c.trim()).filter(Boolean).join('  ')
  );

  // 兜底：模型偶尔写成 "###标题" 或把 ** 拼在行中
  s = s.replace(/[ \t]*#{2,}[ \t]*/g, ' ');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/__/g, '');

  s = normalizeLatex(stripArtifacts(s));
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============ 收尾阶段：Markdown → rich-text HTML ============

function inlineToHtml(text = '') {
  let s = escapeHtml(text);

  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/`([^`]+)`/g, `<code style="${INLINE.code}">$1</code>`);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, `<strong style="${INLINE.strong}"><em style="${INLINE.em}">$1</em></strong>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, `<strong style="${INLINE.strong}">$1</strong>`);
  s = s.replace(/__([^_]+)__/g, `<strong style="${INLINE.strong}">$1</strong>`);
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, `$1<em style="${INLINE.em}">$2</em>`);
  s = s.replace(/~~([^~]+)~~/g, `<del style="${INLINE.del}">$1</del>`);

  // 残余标记符号（"###标题"、"**未闭合"之类）直接清掉，别让它露出来
  s = s.replace(/[ \t]*#{2,}[ \t]*/g, ' ');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/__/g, '');

  return normalizeLatex(s).trim();
}

function toRichNodes(md = '') {
  const raw = normalizeLatexPreservingFence(String(md || '')).replace(/\r/g, '');
  if (!raw.trim()) return '';

  const lines = raw.split('\n');
  const out = [];
  let listType = '';
  let inFence = false;
  let fenceLines = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = '';
    }
  };
  const openList = (type) => {
    if (listType !== type) {
      closeList();
      out.push(`<${type} style="${BLOCK[type]}">`);
      listType = type;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块
    if (/^```/.test(trimmed)) {
      if (inFence) {
        out.push(
          `<pre style="${BLOCK.pre}"><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`
        );
        fenceLines = [];
        inFence = false;
      } else {
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    // 分隔线
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      closeList();
      out.push(`<div style="${BLOCK.hr}"></div>`);
      continue;
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s*(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 4);
      const key = `h${level}`;
      out.push(`<div style="${BLOCK[key]}">${inlineToHtml(heading[2]) || '&nbsp;'}</div>`);
      continue;
    }

    // 引用
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<div style="${BLOCK.quote}">${inlineToHtml(quote[1]) || '&nbsp;'}</div>`);
      continue;
    }

    // 表格：分隔行跳过，普通行拼成一行文本
    if (/^\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?$/.test(trimmed)) {
      closeList();
      continue;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      closeList();
      const cells = trimmed
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length) {
        out.push(`<div style="${BLOCK.table}">${inlineToHtml(cells.join(' ｜ '))}</div>`);
      }
      continue;
    }

    // 无序列表
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      openList('ul');
      out.push(`<li style="${BLOCK.li}">${inlineToHtml(bullet[1]) || '&nbsp;'}</li>`);
      continue;
    }

    // 有序列表
    const ordered = trimmed.match(/^(\d+)[.、)]\s*(.*)$/);
    if (ordered) {
      openList('ol');
      out.push(
        `<li style="${BLOCK.li}">${inlineToHtml(ordered[2]) || '&nbsp;'}</li>`
      );
      continue;
    }

    // 普通段落（一行一段，保证换行不丢）
    closeList();
    out.push(`<div style="${BLOCK.p}">${inlineToHtml(trimmed) || '&nbsp;'}</div>`);
  }

  if (inFence && fenceLines.length) {
    out.push(`<pre style="${BLOCK.pre}"><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
  }
  closeList();

  return out.join('');
}

// 先把 \times 这类符号替换掉，但代码块里的反斜杠要留着（顺序敏感的写法太绕，这里简单跳过整段）
function normalizeLatexPreservingFence(text = '') {
  const parts = String(text).split(/(```[\s\S]*?```)/);
  return parts
    .map((part, idx) => (idx % 2 === 1 ? part : normalizeLatex(part)))
    .join('');
}

// ============ 消息渲染字段装饰（chat.js / history.js 共用） ============
// content 保留原始 Markdown（存档用，不破坏数据）；
// displayText 是去标记纯文本（流式阶段显示）；renderedContent 是富文本 HTML（收尾后显示）。
function decorateMessage(msg) {
  if (!msg || !['ai', 'assistant'].includes(msg.role)) return msg;
  if (msg.isStreaming) return msg; // 正在流式，别动它的中间状态
  if (msg.renderedContent && typeof msg.displayText === 'string') return msg; // 已装饰过，幂等
  const raw = msg.fullText || msg.content || '';
  return {
    ...msg,
    role: 'ai',
    databaseRows: msg.databaseResult ? (msg.databaseResult.rows || []).map(row => (msg.databaseResult.columns || []).map(col => row[col] == null ? '—' : String(row[col]))) : [],
    content: raw,
    displayText: toPlainText(raw),
    renderedContent: toRichNodes(raw),
    isStreaming: false,
    isPaused: false,
  };
}

function decorateChat(chat) {
  if (!chat) return chat;
  return {
    ...chat,
    messages: (chat.messages || []).map(decorateMessage),
  };
}

module.exports = {
  toPlainText,
  toRichNodes,
  decorateMessage,
  decorateChat,
  inlineToHtml,
  normalizeLatex,
  escapeHtml,
};
