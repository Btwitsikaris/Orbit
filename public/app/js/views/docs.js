import { get, post, put, del } from '../api.js';
import { S, userName } from '../state.js';
import { esc, $, icon, renderMd, timeAgo, openModal, confirmDialog, attempt, toast, debounce } from '../ui.js';
import { go, channelName } from '../shared.js';

export async function mountDocs(el, idParam) {
  let list = await get('/docs');
  let docId = idParam ? Number(idParam) : null;
  let doc = null;
  let dirty = false;
  let mode = 'edit'; // edit | preview
  let saving = Promise.resolve();
  let alive = true;

  el.innerHTML = `<div class="docs" id="docs"><aside class="doc-list" id="dl"></aside><section class="doc-body" id="db"></section></div>`;

  const drawList = () => {
    $('#dl', el).innerHTML = `<div class="row between" style="padding:0 6px 8px"><strong>Docs</strong><button class="btn sm primary" id="nd">${icon('plus', 13)} New</button></div>
      <div class="nav">${list.map((d) => `<a href="#/docs/${d.id}" class="${d.id === docId ? 'on' : ''}">${icon('doc', 15)}<span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.title)}</span></a>`).join('') || '<div class="muted small" style="padding:8px">No docs yet.</div>'}</div>`;
    $('#nd', el).onclick = async () => {
      const d = await attempt(() => post('/docs', { title: 'Untitled' }));
      if (d) go(`#/docs/${d.id}`);
    };
  };

  const status = (text) => {
    const s = $('#ds', el);
    if (s) s.textContent = text;
  };

  const drawDoc = () => {
    const host = $('#db', el);
    if (!doc) {
      host.innerHTML = `<div class="empty">${list.length ? 'Pick a doc from the list, or create a new one.' : 'No docs yet. Create the first one.'}</div>`;
      return;
    }
    host.innerHTML = `<div class="row gap wrap" style="margin-bottom:10px">
        <button class="icon-btn back" id="dback" aria-label="All docs">${icon('chevL', 18)}</button>
        <span class="muted small grow" id="ds">Saved · last edit by ${esc(userName(doc.updated_by))} ${timeAgo(doc.updated)}</span>
        <div class="row" role="tablist"><button class="btn sm ${mode === 'edit' ? 'primary' : ''}" data-mode="edit">Edit</button><button class="btn sm ${mode === 'preview' ? 'primary' : ''}" data-mode="preview">Preview</button></div>
        <button class="btn sm" id="share">${icon('send', 13)} Share to chat</button>
        <button class="btn sm ghost" id="ddel" aria-label="Delete doc" title="Delete">${icon('trash', 14)}</button></div>
      <input class="doc-title" id="dt" type="text" value="${esc(doc.title)}" maxlength="160" aria-label="Title" placeholder="Untitled">
      ${mode === 'edit'
        ? `<textarea class="editor" id="dbody" spellcheck="true" placeholder="Write in markdown. # Heading, **bold**, - lists, - [ ] tasks, issue keys like ORB-1 become links." aria-label="Document body">${esc(doc.body)}</textarea>`
        : `<div class="md" id="dprev">${renderMd(doc.body) || '<p class="muted">Nothing here yet.</p>'}</div>`}`;

    for (const b of host.querySelectorAll('[data-mode]')) {
      b.onclick = () => {
        syncFromInputs();
        mode = b.dataset.mode;
        drawDoc();
      };
    }
    $('#dback', host).onclick = () => $('#docs', el).classList.add('show-list');
    $('#dt', host).addEventListener('input', onEdit);
    $('#dbody', host)?.addEventListener('input', onEdit);
    $('#share', host).onclick = share;
    $('#ddel', host).onclick = async () => {
      if (!(await confirmDialog(`Delete “${doc.title}”?`))) return;
      if (await attempt(() => del(`/docs/${doc.id}`))) {
        dirty = false;
        toast('Doc deleted', 'ok');
        go('#/docs');
      }
    };
  };

  const syncFromInputs = () => {
    const t = $('#dt', el);
    const b = $('#dbody', el);
    if (t) doc.title = t.value;
    if (b) doc.body = b.value;
  };

  // ---------- autosave ----------
  const flush = () => {
    saving = saving.then(async () => {
      if (!dirty || !doc) return;
      syncFromInputs();
      const snapshot = { title: doc.title.trim() || 'Untitled', body: doc.body };
      dirty = false;
      status('Saving…');
      try {
        const saved = await put(`/docs/${doc.id}`, { ...snapshot, base_updated: doc.updated });
        doc.updated = saved.updated;
        doc.updated_by = saved.updated_by;
        status(`Saved · ${timeAgo(saved.updated)}`);
        const row = list.find((d) => d.id === doc.id);
        if (row) row.title = saved.title;
        drawList();
      } catch (e) {
        if (e.status === 409 && e.data?.doc) {
          dirty = true; // keep the user's text until they choose
          conflict(e.data.doc);
        } else {
          dirty = true;
          status('Not saved. Retrying on your next edit.');
          toast(e.message, 'error');
        }
      }
    });
    return saving;
  };
  const autosave = debounce(flush, 800);
  const onEdit = () => {
    dirty = true;
    status('Unsaved changes…');
    autosave();
  };

  function conflict(theirs) {
    const m = openModal({
      title: 'Someone else edited this doc',
      html: `<p>${esc(userName(theirs.updated_by))} saved a newer version while you were typing.</p>
        <div class="row end gap"><button class="btn" data-theirs>Load their version</button><button class="btn danger" data-mine>Keep mine and overwrite</button></div>`,
    });
    $('[data-theirs]', m.body).onclick = () => {
      doc = theirs;
      dirty = false;
      m.close();
      drawDoc();
    };
    $('[data-mine]', m.body).onclick = () => {
      doc.updated = theirs.updated;
      m.close();
      flush();
    };
  }

  function share() {
    const chans = S.channels;
    const m = openModal({
      title: 'Share to chat',
      html: chans.map((c) => `<a class="list-item" href="#" data-c="${c.id}">${esc(channelName(c))}</a>`).join(''),
    });
    m.body.onclick = async (e) => {
      const a = e.target.closest('[data-c]');
      if (!a) return;
      e.preventDefault();
      const link = `${location.origin}/app#/docs/${doc.id}`;
      if (await attempt(() => post(`/channels/${a.dataset.c}/messages`, { body: `📄 ${doc.title}: ${link}` }))) {
        toast('Shared', 'ok');
        m.close();
      }
    };
  }

  // ---------- load ----------
  const openDoc = async (id) => {
    doc = await attempt(() => get(`/docs/${id}`));
    if (!doc) docId = null;
    dirty = false;
    drawList();
    drawDoc();
  };

  drawList();
  if (docId) await openDoc(docId);
  else {
    drawDoc();
    if (list.length && !window.matchMedia('(max-width:760px)').matches) go(`#/docs/${list[0].id}`);
  }
  if (!docId) $('#docs', el).classList.add('show-list');

  const onLeave = () => dirty && flush();
  window.addEventListener('beforeunload', onLeave);

  return {
    destroy() {
      alive = false;
      window.removeEventListener('beforeunload', onLeave);
      if (dirty) flush(); // do not lose the last keystrokes when navigating away
    },
    async live(evt) {
      if (evt.type !== 'doc' || !alive) return;
      list = await get('/docs');
      drawList();
      if (doc && evt.id === doc.id && evt.by !== S.me.id) {
        if (evt.deleted) return go('#/docs');
        if (!dirty) {
          const fresh = await get(`/docs/${doc.id}`).catch(() => null);
          if (fresh && fresh.updated !== doc.updated) {
            doc = fresh;
            drawDoc();
            toast(`${userName(fresh.updated_by)} updated this doc`);
          }
        }
      }
    },
  };
}
