// Browser-build storage: per-user isolation, persistence, localhost → browser import, two tabs.
// Runs the real in-browser backend (sql.js + lib/api.js) in Node with an in-memory localStorage.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.quota && String(v).length > this.quota) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

let SQL, createLocalBackend, createLocalStore;
before(async () => {
  SQL = await require('sql.js')();
  ({ createLocalBackend } = await import('../web/local-backend.js'));
  ({ createLocalStore } = await import('../web/storage.js'));
});

const A_ID = 'auth0|aaaaaaaaaaaaaaaaaaaaaaaa';
const B_ID = 'auth0|bbbbbbbbbbbbbbbbbbbbbbbb';
const backendFor = (ls, userId) => createLocalBackend({ userId, storage: createLocalStore(ls), SQL, safetyBackup: () => 'test-safety' });
const counts = async (be) => {
  const d = await be.request('GET', '/api/backup');
  return Object.fromEntries(['assets', 'records', 'projects', 'sessions', 'courses', 'challenges', 'videos'].map(t => [t, d.tables[t].length]));
};

test('accounts are isolated; data survives a reload; switching back finds it again', async () => {
  const ls = new MemStorage();
  let a = backendFor(ls, A_ID);
  const { id: assetId } = await a.request('POST', '/api/assets', { kind: 'pinterest', name: 'A pins', from_date: (await a.request('GET', '/api/bootstrap')).today });
  const day = await a.request('GET', '/api/today');
  const pinTask = day.tasks.find(t => t.unit === 'pin');
  await a.request('POST', `/api/tasks/${pinTask.id}/mark`, { kind: 'pin', idx: 1, asset_id: assetId, done: true });
  await a.request('POST', '/api/projects', { name: 'A secret project', status: 'idea' });
  a.close(); // sign out

  const b = backendFor(ls, B_ID); // sign in as B in the same browser
  const bc = await counts(b);
  assert.deepEqual(bc, { assets: 0, records: 0, projects: 0, sessions: 0, courses: 0, challenges: 0, videos: 0 }, 'B starts empty');
  assert.ok(!(await b.request('GET', '/api/projects')).some(p => p.name === 'A secret project'));
  await b.request('POST', '/api/projects', { name: 'B project', status: 'idea' });
  b.close();

  a = backendFor(ls, A_ID); // back to A (fresh page load)
  const ac = await counts(a);
  assert.equal(ac.assets, 1); assert.equal(ac.records, 1);
  const names = (await a.request('GET', '/api/projects')).map(p => p.name);
  assert.deepEqual(names, ['A secret project'], 'A sees only A’s project');
  const t = (await a.request('GET', '/api/today')).tasks.find(x => x.unit === 'pin');
  assert.equal(t.progress.done, 1, 'checked Pin still there');
  // Storage keys are scoped by user id; nothing unscoped is written.
  for (const k of ls.m.keys()) assert.ok(k.startsWith('dash.v1.u.'), 'unexpected key ' + k);
});

test('a new account never picks up other or unscoped data in the browser', async () => {
  const ls = new MemStorage();
  ls.setItem('dash.v1.legacy', '{"tables":{}}');
  ls.setItem('tableau', 'old');
  await backendFor(ls, A_ID).request('POST', '/api/projects', { name: 'Only A', status: 'idea' });
  const c = backendFor(ls, 'google-oauth2|cccc');
  assert.equal((await counts(c)).projects, 0);
});

test('backup exported from the localhost server imports into a browser account (preview first, ids kept)', async () => {
  // Build a localhost dataset with the Node server code.
  process.removeAllListeners('warning');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-local-'));
  const { open } = require('../lib/db');
  const API = require('../lib/api');
  const db = open(path.join(dir, 'tableau.sqlite'));
  API.ensureDefaults(db);
  const ctx = { db: () => db, source: 'localhost' };
  const call = (method, p, b) => API.handle(ctx, { method }, new URL(p, 'http://x'), b || {});
  const today = (await call('GET', '/api/bootstrap')).today;
  await call('POST', '/api/assets', { kind: 'site_iptv', name: 'Canada', from_date: today });
  await call('POST', '/api/projects', { name: 'IPTV Belgium', status: 'in_progress', milestones: ['Domain', 'Design'] });
  const s = await call('POST', '/api/session/start', { task_label: 'Pricing page', duration_sec: 1800 });
  await call('POST', `/api/session/${s.id}/finish`);
  const exported = JSON.parse(JSON.stringify(await call('GET', '/api/backup'))); // what the download contains
  assert.equal(exported.exported_from, 'localhost'); assert.equal(exported.format_version, 1);

  const ls = new MemStorage();
  const a = backendFor(ls, A_ID);
  const pv = await a.request('POST', '/api/restore/preview', exported);
  assert.equal(pv.current.projects, 0); assert.equal(pv.incoming.projects, 1);
  assert.equal((await counts(a)).projects, 0, 'preview replaces nothing');
  const r = await a.request('POST', '/api/restore/apply', { token: pv.token });
  assert.equal(r.safety_backup, 'test-safety');
  const back = await a.request('GET', '/api/backup');
  for (const t of ['assets', 'projects', 'milestones', 'sessions', 'routines', 'categories']) {
    assert.deepEqual(back.tables[t].map(x => x.id), exported.tables[t].map(x => x.id), `ids kept in ${t}`);
  }
  assert.equal(back.dataset_id, exported.dataset_id, 'dataset id carried over');
  assert.equal(back.tables.sessions[0].task_label, 'Pricing page');
  // Persisted for the next visit, and still invisible to B.
  assert.equal((await counts(backendFor(ls, A_ID))).projects, 1);
  assert.equal((await counts(backendFor(ls, B_ID))).projects, 0);
  // Re-export from the browser and import again: lossless round trip.
  const again = await backendFor(ls, B_ID).request('POST', '/api/restore/preview', back);
  assert.equal(again.incoming.sessions, 1);
});

test('two tabs of the same account do not overwrite each other', async () => {
  const ls = new MemStorage();
  const tab1 = backendFor(ls, A_ID), tab2 = backendFor(ls, A_ID);
  await tab1.request('GET', '/api/today'); await tab2.request('GET', '/api/today');
  await tab1.request('POST', '/api/projects', { name: 'From tab 1', status: 'idea' });
  await tab2.request('POST', '/api/projects', { name: 'From tab 2', status: 'idea' });
  const names = (await backendFor(ls, A_ID).request('GET', '/api/projects')).map(p => p.name).sort();
  assert.deepEqual(names, ['From tab 1', 'From tab 2']);
});

test('a full browser storage reports an error instead of failing silently', async () => {
  const ls = new MemStorage();
  const a = backendFor(ls, A_ID);
  await a.request('GET', '/api/today');
  ls.quota = 10;
  await assert.rejects(a.request('POST', '/api/projects', { name: 'Big', status: 'idea' }), /storage is full/i);
});

test('timer state survives a reload in the browser build', async () => {
  const ls = new MemStorage();
  const a = backendFor(ls, A_ID);
  const s = await a.request('POST', '/api/session/start', { task_label: 'Long', duration_sec: 86400 });
  const again = await backendFor(ls, A_ID).request('GET', '/api/session');
  assert.equal(again.session.id, s.id); assert.equal(again.session.planned_sec, 86400); assert.equal(again.session.state, 'running');
});

test('one-off tasks are saved per account and per date in the browser build', async () => {
  const ls = new MemStorage();
  const a = backendFor(ls, A_ID);
  const today = (await a.request('GET', '/api/bootstrap')).today;
  const t = await a.request('POST', '/api/todos', { title: 'Fix DMCA', date: today });
  await a.request('PUT', `/api/todos/${t.id}`, { done: true });
  const again = await backendFor(ls, A_ID).request('GET', '/api/today');
  assert.deepEqual(again.todos.map(x => [x.title, x.done]), [['Fix DMCA', 1]]);
  assert.equal(again.count.custom.done, 1);
  assert.equal((await backendFor(ls, B_ID).request('GET', '/api/today')).todos.length, 0, 'B never sees A’s tasks');
});

test('planning categories: a Pinterest project with no URL adds no account and no routine tasks', async () => {
  const a = backendFor(new MemStorage(), A_ID);
  const cats = await a.request('GET', '/api/categories');
  const names = cats.map(c => c.name);
  for (const n of ['YouTube', 'Instagram', 'Facebook', 'Pinterest']) assert.equal(names.filter(x => x === n).length, 1, n);
  assert.equal(names.at(-1), 'Other');
  const before = (await a.request('GET', '/api/today')).tasks.length;
  const pin = cats.find(c => c.name === 'Pinterest').id;
  await a.request('POST', '/api/projects', { name: 'Start a Pinterest account', category_id: pin, status: 'planned', links: [] });
  const p = (await a.request('GET', '/api/projects')).find(x => x.name === 'Start a Pinterest account');
  assert.equal(p.category_id, pin); assert.equal(p.status, 'planned'); assert.deepEqual(p.links, []);
  assert.equal((await a.request('GET', '/api/assets')).length, 0);
  assert.equal((await a.request('GET', '/api/today')).tasks.length, before);
});
