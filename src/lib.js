import { db, now } from './db.js';
import { broadcast } from './realtime.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (m) => new HttpError(400, m);
export const unauthorized = (m = 'Please sign in') => new HttpError(401, m);
export const forbidden = (m = 'You do not have access to this') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

export function str(v, name, { min = 1, max = 200, trim = true, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw bad(`${name} is required`);
  }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const s = trim ? v.trim() : v;
  if (s.length < min) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return s;
}

export function oneOf(v, list, name) {
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}

export function intId(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${name} is invalid`);
  return n;
}

export function timestamp(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 4102444800000) throw bad(`${name} is not a valid time`);
  return Math.floor(n);
}

/** Run fn inside a transaction. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const publicUser = (u) => ({ id: u.id, name: u.name, handle: u.handle, email: u.email, color: u.color, role: u.role });

export const userById = (id) => db.prepare('select * from users where id=?').get(id);

export function requireUser(id, name = 'user') {
  const u = userById(id);
  if (!u) throw bad(`That ${name} does not exist`);
  return u;
}

/**
 * Create an in-app notification and push it live.
 * link formats the client understands: issue:KEY, chat:ID, doc:ID, approvals, calendar
 */
export function notify(userId, text, link = '') {
  if (!userId) return;
  const t = now();
  const { lastInsertRowid } = db
    .prepare('insert into notifications(user_id, text, link, read, created) values(?,?,?,0,?)')
    .run(userId, text.slice(0, 300), link, t);
  broadcast('notify', { id: Number(lastInsertRowid), text: text.slice(0, 300), link, created: t }, [userId]);
}

/** @handle mentions -> user rows */
export function mentionedUsers(body) {
  const handles = new Set([...body.matchAll(/(^|\s)@([a-z0-9_]{2,30})\b/gi)].map((m) => m[2].toLowerCase()));
  const out = [];
  for (const h of handles) {
    const u = db.prepare('select * from users where handle=?').get(h);
    if (u) out.push(u);
  }
  return out;
}

export const snippet = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const likePattern = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
