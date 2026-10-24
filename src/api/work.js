// Docs, calendar, approvals, notifications and search.
import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { bad, notFound, forbidden, conflict, str, oneOf, intId, timestamp, notify, requireUser, snippet, likePattern } from '../lib.js';
import { broadcast } from '../realtime.js';
import { addClient } from '../realtime.js';

export const STREAM = Symbol('stream');

export function register(r) {
  // ---------- docs ----------
  r.get('/api/docs', () =>
    db
      .prepare(
        `select d.id, d.title, d.updated, d.updated_by, d.project_id, p.key as project_key
         from docs d left join projects p on p.id=d.project_id order by d.updated desc`,
      )
      .all(),
  );

  const projectIdFor = (key) => {
    if (!key) return null;
    const p = db.prepare('select id from projects where key=?').get(String(key).toUpperCase());
    if (!p) throw bad('Project not found');
    return p.id;
  };

  r.post('/api/docs', ({ body, user }) => {
    const t = now();
    const { lastInsertRowid } = db
      .prepare('insert into docs(title,body,project_id,created_by,updated_by,created,updated) values(?,?,?,?,?,?,?)')
      .run(str(body.title || 'Untitled', 'Title', { max: 160 }), '', projectIdFor(body.project_key), user.id, user.id, t, t);
    broadcast('doc', { id: Number(lastInsertRowid), by: user.id });
    return db.prepare('select * from docs where id=?').get(lastInsertRowid);
  });

  r.get('/api/docs/:id', ({ params }) => {
    const d = db.prepare('select * from docs where id=?').get(intId(params.id, 'doc'));
    if (!d) throw notFound('Doc not found');
    return d;
  });

  r.put('/api/docs/:id', ({ params, body, user }) => {
    const d = db.prepare('select * from docs where id=?').get(intId(params.id, 'doc'));
    if (!d) throw notFound('Doc not found');
    // optimistic concurrency: refuse to overwrite someone else's newer edit
    if (body.base_updated !== undefined && Number(body.base_updated) !== d.updated) {
      const err = conflict('Someone else edited this doc');
      err.extra = { doc: d };
      throw err;
    }
    const title = body.title !== undefined ? str(body.title, 'Title', { max: 160 }) : d.title;
    const text = body.body !== undefined ? str(body.body, 'Body', { max: 200000, optional: true, trim: false }) : d.body;
    const projectId = body.project_key !== undefined ? projectIdFor(body.project_key) : d.project_id;
    const t = Math.max(now(), d.updated + 1);
    db.prepare('update docs set title=?, body=?, project_id=?, updated_by=?, updated=? where id=?').run(title, text, projectId, user.id, t, d.id);
    broadcast('doc', { id: d.id, by: user.id });
    return db.prepare('select * from docs where id=?').get(d.id);
  });

  r.delete('/api/docs/:id', ({ params, user }) => {
    const d = db.prepare('select * from docs where id=?').get(intId(params.id, 'doc'));
    if (!d) throw notFound('Doc not found');
    if (d.created_by !== user.id && user.role !== 'admin') throw forbidden('Only the author or an admin can delete this doc');
    db.prepare('delete from docs where id=?').run(d.id);
    broadcast('doc', { id: d.id, by: user.id, deleted: true });
    return { ok: true };
  });

  // ---------- calendar ----------
  const eventsWithPeople = (rows) =>
    rows.map((e) => ({
      ...e,
      attendees: db.prepare('select user_id, status from event_attendees where event_id=?').all(e.id),
    }));

  r.get('/api/events', ({ query, user }) => {
    const from = query.from ? timestamp(query.from, 'from') : 0;
    const to = query.to ? timestamp(query.to, 'to') : 4102444800000;
    const rows = db
      .prepare(
        `select e.* from events e
         where e.starts_at <= ? and e.ends_at >= ?
           and (e.created_by = ? or exists (select 1 from event_attendees a where a.event_id=e.id and a.user_id=?))
         order by e.starts_at`,
      )
      .all(to, from, user.id, user.id);
    return eventsWithPeople(rows);
  });

  r.post('/api/events', ({ body, user }) => {
    const title = str(body.title, 'Title', { max: 120 });
    const starts = timestamp(body.starts_at, 'Start');
    const ends = timestamp(body.ends_at, 'End');
    if (ends <= starts) throw bad('The end must be after the start');
    const attendees = [...new Set((Array.isArray(body.attendees) ? body.attendees : []).map((x) => intId(x, 'attendee')))];
    for (const id of attendees) requireUser(id, 'attendee');
    const url = body.meeting ? `https://meet.jit.si/orbit-${crypto.randomBytes(5).toString('hex')}` : '';

    const { lastInsertRowid } = db
      .prepare('insert into events(title,description,starts_at,ends_at,location,meeting_url,created_by,created) values(?,?,?,?,?,?,?,?)')
      .run(title, str(body.description, 'Description', { max: 2000, optional: true }), starts, ends, str(body.location, 'Location', { max: 120, optional: true }), url, user.id, now());
    const id = Number(lastInsertRowid);
    db.prepare("insert into event_attendees(event_id,user_id,status) values(?,?,'accepted')").run(id, user.id);
    for (const uid of attendees) {
      if (uid === user.id) continue;
      db.prepare("insert into event_attendees(event_id,user_id,status) values(?,?,'pending')").run(id, uid);
      notify(uid, `${user.name} invited you to "${snippet(title, 50)}" on ${new Date(starts).toDateString()}`, 'calendar');
    }
    broadcast('event', { id }, [user.id, ...attendees]);
    return eventsWithPeople(db.prepare('select * from events where id=?').all(id))[0];
  });

  r.put('/api/events/:id/rsvp', ({ params, body, user }) => {
    const id = intId(params.id, 'event');
    const status = oneOf(body.status, ['accepted', 'declined', 'pending'], 'status');
    const done = db.prepare('update event_attendees set status=? where event_id=? and user_id=?').run(status, id, user.id);
    if (!done.changes) throw forbidden('You are not invited to this event');
    const ev = db.prepare('select * from events where id=?').get(id);
    if (ev.created_by && ev.created_by !== user.id && status !== 'pending') {
      notify(ev.created_by, `${user.name} ${status} "${snippet(ev.title, 50)}"`, 'calendar');
    }
    broadcast('event', { id });
    return { ok: true };
  });

  r.delete('/api/events/:id', ({ params, user }) => {
    const ev = db.prepare('select * from events where id=?').get(intId(params.id, 'event'));
    if (!ev) throw notFound('Event not found');
    if (ev.created_by !== user.id && user.role !== 'admin') throw forbidden('Only the organizer can cancel this event');
    const people = db.prepare('select user_id from event_attendees where event_id=?').all(ev.id).map((a) => a.user_id);
    db.prepare('delete from events where id=?').run(ev.id);
    for (const uid of people) if (uid !== user.id) notify(uid, `"${snippet(ev.title, 50)}" was cancelled`, 'calendar');
    broadcast('event', { id: ev.id, deleted: true }, people);
    return { ok: true };
  });

  // ---------- approvals ----------
  r.get('/api/approvals', ({ user }) => ({
    to_review: db.prepare("select * from approvals where approver_id=? order by (status = 'pending') desc, created desc").all(user.id),
    mine: db.prepare('select * from approvals where requester_id=? order by created desc').all(user.id),
  }));

  r.post('/api/approvals', ({ body, user }) => {
    const approver = requireUser(intId(body.approver_id, 'approver'), 'approver');
    if (approver.id === user.id) throw bad('Pick someone else to approve this');
    const title = str(body.title, 'Title', { max: 160 });
    const { lastInsertRowid } = db
      .prepare('insert into approvals(title,details,requester_id,approver_id,created) values(?,?,?,?,?)')
      .run(title, str(body.details, 'Details', { max: 4000, optional: true }), user.id, approver.id, now());
    notify(approver.id, `${user.name} asked for your approval: ${snippet(title, 60)}`, 'approvals');
    broadcast('approval', { id: Number(lastInsertRowid) }, [user.id, approver.id]);
    return db.prepare('select * from approvals where id=?').get(lastInsertRowid);
  });

  r.post('/api/approvals/:id/decide', ({ params, body, user }) => {
    const a = db.prepare('select * from approvals where id=?').get(intId(params.id, 'approval'));
    if (!a) throw notFound('Request not found');
    if (a.approver_id !== user.id) throw forbidden('Only the approver can decide this');
    if (a.status !== 'pending') throw conflict('This request was already decided');
    const decision = oneOf(body.decision, ['approved', 'rejected'], 'decision');
    const note = str(body.note, 'Note', { max: 1000, optional: true });
    db.prepare('update approvals set status=?, decision_note=?, decided=? where id=?').run(decision, note, now(), a.id);
    notify(a.requester_id, `${user.name} ${decision} "${snippet(a.title, 50)}"${note ? `: ${snippet(note, 60)}` : ''}`, 'approvals');
    broadcast('approval', { id: a.id }, [a.requester_id, a.approver_id]);
    return db.prepare('select * from approvals where id=?').get(a.id);
  });

  // ---------- notifications ----------
  r.get('/api/notifications', ({ user }) => ({
    items: db.prepare('select * from notifications where user_id=? order by id desc limit 50').all(user.id),
    unread: db.prepare('select count(*) c from notifications where user_id=? and read=0').get(user.id).c,
  }));

  r.post('/api/notifications/read', ({ body, user }) => {
    if (body.id) db.prepare('update notifications set read=1 where id=? and user_id=?').run(intId(body.id), user.id);
    else db.prepare('update notifications set read=1 where user_id=?').run(user.id);
    return { ok: true };
  });

  // ---------- search ----------
  r.get('/api/search', ({ query, user }) => {
    const q = String(query.q || '').trim();
    if (q.length < 2) return { issues: [], messages: [], docs: [], people: [] };
    const like = likePattern(q);
    const keyMatch = /^([A-Za-z][A-Za-z0-9]+)-(\d+)$/.exec(q);
    const issues = db
      .prepare(
        `select i.id, i.title, i.status, i.priority, i.type, p.key || '-' || i.num as key
         from issues i join projects p on p.id=i.project_id
         where i.title like ? escape '\\' or i.description like ? escape '\\' or (p.key = ? and i.num = ?)
         order by i.updated desc limit 20`,
      )
      .all(like, like, keyMatch ? keyMatch[1].toUpperCase() : '', keyMatch ? Number(keyMatch[2]) : -1);
    const messages = db
      .prepare(
        `select m.id, m.channel_id, m.body, m.created, m.user_id, c.name as channel_name, c.kind
         from messages m join channels c on c.id=m.channel_id
         where m.body like ? escape '\\'
           and (c.kind='public' or exists (select 1 from channel_members cm where cm.channel_id=c.id and cm.user_id=?))
         order by m.id desc limit 20`,
      )
      .all(like, user.id);
    const docs = db
      .prepare("select id, title, updated, substr(body,1,160) as excerpt from docs where title like ? escape '\\' or body like ? escape '\\' order by updated desc limit 20")
      .all(like, like);
    const people = db
      .prepare("select id, name, handle, email, color from users where name like ? escape '\\' or handle like ? escape '\\' or email like ? escape '\\' limit 10")
      .all(like, like, like);
    return { issues, messages, docs, people };
  });

  // ---------- live stream ----------
  r.get('/api/stream', ({ req, res, user }) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const remove = addClient(user.id, res);
    req.on('close', remove);
    return STREAM;
  });
}
