import { get, post, patch, del } from '../api.js';
import { S, user } from '../state.js';
import { esc, $, $$, icon, avatar, linkify, fmtTime, fmtDate, openModal, confirmDialog, attempt, toast, debounce } from '../ui.js';
import { loadChannels, onShared, go, channelName } from '../shared.js';

const EMOJI = ['👍', '❤️', '🎉', '😄', '👀', '🙏'];

export async function mountChat(el, idParam) {
  let chId = idParam ? Number(idParam) : null;
  if (!chId || !S.channels.some((c) => c.id === chId)) {
    const pick = S.channels.find((c) => c.name === 'general') || S.channels[0];
    chId = pick?.id;
    if (!chId) {
      el.innerHTML = '<div class="page"><div class="empty">No channels yet.</div></div>';
      return {};
    }
    if (idParam) history.replaceState(null, '', `#/chat/${chId}`);
  }
  let threadId = null;
  let msgs = [];
  let hasMore = false;
  let first = true;

  el.innerHTML = `<div class="chat" id="chat">
    <aside class="chan-list" id="cl"></aside>
    <section class="chat-main">
      <header class="chat-head"><button class="icon-btn back" id="showch" aria-label="Channels">${icon('menu', 18)}</button><div class="grow"><strong id="ct"></strong><div class="muted small" id="ctopic"></div></div>
        <button class="btn sm" id="meet">${icon('video', 14)} Meet</button></header>
      <div class="msgs" id="msgs" aria-live="polite"></div>
      <div class="composer" style="position:relative">
        <div class="results hidden" id="mm" style="top:auto;bottom:calc(100% - 6px);left:18px;right:auto;min-width:220px"></div>
        <form id="cf"><textarea id="cb" rows="1" placeholder="Message… (/task, /meet, @handle)" maxlength="4000" aria-label="Message"></textarea>
        <button class="btn primary" type="submit" aria-label="Send">${icon('send', 15)}</button></form></div>
    </section></div>`;

  // ---------- channel list ----------
  const drawList = () => {
    const pub = S.channels.filter((c) => c.kind !== 'dm');
    const dms = S.channels.filter((c) => c.kind === 'dm');
    const item = (c) => `<a href="#/chat/${c.id}" class="${c.id === chId ? 'on' : ''} ${c.unread ? 'unread-name' : ''}">${c.kind === 'dm' ? avatar(user(c.members.find((i) => i !== S.me.id) ?? S.me.id), 20) : icon('hash', 15)}<span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.kind === 'dm' ? channelName(c) : c.name)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</a>`;
    $('#cl', el).innerHTML = `<div class="nav"><h5 class="row between">Channels <button class="icon-btn" id="addch" aria-label="New channel" style="width:24px;height:24px">${icon('plus', 14)}</button></h5>${pub.map(item).join('')}
      <h5 class="row between">Direct messages <button class="icon-btn" id="adddm" aria-label="New message" style="width:24px;height:24px">${icon('plus', 14)}</button></h5>${dms.map(item).join('') || '<div class="muted small" style="padding:4px 10px">No conversations yet.</div>'}</div>`;
    $('#addch', el).onclick = newChannel;
    $('#adddm', el).onclick = newDm;
    const c = S.channels.find((x) => x.id === chId);
    if (c) {
      $('#ct', el).textContent = channelName(c);
      $('#ctopic', el).textContent = c.kind === 'dm' ? 'Private conversation' : c.topic || '';
    }
  };
  const unsub = onShared(drawList);
  drawList();
  $('#showch', el).onclick = () => $('#chat', el).classList.toggle('show-channels');
  $('#cl', el).addEventListener('click', () => $('#chat', el).classList.remove('show-channels'));

  function newChannel() {
    const m = openModal({
      title: 'New channel',
      html: `<form id="chf"><label class="f">Name</label><input name="name" type="text" required maxlength="40" placeholder="design-team">
        <label class="f">Topic <span class="muted">(optional)</span></label><input name="topic" type="text" maxlength="200">
        <div class="err" id="che"></div><div class="row end gap" style="margin-top:10px"><button class="btn" type="button" data-c>Cancel</button><button class="btn primary" type="submit">Create channel</button></div></form>`,
    });
    $('[data-c]', m.body).onclick = m.close;
    $('#chf', m.body).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const c = await post('/channels', Object.fromEntries(new FormData(e.target)));
        await loadChannels();
        m.close();
        go(`#/chat/${c.id}`);
      } catch (err) {
        $('#che', m.body).textContent = err.message;
      }
    };
  }

  function newDm() {
    const m = openModal({
      title: 'New message',
      html: `<div>${S.users.map((u) => `<a class="list-item" href="#" data-u="${u.id}">${avatar(u, 28)}<span class="grow">${esc(u.name)}${u.id === S.me.id ? ' (you)' : ''}</span><span class="muted small">@${esc(u.handle)}</span></a>`).join('')}</div>`,
    });
    m.body.onclick = async (e) => {
      const a = e.target.closest('[data-u]');
      if (!a) return;
      e.preventDefault();
      const c = await attempt(() => post('/dm', { user_id: Number(a.dataset.u) }));
      if (c) {
        await loadChannels();
        m.close();
        go(`#/chat/${c.id}`);
      }
    };
  }

  // ---------- messages ----------
  const actions = (m, inThread) => `<div class="actions">${EMOJI.map((e) => `<button class="icon-btn" style="width:28px;height:28px" data-react="${m.id}" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}
    ${inThread ? '' : `<button class="icon-btn" style="width:28px;height:28px" data-reply="${m.id}" title="Reply in thread" aria-label="Reply in thread">${icon('chat', 14)}</button>`}
    <button class="icon-btn" style="width:28px;height:28px" data-issue-from="${m.id}" title="Create issue" aria-label="Create issue">${icon('board', 14)}</button>
    ${m.user_id === S.me.id ? `<button class="icon-btn" style="width:28px;height:28px" data-edit="${m.id}" title="Edit" aria-label="Edit">${icon('edit', 14)}</button>` : ''}
    ${m.user_id === S.me.id || S.me.role === 'admin' ? `<button class="icon-btn" style="width:28px;height:28px" data-del="${m.id}" title="Delete" aria-label="Delete">${icon('trash', 14)}</button>` : ''}</div>`;

  const msgHtml = (m, inThread = false) => {
    const u = user(m.user_id);
    const rx = Object.entries(m.reactions || {})
      .map(([e, ids]) => `<button class="rx ${ids.includes(S.me.id) ? 'mine' : ''}" data-react="${m.id}" data-emoji="${e}" title="${esc(ids.map((i) => user(i)?.name || '?').join(', '))}">${e} ${ids.length}</button>`)
      .join('');
    return `<div class="msg" data-id="${m.id}">${avatar(u, 34)}<div class="body">
      <div><span class="who">${esc(u?.name || 'Deleted user')}</span><span class="muted small">${fmtTime(m.created)}${m.edited ? ' · edited' : ''}</span></div>
      <div>${linkify(m.body)}</div>${rx ? `<div>${rx}</div>` : ''}
      ${!inThread && m.reply_count ? `<a href="#" class="replies-link" data-reply="${m.id}">${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}</a>` : ''}
    </div>${actions(m, inThread)}</div>`;
  };

  const drawMsgs = () => {
    const box = $('#msgs', el);
    const nearBottom = first || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    let day = '';
    const html = msgs.map((m) => {
      const d = fmtDate(m.created);
      const sep = d !== day ? `<div class="daysep"><span>${d}</span></div>` : '';
      day = d;
      return sep + msgHtml(m);
    });
    box.innerHTML = (hasMore ? '<div style="text-align:center"><button class="btn sm ghost" id="older">Load earlier messages</button></div>' : '') +
      (html.join('') || '<div class="empty">No messages yet. Say hello 👋</div>');
    $('#older', box)?.addEventListener('click', loadOlder);
    if (nearBottom) box.scrollTop = box.scrollHeight;
    first = false;
  };

  const loadMsgs = async () => {
    const r = await get(`/channels/${chId}/messages`);
    msgs = r.messages;
    hasMore = r.has_more;
    drawMsgs();
    loadChannels().catch(() => {}); // server marked this channel read
  };
  const loadOlder = async () => {
    const r = await attempt(() => get(`/channels/${chId}/messages?before=${msgs[0].id}`));
    if (!r) return;
    const box = $('#msgs', el);
    const prev = box.scrollHeight;
    msgs = [...r.messages, ...msgs];
    hasMore = r.has_more;
    drawMsgs();
    box.scrollTop = box.scrollHeight - prev;
  };
  const reloadMsgs = debounce(() => loadMsgs().catch(() => {}), 120);

  // ---------- thread ----------
  const closeThread = () => {
    threadId = null;
    $('#chat', el).classList.remove('thread-open');
    $('.thread', el)?.remove();
  };
  const drawThread = async () => {
    if (!threadId) return;
    const r = await attempt(() => get(`/messages/${threadId}/thread`));
    if (!r) return closeThread();
    let pane = $('.thread', el);
    if (!pane) {
      pane = document.createElement('aside');
      pane.className = 'thread';
      $('#chat', el).appendChild(pane);
      $('#chat', el).classList.add('thread-open');
    }
    pane.innerHTML = `<div class="chat-head"><strong class="grow">Thread</strong><button class="icon-btn" data-close-thread aria-label="Close thread">${icon('x')}</button></div>
      <div class="msgs">${msgHtml(r.parent, true)}<div class="daysep"><span>${r.replies.length} ${r.replies.length === 1 ? 'reply' : 'replies'}</span></div>${r.replies.map((m) => msgHtml(m, true)).join('')}</div>
      <div class="composer"><form id="tf"><textarea id="tb" rows="1" placeholder="Reply…" maxlength="4000" aria-label="Reply"></textarea><button class="btn primary" type="submit" aria-label="Send reply">${icon('send', 15)}</button></form></div>`;
    $('[data-close-thread]', pane).onclick = closeThread;
    const tb = $('#tb', pane);
    const send = async () => {
      const body = tb.value.trim();
      if (!body) return;
      tb.value = '';
      if (await attempt(() => post(`/channels/${chId}/messages`, { body, parent_id: threadId }))) {
        drawThread();
        reloadMsgs();
      } else tb.value = body;
    };
    $('#tf', pane).onsubmit = (e) => (e.preventDefault(), send());
    tb.onkeydown = (e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send());
    const box = $('.msgs', pane);
    box.scrollTop = box.scrollHeight;
  };

  // ---------- actions (delegated) ----------
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-react],[data-reply],[data-edit],[data-del],[data-issue-from]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.react) {
      await attempt(() => post(`/messages/${t.dataset.react}/react`, { emoji: t.dataset.emoji }));
    } else if (t.dataset.reply) {
      threadId = Number(t.dataset.reply);
      drawThread();
    } else if (t.dataset.edit) {
      editMessage(Number(t.dataset.edit));
    } else if (t.dataset.del) {
      if (await confirmDialog('Delete this message?')) await attempt(() => del(`/messages/${t.dataset.del}`));
    } else if (t.dataset.issueFrom) {
      messageToIssue(Number(t.dataset.issueFrom));
    }
  });

  const findMsg = (id) => msgs.find((m) => m.id === id);

  function editMessage(id) {
    const text = findMsg(id)?.body ?? '';
    const m = openModal({ title: 'Edit message', html: `<form id="ef"><textarea rows="4" maxlength="4000" required>${esc(text)}</textarea><div class="row end gap" style="margin-top:10px"><button class="btn" type="button" data-c>Cancel</button><button class="btn primary">Save</button></div></form>` });
    $('[data-c]', m.body).onclick = m.close;
    $('#ef', m.body).onsubmit = async (e) => {
      e.preventDefault();
      if (await attempt(() => patch(`/messages/${id}`, { body: $('textarea', m.body).value }))) m.close();
    };
  }

  function messageToIssue(id) {
    if (!S.projects.length) return toast('Create a project first, then you can turn messages into issues.', 'error');
    const file = async (project_key, m) => {
      const issue = await attempt(() => post(`/messages/${id}/to-issue`, { project_key }));
      if (issue) toast(`Created ${issue.key}`, 'ok');
      m?.close();
    };
    if (S.projects.length === 1) return file(S.projects[0].key);
    const m = openModal({ title: 'Create issue in…', html: S.projects.map((p) => `<a class="list-item" href="#" data-p="${esc(p.key)}"><span class="k">${esc(p.key)}</span><span class="grow">${esc(p.name)}</span></a>`).join('') });
    m.body.onclick = (e) => {
      const a = e.target.closest('[data-p]');
      if (a) (e.preventDefault(), file(a.dataset.p, m));
    };
  }

  // ---------- composer ----------
  const cb = $('#cb', el);
  const mm = $('#mm', el);
  let mentionIdx = 0;
  let mentionList = [];
  const closeMentions = () => ((mentionList = []), mm.classList.add('hidden'));
  const drawMentions = () => {
    if (!mentionList.length) return closeMentions();
    mm.innerHTML = mentionList.map((u, i) => `<a href="#" data-m="${esc(u.handle)}" style="${i === mentionIdx ? 'background:var(--blue-soft)' : ''}">${avatar(u, 20)} ${esc(u.name)} <span class="muted small">@${esc(u.handle)}</span></a>`).join('');
    mm.classList.remove('hidden');
  };
  const insertMention = (handle) => {
    const pos = cb.selectionStart;
    const before = cb.value.slice(0, pos).replace(/@([a-z0-9_]*)$/i, `@${handle} `);
    cb.value = before + cb.value.slice(pos);
    cb.setSelectionRange(before.length, before.length);
    closeMentions();
    cb.focus();
  };
  cb.addEventListener('input', () => {
    cb.style.height = 'auto';
    cb.style.height = `${Math.min(cb.scrollHeight, 140)}px`;
    const m = /(?:^|\s)@([a-z0-9_]*)$/i.exec(cb.value.slice(0, cb.selectionStart));
    if (!m) return closeMentions();
    const q = m[1].toLowerCase();
    mentionList = S.users.filter((u) => u.handle.startsWith(q) || u.name.toLowerCase().startsWith(q)).slice(0, 6);
    mentionIdx = 0;
    drawMentions();
  });
  mm.addEventListener('mousedown', (e) => {
    const a = e.target.closest('[data-m]');
    if (a) (e.preventDefault(), insertMention(a.dataset.m));
  });
  const send = async () => {
    const body = cb.value.trim();
    if (!body) return;
    cb.value = '';
    cb.style.height = 'auto';
    closeMentions();
    if (await attempt(() => post(`/channels/${chId}/messages`, { body }))) {
      first = true;
      loadMsgs();
    } else cb.value = body;
  };
  cb.addEventListener('keydown', (e) => {
    if (mentionList.length) {
      if (e.key === 'ArrowDown') (e.preventDefault(), (mentionIdx = (mentionIdx + 1) % mentionList.length), drawMentions());
      else if (e.key === 'ArrowUp') (e.preventDefault(), (mentionIdx = (mentionIdx - 1 + mentionList.length) % mentionList.length), drawMentions());
      else if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), insertMention(mentionList[mentionIdx].handle));
      else if (e.key === 'Escape') closeMentions();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), send());
  });
  $('#cf', el).onsubmit = (e) => (e.preventDefault(), send());
  $('#meet', el).onclick = async () => {
    if (await attempt(() => post(`/channels/${chId}/messages`, { body: '/meet' }))) loadMsgs();
  };

  S.activeChannel = chId;
  await loadMsgs();
  cb.focus();

  return {
    destroy() {
      unsub();
      S.activeChannel = null;
    },
    live(evt) {
      if (evt.type !== 'message' || evt.channel_id !== chId) return;
      reloadMsgs();
      if (threadId && (evt.parent_id === threadId || evt.id === threadId)) drawThread();
    },
  };
}
