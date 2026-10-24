import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { bad, notFound, forbidden, conflict, str, intId, mentionedUsers, notify, requireUser, snippet } from '../lib.js';
import { broadcast } from '../realtime.js';
import { createIssue, getProject } from './projects.js';

const EMOJI = ['👍', '❤️', '🎉', '😄', '👀', '🙏'];

function channelFor(id, user) {
  const ch = db.prepare('select * from channels where id=?').get(intId(id, 'channel'));
  if (!ch) throw notFound('Channel not found');
  if (ch.kind === 'dm' && !db.prepare('select 1 from channel_members where channel_id=? and user_id=?').get(ch.id, user.id)) {
    throw forbidden('This conversation is private');
  }
  return ch;
}

const audience = (ch) =>
  ch.kind === 'dm' ? db.prepare('select user_id from channel_members where channel_id=?').all(ch.id).map((m) => m.user_id) : null;

function decorate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((m) => m.id);
  const ph = ids.map(() => '?').join(',');
  const reactions = db.prepare(`select message_id, emoji, user_id from reactions where message_id in (${ph}) order by rowid`).all(...ids);
  return rows.map((m) => {
    const rx = {};
    for (const x of reactions) if (x.message_id === m.id) (rx[x.emoji] ||= []).push(x.user_id);
    return { ...m, reactions: rx };
  });
}

const MSG_SQL = `select m.*, (select count(*) from messages r where r.parent_id = m.id) as reply_count from messages m`;

function markRead(channelId, userId) {
  const last = db.prepare('select coalesce(max(id),0) m from messages where channel_id=?').get(channelId).m;
  db.prepare(
    'insert into channel_reads(channel_id,user_id,last_id) values(?,?,?) on conflict(channel_id,user_id) do update set last_id=excluded.last_id',
  ).run(channelId, userId, last);
}

/** Insert a message, notify people, push it live. */
export function postMessage(ch, user, body, parentId = null) {
  const t = now();
  const { lastInsertRowid } = db
    .prepare('insert into messages(channel_id,user_id,body,parent_id,created) values(?,?,?,?,?)')
    .run(ch.id, user.id, body, parentId, t);
  const id = Number(lastInsertRowid);

  const told = new Set([user.id]);
  for (const u of mentionedUsers(body)) {
    if (!told.has(u.id)) notify(u.id, `${user.name} mentioned you in ${ch.kind === 'dm' ? 'a message' : `#${ch.name}`}`, `chat:${ch.id}`);
    told.add(u.id);
  }
  if (ch.kind === 'dm') {
    for (const uid of audience(ch)) {
      if (!told.has(uid)) notify(uid, `${user.name}: ${snippet(body, 70)}`, `chat:${ch.id}`);
      told.add(uid);
    }
  }
  broadcast('message', { channel_id: ch.id, id, parent_id: parentId, user_id: user.id }, audience(ch));
  return decorate(db.prepare(`${MSG_SQL} where m.id=?`).all(id))[0];
}

const meetingUrl = () => `https://meet.jit.si/orbit-${crypto.randomBytes(5).toString('hex')}`;

export function register(r) {
  // ---------- channels ----------
  r.get('/api/channels', ({ user }) => {
    const rows = db
      .prepare(
        `select c.* from channels c
         where c.kind='public' or exists (select 1 from channel_members m where m.channel_id=c.id and m.user_id=?)
         order by c.kind desc, c.name collate nocase`,
      )
      .all(user.id);
    return rows.map((c) => {
      const read = db.prepare('select last_id from channel_reads where channel_id=? and user_id=?').get(c.id, user.id);
      const unread = read
        ? db.prepare('select count(*) n from messages where channel_id=? and id>? and user_id is not ? and parent_id is null').get(c.id, read.last_id, user.id).n
        : db.prepare('select count(*) n from messages where channel_id=? and created>? and user_id is not ? and parent_id is null').get(c.id, user.created, user.id).n;
      const members = c.kind === 'dm' ? db.prepare('select user_id from channel_members where channel_id=?').all(c.id).map((m) => m.user_id) : [];
      return { ...c, members, unread };
    });
  });

  r.post('/api/channels', ({ body, user }) => {
    const name = str(body.name, 'Name', { max: 40 }).toLowerCase().replace(/[\s_]+/g, '-');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw bad('Channel names use letters, numbers and dashes');
    if (db.prepare("select 1 from channels where kind='public' and name=?").get(name)) throw conflict(`#${name} already exists`);
    const topic = str(body.topic, 'Topic', { max: 200, optional: true });
    const { lastInsertRowid } = db.prepare("insert into channels(name,topic,kind,created_by,created) values(?,?,'public',?,?)").run(name, topic, user.id, now());
    broadcast('channel', { id: Number(lastInsertRowid) });
    return db.prepare('select * from channels where id=?').get(lastInsertRowid);
  });

  r.post('/api/dm', ({ body, user }) => {
    const other = requireUser(intId(body.user_id, 'user'));
    const existing = db
      .prepare(
        `select c.* from channels c where c.kind='dm'
           and exists (select 1 from channel_members m where m.channel_id=c.id and m.user_id=?)
           and exists (select 1 from channel_members m where m.channel_id=c.id and m.user_id=?)
           and (select count(*) from channel_members m where m.channel_id=c.id) = ?`,
      )
      .get(user.id, other.id, other.id === user.id ? 1 : 2);
    if (existing) return existing;
    const { lastInsertRowid } = db.prepare("insert into channels(kind,created_by,created) values('dm',?,?)").run(user.id, now());
    const id = Number(lastInsertRowid);
    for (const uid of new Set([user.id, other.id])) db.prepare('insert into channel_members(channel_id,user_id) values(?,?)').run(id, uid);
    broadcast('channel', { id }, [user.id, other.id]);
    return db.prepare('select * from channels where id=?').get(id);
  });

  r.post('/api/channels/:id/read', ({ params, user }) => {
    markRead(channelFor(params.id, user).id, user.id);
    return { ok: true };
  });

  // ---------- messages ----------
  r.get('/api/channels/:id/messages', ({ params, query, user }) => {
    const ch = channelFor(params.id, user);
    const before = Number(query.before) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(query.limit) || 50, 100);
    const rows = db
      .prepare(`${MSG_SQL} where m.channel_id=? and m.parent_id is null and m.id<? order by m.id desc limit ?`)
      .all(ch.id, before, limit)
      .reverse();
    if (!query.before) markRead(ch.id, user.id);
    return { channel: ch, messages: decorate(rows), has_more: rows.length === limit };
  });

  r.get('/api/messages/:id/thread', ({ params, user }) => {
    const parent = db.prepare(`${MSG_SQL} where m.id=?`).get(intId(params.id, 'message'));
    if (!parent) throw notFound('Message not found');
    const ch = channelFor(parent.channel_id, user);
    const replies = db.prepare(`${MSG_SQL} where m.parent_id=? order by m.id`).all(parent.id);
    return { channel: ch, parent: decorate([parent])[0], replies: decorate(replies) };
  });

  r.post('/api/channels/:id/messages', ({ params, body, user }) => {
    const ch = channelFor(params.id, user);
    let text = str(body.body, 'Message', { max: 4000 });
    let parentId = null;
    if (body.parent_id) {
      const parent = db.prepare('select * from messages where id=?').get(intId(body.parent_id, 'parent'));
      if (!parent || parent.channel_id !== ch.id || parent.parent_id) throw bad('You can reply to a top-level message in this channel');
      parentId = parent.id;
    }

    // slash commands
    if (!parentId && /^\/task(\s|$)/.test(text)) {
      const parts = text.slice(5).trim().split(/\s+/);
      let projectKey = null;
      if (parts[0] && /^[A-Z][A-Z0-9]{1,9}$/.test(parts[0]) && db.prepare('select 1 from projects where key=?').get(parts[0])) projectKey = parts.shift();
      const title = parts.join(' ').trim();
      if (!title) throw bad('Usage: /task [PROJECT] what needs doing');
      const project = projectKey
        ? getProject(projectKey)
        : db.prepare('select * from projects order by id limit 1').get();
      if (!project) throw bad('Create a project first, then /task can file issues into it');
      const issue = createIssue(project, { title }, user.id);
      text = `📌 Created ${issue.key}: ${issue.title}`;
    } else if (!parentId && /^\/meet\s*$/.test(text)) {
      text = `📹 Join the meeting: ${meetingUrl()}`;
    }
    return postMessage(ch, user, text, parentId);
  });

  r.patch('/api/messages/:id', ({ params, body, user }) => {
    const m = db.prepare('select * from messages where id=?').get(intId(params.id, 'message'));
    if (!m) throw notFound('Message not found');
    channelFor(m.channel_id, user);
    if (m.user_id !== user.id) throw forbidden('You can only edit your own messages');
    db.prepare('update messages set body=?, edited=? where id=?').run(str(body.body, 'Message', { max: 4000 }), now(), m.id);
    const ch = db.prepare('select * from channels where id=?').get(m.channel_id);
    broadcast('message', { channel_id: m.channel_id, id: m.id, parent_id: m.parent_id }, audience(ch));
    return { ok: true };
  });

  r.delete('/api/messages/:id', ({ params, user }) => {
    const m = db.prepare('select * from messages where id=?').get(intId(params.id, 'message'));
    if (!m) throw notFound('Message not found');
    const ch = channelFor(m.channel_id, user);
    if (m.user_id !== user.id && user.role !== 'admin') throw forbidden('You can only delete your own messages');
    db.prepare('delete from messages where id=?').run(m.id);
    broadcast('message', { channel_id: m.channel_id, id: m.id, parent_id: m.parent_id, deleted: true }, audience(ch));
    return { ok: true };
  });

  r.post('/api/messages/:id/react', ({ params, body, user }) => {
    const m = db.prepare('select * from messages where id=?').get(intId(params.id, 'message'));
    if (!m) throw notFound('Message not found');
    const ch = channelFor(m.channel_id, user);
    if (!EMOJI.includes(body.emoji)) throw bad('Unsupported reaction');
    const had = db.prepare('select 1 from reactions where message_id=? and user_id=? and emoji=?').get(m.id, user.id, body.emoji);
    if (had) db.prepare('delete from reactions where message_id=? and user_id=? and emoji=?').run(m.id, user.id, body.emoji);
    else db.prepare('insert into reactions(message_id,user_id,emoji) values(?,?,?)').run(m.id, user.id, body.emoji);
    broadcast('message', { channel_id: m.channel_id, id: m.id, parent_id: m.parent_id }, audience(ch));
    return { ok: true };
  });

  // Turn a chat message into a tracked issue, and say so in the thread.
  r.post('/api/messages/:id/to-issue', ({ params, body, user }) => {
    const m = db.prepare('select * from messages where id=?').get(intId(params.id, 'message'));
    if (!m) throw notFound('Message not found');
    const ch = channelFor(m.channel_id, user);
    const project = getProject(str(body.project_key, 'Project', { max: 10 }));
    const title = snippet(m.body.split('\n')[0], 120);
    const issue = createIssue(project, { title, description: `${m.body}\n\n(from chat)` }, user.id);
    postMessage(ch, user, `📌 Created ${issue.key} from this message`, m.parent_id || m.id);
    return issue;
  });
}
