# Security

## Reporting a vulnerability
Please do not open a public issue. Email the maintainer (add your address here) or use
GitHub's "Report a vulnerability" button on the Security tab.

## What Orbit does
- Passwords: scrypt with a per-user salt, constant-time comparison; unknown emails cost the same time as wrong passwords.
- Sessions: random 256-bit tokens in HttpOnly, SameSite=Lax cookies (Secure over HTTPS). Only a SHA-256 hash is stored. Sessions expire after 30 days on the server, and changing your password signs out other devices.
- Writes must be `application/json`, which blocks cross-site form posts.
- Login is throttled per address+email and per address; sign-ups are throttled per address.
- All SQL is parameterised. All user text is HTML-escaped before it is rendered.
- Headers: Content-Security-Policy (the app allows only its own scripts), HSTS over HTTPS, `nosniff`, frame blocking, restrictive Permissions-Policy.
- Direct messages are only readable, searchable and streamed to their two participants.

## Trust model (read this before deploying)
Orbit is built for **one trusted team**. Every signed-in member can read all public channels, projects, issues and docs,
and can edit any issue or doc. Only admins, project leads or authors can delete or manage sprints.
It is not multi-tenant: do not host unrelated organisations in one instance.

## Deploy checklist
1. Serve over HTTPS and set `ORBIT_SECURE_COOKIES=1`.
2. Behind a single reverse proxy? Set `ORBIT_TRUST_PROXY=1`.
3. Set `ORBIT_INVITE_CODE` (and `ORBIT_ADMIN_EMAIL`) **before** the first visit, so strangers cannot sign up or claim admin.
4. Mount a persistent volume for the database and back it up.
5. Run a single instance (sessions, live updates and throttling live in process memory).

## Known limits
- The landing page loads fonts from Google Fonts and three.js from jsDelivr (allowed by its CSP). Self-host them if you need zero third-party requests.
- Registration returns "email already exists", so email addresses can be probed. Use an invite code to limit this.
- Throttling is in memory and resets on restart.
