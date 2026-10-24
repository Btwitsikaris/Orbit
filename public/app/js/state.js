// Shared client state. Views read from here; main.js keeps it fresh.
export const S = {
  me: null,
  users: [],
  byId: new Map(),
  byHandle: new Map(),
  projects: [],
  channels: [],
  unread: 0,
};

export function setUsers(list) {
  S.users = list;
  S.byId = new Map(list.map((u) => [u.id, u]));
  S.byHandle = new Map(list.map((u) => [u.handle, u]));
}

export const user = (id) => S.byId.get(id) || null;
export const userName = (id) => user(id)?.name || 'Someone';
