import { get, patch, post, del } from '../api.js';
import { S, user } from '../state.js';
import {
  esc, $, icon, avatar, linkify, timeAgo, openModal, confirmDialog, attempt, toast,
  STATUSES, PRIORITIES, TYPES, options, userOptions,
} from '../ui.js';

let openKey = null;
let current = null;

/** Open the issue dialog. onChange runs after any edit so the caller can refresh. */
export async function openIssue(key, onChange) {
  const data = await attempt(() => get(`/issues/${encodeURIComponent(key)}`));
  if (!data) return;
  openKey = data.issue.key;
  const modal = openModal({ title: data.issue.key, html: '<div id="ib"></div>', wide: true, onClose: () => ((openKey = null), (current = null)) });
  current = { modal, onChange };
  draw(modal, data, onChange);
}

/** Live updates: redraw the open dialog if it is the issue that changed. */
export async function refreshOpenIssue(evt) {
  if (!current || evt.key !== openKey) return;
  const data = await get(`/issues/${encodeURIComponent(openKey)}`).catch(() => null);
  if (!data) return current.modal.close();
  draw(current.modal, data, current.onChange);
}

function draw(modal, { issue, sprints, comments, activity }, onChange) {
  const project = S.projects.find((p) => p.key === issue.project_key);
  const people = (id) => user(id);
  const feed = [
    ...comments.map((c) => ({ t: c.created, html: `<div class="comment">${avatar(people(c.user_id), 28)}<div class="bubble"><strong>${esc(people(c.user_id)?.name || 'Someone')}</strong> <span class="muted small">${timeAgo(c.created)}</span><div>${linkify(c.body)}</div></div></div>` })),
    ...activity.map((a) => ({ t: a.created, html: `<div class="act">${esc(people(a.user_id)?.name || 'Someone')} ${esc(a.text)} · ${timeAgo(a.created)}</div>` })),
  ].sort((a, b) => a.t - b.t);

  const sprintOpts = ['<option value="">Backlog</option>', ...sprints.map((s) => `<option value="${s.id}" ${s.id === issue.sprint_id ? 'selected' : ''}>${esc(s.name)}${s.state === 'active' ? ' (active)' : ''}</option>`)].join('');
  $('#ib', modal.body).innerHTML = `<div class="issue-grid">
    <div>
      <div class="muted small" style="margin-bottom:6px">${esc(project?.name || issue.project_key)} · <span class="k">${esc(issue.key)}</span></div>
      <input class="issue-title" id="f-title" type="text" value="${esc(issue.title)}" maxlength="200" aria-label="Title">
      <label class="f">Description</label>
      <textarea id="f-desc" rows="5" placeholder="Add more detail…">${esc(issue.description)}</textarea>
      <h4 style="margin:20px 0 4px">Comments &amp; activity</h4>
      <div id="feed">${feed.map((x) => x.html).join('') || '<div class="muted small">No activity yet.</div>'}</div>
      <form id="cf" style="margin-top:10px"><textarea id="cb" rows="2" placeholder="Write a comment… use @handle to mention" required></textarea>
        <div class="row end" style="margin-top:6px"><button class="btn primary sm" type="submit">Comment</button></div></form>
    </div>
    <div class="fields">
      <div><label>Status</label><select id="f-status">${options(STATUSES, issue.status)}</select></div>
      <div><label>Assignee</label><select id="f-assignee">${userOptions(issue.assignee_id)}</select></div>
      <div><label>Priority</label><select id="f-priority">${options(PRIORITIES, issue.priority)}</select></div>
      <div><label>Type</label><select id="f-type">${options(TYPES, issue.type)}</select></div>
      <div><label>Sprint</label><select id="f-sprint">${sprintOpts}</select></div>
      <div><label>Labels</label><input id="f-labels" type="text" value="${esc(issue.labels.join(', '))}" placeholder="comma separated"></div>
      <div><label>Estimate (points)</label><input id="f-estimate" type="number" min="0" max="1000" value="${issue.estimate ?? ''}"></div>
      <div class="muted small">Reporter: ${esc(people(issue.reporter_id)?.name || 'unknown')}<br>Created ${timeAgo(issue.created)}</div>
      <button class="btn danger sm" id="del">${icon('trash', 14)} Delete issue</button>
    </div></div>`;

  const save = async (patchBody) => {
    const r = await attempt(() => patch(`/issues/${encodeURIComponent(issue.key)}`, patchBody));
    if (r) onChange?.();
  };
  const field = (id, key, conv = (v) => v) => {
    $(id, modal.body).addEventListener('change', (e) => save({ [key]: conv(e.target.value) }));
  };
  field('#f-title', 'title');
  field('#f-desc', 'description');
  field('#f-status', 'status');
  field('#f-priority', 'priority');
  field('#f-type', 'type');
  field('#f-assignee', 'assignee_id', (v) => (v ? Number(v) : null));
  field('#f-sprint', 'sprint_id', (v) => (v ? Number(v) : null));
  field('#f-labels', 'labels', (v) => v.split(',').map((x) => x.trim()).filter(Boolean));
  field('#f-estimate', 'estimate', (v) => (v === '' ? null : Number(v)));

  $('#cf', modal.body).onsubmit = async (e) => {
    e.preventDefault();
    const body = $('#cb', modal.body).value.trim();
    if (!body) return;
    const ok = await attempt(() => post(`/issues/${encodeURIComponent(issue.key)}/comments`, { body }));
    if (ok) onChange?.();
  };
  $('#del', modal.body).onclick = async () => {
    if (!(await confirmDialog(`Delete ${issue.key}? This cannot be undone.`))) return;
    const ok = await attempt(() => del(`/issues/${encodeURIComponent(issue.key)}`));
    if (ok) {
      toast(`${issue.key} deleted`, 'ok');
      modal.close();
      onChange?.();
    }
  };
}
