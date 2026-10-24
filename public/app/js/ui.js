import { S, user } from './state.js';

// ---------- escaping & DOM ----------
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- constants ----------
export const STATUSES = [
  ['todo', 'To do'],
  ['in_progress', 'In progress'],
  ['in_review', 'In review'],
  ['done', 'Done'],
];
export const PRIORITIES = [
  ['highest', 'Highest'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
  ['lowest', 'Lowest'],
];
export const TYPES = [
  ['task', 'Task'],
  ['bug', 'Bug'],
  ['story', 'Story'],
  ['epic', 'Epic'],
];
export const TYPE_ICON = { task: '☑', bug: '🐞', story: '📖', epic: '⚡' };
export const statusLabel = (s) => STATUSES.find((x) => x[0] === s)?.[1] || s;
export const priorityLabel = (s) => PRIORITIES.find((x) => x[0] === s)?.[1] || s;

// ---------- icons ----------
const ICONS = {
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  board: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  calendar: 'M3 4h18v18H3z M16 2v4 M8 2v4 M3 10h18',
  check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  plus: 'M12 5v14 M5 12h14',
  x: 'M18 6L6 18 M6 6l12 12',
  send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4z',
  video: 'M23 7l-7 5 7 5z M1 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H1z',
  trash: 'M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  hash: 'M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 18',
  edit: 'M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3',
  menu: 'M3 12h18 M3 6h18 M3 18h18',
  chevL: 'M15 18l-6-6 6-6',
  chevR: 'M9 18l6-6-6-6',
};
export const icon = (name, size = 16) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;

// ---------- people ----------
export function avatar(u, size = 28) {
  if (!u) return `<span class="av" style="width:${size}px;height:${size}px;background:#cbd2e6;font-size:${size * 0.4}px" title="Unassigned">?</span>`;
  const initials = u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="av" style="width:${size}px;height:${size}px;background:${esc(u.color)};font-size:${Math.round(size * 0.4)}px" title="${esc(u.name)}">${esc(initials)}</span>`;
}
export const userOptions = (selected, { none = 'Unassigned' } = {}) =>
  `<option value="">${esc(none)}</option>` +
  S.users.map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
export const options = (list, selected) =>
  list.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');

// ---------- time ----------
export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtDateTime = (ms) => `${fmtDate(ms)}, ${fmtTime(ms)}`;
export const pad = (n) => String(n).padStart(2, '0');
export const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ---------- rich text ----------
/** Plain text -> safe HTML with issue keys, @mentions and URLs linked. */
export function linkify(text) {
  return String(text ?? '')
    .split(/(https?:\/\/[^\s<]+)/)
    .map((part, i) => {
      if (i % 2) return `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`;
      return esc(part)
        .replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g, '<a href="#" class="ikey" data-issue="$1">$1</a>')
        .replace(/(^|\s)@([a-z0-9_]{2,30})\b/gi, (m, sp, h) =>
          S.byHandle.has(h.toLowerCase()) ? `${sp}<span class="mention">@${h}</span>` : m,
        );
    })
    .join('')
    .replace(/\n/g, '<br>');
}

function formatMd(s) {
  // s is already HTML-escaped and contains no links
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g, '<a href="#" class="ikey" data-issue="$1">$1</a>');
}

function inlineMd(s) {
  // s is already HTML-escaped. Links are pulled out first so formatting can never end up inside an href.
  const links = [];
  const stripped = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|#|\/)[^)\s]*)\)/g, (m, text, href) => {
    links.push({ text, href });
    return `\u0000${links.length - 1}\u0000`;
  });
  return formatMd(stripped).replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const { text, href } = links[Number(i)];
    const external = /^https?:/.test(href);
    return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${formatMd(text)}</a>`;
  });
}

/** Small, safe markdown renderer for docs (escapes everything first). */
export function renderMd(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let code = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    if (code !== null) {
      if (raw.trim().startsWith('```')) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(raw);
      continue;
    }
    if (raw.trim().startsWith('```')) {
      closeList();
      code = [];
      continue;
    }
    const line = esc(raw);
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      closeList();
      out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`);
    } else if (/^\s*---+\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
    } else if ((m = /^\s*[-*]\s+\[( |x)\]\s+(.*)$/i.exec(line))) {
      if (list !== 'ul') (closeList(), out.push('<ul class="tasks">'), (list = 'ul'));
      out.push(`<li><input type="checkbox" disabled ${m[1].toLowerCase() === 'x' ? 'checked' : ''}> ${inlineMd(m[2])}</li>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      if (list !== 'ul') (closeList(), out.push('<ul>'), (list = 'ul'));
      out.push(`<li>${inlineMd(m[1])}</li>`);
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      if (list !== 'ol') (closeList(), out.push('<ol>'), (list = 'ol'));
      out.push(`<li>${inlineMd(m[1])}</li>`);
    } else if ((m = /^&gt;\s?(.*)$/.exec(line))) {
      closeList();
      out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  closeList();
  return out.join('\n');
}

// ---------- toasts & modals ----------
export function toast(message, kind = 'info') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

const openModals = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) openModals[openModals.length - 1].close();
});

/** Opens a dialog. Returns { body, close }. */
export function openModal({ title, html, wide = false, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${html}</div></div>`;
  document.body.appendChild(wrap);
  const api = {
    body: $('.modal-body', wrap),
    close() {
      wrap.remove();
      const i = openModals.indexOf(api);
      if (i >= 0) openModals.splice(i, 1);
      onClose?.();
    },
  };
  openModals.push(api);
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) api.close();
  });
  $('[data-close]', wrap).onclick = api.close;
  const first = $('input:not([type=checkbox]), textarea, select', api.body);
  first?.focus();
  return api;
}

export function confirmDialog(message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    let settled = false;
    const m = openModal({
      title: 'Are you sure?',
      html: `<p>${esc(message)}</p><div class="row end gap"><button class="btn" data-no>Cancel</button><button class="btn danger" data-yes>${esc(confirmLabel)}</button></div>`,
      onClose: () => !settled && resolve(false),
    });
    $('[data-no]', m.body).onclick = () => m.close();
    $('[data-yes]', m.body).onclick = () => {
      settled = true;
      m.close();
      resolve(true);
    };
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Run an async action; show errors as toasts. */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || 'Something went wrong', 'error');
    return undefined;
  }
}
