import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, unauthorized } from './lib.js';
import { currentUser, register as registerAuth } from './api/auth.js';
import { register as registerProjects } from './api/projects.js';
import { register as registerChat } from './api/chat.js';
import { register as registerWork, STREAM } from './api/work.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// ---------- tiny router ----------
function makeRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, opts = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, re, handler, public: !!opts.public });
  };
  return {
    routes,
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
  };
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
};

// The app loads only its own scripts. Styles allow inline because views set style="" attributes.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// The landing page has an inline module script and loads three.js from jsDelivr.
const LANDING_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || process.env.ORBIT_SECURE_COOKIES === '1';

function securityHeaders(req, kind) {
  const h = { ...BASE_HEADERS };
  if (isHttps(req)) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  if (kind === 'api') {
    h['content-security-policy'] = "default-src 'none'; frame-ancestors 'none'";
    h['x-frame-options'] = 'DENY';
  } else if (kind === 'landing') {
    h['content-security-policy'] = LANDING_CSP;
  } else {
    h['content-security-policy'] = APP_CSP;
    h['x-frame-options'] = 'DENY';
  }
  return h;
}

function sendJson(res, status, data, req) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders(req, 'api') });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  const landing = file === path.join(PUBLIC, 'index.html');
  const cache = file.startsWith(path.join(PUBLIC, 'assets') + path.sep) || ext === '.ico' ? 'public, max-age=86400' : 'no-cache';
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
    ...securityHeaders(req, landing ? 'landing' : 'app'),
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  if (rel === '/') rel = '/index.html';
  if (rel === '/app' || rel === '/app/') rel = '/app/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return false; // path traversal
  return serveFile(req, res, file);
}

export function createApp() {
  const router = makeRouter();
  registerAuth(router);
  registerProjects(router);
  registerChat(router);
  registerWork(router);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/health') return sendJson(res, 200, { ok: true }, req);

      if (pathname.startsWith('/api/')) {
        let matched = null;
        let pathMatch = false;
        for (const r of router.routes) {
          const m = r.re.exec(pathname);
          if (!m) continue;
          pathMatch = true;
          if (r.method === req.method) {
            matched = { r, params: m.groups || {} };
            break;
          }
        }
        if (!matched) return sendJson(res, pathMatch ? 405 : 404, { error: pathMatch ? 'Method not allowed' : 'Not found' }, req);

        const user = currentUser(req);
        if (!matched.r.public && !user) throw unauthorized();

        let body = {};
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const raw = await readBody(req);
          const isJson = /^application\/json\b/i.test(req.headers['content-type'] || '');
          // Only JSON is accepted for writes: this is what blocks cross-site form posts.
          if (req.method !== 'DELETE' || raw) {
            if (!isJson) throw new HttpError(415, 'Content-Type must be application/json');
          }
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              throw new HttpError(400, 'Invalid JSON');
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
          }
        }

        const query = Object.fromEntries(url.searchParams);
        const result = await matched.r.handler({ req, res, user, params: matched.params, query, body });
        if (result === STREAM) return;
        return sendJson(res, 200, result === undefined ? { ok: true } : result, req);
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (serveStatic(req, res, pathname)) return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders(req, 'app') });
      res.end('Not found');
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) }, req);
      console.error(new Date().toISOString(), req.method, req.url, e);
      sendJson(res, 500, { error: 'Something went wrong on our side' }, req);
    }
  });
  server.requestTimeout = 30_000; // time allowed to receive a full request (does not affect SSE responses)
  server.headersTimeout = 15_000;
  return server;
}

// Run only when started directly (tests import createApp)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Orbit is running on http://localhost:${port}  (app: /app)`));
}
