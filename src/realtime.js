// Server-sent events: one long-lived response per open browser tab.
const clients = new Set();

const MAX_PER_USER = 8;

export function addClient(userId, res) {
  // A user can have a few tabs open; beyond that the oldest connection is closed.
  const mine = [...clients].filter((c) => c.userId === userId);
  while (mine.length >= MAX_PER_USER) {
    const old = mine.shift();
    clients.delete(old);
    old.res.end();
  }
  const c = { userId, res };
  clients.add(c);
  const remove = () => clients.delete(c);
  res.on('error', remove);
  return remove;
}

/** Send an event to everyone, or only to the listed user ids. */
export function broadcast(type, payload = {}, userIds = null) {
  const data = `event: orbit\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const c of clients) {
    if (!userIds || userIds.includes(c.userId)) c.res.write(data);
  }
}

setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 25000).unref();
