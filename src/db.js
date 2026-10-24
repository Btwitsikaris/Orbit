import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.ORBIT_DB || './data/orbit.db';
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
create table if not exists users(
  id integer primary key, name text not null, handle text not null unique, email text not null unique,
  pass_hash text not null, color text not null, role text not null default 'member', created integer not null);
create table if not exists sessions(
  token text primary key, user_id integer not null references users(id) on delete cascade, created integer not null);

create table if not exists projects(
  id integer primary key, key text not null unique, name text not null, description text not null default '',
  lead_id integer references users(id) on delete set null, next_num integer not null default 1, created integer not null);
create table if not exists sprints(
  id integer primary key, project_id integer not null references projects(id) on delete cascade,
  name text not null, state text not null default 'planned', created integer not null, started integer, ended integer);
create table if not exists issues(
  id integer primary key, project_id integer not null references projects(id) on delete cascade, num integer not null,
  title text not null, description text not null default '', type text not null default 'task',
  status text not null default 'todo', priority text not null default 'medium',
  assignee_id integer references users(id) on delete set null, reporter_id integer references users(id) on delete set null,
  sprint_id integer references sprints(id) on delete set null, labels text not null default '', estimate integer,
  rank real not null default 0, created integer not null, updated integer not null, unique(project_id, num));
create table if not exists comments(
  id integer primary key, issue_id integer not null references issues(id) on delete cascade,
  user_id integer references users(id) on delete set null, body text not null, created integer not null);
create table if not exists activity(
  id integer primary key, issue_id integer not null references issues(id) on delete cascade,
  user_id integer references users(id) on delete set null, text text not null, created integer not null);

create table if not exists channels(
  id integer primary key, name text, topic text not null default '', kind text not null default 'public',
  created_by integer references users(id) on delete set null, created integer not null);
create unique index if not exists channels_name on channels(name) where kind = 'public';
create table if not exists channel_members(
  channel_id integer not null references channels(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade, primary key(channel_id, user_id));
create table if not exists channel_reads(
  channel_id integer not null references channels(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade, last_id integer not null default 0,
  primary key(channel_id, user_id));
create table if not exists messages(
  id integer primary key, channel_id integer not null references channels(id) on delete cascade,
  user_id integer references users(id) on delete set null, body text not null,
  parent_id integer references messages(id) on delete cascade, created integer not null, edited integer);
create table if not exists reactions(
  message_id integer not null references messages(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade, emoji text not null,
  primary key(message_id, user_id, emoji));

create table if not exists docs(
  id integer primary key, title text not null, body text not null default '',
  project_id integer references projects(id) on delete set null,
  created_by integer references users(id) on delete set null, updated_by integer references users(id) on delete set null,
  created integer not null, updated integer not null);

create table if not exists events(
  id integer primary key, title text not null, description text not null default '',
  starts_at integer not null, ends_at integer not null, location text not null default '', meeting_url text not null default '',
  created_by integer references users(id) on delete set null, created integer not null);
create table if not exists event_attendees(
  event_id integer not null references events(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade, status text not null default 'pending',
  primary key(event_id, user_id));

create table if not exists approvals(
  id integer primary key, title text not null, details text not null default '',
  requester_id integer not null references users(id) on delete cascade,
  approver_id integer not null references users(id) on delete cascade,
  status text not null default 'pending', decision_note text not null default '', created integer not null, decided integer);

create table if not exists notifications(
  id integer primary key, user_id integer not null references users(id) on delete cascade,
  text text not null, link text not null default '', read integer not null default 0, created integer not null);

create index if not exists idx_issues_project on issues(project_id);
create index if not exists idx_messages_channel on messages(channel_id, id);
create index if not exists idx_notifications_user on notifications(user_id, read);
`);

export const now = () => Date.now();

if (!db.prepare("select 1 from channels where kind='public' and name='general'").get()) {
  db.prepare("insert into channels(name, topic, kind, created) values('general', 'Company-wide announcements and chat', 'public', ?)").run(now());
}
