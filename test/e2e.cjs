const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const OUT = require('node:path').join(require('node:os').tmpdir(), 'orbit-e2e-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PORT: '4311', ORBIT_DB: ':memory:' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => console.log('[server err]', String(d).trim()));
  await new Promise((r) => setTimeout(r, 1200));

  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, tag) => {
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`));
  };
  const base = 'http://localhost:4311';
  const steps = [];
  const ok = (s) => (steps.push(s), console.log('  ✓', s));

  const ctxA = await browser.newContext({ viewport: { width: 1360, height: 840 } });
  const a = await ctxA.newPage();
  watch(a, 'alice');

  // landing page loads
  await a.goto(base + '/', { waitUntil: 'domcontentloaded' });
  ok('landing page responds');

  // register alice
  await a.goto(base + '/app');
  await a.click('#sw');
  await a.fill('[name=name]', 'Alice Admin');
  await a.fill('[name=email]', 'alice@example.com');
  await a.fill('[name=password]', 'password123');
  await a.click('button[type=submit]');
  await a.waitForSelector('.shell');
  await a.waitForSelector('text=Good');
  ok('register + home renders');
  await a.screenshot({ path: `${OUT}/01-home.png` });

  // second user via API in separate context
  const ctxB = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const b = await ctxB.newPage();
  watch(b, 'bob');
  await b.goto(base + '/app');
  await b.click('#sw');
  await b.fill('[name=name]', 'Bob Builder');
  await b.fill('[name=email]', 'bob@example.com');
  await b.fill('[name=password]', 'password123');
  await b.click('button[type=submit]');
  await b.waitForSelector('.shell');
  await b.goto(base + '/app#/chat');
  await b.waitForSelector('.chat');
  ok('second user joins');

  // chat: alice sends, bob receives live
  await a.click('a[href="#/chat"]');
  await a.waitForSelector('.composer textarea');
  await a.fill('#cb', 'Hello team @bob, see ORB-1');
  await a.press('#cb', 'Enter');
  await a.waitForSelector('.msg:has-text("Hello team")');
  await b.waitForSelector('.msg:has-text("Hello team")', { timeout: 5000 });
  ok('message delivered live to second browser');
  const mention = await b.locator('.msg:has-text("Hello team") .mention').count();
  if (mention < 1) throw new Error('mention not highlighted');
  ok('@mention highlighted');

  // bob got a toast/notification
  await b.waitForSelector('.toast', { timeout: 5000 });
  ok('mention notification toast');

  // /task slash command
  await a.fill('#cb', '/task ORB Write launch notes');
  await a.press('#cb', 'Enter');
  await a.waitForSelector('.msg:has-text("Created ORB-")');
  ok('/task creates an issue from chat');

  // reaction + thread reply
  const msg = a.locator('.msg:has-text("Hello team")');
  await msg.hover();
  await msg.locator('[data-react][data-emoji="👍"]').click();
  await a.waitForSelector('.msg:has-text("Hello team") .rx.mine');
  await msg.hover();
  await msg.locator('[data-reply]').first().click();
  await a.waitForSelector('.thread textarea');
  await a.fill('.thread textarea', 'Thread reply here');
  await a.press('.thread textarea', 'Enter');
  await a.waitForSelector('.thread .msg:has-text("Thread reply here")');
  ok('reactions + threads');
  await a.screenshot({ path: `${OUT}/02-chat.png` });

  // projects board
  await a.goto(base + '/app#/p/ORB');
  await a.waitForSelector('.board .ticket');
  const todo0 = await a.locator('.col[data-status=todo] .ticket').count();
  await a.locator('.col[data-status=todo] .ticket').first().dragTo(a.locator('.col[data-status=done]'));
  await a.waitForFunction((n) => document.querySelectorAll('.col[data-status=todo] .ticket').length === n - 1, todo0);
  ok('drag issue across board');
  await a.screenshot({ path: `${OUT}/03-board.png` });

  // issue dialog + comment
  await a.locator('.ticket').first().click();
  await a.waitForSelector('.modal .issue-grid');
  await a.fill('#cb', 'Looks good @bob');
  await a.click('#cf button[type=submit]');
  await a.waitForSelector('.modal .comment:has-text("Looks good")');
  ok('issue dialog + comment');
  await a.screenshot({ path: `${OUT}/04-issue.png` });
  await a.keyboard.press('Escape');

  // backlog + sprint
  await a.click('.tabs a:has-text("Backlog")');
  await a.waitForSelector('.sprint');
  await a.fill('[data-quick=""] input', 'Quick added issue');
  await a.press('[data-quick=""] input', 'Enter');
  await a.waitForSelector('.irow:has-text("Quick added issue")');
  ok('backlog quick-create');

  // docs
  await a.goto(base + '/app#/docs');
  await a.waitForSelector('.doc-title');
  await a.click('#nd');
  await a.waitForSelector('#dbody');
  await a.fill('.doc-title', 'Launch plan');
  await a.fill('#dbody', '# Plan\n\n- [ ] ship it\n\nSee ORB-1');
  await a.waitForSelector('#ds:has-text("Saved ·")', { timeout: 5000 });
  await a.click('[data-mode=preview]');
  await a.waitForSelector('#dprev h1');
  ok('docs autosave + markdown preview');
  await a.screenshot({ path: `${OUT}/05-docs.png` });

  // calendar
  await a.goto(base + '/app#/calendar');
  await a.waitForSelector('.cal .day');
  await a.click('#newev');
  await a.fill('[name=title]', 'Sprint planning');
  await a.check('input[name=att]');
  await a.click('#ef button[type=submit]');
  await a.waitForSelector('.ev:has-text("Sprint planning")');
  ok('calendar event created');
  await b.waitForSelector('.toast:has-text("invited you")', { timeout: 5000 });
  ok('invitee notified live');
  await a.screenshot({ path: `${OUT}/06-calendar.png` });

  // approvals
  await b.goto(base + '/app#/approvals');
  await b.waitForSelector('#nr');
  await b.click('#nr');
  await b.fill('[name=title]', 'Team lunch budget');
  await b.click('#rf button[type=submit]');
  await b.waitForSelector('text=Team lunch budget');
  await a.goto(base + '/app#/approvals');
  await a.waitForSelector('[data-d=approved]');
  await a.click('[data-d=approved]');
  await a.waitForSelector('.chip.approved');
  ok('approval request + decision');

  // search
  await a.goto(base + '/app#/');
  await a.fill('#q', 'launch');
  await a.waitForSelector('.results a');
  ok('global search');

  // mobile layout
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 780 }, storageState: await ctxA.storageState() });
  const m = await ctxM.newPage();
  watch(m, 'mobile');
  await m.goto(base + '/app#/chat');
  await m.waitForSelector('.chat');
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('horizontal overflow on mobile');
  await m.screenshot({ path: `${OUT}/07-mobile-chat.png` });
  ok('mobile: no horizontal overflow');

  // sign out
  await a.click('#out');
  await a.waitForSelector('.auth-card');
  ok('sign out');

  console.log('\nconsole/page errors:', errors.length ? errors : 'none');
  await browser.close();
  srv.kill();
  process.exit(errors.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
