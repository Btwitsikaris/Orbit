// Shared lists (people, projects, channels) that several views read. Loaders notify subscribers.
import { get } from './api.js';
import { S, setUsers, user } from './state.js';

const bus = new EventTarget();
export const onShared = (fn) => {
  const h = () => fn();
  bus.addEventListener('change', h);
  return () => bus.removeEventListener('change', h);
};
const fire = () => bus.dispatchEvent(new Event('change'));

export async function loadUsers() {
  setUsers(await get('/users'));
  fire();
}
export async function loadProjects() {
  S.projects = await get('/projects');
  fire();
}
export async function loadChannels() {
  S.channels = await get('/channels');
  fire();
}

export const go = (hash) => {
  location.hash = hash;
};

/** Display name for a channel (DMs are named after the other person). */
export function channelName(c) {
  if (c.kind !== 'dm') return `# ${c.name}`;
  const other = c.members.find((id) => id !== S.me.id);
  if (!other) return `${S.me.name} (you)`;
  return user(other)?.name || 'Direct message';
}
