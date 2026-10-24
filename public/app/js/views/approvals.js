import { get, post } from '../api.js';
import { S, user, userName } from '../state.js';
import { esc, $, $$, icon, avatar, timeAgo, openModal, attempt, toast, userOptions } from '../ui.js';

export async function mountApprovals(el) {
  let data = await get('/approvals');
  let alive = true;

  const row = (a, who, label) => `<div class="card pad" style="margin-bottom:10px" data-a="${a.id}">
    <div class="row between gap wrap"><div class="row gap grow">${avatar(user(who), 30)}<div><strong>${esc(a.title)}</strong>
      <div class="muted small">${label} ${esc(userName(who))} · ${timeAgo(a.created)}</div></div></div><span class="chip ${a.status}">${a.status}</span></div>
    ${a.details ? `<p style="margin:10px 0 0;white-space:pre-wrap">${esc(a.details)}</p>` : ''}
    ${a.decision_note ? `<p class="muted small" style="margin:8px 0 0">Note: ${esc(a.decision_note)}</p>` : ''}
    ${a.status === 'pending' && a.approver_id === S.me.id
      ? `<div class="row gap" style="margin-top:12px"><input type="text" placeholder="Add a note (optional)" maxlength="1000" data-note aria-label="Decision note"><button class="btn" data-d="rejected">Reject</button><button class="btn primary" data-d="approved">Approve</button></div>`
      : ''}</div>`;

  const draw = () => {
    el.innerHTML = `<div class="page"><div class="page-head"><h1>Approvals</h1><button class="btn primary" id="nr">${icon('plus', 14)} New request</button></div>
      <h3 style="margin:0 0 10px">To review</h3>${data.to_review.map((a) => row(a, a.requester_id, 'from')).join('') || '<div class="card empty">Nothing to review.</div>'}
      <h3 style="margin:22px 0 10px">My requests</h3>${data.mine.map((a) => row(a, a.approver_id, 'sent to')).join('') || '<div class="card empty">You have not asked for anything yet.</div>'}</div>`;
    $('#nr', el).onclick = newRequest;
    for (const b of $$('[data-d]', el)) {
      b.onclick = async () => {
        const card = b.closest('[data-a]');
        const note = $('[data-note]', card).value;
        if (await attempt(() => post(`/approvals/${card.dataset.a}/decide`, { decision: b.dataset.d, note }))) {
          toast(`Request ${b.dataset.d}`, 'ok');
          reload();
        }
      };
    }
  };

  const reload = async () => {
    data = await get('/approvals');
    if (alive) draw();
  };

  function newRequest() {
    const others = S.users.filter((u) => u.id !== S.me.id);
    if (!others.length) return toast('Invite a teammate first. Approvals need someone else to review them.', 'error');
    const m = openModal({
      title: 'New approval request',
      html: `<form id="rf"><label class="f">What do you need approved?</label><input name="title" type="text" required maxlength="160" placeholder="Budget for Q4 offsite">
        <label class="f">Approver</label><select name="approver_id" required>${others.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
        <label class="f">Details</label><textarea name="details" rows="4" maxlength="4000"></textarea>
        <div class="err" id="re"></div><div class="row end gap" style="margin-top:10px"><button class="btn" type="button" data-c>Cancel</button><button class="btn primary" type="submit">Send request</button></div></form>`,
    });
    $('[data-c]', m.body).onclick = m.close;
    $('#rf', m.body).onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.approver_id = Number(b.approver_id);
      try {
        await post('/approvals', b);
        m.close();
        toast('Request sent', 'ok');
        reload();
      } catch (err) {
        $('#re', m.body).textContent = err.message;
      }
    };
  }

  draw();
  return { destroy: () => (alive = false), live: (evt) => evt.type === 'approval' && reload().catch(() => {}) };
}
