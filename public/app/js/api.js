// Thin fetch wrapper + live event bus (server-sent events).
export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

// ---- live events ----
const bus = new EventTarget();

/** Subscribe to server events. Returns an unsubscribe function. */
export function onLive(fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener('orbit', h);
  return () => bus.removeEventListener('orbit', h);
}

let es = null;
export function connectStream() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.addEventListener('orbit', (e) => {
    try {
      bus.dispatchEvent(new CustomEvent('orbit', { detail: JSON.parse(e.data) }));
    } catch {
      /* ignore malformed event */
    }
  });
}

export function disconnectStream() {
  es?.close();
  es = null;
}
