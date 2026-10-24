import { get, post, patch } from '../api.js';
import { S, user } from '../state.js';
import {
  esc, $, $$, icon, avatar, statusLabel, priorityLabel, TYPE_ICON, STATUSES, PRIORITIES, TYPES,
  options, userOptions, openModal, attempt, toast, debounce,
} from '../ui.js';
import { loadProjects, go } from '../shared.js';
import { openIssue } from './issue.js';

// ---------- project list ----------
export async function mountProjects(el) {
  const draw = () => {
    el.innerHTML = `<div class="page">
      <div class="page-head"><h1>Projects</h1><button class="btn primary" id="np">${icon('plus', 14)} New project</button></div>
      ${S.projects.length ? `<div class="grid2">${S.projects
        .map((p) => {
          const total = p.open_count + p.done_count;
          const pct = total ? Math.round((p.done_count / total) * 100) : 0;
          return `<a class="card pcard" href="#/p/${esc(p.key)}"><div class="row between"><h3 style="margin:0">${esc(p.name)}</h3><span class="k">${esc(p.key)}</span></div>
            <p class="muted" style="margin:6px 0 0">${esc(p.description || 'No description')}</p>
            <div class="bar" aria-label="${pct}% done"><i style="width:${pct}%"></i></div>
            <div class="muted small" style="margin-top:6px">${p.open_count} open · ${p.done_count} done</div></a>`;
        })
        .join('')}</div>` : '<div class="card empty">No projects yet. Create your first one to start tracking work.</div>'}</div>`;
    $('#np', el).onclick = newProject;
  };
  const newProject = () => {
    const m = openModal({
      title: 'New project',
      html: `<form id="pf"><label class="f">Name</label><input name="name" type="text" required maxlength="80" placeholder="Website redesign">
        <label class="f">Key <span class="muted">(prefix for issue IDs, e.g. WEB)</span></label><input name="key" type="text" required maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{1,9}" placeholder="WEB" style="text-transform:uppercase">
        <label class="f">Description</label><textarea name="description" rows="2" maxlength="500"></textarea>
        <div class="err" id="pe"></div><div class="row end gap" style="margin-top:10px"><button class="btn" type="button" data-c>Cancel</button><button class="btn primary" type="submit">Create project</button></div></form>`,
    });
    $('[data-c]', m.body).onclick = m.close;
    const nameEl = $('[name=name]', m.body);
    const keyEl = $('[name=key]', m.body);
    nameEl.addEventListener('input', () => {
      if (!keyEl.dataset.touched) keyEl.value = nameEl.value.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
    });
    keyEl.addEventListener('input', () => (keyEl.dataset.touched = '1'));
    $('#pf', m.body).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const p = await post('/projects', Object.fromEntries(new FormData(e.target)));
        await loadProjects();
        m.close();
        go(`#/p/${p.key}`);
      } catch (err) {
        $('#pe', m.body).textContent = err.message;
      }
    };
  };
  draw();
  return { live: (evt) => evt.type === 'project' && setTimeout(draw, 500) };
}

// ---------- one project: board + backlog ----------
export async function mountProject(el, key, tab = 'board') {
  key = key.toUpperCase();
  let data = await get(`/projects/${key}`);
  const f = { assignee: '', type: '', q: '' };
  let dragKey = null;

  const reload = async () => {
    try {
      data = await get(`/projects/${key}`);
    } catch {
      return go('#/projects');
    }
    draw();
  };

  const issueMatches = (i) =>
    (!f.assignee || String(i.assignee_id ?? 'none') === f.assignee) &&
    (!f.type || i.type === f.type) &&
    (!f.q || `${i.key} ${i.title}`.toLowerCase().includes(f.q.toLowerCase()));

  const filters = () => `<div class="filters">
    <input type="text" id="fq" placeholder="Filter issues…" value="${esc(f.q)}" aria-label="Filter issues">
    <select id="fa" aria-label="Assignee"><option value="">Everyone</option><option value="none" ${f.assignee === 'none' ? 'selected' : ''}>Unassigned</option>${S.users.map((u) => `<option value="${u.id}" ${String(u.id) === f.assignee ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
    <select id="ft" aria-label="Type"><option value="">All types</option>${options(TYPES, f.type)}</select></div>`;

  const ticket = (i) => `<div class="ticket" draggable="true" data-key="${esc(i.key)}" tabindex="0" role="button" aria-label="${esc(i.key)} ${esc(i.title)}">
    <div class="t">${esc(i.title)}</div>
    <div class="meta"><span class="row gap" style="gap:6px"><span>${TYPE_ICON[i.type] || ''}</span><span class="k">${esc(i.key)}</span><span class="prio ${i.priority}" title="${priorityLabel(i.priority)}">${priorityLabel(i.priority).toUpperCase()}</span></span>
    ${avatar(user(i.assignee_id), 24)}</div></div>`;

  const irow = (i) => `<div class="irow" draggable="true" data-key="${esc(i.key)}" tabindex="0" role="button">
    <span>${TYPE_ICON[i.type] || ''}</span><span class="k">${esc(i.key)}</span><span class="title">${esc(i.title)}</span>
    ${i.estimate != null ? `<span class="chip">${i.estimate}</span>` : ''}<span class="chip ${i.status}">${statusLabel(i.status)}</span>${avatar(user(i.assignee_id), 22)}</div>`;

  function drawBoard(host) {
    const active = data.sprints.find((s) => s.state === 'active');
    const issues = data.issues.filter((i) => (active ? i.sprint_id === active.id : true)).filter(issueMatches);
    host.innerHTML = `<div class="muted small" style="margin-bottom:10px">${active ? `${icon('board', 13)} <strong>${esc(active.name)}</strong> is active` : 'No active sprint. Showing every issue. Start a sprint from the Backlog tab.'}</div>
      <div class="board">${STATUSES.map(([s, label]) => {
        const col = issues.filter((i) => i.status === s);
        return `<div class="col" data-status="${s}"><h4><span>${label}</span><span>${col.length}</span></h4>${col.map(ticket).join('')}</div>`;
      }).join('')}</div>`;
    for (const col of $$('.col', host)) {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('over');
      });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('over');
        if (!dragKey) return;
        const status = col.dataset.status;
        const inCol = data.issues.filter((i) => i.status === status && i.key !== dragKey);
        const rank = (inCol.length ? Math.max(...inCol.map((i) => i.rank)) : 0) + 1000;
        const k = dragKey;
        dragKey = null;
        const moved = data.issues.find((i) => i.key === k);
        if (moved) Object.assign(moved, { status, rank });
        drawBoard(host); // optimistic
        await attempt(() => patch(`/issues/${k}`, { status, rank }));
        reload();
      });
    }
  }

  function drawBacklog(host) {
    const open = data.sprints.filter((s) => s.state !== 'done');
    const finished = data.sprints.length - open.length;
    const all = data.issues.filter(issueMatches);
    const section = (s) => {
      const rows = all.filter((i) => i.sprint_id === (s ? s.id : null));
      const pts = rows.reduce((n, i) => n + (i.estimate || 0), 0);
      return `<div class="card sprint dropzone" data-sprint="${s ? s.id : ''}">
        <div class="sprint-head"><h4>${s ? esc(s.name) : 'Backlog'}</h4>
          ${s ? `<span class="chip ${s.state === 'active' ? 'in_progress' : ''}">${s.state}</span>` : ''}
          <span class="muted small">${rows.length} issues${pts ? ` · ${pts} pts` : ''}</span><span class="grow"></span>
          ${s?.state === 'planned' ? `<button class="btn sm" data-start="${s.id}">Start sprint</button>` : ''}
          ${s?.state === 'active' ? `<button class="btn sm" data-done="${s.id}">Complete sprint</button>` : ''}</div>
        ${rows.map(irow).join('') || '<div class="empty" style="padding:14px">Drag issues here.</div>'}
        <form class="irow" data-quick="${s ? s.id : ''}" style="cursor:default"><input type="text" placeholder="+ Create issue (press Enter)" maxlength="200" aria-label="New issue title" style="border-style:dashed"></form></div>`;
    };
    host.innerHTML = `<div class="row gap" style="margin-bottom:12px"><button class="btn" id="ns">${icon('plus', 14)} Create sprint</button>
      ${finished ? `<span class="muted small">${finished} completed sprint${finished > 1 ? 's' : ''}</span>` : ''}</div>
      ${open.map(section).join('')}${section(null)}`;

    $('#ns', host).onclick = async () => {
      const name = `Sprint ${data.sprints.length + 1}`;
      await attempt(() => post(`/projects/${key}/sprints`, { name }));
      reload();
    };
    for (const b of $$('[data-start]', host)) b.onclick = async () => ((await attempt(() => patch(`/sprints/${b.dataset.start}`, { state: 'active' }))) && reload());
    for (const b of $$('[data-done]', host)) b.onclick = async () => ((await attempt(() => patch(`/sprints/${b.dataset.done}`, { state: 'done' }))) && (toast('Sprint completed. Unfinished issues went back to the backlog.', 'ok'), reload()));
    for (const q of $$('[data-quick]', host)) {
      q.onsubmit = async (e) => {
        e.preventDefault();
        const input = $('input', q);
        const title = input.value.trim();
        if (!title) return;
        const body = { title };
        if (q.dataset.quick) body.sprint_id = Number(q.dataset.quick);
        if (await attempt(() => post(`/projects/${key}/issues`, body))) reload();
      };
    }
    for (const z of $$('.dropzone', host)) {
      z.addEventListener('dragover', (e) => (e.preventDefault(), z.classList.add('over')));
      z.addEventListener('dragleave', () => z.classList.remove('over'));
      z.addEventListener('drop', async (e) => {
        e.preventDefault();
        z.classList.remove('over');
        if (!dragKey) return;
        const k = dragKey;
        dragKey = null;
        if (await attempt(() => patch(`/issues/${k}`, { sprint_id: z.dataset.sprint ? Number(z.dataset.sprint) : null }))) reload();
      });
    }
  }

  function draw() {
    const p = data.project;
    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${esc(p.name)} <span class="k">${esc(p.key)}</span></h1><div class="muted">${esc(p.description || '')}</div></div>
        <button class="btn primary" id="ni">${icon('plus', 14)} Create issue</button></div>
      <div class="tabs"><a href="#/p/${esc(p.key)}/board" class="${tab === 'board' ? 'on' : ''}">Board</a><a href="#/p/${esc(p.key)}/backlog" class="${tab === 'backlog' ? 'on' : ''}">Backlog</a></div>
      ${filters()}<div id="pv"></div></div>`;
    (tab === 'backlog' ? drawBacklog : drawBoard)($('#pv', el));

    $('#ni', el).onclick = newIssue;
    $('#fq', el).oninput = debounce((e) => {
      f.q = e.target.value;
      (tab === 'backlog' ? drawBacklog : drawBoard)($('#pv', el));
    }, 150);
    $('#fa', el).onchange = (e) => ((f.assignee = e.target.value), draw());
    $('#ft', el).onchange = (e) => ((f.type = e.target.value), draw());
  }

  // drag start / click handlers are delegated once
  el.addEventListener('dragstart', (e) => {
    const t = e.target.closest?.('[data-key]');
    if (!t) return;
    dragKey = t.dataset.key;
    t.classList.add('drag');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragKey);
  });
  el.addEventListener('dragend', (e) => e.target.closest?.('[data-key]')?.classList.remove('drag'));
  const openFrom = (e) => {
    const t = e.target.closest('[data-key]');
    if (t && !e.target.closest('form,button,input')) openIssue(t.dataset.key, reload);
  };
  el.addEventListener('click', openFrom);
  el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-key]') && (e.preventDefault(), openFrom(e)));

  function newIssue() {
    const active = data.sprints.find((s) => s.state === 'active');
    const sprints = data.sprints.filter((s) => s.state !== 'done');
    const m = openModal({
      title: `New issue in ${data.project.name}`,
      html: `<form id="nf"><label class="f">Title</label><input name="title" type="text" required maxlength="200">
        <div class="row gap"><div class="grow"><label class="f">Type</label><select name="type">${options(TYPES, 'task')}</select></div>
        <div class="grow"><label class="f">Priority</label><select name="priority">${options(PRIORITIES, 'medium')}</select></div></div>
        <div class="row gap"><div class="grow"><label class="f">Assignee</label><select name="assignee_id">${userOptions(null)}</select></div>
        <div class="grow"><label class="f">Sprint</label><select name="sprint_id"><option value="">Backlog</option>${sprints.map((s) => `<option value="${s.id}" ${active && s.id === active.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div></div>
        <label class="f">Description</label><textarea name="description" rows="4"></textarea>
        <div class="err" id="ne"></div><div class="row end gap" style="margin-top:10px"><button class="btn" type="button" data-c>Cancel</button><button class="btn primary" type="submit">Create issue</button></div></form>`,
    });
    $('[data-c]', m.body).onclick = m.close;
    $('#nf', m.body).onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.assignee_id = b.assignee_id ? Number(b.assignee_id) : null;
      b.sprint_id = b.sprint_id ? Number(b.sprint_id) : null;
      try {
        const issue = await post(`/projects/${key}/issues`, b);
        m.close();
        toast(`Created ${issue.key}`, 'ok');
        reload();
      } catch (err) {
        $('#ne', m.body).textContent = err.message;
      }
    };
  }

  draw();
  return { live: (evt) => (evt.type === 'issue' && (!evt.project_key || evt.project_key === key) ? reload() : undefined) };
}
