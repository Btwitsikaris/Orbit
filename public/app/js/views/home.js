import { get } from '../api.js';
import { S, userName } from '../state.js';
import { esc, icon, statusLabel, priorityLabel, timeAgo, fmtDateTime, TYPE_ICON } from '../ui.js';
import { channelName } from '../shared.js';

export async function mountHome(el) {
  const draw = async () => {
    const week = Date.now() + 7 * 864e5;
    const [mine, events, approvals, docs] = await Promise.all([
      get('/issues?mine=1'),
      get(`/events?from=${Date.now()}&to=${week}`),
      get('/approvals'),
      get('/docs'),
    ]);
    const pending = approvals.to_review.filter((a) => a.status === 'pending');
    const unreadChannels = S.channels.filter((c) => c.unread > 0);
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${hello}, ${esc(S.me.name.split(' ')[0])}</h1><div class="muted">Here is what needs you today.</div></div></div>
      <div class="grid2">
        <section class="card pad"><h3>${icon('board', 15)} My open issues</h3>
          ${mine.length ? mine.slice(0, 8).map((i) => `<a class="list-item" href="#" data-issue="${esc(i.key)}"><span>${TYPE_ICON[i.type] || ''}</span><span class="k">${esc(i.key)}</span><span class="grow">${esc(i.title)}</span><span class="chip ${i.status}">${statusLabel(i.status)}</span><span class="prio ${i.priority}">${priorityLabel(i.priority)}</span></a>`).join('') : '<div class="empty">Nothing assigned to you.</div>'}
        </section>
        <section class="card pad"><h3>${icon('chat', 15)} Unread conversations</h3>
          ${unreadChannels.length ? unreadChannels.map((c) => `<a class="list-item" href="#/chat/${c.id}"><span class="grow">${esc(channelName(c))}</span><span class="badge">${c.unread}</span></a>`).join('') : '<div class="empty">No unread messages.</div>'}
        </section>
        <section class="card pad"><h3>${icon('calendar', 15)} Next 7 days</h3>
          ${events.length ? events.slice(0, 6).map((e) => `<a class="list-item" href="#/calendar"><span class="grow"><strong>${esc(e.title)}</strong><div class="muted small">${fmtDateTime(e.starts_at)}</div></span>${e.meeting_url ? `<span class="chip">${icon('video', 12)} video</span>` : ''}</a>`).join('') : '<div class="empty">No events coming up.</div>'}
        </section>
        <section class="card pad"><h3>${icon('check', 15)} Waiting for your approval</h3>
          ${pending.length ? pending.map((a) => `<a class="list-item" href="#/approvals"><span class="grow"><strong>${esc(a.title)}</strong><div class="muted small">from ${esc(userName(a.requester_id))} · ${timeAgo(a.created)}</div></span></a>`).join('') : '<div class="empty">No pending requests.</div>'}
        </section>
        <section class="card pad"><h3>${icon('doc', 15)} Recent docs</h3>
          ${docs.length ? docs.slice(0, 5).map((d) => `<a class="list-item" href="#/docs/${d.id}"><span class="grow">${esc(d.title)}</span><span class="muted small">${timeAgo(d.updated)}</span></a>`).join('') : '<div class="empty">No docs yet.</div>'}
        </section>
      </div></div>`;
  };
  await draw();
  const live = (evt) => {
    if (['issue', 'event', 'approval', 'doc', 'message'].includes(evt.type)) draw().catch(() => {});
  };
  return { live };
}
