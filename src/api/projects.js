import { db, now } from '../db.js';
import { bad, notFound, forbidden, conflict, str, oneOf, intId, tx, notify, mentionedUsers, requireUser, snippet } from '../lib.js';
import { broadcast } from '../realtime.js';

export const TYPES = ['task', 'bug', 'story', 'epic'];
export const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];
export const PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'];
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

const ISSUE_SQL = 'select i.*, p.key as pkey from issues i join projects p on p.id = i.project_id';

export const shapeIssue = (i) => ({
  id: i.id,
  key: `${i.pkey}-${i.num}`,
  project_key: i.pkey,
  title: i.title,
  description: i.description,
  type: i.type,
  status: i.status,
  priority: i.priority,
  assignee_id: i.assignee_id,
  reporter_id: i.reporter_id,
  sprint_id: i.sprint_id,
  labels: i.labels ? i.labels.split(',').filter(Boolean) : [],
  estimate: i.estimate,
  rank: i.rank,
  created: i.created,
  updated: i.updated,
});

const canManage = (project, user) => user.role === 'admin' || project.lead_id === user.id;

export function getProject(key) {
  const p = db.prepare('select * from projects where key=?').get(String(key).toUpperCase());
  if (!p) throw notFound('Project not found');
  return p;
}

export function getIssueRow(key) {
  const m = /^([A-Za-z][A-Za-z0-9]+)-(\d+)$/.exec(String(key));
  if (!m) throw notFound('Issue not found');
  const row = db.prepare(`${ISSUE_SQL} where p.key=? and i.num=?`).get(m[1].toUpperCase(), Number(m[2]));
  if (!row) throw notFound('Issue not found');
  return row;
}

function cleanLabels(v) {
  if (v === undefined || v === null) return '';
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!s) continue;
    if (!/^[\w .-]{1,24}$/.test(s)) throw bad('Labels can use letters, numbers, spaces, dots and dashes (max 24 characters)');
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 8) throw bad('At most 8 labels');
  return out.join(',');
}

function checkSprint(project, sprintId) {
  if (sprintId === null || sprintId === undefined) return null;
  const s = db.prepare('select * from sprints where id=? and project_id=?').get(intId(sprintId, 'sprint'), project.id);
  if (!s) throw bad('That sprint is not in this project');
  if (s.state === 'done') throw bad('That sprint is already completed');
  return s.id;
}

export function createIssue(project, data, userId) {
  const title = str(data.title, 'Title', { max: 200 });
  const description = str(data.description, 'Description', { max: 20000, optional: true, trim: false });
  const type = oneOf(data.type || 'task', TYPES, 'type');
  const priority = oneOf(data.priority || 'medium', PRIORITIES, 'priority');
  const status = oneOf(data.status || 'todo', STATUSES, 'status');
  const assignee = data.assignee_id ? requireUser(intId(data.assignee_id, 'assignee'), 'assignee').id : null;
  const sprint = checkSprint(project, data.sprint_id);
  const labels = cleanLabels(data.labels);
  let estimate = null;
  if (data.estimate !== undefined && data.estimate !== null && data.estimate !== '') {
    estimate = Number(data.estimate);
    if (!Number.isInteger(estimate) || estimate < 0 || estimate > 1000) throw bad('Estimate must be a whole number from 0 to 1000');
  }

  const id = tx(() => {
    const num = db.prepare('select next_num from projects where id=?').get(project.id).next_num;
    db.prepare('update projects set next_num = next_num + 1 where id=?').run(project.id);
    const rank = db.prepare('select coalesce(max(rank), 0) m from issues where project_id=? and status=?').get(project.id, status).m + 1000;
    const t = now();
    const { lastInsertRowid } = db
      .prepare(
        'insert into issues(project_id,num,title,description,type,status,priority,assignee_id,reporter_id,sprint_id,labels,estimate,rank,created,updated) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(project.id, num, title, description, type, status, priority, assignee, userId, sprint, labels, estimate, rank, t, t);
    db.prepare('insert into activity(issue_id,user_id,text,created) values(?,?,?,?)').run(lastInsertRowid, userId, 'created this issue', t);
    return Number(lastInsertRowid);
  });

  const issue = shapeIssue(db.prepare(`${ISSUE_SQL} where i.id=?`).get(id));
  if (issue.assignee_id && issue.assignee_id !== userId) {
    const me = requireUser(userId);
    notify(issue.assignee_id, `${me.name} assigned you ${issue.key}: ${snippet(issue.title)}`, `issue:${issue.key}`);
  }
  broadcast('issue', { key: issue.key, project_key: issue.project_key });
  return issue;
}

export function register(r) {
  // ---------- projects ----------
  r.get('/api/projects', () =>
    db
      .prepare(
        `select p.id, p.key, p.name, p.description, p.lead_id, p.created,
          (select count(*) from issues i where i.project_id=p.id and i.status != 'done') as open_count,
          (select count(*) from issues i where i.project_id=p.id and i.status = 'done') as done_count
         from projects p order by p.name collate nocase`,
      )
      .all(),
  );

  r.post('/api/projects', ({ body, user }) => {
    const key = str(body.key, 'Key', { max: 10 }).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw bad('Key must be 2-10 letters or numbers, starting with a letter');
    const name = str(body.name, 'Name', { max: 80 });
    const description = str(body.description, 'Description', { max: 500, optional: true });
    if (db.prepare('select 1 from projects where key=?').get(key)) throw conflict(`A project with key ${key} already exists`);
    db.prepare('insert into projects(key,name,description,lead_id,created) values(?,?,?,?,?)').run(key, name, description, user.id, now());
    broadcast('project', { key });
    return getProject(key);
  });

  r.get('/api/projects/:key', ({ params }) => {
    const project = getProject(params.key);
    const sprints = db.prepare('select * from sprints where project_id=? order by id').all(project.id);
    const issues = db
      .prepare(`${ISSUE_SQL} where i.project_id=? order by i.rank, i.id`)
      .all(project.id)
      .map(shapeIssue);
    return { project, sprints, issues };
  });

  r.post('/api/projects/:key/issues', ({ params, body, user }) => createIssue(getProject(params.key), body, user.id));

  // ---------- sprints ----------
  r.post('/api/projects/:key/sprints', ({ params, body, user }) => {
    const project = getProject(params.key);
    if (!canManage(project, user)) throw forbidden('Only the project lead or an admin can manage sprints');
    const name = str(body.name, 'Name', { max: 60 });
    const { lastInsertRowid } = db.prepare('insert into sprints(project_id,name,created) values(?,?,?)').run(project.id, name, now());
    broadcast('issue', { project_key: project.key });
    return db.prepare('select * from sprints where id=?').get(lastInsertRowid);
  });

  r.patch('/api/sprints/:id', ({ params, body, user }) => {
    const sprint = db.prepare('select * from sprints where id=?').get(intId(params.id));
    if (!sprint) throw notFound('Sprint not found');
    const project = db.prepare('select * from projects where id=?').get(sprint.project_id);
    if (!canManage(project, user)) throw forbidden('Only the project lead or an admin can manage sprints');
    const name = body.name !== undefined ? str(body.name, 'Name', { max: 60 }) : sprint.name;
    let { state, started, ended } = sprint;

    if (body.state !== undefined && body.state !== sprint.state) {
      oneOf(body.state, ['planned', 'active', 'done'], 'state');
      if (body.state === 'active') {
        if (sprint.state === 'done') throw bad('A completed sprint cannot be restarted');
        if (db.prepare("select 1 from sprints where project_id=? and state='active'").get(project.id)) {
          throw conflict('Another sprint is already active. Complete it first.');
        }
        started = now();
      } else if (body.state === 'done') {
        if (sprint.state !== 'active') throw bad('Only an active sprint can be completed');
        ended = now();
        // unfinished work goes back to the backlog
        db.prepare("update issues set sprint_id=null, updated=? where sprint_id=? and status != 'done'").run(now(), sprint.id);
      } else {
        throw bad('A sprint cannot go back to planned');
      }
      state = body.state;
    }
    db.prepare('update sprints set name=?, state=?, started=?, ended=? where id=?').run(name, state, started, ended, sprint.id);
    broadcast('issue', { project_key: project.key });
    return db.prepare('select * from sprints where id=?').get(sprint.id);
  });

  // ---------- issues ----------
  r.get('/api/issues', ({ query, user }) => {
    if (query.mine) {
      return db
        .prepare(`${ISSUE_SQL} where i.assignee_id=? and i.status != 'done' order by i.updated desc limit 50`)
        .all(user.id)
        .map(shapeIssue);
    }
    throw bad('Use ?mine=1, or open a project to list its issues');
  });

  r.get('/api/issues/:key', ({ params }) => {
    const row = getIssueRow(params.key);
    return {
      issue: shapeIssue(row),
      sprints: db.prepare("select * from sprints where project_id=? and state != 'done' order by id").all(row.project_id),
      comments: db.prepare('select * from comments where issue_id=? order by id').all(row.id),
      activity: db.prepare('select * from activity where issue_id=? order by id desc limit 50').all(row.id),
    };
  });

  const FIELDS = {
    title: (v) => str(v, 'Title', { max: 200 }),
    description: (v) => str(v, 'Description', { max: 20000, optional: true, trim: false }),
    type: (v) => oneOf(v, TYPES, 'type'),
    status: (v) => oneOf(v, STATUSES, 'status'),
    priority: (v) => oneOf(v, PRIORITIES, 'priority'),
    assignee_id: (v) => (v === null || v === '' ? null : requireUser(intId(v, 'assignee'), 'assignee').id),
    sprint_id: (v, row) => checkSprint({ id: row.project_id }, v === '' ? null : v),
    labels: (v) => cleanLabels(v),
    estimate: (v) => {
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw bad('Estimate must be a whole number from 0 to 1000');
      return n;
    },
    rank: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad('rank is invalid');
      return n;
    },
  };

  r.patch('/api/issues/:key', ({ params, body, user }) => {
    const row = getIssueRow(params.key);
    const key = `${row.pkey}-${row.num}`;
    const changes = {};
    const notes = [];
    const userName = (id) => (id ? db.prepare('select name from users where id=?').get(id)?.name || 'someone' : 'nobody');

    for (const [field, fn] of Object.entries(FIELDS)) {
      if (!(field in body)) continue;
      const next = fn(body[field], row);
      if (next === row[field]) continue;
      changes[field] = next;
      if (field === 'status') notes.push(`moved this from ${STATUS_LABEL[row.status]} to ${STATUS_LABEL[next]}`);
      else if (field === 'assignee_id') notes.push(next ? `assigned this to ${userName(next)}` : 'removed the assignee');
      else if (field === 'sprint_id') {
        const n = next ? db.prepare('select name from sprints where id=?').get(next).name : 'the backlog';
        notes.push(`moved this to ${n}`);
      } else if (field === 'rank') {
        /* ordering only, not worth an activity line */
      } else if (field === 'description') notes.push('updated the description');
      else notes.push(`changed ${field} to ${Array.isArray(next) ? next : String(next ?? 'none')}`);
    }
    if (!Object.keys(changes).length) return shapeIssue(row);

    const cols = Object.keys(changes);
    const t = now();
    tx(() => {
      db.prepare(`update issues set ${cols.map((c) => `${c}=?`).join(', ')}, updated=? where id=?`).run(...cols.map((c) => changes[c]), t, row.id);
      for (const text of notes) db.prepare('insert into activity(issue_id,user_id,text,created) values(?,?,?,?)').run(row.id, user.id, text, t);
    });

    if ('assignee_id' in changes && changes.assignee_id && changes.assignee_id !== user.id) {
      notify(changes.assignee_id, `${user.name} assigned you ${key}: ${snippet(row.title)}`, `issue:${key}`);
    }
    if ('status' in changes && row.reporter_id && row.reporter_id !== user.id) {
      notify(row.reporter_id, `${user.name} moved ${key} to ${STATUS_LABEL[changes.status]}`, `issue:${key}`);
    }
    broadcast('issue', { key, project_key: row.pkey });
    return shapeIssue(db.prepare(`${ISSUE_SQL} where i.id=?`).get(row.id));
  });

  r.delete('/api/issues/:key', ({ params, user }) => {
    const row = getIssueRow(params.key);
    if (user.role !== 'admin' && row.reporter_id !== user.id) throw forbidden('Only the reporter or an admin can delete an issue');
    db.prepare('delete from issues where id=?').run(row.id);
    broadcast('issue', { key: `${row.pkey}-${row.num}`, project_key: row.pkey, deleted: true });
    return { ok: true };
  });

  r.post('/api/issues/:key/comments', ({ params, body, user }) => {
    const row = getIssueRow(params.key);
    const key = `${row.pkey}-${row.num}`;
    const text = str(body.body, 'Comment', { max: 5000 });
    const t = now();
    const { lastInsertRowid } = db.prepare('insert into comments(issue_id,user_id,body,created) values(?,?,?,?)').run(row.id, user.id, text, t);
    db.prepare('update issues set updated=? where id=?').run(t, row.id);

    const told = new Set([user.id]);
    for (const u of mentionedUsers(text)) {
      if (!told.has(u.id)) notify(u.id, `${user.name} mentioned you on ${key}`, `issue:${key}`);
      told.add(u.id);
    }
    for (const id of [row.assignee_id, row.reporter_id]) {
      if (id && !told.has(id)) notify(id, `${user.name} commented on ${key}: ${snippet(text, 60)}`, `issue:${key}`);
      told.add(id);
    }
    broadcast('issue', { key, project_key: row.pkey });
    return db.prepare('select * from comments where id=?').get(lastInsertRowid);
  });
}
