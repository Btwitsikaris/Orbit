import { get, post, patch, onLive, connectStream, disconnectStream } from './api.js';
import { S } from './state.js';
import { $, $$, esc, icon, avatar, toast, attempt, debounce, timeAgo } from './ui.js';
import { loadUsers, loadProjects, loadChannels, onShared, go } from './shared.js';
import { mountHome } from './views/home.js';
import { mountProjects, mountProject } from './views/projects.js';
import { mountChat } from './views/chat.js';
import { mountDocs } from './views/docs.js';
import { mountCalendar } from './views/calendar.js';
import { mountApprovals } from './views/approvals.js';
import { openIssue, refreshOpenIssue } from './views/issue.js';

const root = $('#root');
let view = null; // { destroy?, live? }

// ---------- sign in / register ----------
async function authScreen(mode = 'login') {
  const reg = mode === 'register';
  const invite = reg ? await get('/auth/config').then((c) => c.invite_required, () => false) : false;
  root.innerHTML = `<div class="auth"><form class="auth-card" id="af" novalidate>
    <div class="logo"><img src="/assets/logo-256.png" alt="">ORBIT</div>
    <h2>${reg ? 'Create your account' : 'Welcome back'}</h2>
    <p class="muted" style="margin:0 0 6px">${reg ? (invite ? 'You need an invite code from your workspace admin.' : 'The first account becomes the workspace admin.') : 'Sign in to your workspace.'}</p>
    ${reg ? '<label class="f" for="n">Name</label><input id="n" name="name" type="text" autocomplete="name" required>' : ''}
    <label class="f" for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required>
    <label class="f" for="p">Password</label><input id="p" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" ${reg ? 'minlength="8"' : ''} required>
    ${invite ? '<label class="f" for="iv">Invite code</label><input id="iv" name="invite" type="text" autocomplete="off" required>' : ''}
    <div class="err" id="ae" role="alert"></div>
    <button class="btn primary" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
    <div class="switch">${reg ? 'Already have an account? <a href="#" id="sw">Sign in</a>' : 'New here? <a href="#" id="sw">Create an account</a>'}</div>
  </form></div>`;
  $('#sw').onclick = (e) => {
    e.preventDefault();
    authScreen(reg ? 'login' : 'register');
  };
  $('#af').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      await post(reg ? '/auth/register' : '/auth/login', f);
      if (!location.hash) location.hash = '#/'; // keep a deep link such as #/docs through sign-in
      boot();
    } catch (err) {
      $('#ae').textContent = err.message;
      btn.disabled = false;
    }
  };
}

// ---------- shell ----------
function renderShell() {
  root.innerHTML = `<div class="shell" id="shell">
    <aside class="side" aria-label="Main navigation">
      <div class="top"><span class="logo"><img src="/assets/logo-256.png" alt="">ORBIT</span></div>
      <nav class="nav" id="nav"></nav>
      <div class="me" id="me"></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu" id="menu" aria-label="Menu">${icon('menu', 18)}</button>
        <div class="search">${icon('search')}<input id="q" type="text" placeholder="Search issues, messages, docs, people…" autocomplete="off" aria-label="Search"><div class="results hidden" id="results"></div></div>
        <div style="flex:1"></div>
        <button class="icon-btn" id="bell" aria-label="Notifications" style="position:relative">${icon('bell', 18)}<span class="badge hidden" id="bellN" style="position:absolute;top:0;right:0"></span></button>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;
  $('#menu').onclick = () => $('#shell').classList.toggle('menu-open');
  $('#nav').addEventListener('click', () => $('#shell').classList.remove('menu-open'));
  $('#me').innerHTML = `${avatar(S.me, 32)}<div class="grow"><div style="font-weight:600;line-height:1.2">${esc(S.me.name)}</div><div class="muted small">@${esc(S.me.handle)}</div></div>
    <button class="icon-btn" id="out" aria-label="Sign out" title="Sign out">${icon('logout')}</button>`;
  $('#out').onclick = async () => {
    await attempt(() => post('/auth/logout', {}));
    disconnectStream();
    view?.destroy?.();
    view = null;
    S.me = null;
    routeToken++;
    authScreen('login');
  };
  setupSearch();
  setupBell();
  renderNav();
  renderBell();
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  const h = location.hash || '#/';
  const on = (p) => (p === '#/' ? h === '#/' || h === '' : h.startsWith(p)) ? 'on' : '';
  const chatUnread = S.channels.reduce((n, c) => n + (c.unread || 0), 0);
  nav.innerHTML = `
    <a href="#/" class="${on('#/')}">${icon('home')} Home</a>
    <a href="#/chat" class="${on('#/chat')}">${icon('chat')} Chat ${chatUnread ? `<span class="badge">${chatUnread}</span>` : ''}</a>
    <a href="#/projects" class="${on('#/projects')}">${icon('board')} Projects</a>
    <a href="#/docs" class="${on('#/docs')}">${icon('doc')} Docs</a>
    <a href="#/calendar" class="${on('#/calendar')}">${icon('calendar')} Calendar</a>
    <a href="#/approvals" class="${on('#/approvals')}">${icon('check')} Approvals</a>
    ${S.projects.length ? '<h5>Projects</h5>' : ''}
    ${S.projects.map((p) => `<a href="#/p/${esc(p.key)}" class="${on(`#/p/${p.key}`)}"><span class="k">${esc(p.key)}</span> ${esc(p.name)}</a>`).join('')}`;
}

function renderBell() {
  const n = $('#bellN');
  if (!n) return;
  n.textContent = S.unread > 99 ? '99+' : S.unread;
  n.classList.toggle('hidden', !S.unread);
  document.title = S.unread ? `(${S.unread}) Orbit` : 'Orbit';
}

// ---------- notifications ----------
function setupBell() {
  $('#bell').onclick = async (e) => {
    e.stopPropagation();
    const old = $('.notif');
    if (old) return old.remove();
    const data = await attempt(() => get('/notifications'));
    if (!data) return;
    const el = document.createElement('div');
    el.className = 'notif';
    el.innerHTML = data.items.length
      ? `<div class="row between" style="padding:10px 14px;border-bottom:1px solid var(--line)"><strong>Notifications</strong><button class="btn sm ghost" id="allread">Mark all read</button></div>` +
        data.items
          .map((n) => `<a href="#" data-n="${n.id}" data-link="${esc(n.link)}" class="${n.read ? '' : 'unread'}">${esc(n.text)}<div class="muted small">${timeAgo(n.created)}</div></a>`)
          .join('')
      : '<div class="empty">You are all caught up.</div>';
    $('.main').appendChild(el);
    $('#allread', el)?.addEventListener('click', async () => {
      await post('/notifications/read', {});
      S.unread = 0;
      renderBell();
      el.remove();
    });
    el.addEventListener('click', async (ev) => {
      const a = ev.target.closest('a[data-n]');
      if (!a) return;
      ev.preventDefault();
      await post('/notifications/read', { id: Number(a.dataset.n) }).catch(() => {});
      if (a.classList.contains('unread')) S.unread = Math.max(0, S.unread - 1);
      renderBell();
      el.remove();
      followLink(a.dataset.link);
    });
  };
  document.addEventListener('click', (e) => {
    const n = $('.notif');
    if (n && !n.contains(e.target)) n.remove();
  });
}

function followLink(link) {
  const [kind, id] = String(link).split(':');
  if (kind === 'issue') openIssue(id);
  else if (kind === 'chat') go(`#/chat/${id}`);
  else if (kind === 'doc') go(`#/docs/${id}`);
  else if (kind === 'approvals') go('#/approvals');
  else if (kind === 'calendar') go('#/calendar');
}

// ---------- search ----------
function setupSearch() {
  const input = $('#q');
  const box = $('#results');
  const close = () => box.classList.add('hidden');
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    const r = await attempt(() => get(`/search?q=${encodeURIComponent(q)}`));
    if (!r || input.value.trim() !== q) return;
    const sec = (title, items) => (items.length ? `<h6>${title}</h6>${items.join('')}` : '');
    const html =
      sec('Issues', r.issues.map((i) => `<a href="#" data-issue="${esc(i.key)}"><span class="k">${esc(i.key)}</span> ${esc(i.title)}</a>`)) +
      sec('Messages', r.messages.map((m) => `<a href="#/chat/${m.channel_id}"><span class="muted small">${m.kind === 'dm' ? 'DM' : `#${esc(m.channel_name)}`}</span> ${esc(m.body.slice(0, 90))}</a>`)) +
      sec('Docs', r.docs.map((d) => `<a href="#/docs/${d.id}">${icon('doc', 14)} ${esc(d.title)}</a>`)) +
      sec('People', r.people.map((p) => `<a href="#" data-dm="${p.id}">${avatar(p, 20)} ${esc(p.name)} <span class="muted small">@${esc(p.handle)}</span></a>`));
    box.innerHTML = html || '<div class="empty">No results</div>';
    box.classList.remove('hidden');
  }, 250);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => e.key === 'Escape' && (close(), input.blur()));
  box.addEventListener('click', async (e) => {
    const dm = e.target.closest('[data-dm]');
    if (dm) {
      e.preventDefault();
      const ch = await attempt(() => post('/dm', { user_id: Number(dm.dataset.dm) }));
      if (ch) {
        await loadChannels();
        go(`#/chat/${ch.id}`);
      }
    }
    close();
    input.value = '';
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) close();
  });
}

// ---------- routing ----------
const ROUTES = [
  [/^\/?$/, () => mountHome],
  [/^\/projects$/, () => mountProjects],
  [/^\/p\/([A-Za-z0-9]+)(?:\/(board|backlog))?$/, () => mountProject],
  [/^\/chat(?:\/(\d+))?$/, () => mountChat],
  [/^\/docs(?:\/(\d+))?$/, () => mountDocs],
  [/^\/calendar$/, () => mountCalendar],
  [/^\/approvals$/, () => mountApprovals],
];

let routeToken = 0;
function route() {
  if (!S.me) return;
  const path = (location.hash || '#/').slice(1) || '/';
  view?.destroy?.();
  view = null;
  const outer = $('#view');
  outer.scrollTop = 0;
  // every page gets a fresh container, so listeners a page attaches die with it
  const el = document.createElement('div');
  el.style.height = '100%';
  outer.replaceChildren(el);
  for (const [re, pick] of ROUTES) {
    const m = re.exec(path);
    if (m) {
      const token = ++routeToken;
      Promise.resolve(pick()(el, ...m.slice(1)))
        .then((v) => {
          if (token !== routeToken) return v?.destroy?.(); // navigated away while loading
          view = v || null;
        })
        .catch((e) => {
          el.innerHTML = `<div class="page"><div class="card pad"><h3>Could not load this page</h3><p class="muted">${esc(e.message)}</p></div></div>`;
        });
      renderNav();
      return;
    }
  }
  el.innerHTML = '<div class="page"><div class="empty">Page not found. <a href="#/">Go home</a></div></div>';
  renderNav();
}

// ---------- live events ----------
const refreshChannels = debounce(() => loadChannels().catch(() => {}), 300);
const refreshProjects = debounce(() => loadProjects().catch(() => {}), 400);

function handleLive(evt) {
  switch (evt.type) {
    case 'user':
      loadUsers().catch(() => {});
      break;
    case 'project':
    case 'issue':
      refreshProjects();
      break;
    case 'channel':
    case 'message':
      refreshChannels();
      break;
    case 'notify':
      S.unread += 1;
      renderBell();
      toast(evt.text);
      break;
    default:
  }
  if (evt.type === 'issue') refreshOpenIssue(evt);
  view?.live?.(evt);
}

let started = false;
async function boot() {
  let me;
  try {
    me = await get('/me');
  } catch (e) {
    if (e.status === 401) return authScreen('login');
    root.innerHTML = `<div class="auth"><div class="auth-card"><h2>Can’t reach Orbit</h2><p class="muted">${esc(e.message)}</p></div></div>`;
    return;
  }
  S.me = me.user;
  S.unread = me.unread;
  await Promise.all([loadUsers(), loadProjects(), loadChannels()]);
  renderShell();
  connectStream();
  if (!started) {
    started = true;
    onLive(handleLive);
    onShared(renderNav);
    window.addEventListener('hashchange', route);
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-issue]');
      if (a) {
        e.preventDefault();
        openIssue(a.dataset.issue);
      }
    });
  }
  route();
}

boot();