import { get, post, put, del } from '../api.js';
import { S, user, userName } from '../state.js';
import { esc, $, $$, icon, avatar, fmtTime, fmtDateTime, dateInput, timeInput, openModal, confirmDialog, attempt, toast } from '../ui.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function mountCalendar(el) {
  let cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  let events = [];
  let alive = true;

  const range = () => {
    const start = new Date(cursor);
    start.setDate(1 - start.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 42);
    return [start, end];
  };

  const load = async () => {
    const [a, b] = range();
    events = await get(`/events?from=${a.getTime()}&to=${b.getTime()}`);
    if (alive) draw();
  };

  const myStatus = (e) => e.attendees.find((a) => a.user_id === S.me.id)?.status || 'accepted';

  function draw() {
    const [start] = range();
    const todayKey = dateInput(new Date());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = dateInput(d);
      const dayStart = new Date(d).setHours(0, 0, 0, 0);
      const dayEnd = dayStart + 864e5;
      const todays = events.filter((e) => e.starts_at < dayEnd && e.ends_at > dayStart);
      cells.push(`<div class="day ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${key === todayKey ? 'today' : ''}" data-day="${key}" role="button" tabindex="0" aria-label="${d.toDateString()}">
        <span class="n">${d.getDate()}</span>
        ${todays.slice(0, 3).map((e) => `<button class="ev ${myStatus(e)}" data-ev="${e.id}" title="${esc(e.title)}">${fmtTime(e.starts_at)} ${esc(e.title)}</button>`).join('')}
        ${todays.length > 3 ? `<div class="muted small">+${todays.length - 3} more</div>` : ''}</div>`);
    }
    el.innerHTML = `<div class="page">
      <div class="page-head"><div class="row gap"><h1>${cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1>
        <button class="icon-btn" id="prev" aria-label="Previous month">${icon('chevL', 18)}</button><button class="btn sm" id="today">Today</button><button class="icon-btn" id="next" aria-label="Next month">${icon('chevR', 18)}</button></div>
        <button class="btn primary" id="newev">${icon('plus', 14)} New event</button></div>
      <div class="cal">${DOW.map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div></div>`;
    $('#prev', el).onclick = () => (cursor.setMonth(cursor.getMonth() - 1), load());
    $('#next', el).onclick = () => (cursor.setMonth(cursor.getMonth() + 1), load());
    $('#today', el).onclick = () => ((cursor = new Date()), cursor.setDate(1), cursor.setHours(0, 0, 0, 0), load());
    $('#newev', el).onclick = () => newEvent(new Date());
  }

  el.addEventListener('click', (e) => {
    const ev = e.target.closest('[data-ev]');
    if (ev) return showEvent(events.find((x) => x.id === Number(ev.dataset.ev)));
    const day = e.target.closest('[data-day]');
    if (day) {
      const [y, m, d] = day.dataset.day.split('-').map(Number);
      newEvent(new Date(y, m - 1, d, 9, 0));
    }
  });
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-day]')) (e.preventDefault(), e.target.click());
  });

  function newEvent(when) {
    const start = new Date(when);
    if (dateInput(start) === dateInput(new Date())) {
      start.setHours(new Date().getHours() + 1, 0, 0, 0);
    }
    const end = new Date(start.getTime() + 3600e3);
    const m = openModal({
      title: 'New event',
      html: `<form id="ef"><label class="f">Title</label><input name="title" type="text" required maxlength="120">
        <div class="row gap"><div class="grow"><label class="f">Date</label><input name="date" type="date" required value="${dateInput(start)}"></div>
        <div><label class="f">Start</label><input name="start" type="time" required value="${timeInput(start)}"></div>
        <div><label class="f">End</label><input name="end" type="time" required value="${timeInput(end)}"></div></div>
        <label class="f">Location</label><input name="location" type="text" maxlength="120" placeholder="Room, address…">
        <label class="f">Description</label><textarea name="description" rows="2" maxlength="2000"></textarea>
        <label class="f">Invite people</label><div style="max-height:130px;overflow:auto;border:1px solid var(--line);border-radius:9px;padding:4px 8px">
          ${S.users.filter((u) => u.id !== S.me.id).map((u) => `<label class="row gap" style="padding:4px 0"><input type="checkbox" name="att" value="${u.id}"> ${avatar(u, 20)} ${esc(u.name)}</label>`).join('') || '<span class="muted small">No one else has joined yet.</span>'}</div>
        <label class="row gap" style="margin-top:10px"><input type="checkbox" name="meeting" checked> ${icon('video', 14)} Add a video meeting link</label>
        <div class="err" id="ee"></div><div class="row end gap" style="margin-top:10px"><button class="btn" type="button" data-c>Cancel</button><button class="btn primary" type="submit">Create event</button></div></form>`,
    });
    $('[data-c]', m.body).onclick = m.close;
    $('#ef', m.body).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const at = (t) => new Date(`${f.get('date')}T${t}`).getTime();
      try {
        await post('/events', {
          title: f.get('title'),
          starts_at: at(f.get('start')),
          ends_at: at(f.get('end')),
          location: f.get('location'),
          description: f.get('description'),
          attendees: f.getAll('att').map(Number),
          meeting: f.get('meeting') === 'on',
        });
        m.close();
        toast('Event created', 'ok');
        load();
      } catch (err) {
        $('#ee', m.body).textContent = err.message;
      }
    };
  }

  function showEvent(ev) {
    if (!ev) return;
    const mine = ev.attendees.find((a) => a.user_id === S.me.id);
    const canCancel = ev.created_by === S.me.id || S.me.role === 'admin';
    const m = openModal({
      title: ev.title,
      html: `<p class="muted" style="margin-top:0">${fmtDateTime(ev.starts_at)} – ${fmtTime(ev.ends_at)}</p>
        ${ev.location ? `<p>${esc(ev.location)}</p>` : ''}${ev.description ? `<p>${esc(ev.description)}</p>` : ''}
        ${ev.meeting_url ? `<p><a class="btn primary" href="${esc(ev.meeting_url)}" target="_blank" rel="noopener noreferrer">${icon('video', 14)} Join video meeting</a></p>` : ''}
        <h4 style="margin:12px 0 6px">Attendees</h4>
        ${ev.attendees.map((a) => `<div class="list-item">${avatar(user(a.user_id), 24)}<span class="grow">${esc(userName(a.user_id))}${a.user_id === ev.created_by ? ' <span class="muted small">(organizer)</span>' : ''}</span><span class="chip ${a.status}">${a.status}</span></div>`).join('')}
        <div class="row end gap" style="margin-top:14px">
          ${mine && ev.created_by !== S.me.id ? `<button class="btn" data-rsvp="declined">Decline</button><button class="btn primary" data-rsvp="accepted">Accept</button>` : ''}
          ${canCancel ? `<button class="btn danger" id="cancel">${icon('trash', 14)} Cancel event</button>` : ''}</div>`,
    });
    for (const b of $$('[data-rsvp]', m.body)) {
      b.onclick = async () => {
        if (await attempt(() => put(`/events/${ev.id}/rsvp`, { status: b.dataset.rsvp }))) {
          m.close();
          load();
        }
      };
    }
    $('#cancel', m.body)?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Cancel “${ev.title}”? Attendees will be notified.`, 'Cancel event'))) return;
      if (await attempt(() => del(`/events/${ev.id}`))) {
        m.close();
        load();
      }
    });
  }

  await load();
  return {
    destroy: () => (alive = false),
    live: (evt) => evt.type === 'event' && load().catch(() => {}),
  };
}
