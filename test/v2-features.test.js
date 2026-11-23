// Schema v2 features in the browser engine (sql.js + lib/api.js): compatibility with v1 backups and
// synced snapshots, recorded daily scores, cancelled tasks, subtasks, completion history, project status.
// Fixtures in test/fixtures were produced by the previous version of the app (disposable sample data).
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

let SQL, createLocalBackend, createLocalStore, createCloudStore;
before(async () => {
  SQL = await require('sql.js')();
  ({ createLocalBackend } = await import('../web/local-backend.js'));
  ({ createLocalStore } = await import('../web/storage.js'));
  ({ createCloudStore } = await import('../web/cloud-store.js'));
});
const realNow = Date.now;
const atDay = (n) => { Date.now = () => realNow() + n * 86400000; }; // move the app's clock by n days
afterEach(() => { Date.now = realNow; });

const ME = 'auth0|v2tester';
const backend = (ls = new MemStorage()) => {
  const be = createLocalBackend({ userId: ME, storage: createLocalStore(ls), SQL, safetyBackup: () => 'safety.json' });
  be.ls = ls; return be;
};
const reload = (be) => { be.close(); return backend(be.ls); }; // a page refresh
const req = (be) => (m, p, b) => be.request(m, p, b);

test('a v1 backup imports with safe defaults, and exports/re-imports losslessly as v2', async () => {
  const v1 = fixture('v1-backup.json');
  assert.equal(v1.schema_version, 1);
  const be = backend(); const r = req(be);
  const pv = await r('POST', '/api/restore/preview', v1);
  assert.equal(pv.incoming.todos === undefined ? v1.tables.todos.length : pv.incoming.todos, v1.tables.todos.length);
  await r('POST', '/api/restore/apply', { token: pv.token });
  const out = await r('GET', '/api/backup');
  assert.equal(out.schema_version, 2);
  // Same records and ids.
  for (const t of ['todos', 'tasks', 'records', 'projects', 'assets', 'days']) {
    assert.deepEqual(out.tables[t].map(x => x.id ?? x.date), v1.tables[t].map(x => x.id ?? x.date), `ids kept in ${t}`);
  }
  // New fields get safe defaults.
  assert.ok(out.tables.todos.every(t => t.cancelled_on === null && t.cancelled_at === null), 'no task cancelled');
  assert.deepEqual(out.tables.subtasks, []);
  // Done tasks get a reconstructed completion on the day they were done (marked as backfill).
  const doneTodos = v1.tables.todos.filter(t => t.done);
  assert.deepEqual(out.tables.completions.map(c => [c.todo_id, c.done_on, c.source]).sort(), doneTodos.map(t => [t.id, t.done_on, 'backfill']).sort());
  // Past days that were set up get their score recorded once (backfill); none for days never set up.
  const today = (await r('GET', '/api/bootstrap')).today;
  const pastDays = v1.tables.days.map(d => d.date).filter(d => d < today);
  assert.deepEqual(out.tables.day_scores.filter(s => s.date < today).map(s => s.date).sort(), pastDays.sort());
  // Projects keep their status.
  assert.deepEqual((await r('GET', '/api/projects')).map(p => [p.name, p.status]).sort(), v1.tables.projects.map(p => [p.name, p.status]).sort());

  // v2 export → fresh account → identical data, and backfill doesn't duplicate anything.
  const be2 = backend(); const r2 = req(be2);
  const pv2 = await r2('POST', '/api/restore/preview', JSON.parse(JSON.stringify(out)));
  await r2('POST', '/api/restore/apply', { token: pv2.token });
  const again = await r2('GET', '/api/backup');
  for (const t of ['todos', 'subtasks', 'completions', 'day_scores', 'projects']) assert.deepEqual(again.tables[t], out.tables[t], `round trip ${t}`);
});

test('a v1 synced snapshot still loads through cloud sync and is upgraded', async () => {
  const snap = fixture('v1-snapshot.json');
  const ls = new MemStorage();
  const remote = {
    rows: { real: { rev: snap.rev, snapshot: snap } },
    async head(s) { return this.rows[s] ? { rev: this.rows[s].rev } : null; },
    async get(s) { return this.rows[s] ? JSON.parse(JSON.stringify(this.rows[s])) : null; },
    async save(s, exp, rev, snapshot) { if ((this.rows[s] && this.rows[s].rev) !== exp) return { status: 'conflict' }; this.rows[s] = { rev, snapshot }; return { status: 'ok', rev }; },
  };
  const store = createCloudStore({ ls, userId: ME, remote, localStore: createLocalStore(ls), timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} } });
  await store.init();
  const be = createLocalBackend({ userId: ME, storage: store, SQL, safetyBackup: () => 'x' });
  const d = await be.request('GET', '/api/today');
  assert.ok(d.todos.some(t => t.title === 'Still open from three days ago' && t.overdue), 'carried forward as overdue');
  assert.ok(d.todos.every(t => Array.isArray(t.subtasks)));
  await store.push();
  assert.equal(remote.rows.real.snapshot.schema_version, 2, 'upgraded snapshot synced');
  // Another device loads the upgraded snapshot.
  const ls2 = new MemStorage();
  const store2 = createCloudStore({ ls: ls2, userId: ME, remote, localStore: createLocalStore(ls2), timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} } });
  await store2.init();
  const be2 = createLocalBackend({ userId: ME, storage: store2, SQL, safetyBackup: () => 'x' });
  assert.deepEqual((await be2.request('GET', '/api/today')).todos.map(t => t.id), d.todos.map(t => t.id));
});

test('newer data is refused by an older format check instead of being silently truncated', async () => {
  const be = backend(); const r = req(be);
  const out = await r('GET', '/api/backup');
  await assert.rejects(r('POST', '/api/restore/preview', { ...out, schema_version: 99 }), /newer version/);
});

test('past days keep their recorded score after later deletion, cancellation and moves', async () => {
  const be = backend(); const r = req(be);
  atDay(-2);
  const d2 = (await r('GET', '/api/bootstrap')).today;
  const a = await r('POST', '/api/todos', { title: 'A', date: d2 });
  const b = await r('POST', '/api/todos', { title: 'B', date: d2 });
  await r('POST', '/api/todos', { title: 'C (left open)', date: d2 });
  await r('PUT', `/api/todos/${a.id}`, { done: true });
  const day2 = (await r('GET', '/api/today')).count;
  assert.equal(day2.custom.done, 1); assert.equal(day2.custom.total, 3);
  atDay(-1);
  await r('GET', '/api/today'); // the app is opened the next day
  atDay(0);
  await r('DELETE', `/api/todos/${a.id}`); // later deletion of a task completed that day
  const open = (await r('GET', '/api/today')).todos.find(t => t.title === 'C (left open)');
  await r('POST', `/api/todos/${open.id}/cancel`); // later cancellation
  await r('PUT', `/api/todos/${b.id}`, { title: 'B renamed' }); // later edit
  const past = (await r('GET', `/api/today?date=${d2}`)).dayScore;
  assert.deepEqual([past.done, past.total, past.pct], [day2.done, day2.total, day2.pct], 'day -2 score unchanged');
  const h = await r('GET', '/api/history/scores');
  assert.equal(h.days.find(x => x.date === d2).pct, day2.pct);
  const st = await r('GET', `/api/stats?from=${d2}&to=${d2}`);
  assert.equal(st.daily[0].overall, day2.pct, 'Stats agrees');
  // A day the app was never opened, with nothing recorded: No score recorded (null), not 0%.
  const never = (await r('GET', `/api/today?date=2020-01-01`));
  assert.equal(never.dayScore.pct, null); assert.equal(never.unrecorded, true); assert.equal(never.tasks.length, 0, 'not generated after the fact');
  // Correcting a past day on purpose (checking its task) does update that day.
  await r('PUT', `/api/todos/${b.id}`, { done: true, on: d2 }); // viewing day -2 and checking B there
  assert.equal((await r('GET', `/api/today?date=${d2}`)).dayScore.done, day2.done + 1, 'explicit correction of that day counts');
});

test('cancel: kept in history, out of active lists, Overdue, Next action and today’s score; reopen undoes it', async () => {
  const be = backend(); const r = req(be);
  atDay(-1);
  const y = (await r('GET', '/api/bootstrap')).today;
  const old = await r('POST', '/api/todos', { title: 'Overdue soon', date: y });
  await r('GET', '/api/today');
  atDay(0);
  const t = (await r('GET', '/api/bootstrap')).today;
  const own = await r('POST', '/api/todos', { title: 'Today task', date: t });
  let d = await r('GET', '/api/today');
  assert.ok(d.todos.find(x => x.id === old.id).overdue);
  const before = d.count;
  await r('POST', `/api/todos/${old.id}/cancel`);
  await r('POST', `/api/todos/${own.id}/cancel`);
  d = await r('GET', '/api/today');
  assert.ok(!d.todos.some(x => x.id === old.id || x.id === own.id), 'gone from active and Overdue');
  assert.deepEqual(d.cancelled.map(x => x.title).sort(), ['Overdue soon', 'Today task'], 'listed as Cancelled');
  assert.equal(d.count.custom.total, before.custom.total - 2, 'excluded from today’s score');
  assert.equal(d.count.total, before.total - 2);
  // Yesterday is not rewritten: the task still counted (open) there.
  const yd = await r('GET', `/api/today?date=${y}`);
  assert.ok(yd.todos.some(x => x.id === old.id)); assert.deepEqual([yd.dayScore.custom.done, yd.dayScore.custom.total], [0, 1]);
  // Not Done, not deleted.
  const row = (await r('GET', '/api/backup')).tables.todos.find(x => x.id === old.id);
  assert.equal(row.done, 0); assert.equal(row.cancelled_on, t);
  await assert.rejects(r('PUT', `/api/todos/${old.id}`, { done: true }), /cancelled/);
  await r('POST', `/api/todos/${old.id}/reopen`);
  d = await r('GET', '/api/today');
  assert.ok(d.todos.find(x => x.id === old.id).overdue, 'back in Overdue');
  assert.equal(d.count.custom.total, before.custom.total - 1);
  // Survives a refresh.
  const fresh = reload(be);
  assert.deepEqual((await fresh.request('GET', '/api/today')).cancelled.map(x => x.title), ['Today task']);
});

test('subtasks: add/edit/remove, progress, parent Done choices, not counted in the score, kept through refresh and backup', async () => {
  let be = backend(); let r = req(be);
  const t = (await r('GET', '/api/bootstrap')).today;
  const p = await r('POST', '/api/todos', { title: 'Launch page', date: t });
  const q = await r('POST', '/api/todos', { title: 'Write post', date: t });
  const s = [];
  for (const title of ['Copy', 'Images', 'SEO', 'Deploy']) s.push(await r('POST', `/api/todos/${p.id}/subtasks`, { title }));
  await r('PUT', `/api/subtasks/${s[0].id}`, { done: true });
  await r('PUT', `/api/subtasks/${s[1].id}`, { title: 'Images (final)', done: true });
  await r('DELETE', `/api/subtasks/${s[3].id}`);
  let d = await r('GET', '/api/today');
  let parent = d.todos.find(x => x.id === p.id);
  assert.deepEqual([parent.sub_done, parent.subtasks.length], [2, 3]);
  assert.equal(parent.subtasks[1].title, 'Images (final)');
  assert.equal(d.count.custom.total, 2, 'subtasks are not separate tasks in the score');
  assert.equal(d.todos.length, 2, 'no extra top-level tasks');
  // Parent only: open subtasks stay open.
  await r('PUT', `/api/todos/${p.id}`, { done: true, subtasks: 'parent' });
  parent = (await r('GET', '/api/today')).todos.find(x => x.id === p.id);
  assert.equal(parent.done, 1); assert.equal(parent.sub_done, 2);
  // Complete all: reopen, then Done with all subtasks.
  await r('PUT', `/api/todos/${p.id}`, { done: false });
  await r('PUT', `/api/todos/${p.id}`, { done: true, subtasks: 'all' });
  d = await r('GET', '/api/today');
  parent = d.todos.find(x => x.id === p.id);
  assert.equal(parent.sub_done, 3);
  assert.equal(d.count.custom.done, 1);
  // Refresh + backup/import keep statuses.
  be = reload(be); r = req(be);
  const exported = await r('GET', '/api/backup');
  const other = backend(); const r2 = req(other);
  const pv = await r2('POST', '/api/restore/preview', JSON.parse(JSON.stringify(exported)));
  await r2('POST', '/api/restore/apply', { token: pv.token });
  const imported = (await r2('GET', '/api/today')).todos;
  assert.deepEqual(imported.map(x => [x.id, x.done, x.subtasks.map(st => [st.title, st.done])]),
    (await r('GET', '/api/today')).todos.map(x => [x.id, x.done, x.subtasks.map(st => [st.title, st.done])]));
  void q;
});

test('completion history: grouped by the day marked Done, survives edits/deletion, subtasks under their parent', async () => {
  const be = backend(); const r = req(be);
  atDay(-1);
  const mon = (await r('GET', '/api/bootstrap')).today;
  const late = await r('POST', '/api/todos', { title: 'Due Monday', date: mon });
  const same = await r('POST', '/api/todos', { title: 'Done Monday', date: mon });
  await r('PUT', `/api/todos/${same.id}`, { done: true });
  const par = await r('POST', '/api/todos', { title: 'Parent', date: mon });
  const st = await r('POST', `/api/todos/${par.id}/subtasks`, { title: 'Child step' });
  atDay(0);
  const tue = (await r('GET', '/api/bootstrap')).today;
  await r('PUT', `/api/todos/${late.id}`, { done: true }); // completed Tuesday
  await r('PUT', `/api/subtasks/${st.id}`, { done: true }); // subtask done Tuesday, parent not done
  let h = await r('GET', `/api/history/completions?date=${tue}`);
  assert.deepEqual(h.items.filter(i => i.kind === 'todo').map(i => i.title), ['Due Monday']);
  assert.equal(h.count, h.items.filter(i => i.kind !== 'parent').length);
  const parentGroup = h.items.find(i => i.kind === 'parent');
  assert.deepEqual([parentGroup.title, parentGroup.subtasks.map(s => s.title)], ['Parent', ['Child step']], 'subtask under its parent, not counted');
  assert.ok(h.items.find(i => i.title === 'Due Monday').done_at, 'completion time');
  const m = await r('GET', `/api/history/completions?date=${mon}`);
  assert.deepEqual(m.items.filter(i => i.kind === 'todo').map(i => i.title), ['Done Monday']);
  // Deleting and renaming later keeps the record.
  await r('DELETE', `/api/todos/${same.id}`);
  const m2 = await r('GET', `/api/history/completions?date=${mon}`);
  assert.deepEqual(m2.items.filter(i => i.kind === 'todo').map(i => [i.title, i.deleted]), [['Done Monday', true]]);
  // Reopening removes it (it is no longer completed).
  await r('PUT', `/api/todos/${late.id}`, { done: false });
  h = await r('GET', `/api/history/completions?date=${tue}`);
  assert.ok(!h.items.some(i => i.title === 'Due Monday'));
  // Survives export/import.
  const out = await r('GET', '/api/backup');
  const be2 = backend(); const r2 = req(be2);
  const pv = await r2('POST', '/api/restore/preview', JSON.parse(JSON.stringify(out)));
  await r2('POST', '/api/restore/apply', { token: pv.token });
  assert.deepEqual(await r2('GET', `/api/history/completions?date=${mon}`), m2);
});

test('completion history of old data: reconstructed where possible, otherwise “not available”', async () => {
  const be = backend(); const r = req(be);
  const pv = await r('POST', '/api/restore/preview', fixture('v1-backup.json'));
  await r('POST', '/api/restore/apply', { token: pv.token });
  const v1 = fixture('v1-backup.json');
  const lateTodo = v1.tables.todos.find(t => t.title === 'Due day -3, completed day -2');
  const h = await r('GET', `/api/history/completions?date=${lateTodo.done_on}`);
  assert.ok(h.items.some(i => i.title === lateTodo.title), 'grouped by its done day');
  assert.notEqual(lateTodo.done_on, lateTodo.date);
  assert.equal(h.history, h.date >= h.log_since ? 'complete' : 'partial');
  const none = await r('GET', '/api/history/completions?date=2019-06-01');
  assert.deepEqual([none.history, none.count], ['none', 0]);
});

test('project status changes on its own and persists through refresh and backup', async () => {
  let be = backend(); let r = req(be);
  const p = await r('POST', '/api/projects', { name: 'Shop', status: 'idea', notes: 'keep me' });
  await r('PUT', `/api/projects/${p.id}`, { status: 'in_progress' });
  be = reload(be); r = req(be);
  const got = (await r('GET', '/api/projects')).find(x => x.id === p.id);
  assert.deepEqual([got.status, got.notes], ['in_progress', 'keep me']);
  await assert.rejects(r('PUT', `/api/projects/${p.id}`, { status: 'planned_date' }), /date/i, 'a scheduled status needs a date');
  await r('PUT', `/api/projects/${p.id}`, { status: 'planned_date', planned_for: '2027-02' });
  const out = await r('GET', '/api/backup');
  assert.equal(out.tables.projects.find(x => x.id === p.id).status, 'planned_date');
});

test('reading Today does not create a new revision (sync stays quiet)', async () => {
  const be = backend(); const r = req(be);
  await r('GET', '/api/today');
  const rev = be.ls.getItem('dash.v1.u.' + encodeURIComponent(ME) + '.real.rev');
  await r('GET', '/api/today'); await r('GET', '/api/history/scores');
  assert.equal(be.ls.getItem('dash.v1.u.' + encodeURIComponent(ME) + '.real.rev'), rev);
});
