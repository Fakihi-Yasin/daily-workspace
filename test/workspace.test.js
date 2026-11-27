// Personal workspace customization (lib/workspace.js) in the browser engine (sql.js + lib/api.js):
// an existing account keeps its data and layout; a new student starts blank; layout, categories,
// repeating tasks, calendar and saved views are per account and private.
const { test, before } = require('node:test');
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
let SQL, createLocalBackend, createLocalStore;
before(async () => {
  SQL = await require('sql.js')();
  ({ createLocalBackend } = await import('../web/local-backend.js'));
  ({ createLocalStore } = await import('../web/storage.js'));
});
const backend = (user, ls = new MemStorage()) => {
  const be = createLocalBackend({ userId: user, storage: createLocalStore(ls), SQL, safetyBackup: () => 'safety.json' });
  be.ls = ls; be.user = user; return be;
};
const reload = (be) => { be.close(); return backend(be.user, be.ls); };
const req = (be) => (m, p, b) => be.request(m, p, b);
const shown = (part) => part.order.filter(k => !part.hidden.includes(k));

test('an existing account (classic setup) keeps all its data and exactly its layout, sites & social sections included', async () => {
  const v1 = fixture('v1-backup.json');
  const be = backend('auth0|owner'); const r = req(be);
  const pv = await r('POST', '/api/restore/preview', v1);
  await r('POST', '/api/restore/apply', { token: pv.token });
  const before = await r('GET', '/api/backup');
  const again = reload(be); const r2 = req(again);
  const after = await r2('GET', '/api/backup');
  for (const t of ['assets', 'routines', 'tasks', 'records', 'categories', 'projects', 'todos', 'days']) {
    assert.deepEqual(after.tables[t].map(x => x.id ?? x.date), before.tables[t].map(x => x.id ?? x.date), `${t} kept`);
    assert.equal(after.tables[t].length, v1.tables[t].length, `${t}: same count as the original`);
  }
  assert.deepEqual(after.tables.categories.map(c => c.name), v1.tables.categories.map(c => c.name), 'category names unchanged');
  assert.ok(after.tables.categories.every(c => c.archived === 0), 'nothing archived');
  const ws = await r2('GET', '/api/workspace');
  assert.deepEqual(ws.onboarding, { pending: false, setup: null }, 'no first-login screen for an existing account');
  assert.equal(ws.layout.sites, true, 'Blogging, IPTV, Facebook, Instagram, Pinterest stay');
  assert.deepEqual(shown(ws.layout.home), ['focus', 'tasks', 'routines', 'score', 'next', 'sessions', 'pctime'], 'the same Today as before');
  assert.deepEqual(shown(ws.layout.nav), ['projects', 'learning', 'challenges', 'teams', 'stats'], 'the same sidebar as before');
  assert.equal(ws.layout.customized, false);
  // Its routines (sites, Pinterest, social) still run.
  const today = await r2('GET', '/api/today');
  assert.ok(today.tasks.length > 0, 'routine checklist still generated');
});

test('a new student starts blank, skips or picks Study, and customizes sections and sidebar; it survives a reload', async () => {
  const be = backend('auth0|student'); const r = req(be);
  let ws = await r('GET', '/api/workspace');
  assert.equal(ws.onboarding.pending, true);
  assert.deepEqual((await r('GET', '/api/categories')).map(c => c.name), ['Other']);
  await r('POST', '/api/workspace/setup', { setup: 'blank' });
  ws = await r('GET', '/api/workspace');
  assert.deepEqual(ws.onboarding, { pending: false, setup: 'blank' });
  assert.deepEqual((await r('GET', '/api/categories')).map(c => c.name), ['Other'], 'Start blank: nothing created');
  assert.equal((await r('GET', '/api/today')).todos.length, 0, 'no sample tasks');
  // Show, hide and reorder.
  await r('PUT', '/api/workspace/layout', { home: { order: ['calendar', 'tasks', 'projects', 'focus'], hidden: ['focus', 'projects'] },
    nav: { order: ['stats', 'teams', 'projects'], hidden: ['learning', 'challenges'] } });
  const be2 = reload(be); const r2 = req(be2);
  ws = await r2('GET', '/api/workspace');
  assert.deepEqual(shown(ws.layout.home).slice(0, 2), ['calendar', 'tasks']);
  assert.ok(ws.layout.home.hidden.includes('projects') && ws.layout.home.hidden.includes('focus'));
  assert.deepEqual(shown(ws.layout.nav).slice(0, 3), ['stats', 'teams', 'projects']);
  assert.equal(ws.layout.sites, false);
  // Unknown keys are ignored; reset goes back to the defaults.
  await r2('PUT', '/api/workspace/layout', { home: { order: ['tasks', 'hack'], hidden: ['<script>'] } });
  ws = await r2('GET', '/api/workspace');
  assert.ok(!ws.layout.home.order.includes('hack') && !ws.layout.home.hidden.includes('<script>'));
  ws = { layout: await r2('POST', '/api/workspace/layout/reset') };
  assert.deepEqual(shown(ws.layout.home), ['tasks', 'projects', 'calendar']);
  // Another account on the same browser has its own layout.
  const other = backend('auth0|someone-else', be2.ls);
  const wo = await req(other)('GET', '/api/workspace');
  assert.equal(wo.layout.customized, false);
  assert.equal(wo.onboarding.pending, true);
});

test('categories: type one while adding a task or project; suggestions; rename and archive keep old tasks', async () => {
  const be = backend('auth0|freelancer'); const r = req(be);
  const day = (await r('GET', '/api/bootstrap')).today;
  const t1 = await r('POST', '/api/todos', { title: 'Invoice ACME', category_name: 'Clients' });
  const t2 = await r('POST', '/api/todos', { title: 'Call ACME', category_name: ' clients ' }); // same one, case ignored
  assert.equal(t1.category_id, t2.category_id);
  const p = await r('POST', '/api/projects', { name: 'ACME site', category_name: 'Work', status: 'in_progress' });
  let cats = await r('GET', '/api/categories');
  assert.deepEqual(cats.map(c => c.name), ['Clients', 'Work', 'Other']);
  // Rename: tasks follow the category.
  const clients = cats.find(c => c.name === 'Clients');
  await r('PUT', `/api/categories/${clients.id}`, { name: 'Customers', color: clients.color, coding: true });
  let todos = (await r('GET', '/api/today')).todos;
  assert.ok(todos.filter(t => t.category_id === clients.id).length === 2);
  // Archive: hidden from pickers (archived flag), still on the old tasks and project.
  await r('PUT', `/api/categories/${clients.id}/archive`, { archived: true });
  const work = cats.find(c => c.name === 'Work');
  await r('PUT', `/api/categories/${work.id}/archive`, { archived: true });
  cats = await r('GET', '/api/categories');
  assert.deepEqual(cats.filter(c => c.archived).map(c => c.name).sort(), ['Customers', 'Work']);
  todos = (await r('GET', '/api/today')).todos;
  assert.equal(todos.filter(t => t.category_id === clients.id).length, 2, 'old tasks keep it');
  assert.equal((await r('GET', '/api/projects')).find(x => x.id === p.id).category_id, work.id);
  await assert.rejects(r('PUT', `/api/categories/${cats.find(c => c.name === 'Other').id}/archive`, { archived: true }), /can’t be archived/);
  // Typing an archived name brings it back instead of duplicating.
  await r('POST', '/api/todos', { title: 'New lead', category_name: 'customers' });
  assert.equal((await r('GET', '/api/categories')).find(c => c.id === clients.id).archived, 0);
  // Clear / change a task's category; unknown ids refused.
  await r('PUT', `/api/todos/${t1.id}`, { category_id: null });
  assert.equal((await r('GET', '/api/today')).todos.find(t => t.id === t1.id).category_id, null);
  await assert.rejects(r('PUT', `/api/todos/${t1.id}`, { category_id: 9999 }), /Unknown category/);
  assert.ok(day);
});

test('three accounts: private workspace customization stays separate from a shared team', async () => {
  const { createDb, claimsFor } = await import('./support/supabase-pg.mjs');
  const ownerId = 'auth0|workspace-owner';
  const studentId = 'auth0|workspace-student';
  const memberId = 'auth0|workspace-member';
  const pg = await createDb({
    afterMigration: async (file, db) => {
      if (file.startsWith('20261124000000')) {
        await db.query('select app_private.bootstrap_super_admin($1)', [ownerId]);
      }
    },
  });
  const storage = new MemStorage();
  const accounts = [ownerId, studentId, memberId].map((id, i) => ({
    be: backend(id, storage),
    claims: claimsFor(id, { email: `workspace-${i}@example.test` }),
  }));
  const [owner, student, member] = accounts;
  const rpc = (account, name, args) => pg.rpc(account.claims, name, args);
  try {
    for (const account of accounts) await rpc(account, 'register_me');
    const r = req(owner.be);
    const preview = await r('POST', '/api/restore/preview', fixture('v1-backup.json'));
    await r('POST', '/api/restore/apply', { token: preview.token });
    const privateTask = 'Owner private task';
    await r('POST', '/api/todos', { title: privateTask, category_name: 'Owner private category' });
    assert.equal((await r('GET', '/api/workspace')).layout.sites, true);
    assert.deepEqual((await rpc(owner, 'my_access')).features, ['pc_time']);

    const studentRequest = req(student.be);
    await studentRequest('POST', '/api/workspace/setup', { setup: 'blank' });
    assert.deepEqual((await studentRequest('GET', '/api/today')).todos, []);
    await studentRequest('PUT', '/api/workspace/layout', {
      home: { order: ['calendar', 'tasks', 'projects'], hidden: ['projects'] },
    });
    assert.equal((await rpc(student, 'my_access')).role, 'admin');
    assert.equal((await req(member.be)('GET', '/api/workspace')).layout.customized, false);
    assert.equal((await r('GET', '/api/workspace')).layout.customized, false);

    const team = await rpc(owner, 'team_create', { p_name: 'Shared team' });
    const invite = await rpc(owner, 'team_invite_create', {
      p_team_id: team.id, p_email: 'workspace-2@example.test',
    });
    await rpc(member, 'my_invite_accept', { p_invite_id: invite.id });
    await rpc(owner, 'team_category_save', { p_team_id: team.id, p_id: null, p_name: 'Team category' });
    const board = await rpc(member, 'team_get', { p_team_id: team.id });
    assert.deepEqual(board.categories.map(c => c.name), ['Team category']);
    assert.deepEqual(board.tasks, []);
    assert.equal(JSON.stringify(board).includes(privateTask), false);
    assert.deepEqual((await req(member.be)('GET', '/api/categories')).map(c => c.name), ['Other']);
    await assert.rejects(rpc(member, 'team_member_directory'), /super_admin_required/);
    await assert.rejects(rpc(member, 'pc_device_list'), /feature_not_available/);
  } finally {
    for (const account of accounts) account.be.close();
    await pg.close();
  }
});

test('repeating tasks: completing one schedules the next (once); reopening takes it back', async () => {
  const be = backend('auth0|routine'); const r = req(be);
  const today = (await r('GET', '/api/bootstrap')).today;
  const t = await r('POST', '/api/todos', { title: 'Weekly report', repeat: 'weekly', category_name: 'Work' });
  await r('PUT', `/api/todos/${t.id}`, { done: true });
  const all = (await r('GET', '/api/backup')).tables.todos;
  const next = all.filter(x => x.title === 'Weekly report' && x.id !== t.id);
  assert.equal(next.length, 1);
  assert.equal(next[0].date > today, true);
  assert.deepEqual([next[0].repeat, next[0].category_id, next[0].series_id], ['weekly', t.category_id, t.id]);
  // Undo + redo doesn't create a second one.
  await r('PUT', `/api/todos/${t.id}`, { done: false });
  assert.equal((await r('GET', '/api/backup')).tables.todos.filter(x => x.title === 'Weekly report').length, 1, 'untouched next one removed');
  await r('PUT', `/api/todos/${t.id}`, { done: true });
  await r('PUT', `/api/todos/${t.id}`, { done: true });
  assert.equal((await r('GET', '/api/backup')).tables.todos.filter(x => x.title === 'Weekly report').length, 2);
  // Monthly deadline on the 31st → last day of next month; weekdays skip the weekend.
  const W = require('../lib/workspace');
  assert.equal(W.nextDate('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(W.nextDate('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(W.nextDate('2026-11-27', 'weekdays'), '2026-11-30'); // Friday → Monday
  await assert.rejects(r('PUT', `/api/todos/${t.id}`, { repeat: 'hourly' }), /Unknown repeat/);
});

test('calendar and saved views: due this week, overdue, by category (Exams)', async () => {
  const be = backend('auth0|student2'); const r = req(be);
  await r('POST', '/api/workspace/setup', { setup: 'study' });
  const today = (await r('GET', '/api/bootstrap')).today;
  const add = (o) => r('POST', '/api/todos', o);
  const D = require('../lib/dates');
  await add({ title: 'Maths exam', date: D.addDays(today, 3), category_name: 'Exams' });
  await add({ title: 'History essay', date: D.addDays(today, 1), category_name: 'Assignments' });
  await add({ title: 'Late lab report', date: D.addDays(today, -2), category_name: 'Assignments' });
  await add({ title: 'Final exam', date: D.addDays(today, 40), category_name: 'Exams' });
  await r('POST', '/api/projects', { name: 'Thesis', status: 'planned_date', planned_for: D.addDays(today, 5), category_name: 'Courses' });
  const ag = await r('GET', '/api/agenda?days=14');
  assert.equal(ag.overdue, 1);
  assert.deepEqual(ag.days.flatMap(d => d.tasks.map(t => t.title)), ['History essay', 'Maths exam']);
  assert.deepEqual(ag.days.flatMap(d => d.projects.map(p => p.name)), ['Thesis']);
  const exams = (await r('GET', '/api/workspace')).layout.views.find(v => v.name === 'Exams');
  const ex = await r('GET', `/api/views/tasks?range=all&category_id=${exams.category_id}`);
  assert.deepEqual(ex.map(t => t.title), ['Maths exam', 'Final exam']);
  assert.deepEqual((await r('GET', '/api/views/tasks?range=overdue')).map(t => t.title), ['Late lab report']);
  const week = (await r('GET', '/api/views/tasks?range=week')).map(t => t.title);
  assert.ok(week.includes('Late lab report') && !week.includes('Final exam'));
  // Custom saved view, kept in this account's settings.
  const views = [...(await r('GET', '/api/workspace')).layout.views, { name: 'Assignments due', range: 'week', category_id: ex[0].category_id }];
  await r('PUT', '/api/workspace/layout', { views });
  assert.ok((await r('GET', '/api/workspace')).layout.views.some(v => v.name === 'Assignments due'));
});

test('personal task creation stores its optional subtasks atomically and reloads them', async () => {
  const be = backend('auth0|draft-subtasks');
  const r = req(be);
  const t = await r('POST','/api/todos',{title:'Personal checklist',subtasks:['First','Second']});
  assert.deepEqual(t.subtasks.map(s=>s.title),['First','Second']);
  await assert.rejects(r('POST','/api/todos',{title:'Invalid personal task',subtasks:['Valid','']}), /Use up to 30 subtasks/);
  const after = await req(reload(be))('GET','/api/today');
  assert.ok(!after.todos.some(t=>t.title==='Invalid personal task'));
  assert.deepEqual(after.todos.find(x=>x.id===t.id).subtasks.map(s=>s.title),['First','Second']);
});
