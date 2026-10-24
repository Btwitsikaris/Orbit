<p align="center"><img src="public/assets/logo-256.png" width="96" alt="Orbit logo"></p>

<h1 align="center">Orbit</h1>

A self-hosted team workspace in one small Node app: **chat, projects and sprints, docs, calendar and approvals**.
No dependencies to install, one SQLite file for data.

## Run it

```bash
npm start            # needs Node 22.13 or newer
# open http://localhost:3000/app and create the first account (it becomes the admin)
```

Docker (runs as the unprivileged `node` user; use a named volume so permissions just work):

```bash
docker build -t orbit .
docker run -p 3000:3000 -v orbit-data:/app/data \
  -e ORBIT_INVITE_CODE=choose-a-code -e ORBIT_ADMIN_EMAIL=you@example.com orbit
```

Copy `.env.example` to `.env` for local settings (`npm start` loads it).

## Deploying

Orbit is a **long-running server with a SQLite file and live (SSE) connections**, so it needs a host with a persistent disk and a normal Node process:
Render, Railway, Fly.io, a VPS, or any Docker host. Run a single instance and mount a volume at `/app/data`.

**It cannot run on Vercel, Netlify or other serverless platforms**: there is no persistent disk and no long-lived connections. (The static landing page alone could be hosted there.)

Before the first visit, set `ORBIT_INVITE_CODE` and `ORBIT_ADMIN_EMAIL` so nobody else can sign up or claim the admin role, enable HTTPS, and set `ORBIT_TRUST_PROXY=1` if you are behind one proxy. See [SECURITY.md](SECURITY.md).

The landing page is at `/`, the app at `/app`, and a health check at `/health`.
Put it behind HTTPS (Caddy, nginx, a cloud load balancer) before real use, and set `ORBIT_SECURE_COOKIES=1` if the proxy doesn't send `X-Forwarded-Proto`.

## What is in it

| Area | What you get |
|---|---|
| **Chat** | Public channels, private DMs, threads, emoji reactions, edit and delete, `@mentions`, unread counts, live delivery |
| **Projects** | Boards with drag and drop, backlog, sprints (start, complete, unfinished work returns to backlog), issue types, priorities, labels, estimates, comments, activity log |
| **Docs** | Markdown pages with autosave, live preview, edit-conflict detection, share-to-chat |
| **Calendar** | Month view, invites with accept/decline, optional video meeting link |
| **Approvals** | Ask a teammate to sign off, they approve or reject with a note |
| **Everywhere** | Global search, notifications (live toasts), mobile layout |

Cross-links: type `/task Fix the login page` in chat to file an issue, `/meet` to post a video link, write an issue key like `ORB-3` anywhere to get a link, or use the board icon on a message to turn it into an issue.

Video meetings use free Jitsi links (`meet.jit.si`). Your data stays on your server; the pages themselves load fonts from Google Fonts and the landing page loads three.js from jsDelivr.

## Tests

```bash
npm test             # 29 API and security checks (in-memory database, no setup)
npm i -D playwright && npx playwright install chromium
npm run test:e2e     # drives the real UI in a browser
```

## Layout

```
src/server.js        HTTP server, router, static files
src/db.js            SQLite schema (node:sqlite)
src/lib.js           validation, errors, notifications
src/realtime.js      server-sent events
src/api/*.js         auth, projects, chat, docs/calendar/approvals/search
public/index.html    landing page
public/app/          the web app (plain ES modules, no build step)
public/assets/       logo, favicons and app icons
```

## Notes and limits

- Single server, single database file. Fine for a team; for many replicas you would move to Postgres.
- Passwords are hashed with scrypt; sessions are HttpOnly cookies stored hashed and expiring after 30 days; writes must be JSON (blocks cross-site form posts); login and sign-up are throttled; a Content-Security-Policy restricts scripts.
- Built for one trusted team: members can edit any issue or doc. See the trust model in [SECURITY.md](SECURITY.md).
- Anyone who can reach the instance can register unless you set `ORBIT_INVITE_CODE`. Run it on a private network or behind your SSO proxy if the team should be closed.

## License

MIT, see [LICENSE](LICENSE).
