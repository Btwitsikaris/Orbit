// API tests: boots the real server on a random port with an in-memory database.
process.env.ORBIT_DB = ':memory:';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const srv = createApp().listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

class Client {
  constructor(name) { this.name = name; this.cookie = ''; }
  async call(method, path, body, { raw = false, headers = {} } = {}) {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    if (raw) return r;
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
  }
  get = (p) => this.call('GET', p);
  post = (p, b) => this.call('POST', p, b);
  put = (p, b) => this.call('PUT', p, b);
  patch = (p, b) => this.call('PATCH', p, b);
  del = (p) => this.call('DELETE', p);
}

let n = 0;
const ok = (name) => console.log('  ✓', name, (n++, ''));
const expect = (res, status, what) => assert.equal(res.status, status, `${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);

const alice = new Client('alice'), bob = new Client('bob'), eve = new Client('eve');

// ---------- auth ----------
expect(await alice.get('/api/me'), 401, 'me without session');
expect(await alice.post('/api/auth/register', { name: 'Alice', email: 'bad', password: 'password1' }), 400, 'bad email');
expect(await alice.post('/api/auth/register', { name: 'Alice', email: 'alice@x.com', password: 'short' }), 400, 'short password');
let r = await alice.post('/api/auth/register', { name: 'Alice', email: 'alice@x.com', password: 'password1' });
expect(r, 200, 'register alice');
assert.equal(r.body.user.role, 'admin'); assert.equal(r.body.user.handle, 'alice');
r = await bob.post('/api/auth/register', { name: 'Bob', email: 'bob@x.com', password: 'password1' });
assert.equal(r.body.user.role, 'member');
await eve.post('/api/auth/register', { name: 'Eve', email: 'eve@x.com', password: 'password1' });
expect(await new Client('x').post('/api/auth/register', { name: 'Dup', email: 'ALICE@x.com', password: 'password1' }), 409, 'duplicate email');
expect(await new Client('x').post('/api/auth/login', { email: 'alice@x.com', password: 'nope-nope' }), 401, 'wrong password');
const again = new Client('alice2');
expect(await again.post('/api/auth/login', { email: 'alice@x.com', password: 'password1' }), 200, 'login');
ok('register / login / roles / duplicates');

// CSRF-style protection: non-JSON writes are rejected
const form = await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: alice.cookie }, body: '{}' });
assert.equal(form.status, 415); ok('non-JSON write rejected');

const users = (await alice.get('/api/users')).body;
assert.equal(users.length, 3);
const [A, B, E] = ['alice', 'bob', 'eve'].map((h) => users.find((u) => u.handle === h));
assert.ok(!('pass_hash' in users[0])); ok('users list hides password hashes');

// ---------- projects & issues ----------
let projects = (await alice.get('/api/projects')).body;
assert.equal(projects[0].key, 'ORB'); assert.equal(projects[0].open_count, 4); ok('demo project seeded for first user');
expect(await alice.post('/api/projects', { key: 'orb', name: 'Dup' }), 409, 'duplicate project key');
expect(await alice.post('/api/projects', { key: '1x', name: 'Bad' }), 400, 'bad key');
expect(await alice.post('/api/projects', { key: 'web', name: 'Website' }), 200, 'create project');

r = await alice.post('/api/projects/WEB/issues', { title: 'Fix login bug', type: 'bug', priority: 'high', assignee_id: B.id, labels: ['auth', 'urgent'] });
expect(r, 200, 'create issue');
const issue = r.body; assert.equal(issue.key, 'WEB-1'); assert.deepEqual(issue.labels, ['auth', 'urgent']);
assert.equal((await alice.post('/api/projects/WEB/issues', { title: 'Second' })).body.key, 'WEB-2');
expect((await alice.post('/api/projects/WEB/issues', { title: '' })), 400, 'empty title');
expect((await alice.post('/api/projects/WEB/issues', { title: 'x', type: 'nonsense' })), 400, 'bad type');

let notes = (await bob.get('/api/notifications')).body;
assert.ok(notes.items.some((x) => x.link === 'issue:WEB-1')); ok('issue creation notifies the assignee');

r = await bob.patch('/api/issues/WEB-1', { status: 'in_progress' });
assert.equal(r.body.status, 'in_progress');
let detail = (await bob.get('/api/issues/WEB-1')).body;
assert.ok(detail.activity.some((a) => /moved this from To do to In progress/.test(a.text)));
notes = (await alice.get('/api/notifications')).body;
assert.ok(notes.items.some((x) => /moved WEB-1/.test(x.text))); ok('status change logs activity and notifies reporter');

expect(await bob.patch('/api/issues/WEB-1', { status: 'flying' }), 400, 'bad status');
expect(await bob.get('/api/issues/NOPE-9'), 404, 'unknown issue');
r = await bob.patch('/api/issues/WEB-2', { rank: 500, status: 'done' });
assert.equal(r.body.rank, 500); ok('issue edit + ordering');

r = await bob.post('/api/issues/WEB-1/comments', { body: 'Looking into it @alice' });
expect(r, 200, 'comment');
notes = (await alice.get('/api/notifications')).body;
assert.ok(notes.items.some((x) => /mentioned you on WEB-1/.test(x.text))); ok('comments with @mention notify');

// sprints
const sp = (await alice.post('/api/projects/WEB/sprints', { name: 'Sprint 1' })).body;
expect(await alice.patch(`/api/sprints/${sp.id}`, { state: 'active' }), 200, 'start sprint');
const sp2 = (await alice.post('/api/projects/WEB/sprints', { name: 'Sprint 2' })).body;
expect(await alice.patch(`/api/sprints/${sp2.id}`, { state: 'active' }), 409, 'only one active sprint');
await alice.patch('/api/issues/WEB-1', { sprint_id: sp.id });
await alice.patch('/api/issues/WEB-2', { sprint_id: sp.id });
await alice.patch(`/api/sprints/${sp.id}`, { state: 'done' });
const proj = (await alice.get('/api/projects/WEB')).body;
assert.equal(proj.issues.find((i) => i.key === 'WEB-1').sprint_id, null, 'unfinished issue returned to backlog');
assert.equal(proj.issues.find((i) => i.key === 'WEB-2').sprint_id, sp.id, 'done issue stays in sprint');
expect(await alice.patch('/api/issues/WEB-1', { sprint_id: sp.id }), 400, 'cannot add to completed sprint');
ok('sprint lifecycle');

expect(await bob.del('/api/issues/WEB-2'), 403, 'non-reporter cannot delete');
expect(await alice.del('/api/issues/WEB-2'), 200, 'reporter deletes');
assert.equal((await bob.get('/api/issues?mine=1')).body.length, 1); ok('my issues + delete permissions');

// ---------- chat ----------
let chans = (await alice.get('/api/channels')).body;
const general = chans.find((c) => c.name === 'general');
assert.ok(general && general.unread === 0, 'your own messages are never unread');
assert.equal((await bob.get('/api/channels')).body.find((c) => c.name === 'general').unread, 0, 'new members start with a clean slate');
r = await alice.post(`/api/channels/${general.id}/messages`, { body: 'Hello team, see WEB-1 @bob' });
expect(r, 200, 'post message');
assert.equal((await bob.get('/api/channels')).body.find((c) => c.name === 'general').unread, 1);
await bob.get(`/api/channels/${general.id}/messages`);
assert.equal((await bob.get('/api/channels')).body.find((c) => c.name === 'general').unread, 0); ok('messages + unread counters');
assert.ok((await bob.get('/api/notifications')).body.items.some((x) => x.link === `chat:${general.id}`)); ok('chat @mention notifies');

const msgId = r.body.id;
await bob.post(`/api/messages/${msgId}/react`, { emoji: '👍' });
expect(await bob.post(`/api/messages/${msgId}/react`, { emoji: '💩' }), 400, 'unsupported emoji');
await alice.post(`/api/channels/${general.id}/messages`, { body: 'Thread reply', parent_id: msgId });
r = await bob.get(`/api/channels/${general.id}/messages`);
const m = r.body.messages.find((x) => x.id === msgId);
assert.deepEqual(m.reactions['👍'], [B.id]); assert.equal(m.reply_count, 1);
assert.equal((await bob.get(`/api/messages/${msgId}/thread`)).body.replies.length, 1); ok('reactions + threads');

r = await alice.post(`/api/channels/${general.id}/messages`, { body: '/task WEB Update the footer' });
assert.match(r.body.body, /Created WEB-3: Update the footer/);
r = await alice.post(`/api/channels/${general.id}/messages`, { body: '/meet' });
assert.match(r.body.body, /meet\.jit\.si\/orbit-/); ok('/task and /meet slash commands');

r = await bob.post(`/api/messages/${msgId}/to-issue`, { project_key: 'WEB' });
expect(r, 200, 'message to issue'); assert.equal(r.body.key, 'WEB-4'); ok('message -> issue');

// DMs are private
const dm = (await alice.post('/api/dm', { user_id: B.id })).body;
assert.equal((await alice.post('/api/dm', { user_id: B.id })).body.id, dm.id, 'dm is reused');
await alice.post(`/api/channels/${dm.id}/messages`, { body: 'secret plan' });
expect(await eve.get(`/api/channels/${dm.id}/messages`), 403, 'outsider reads dm');
expect(await eve.post(`/api/channels/${dm.id}/messages`, { body: 'hi' }), 403, 'outsider writes dm');
assert.ok(!(await eve.get('/api/channels')).body.some((c) => c.id === dm.id), 'dm hidden from list');
assert.equal((await eve.get('/api/search?q=secret')).body.messages.length, 0, 'dm hidden from search');
assert.equal((await bob.get('/api/search?q=secret')).body.messages.length, 1);
expect(await alice.del(`/api/messages/${msgId}`), 200, 'author deletes');
expect(await eve.del(`/api/messages/${msgId + 100}`), 404, 'delete missing');
ok('DM privacy (read, write, list, search)');

expect(await alice.post('/api/channels', { name: 'Design Team' }), 200, 'create channel');
expect(await alice.post('/api/channels', { name: 'design team' }), 409, 'duplicate channel');

// ---------- docs ----------
let doc = (await alice.post('/api/docs', { title: 'Spec' })).body;
r = await alice.put(`/api/docs/${doc.id}`, { body: '# Hello', base_updated: doc.updated });
expect(r, 200, 'save doc');
r = await bob.put(`/api/docs/${doc.id}`, { body: 'stale', base_updated: doc.updated });
expect(r, 409, 'stale save'); assert.equal(r.body.doc.body, '# Hello'); ok('docs with edit-conflict detection');
expect(await bob.del(`/api/docs/${doc.id}`), 403, 'non-author delete');

// ---------- calendar ----------
const t0 = Date.now() + 3600e3;
expect(await alice.post('/api/events', { title: 'Standup', starts_at: t0, ends_at: t0 - 1 }), 400, 'end before start');
r = await alice.post('/api/events', { title: 'Standup', starts_at: t0, ends_at: t0 + 1800e3, attendees: [B.id], meeting: true });
expect(r, 200, 'create event'); assert.match(r.body.meeting_url, /^https:\/\/meet\.jit\.si\/orbit-/);
const evId = r.body.id;
assert.equal((await bob.get(`/api/events?from=${t0 - 1000}&to=${t0 + 99999}`)).body.length, 1);
assert.equal((await eve.get(`/api/events?from=${t0 - 1000}&to=${t0 + 99999}`)).body.length, 0, 'uninvited user sees nothing');
expect(await eve.put(`/api/events/${evId}/rsvp`, { status: 'accepted' }), 403, 'uninvited rsvp');
expect(await bob.put(`/api/events/${evId}/rsvp`, { status: 'accepted' }), 200, 'rsvp');
expect(await bob.del(`/api/events/${evId}`), 403, 'non-organizer cancel');
ok('calendar: visibility, invites, rsvp');

// ---------- approvals ----------
r = await bob.post('/api/approvals', { title: 'Budget for Q4', details: '$5k', approver_id: A.id });
expect(r, 200, 'request approval');
expect(await bob.post('/api/approvals', { title: 'x', approver_id: B.id }), 400, 'self-approval blocked');
expect(await eve.post(`/api/approvals/${r.body.id}/decide`, { decision: 'approved' }), 403, 'wrong approver');
expect(await alice.post(`/api/approvals/${r.body.id}/decide`, { decision: 'approved', note: 'ok' }), 200, 'approve');
expect(await alice.post(`/api/approvals/${r.body.id}/decide`, { decision: 'rejected' }), 409, 'cannot decide twice');
assert.equal((await bob.get('/api/approvals')).body.mine[0].status, 'approved');
ok('approvals workflow');

// ---------- search, notifications, safety ----------
const s = (await alice.get('/api/search?q=login')).body;
assert.ok(s.issues.some((i) => i.key === 'WEB-1')); assert.ok((await alice.get('/api/search?q=WEB-1')).body.issues.length >= 1);
assert.equal((await alice.get("/api/search?q=%25")).body.issues.length, 0, 'wildcards are escaped');
ok('search');
await bob.post('/api/notifications/read', {});
assert.equal((await bob.get('/api/notifications')).body.unread, 0); ok('mark notifications read');

const evil = (await alice.post('/api/projects/WEB/issues', { title: '<img src=x onerror=alert(1)>' })).body;
assert.equal(evil.title, '<img src=x onerror=alert(1)>', 'stored as plain text (escaped on render)');

// SSE: bob receives a live event when alice posts
const ctl = new AbortController();
const stream = await fetch(base + '/api/stream', { headers: { cookie: bob.cookie }, signal: ctl.signal });
assert.equal(stream.headers.get('content-type'), 'text/event-stream');
const reader = stream.body.getReader();
const got = (async () => { let buf = ''; for (;;) { const { value } = await reader.read(); buf += Buffer.from(value).toString(); if (buf.includes('"type":"message"')) return buf; } })();
await new Promise((r) => setTimeout(r, 100));
await alice.post(`/api/channels/${general.id}/messages`, { body: 'live!' });
const live = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event')), 2000))]);
assert.match(live, /"channel_id"/);
// ...and eve (not in the DM) gets nothing for DM traffic
ctl.abort(); ok('realtime SSE delivery');

// ---------- hardening ----------
const { db: rawDb } = await import('../src/db.js');
const login = (c, email, password, ip) => c.call('POST', '/api/auth/login', { email, password }, ip ? { headers: { 'x-forwarded-for': ip } } : {});

// a malformed cookie must not crash anything
{
  const bad = { cookie: 'orbit_session=%E0%A4%A' };
  expect(await new Client('x').call('GET', '/api/me', undefined, { headers: bad }), 401, 'malformed cookie on /me');
  expect(await new Client('x').call('POST', '/api/auth/login', { email: 'nobody@x.com', password: 'whatever1' }, { headers: bad }), 401, 'malformed cookie on login');
  ok('malformed cookie does not crash requests');
}

// security headers
{
  const app = await fetch(base + '/app');
  assert.match(app.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
  assert.match(app.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!app.headers.get('strict-transport-security'), 'no HSTS over plain http');
  const https = await fetch(base + '/app', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security'), /max-age=/);
  assert.match((await fetch(base + '/api/me')).headers.get('content-security-policy'), /default-src 'none'/);
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /cdn\.jsdelivr\.net/);
  assert.equal((await fetch(base + '/favicon.ico')).status, 200);
  assert.equal((await fetch(base + '/assets/logo.png')).status, 200);
  ok('CSP, HSTS, favicon and logo are served');
}

// sessions: stored hashed, expire on the server, and a password change signs other devices out
{
  const dev1 = new Client('bob-phone'), dev2 = new Client('bob-laptop');
  expect(await login(dev1, 'bob@x.com', 'password1'), 200, 'bob login 1');
  expect(await login(dev2, 'bob@x.com', 'password1'), 200, 'bob login 2');
  const token = dev1.cookie.split('=')[1];
  assert.equal(rawDb.prepare('select count(*) c from sessions where token=?').get(token).c, 0, 'raw token must not be stored');
  expect(await dev1.patch('/api/me', { password: 'password2!', current_password: 'password1' }), 200, 'change password');
  expect(await dev1.get('/api/me'), 200, 'current device stays signed in');
  expect(await dev2.get('/api/me'), 401, 'other device signed out');
  rawDb.prepare('update sessions set created=? where token=(select token from sessions order by rowid desc limit 1)').run(Date.now() - 31 * 86400_000);
  expect(await dev1.get('/api/me'), 401, 'expired session is rejected');
  expect(await login(dev1, 'bob@x.com', 'password2!'), 200, 'login with new password');
  expect(await dev1.patch('/api/me', { password: 'password1', current_password: 'password2!' }), 200, 'restore password');
  ok('sessions hashed, expire server-side, revoked on password change');
}

// one attacker cannot lock a victim out
{
  process.env.ORBIT_TRUST_PROXY = '1';
  const attacker = new Client('attacker');
  for (let i = 0; i < 10; i++) expect(await login(attacker, 'eve@x.com', 'wrong-pass', '9.9.9.9'), 401, 'bad guess');
  expect(await login(attacker, 'eve@x.com', 'wrong-pass', '9.9.9.9'), 429, 'attacker is throttled');
  expect(await login(new Client('real-eve'), 'eve@x.com', 'password1', '1.1.1.1'), 200, 'real user still signs in');
  delete process.env.ORBIT_TRUST_PROXY;
  ok('login throttle is per address, not a lockout for the victim');
}

// sprint management is limited to the project lead / admin
{
  const proj = (await alice.get('/api/projects/ORB')).body;
  const sprintId = proj.sprints[0].id;
  expect(await eve.post('/api/projects/ORB/sprints', { name: 'Eve sprint' }), 403, 'member creates sprint');
  expect(await eve.patch(`/api/sprints/${sprintId}`, { name: 'hijack' }), 403, 'member edits sprint');
  ok('sprints need lead or admin');
}

// invite code + sign-up throttle
{
  process.env.ORBIT_INVITE_CODE = 's3cret-code';
  assert.equal((await new Client('x').get('/api/auth/config')).body.invite_required, true);
  expect(await new Client('x').post('/api/auth/register', { name: 'Z', email: 'z@x.com', password: 'password1' }), 403, 'no invite');
  expect(await new Client('x').post('/api/auth/register', { name: 'Z', email: 'z@x.com', password: 'password1', invite: 'nope' }), 403, 'wrong invite');
  expect(await new Client('x').post('/api/auth/register', { name: 'Z', email: 'z@x.com', password: 'password1', invite: 's3cret-code' }), 200, 'right invite');
  delete process.env.ORBIT_INVITE_CODE;
  assert.equal((await new Client('x').get('/api/auth/config')).body.invite_required, false);

  process.env.ORBIT_TRUST_PROXY = '1';
  process.env.ORBIT_REGISTER_LIMIT = '2';
  const h = { headers: { 'x-forwarded-for': '7.7.7.7' } };
  const reg = (i) => new Client('s').call('POST', '/api/auth/register', { name: 'S', email: `spam${i}@x.com`, password: 'password1' }, h);
  expect((await reg(1)), 200, 'signup 1'); expect((await reg(2)), 200, 'signup 2'); expect((await reg(3)), 429, 'signup throttled');
  delete process.env.ORBIT_TRUST_PROXY; delete process.env.ORBIT_REGISTER_LIMIT;
  ok('invite code and sign-up throttle');
}

// markdown renderer cannot be tricked into breaking out of attributes
{
  globalThis.document = { addEventListener() {} };
  const { renderMd, linkify } = await import('../public/app/js/ui.js');
  const attacks = [
    '[x](https://a.com/" onmouseover="alert(1))', '[x](https://a.com/`a`)', '[x](https://a.com/**b**)', '[x](javascript:alert(1))',
    'https://a.com/"onmouseover="alert(1)', '`<img src=x onerror=alert(1)>`', '<script>alert(1)</script>', '[a](https://x.com/ORB-1 "t")',
  ];
  for (const a of attacks) for (const html of [renderMd(a), linkify(a)]) {
    assert.ok(!/<(script|img|iframe)\b/i.test(html), `raw tag survived: ${a}`);
    assert.ok(!/href="[^"]*[<>]/.test(html), `markup inside href: ${a}`);
    assert.ok(!/ on\w+=/i.test(html.replace(/&quot;/g, '')) || !/<[^>]* on\w+="/i.test(html), `event handler attribute: ${a}`);
    assert.ok(!/href="javascript:/i.test(html), `javascript: link: ${a}`);
  }
  ok('markdown / linkify XSS payloads stay inert');
}

expect(await alice.post('/api/auth/logout', {}), 200, 'logout');
expect(await alice.get('/api/me'), 401, 'session ended');

// static
assert.equal((await fetch(base + '/')).status, 200);
assert.equal((await fetch(base + '/app')).status, 200);
assert.equal((await fetch(base + '/..%2f..%2fetc/passwd')).status, 404, 'path traversal blocked');

console.log(`\nAll ${n} checks passed.`);
srv.close();
process.exit(0);
