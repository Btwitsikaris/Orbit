import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, now } from '../db.js';
import { bad, conflict, str, publicUser, unauthorized, HttpError } from '../lib.js';
import { createIssue, getProject } from './projects.js';
import { broadcast } from '../realtime.js';

const COLORS = ['#0E2AC5', '#2F69FF', '#7C3AED', '#DB2777', '#EA580C', '#059669', '#0891B2', '#CA8A04'];
const COOKIE = 'orbit_session';
const MAX_AGE = 30 * 24 * 3600; // seconds; enforced on the server as well as in the cookie

const scrypt = promisify(crypto.scrypt);
const hash = async (password, salt) => (await scrypt(password, salt, 64)).toString('hex');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${await hash(password, salt)}`;
}

async function checkPassword(password, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(await hash(password, salt), 'hex');
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Used when the email is unknown, so "no such user" costs the same time as "wrong password".
const DUMMY = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw; // malformed escape: keep it raw instead of crashing the request
    }
  }
  return out;
}

/**
 * The signed-in user for this request, or null.
 * Session tokens are stored hashed, so a leaked database file cannot be used to sign in.
 */
export function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token || token.length > 200) return null;
  const sid = sha256(token);
  const row = db
    .prepare('select u.*, s.token as _sid from sessions s join users u on u.id = s.user_id where s.token=? and s.created > ?')
    .get(sid, now() - MAX_AGE * 1000);
  return row || null;
}

function purgeSessions() {
  db.prepare('delete from sessions where created <= ?').run(now() - MAX_AGE * 1000);
}
purgeSessions();
setInterval(purgeSessions, 3600_000).unref();

const trustProxy = () => process.env.ORBIT_TRUST_PROXY === '1';

/** Client address. Behind one trusted proxy the last X-Forwarded-For entry is the real client. */
export function clientIp(req) {
  if (trustProxy()) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '';
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('insert into sessions(token,user_id,created) values(?,?,?)').run(sha256(token), userId, now());
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.ORBIT_SECURE_COOKIES === '1';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`);
}

// ---- throttling (in memory; one server process) ----
// Failed logins are counted per ip+email (10) and per ip (30), so one attacker cannot lock a
// victim out from their own address, plus a high per-email ceiling against distributed guessing.
const WINDOW = 600_000;
const buckets = new Map();
const recent = (key, window = WINDOW) => {
  const t = now();
  const list = (buckets.get(key) || []).filter((x) => t - x < window);
  buckets.set(key, list);
  return list;
};
const hit = (key) => recent(key).push(now()) && buckets.get(key);
const over = (key, limit, window = WINDOW) => recent(key, window).length >= limit;
setInterval(() => {
  const t = now();
  for (const [k, list] of buckets) if (!list.some((x) => t - x < 3600_000)) buckets.delete(k);
}, 300_000).unref();

const loginBlocked = (ip, email) => over(`l:${ip}|${email}`, 10) || over(`l:${ip}`, 30) || over(`l:|${email}`, 100);
const loginFailed = (ip, email) => [`l:${ip}|${email}`, `l:${ip}`, `l:|${email}`].forEach(hit);

const inviteOk = (given) => {
  const want = process.env.ORBIT_INVITE_CODE;
  if (!want) return true;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
};

function uniqueHandle(email) {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  if (base.length < 2) base = `user${base}`;
  let h = base;
  for (let n = 2; db.prepare('select 1 from users where handle=?').get(h); n++) h = `${base}${n}`;
  return h;
}

/** First account gets a small demo workspace so the app doesn't open empty. */
function seedDemo(user) {
  const t = now();
  const { lastInsertRowid } = db
    .prepare('insert into projects(key,name,description,lead_id,created) values(?,?,?,?,?)')
    .run('ORB', 'Orbit Launch', 'A sample project: plan, discuss and ship in one place.', user.id, t);
  const project = getProject('ORB');
  const sprint = Number(
    db.prepare("insert into sprints(project_id,name,state,created,started) values(?,?,'active',?,?)").run(lastInsertRowid, 'Sprint 1', t, t).lastInsertRowid,
  );
  const demo = [
    ['Welcome to Orbit: drag me across the board', 'story', 'todo', 'medium'],
    ['Open an issue and leave a comment with @mention', 'task', 'todo', 'low'],
    ['Try the chat: type /task Fix the login page', 'task', 'in_progress', 'high'],
    ['Invite your team', 'task', 'in_review', 'high'],
    ['Create your first real project', 'epic', 'done', 'medium'],
  ];
  for (const [title, type, status, priority] of demo) {
    createIssue(project, { title, type, status, priority, sprint_id: sprint, assignee_id: user.id }, user.id);
  }
  db.prepare('insert into docs(title,body,project_id,created_by,updated_by,created,updated) values(?,?,?,?,?,?,?)').run(
    'Welcome to Orbit',
    '# Welcome to Orbit\n\nOne place for **projects, chat, docs and calendar**.\n\n## Try this\n\n- [x] Create an account\n- [ ] Drag an issue on the board (see ORB-1)\n- [ ] Say hello in #general\n- [ ] Schedule a meeting from the Calendar\n\nDocs support markdown, and issue keys like ORB-3 become links automatically.\n',
    lastInsertRowid,
    user.id,
    user.id,
    t,
    t,
  );
  const general = db.prepare("select id from channels where name='general' and kind='public'").get();
  db.prepare('insert into messages(channel_id,user_id,body,created) values(?,?,?,?)').run(
    general.id,
    user.id,
    'Welcome to Orbit! 👋 Mention teammates with @handle, link issues like ORB-1, or type /meet to start a video call.',
    t,
  );
}

export function register(r) {
  // Lets the sign-up form know whether to ask for an invite code.
  r.get('/api/auth/config', () => ({ invite_required: !!process.env.ORBIT_INVITE_CODE }), { public: true });

  r.post(
    '/api/auth/register',
    async ({ req, res, body }) => {
      const ip = clientIp(req);
      const limit = Number(process.env.ORBIT_REGISTER_LIMIT) || 20;
      if (over(`r:${ip}`, limit, 3600_000)) throw new HttpError(429, 'Too many sign-ups from this address. Try again later.');
      hit(`r:${ip}`);

      const name = str(body.name, 'Name', { max: 60 });
      const email = str(body.email, 'Email', { max: 120 }).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
      const password = str(body.password, 'Password', { min: 8, max: 200, trim: false });
      if (!inviteOk(body.invite)) throw new HttpError(403, 'A valid invite code is required');

      const pass_hash = await makePassword(password); // async: do not block the server

      // Everything below is synchronous, so two simultaneous sign-ups cannot both become admin.
      const first = db.prepare('select count(*) c from users').get().c === 0;
      const adminEmail = (process.env.ORBIT_ADMIN_EMAIL || '').trim().toLowerCase();
      if (first && adminEmail && email !== adminEmail) throw new HttpError(403, 'The first account must use the configured admin email');
      if (db.prepare('select 1 from users where email=?').get(email)) throw conflict('An account with that email already exists');

      const { lastInsertRowid } = db
        .prepare('insert into users(name,handle,email,pass_hash,color,role,created) values(?,?,?,?,?,?,?)')
        .run(name, uniqueHandle(email), email, pass_hash, COLORS[Math.floor(Math.random() * COLORS.length)], first ? 'admin' : 'member', now());
      const user = db.prepare('select * from users where id=?').get(lastInsertRowid);
      if (first) seedDemo(user);
      startSession(req, res, user.id);
      broadcast('user', { id: user.id });
      return { user: publicUser(user) };
    },
    { public: true },
  );

  r.post(
    '/api/auth/login',
    async ({ req, res, body }) => {
      const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
      const ip = clientIp(req);
      if (loginBlocked(ip, email)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const user = db.prepare('select * from users where email=?').get(email);
      const good = await checkPassword(String(body.password || '').slice(0, 200), user ? user.pass_hash : DUMMY);
      if (!user || !good) {
        loginFailed(ip, email);
        throw unauthorized('Wrong email or password');
      }
      startSession(req, res, user.id);
      return { user: publicUser(user) };
    },
    { public: true },
  );

  r.post('/api/auth/logout', ({ req, res }) => {
    const token = cookies(req)[COOKIE];
    if (token) db.prepare('delete from sessions where token=?').run(sha256(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  r.get('/api/me', ({ user }) => ({
    user: publicUser(user),
    unread: db.prepare('select count(*) c from notifications where user_id=? and read=0').get(user.id).c,
  }));

  r.patch('/api/me', async ({ user, body }) => {
    if (body.name !== undefined) db.prepare('update users set name=? where id=?').run(str(body.name, 'Name', { max: 60 }), user.id);
    if (body.password !== undefined) {
      const current = String(body.current_password || '').slice(0, 200);
      if (!(await checkPassword(current, user.pass_hash))) throw bad('Current password is incorrect');
      const next = await makePassword(str(body.password, 'Password', { min: 8, max: 200, trim: false }));
      db.prepare('update users set pass_hash=? where id=?').run(next, user.id);
      // Changing the password signs every other device out.
      db.prepare('delete from sessions where user_id=? and token != ?').run(user.id, user._sid);
    }
    broadcast('user', { id: user.id });
    return { user: publicUser(db.prepare('select * from users where id=?').get(user.id)) };
  });

  r.get('/api/users', () => db.prepare('select * from users order by name collate nocase').all().map(publicUser));
}
