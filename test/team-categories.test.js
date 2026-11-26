// Team categories (owner-managed, separate from personal ones), "My team tasks", feature grants and
// the single Super Admin — against the real SQL in PGlite (test/support/supabase-pg.mjs).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let pg, claimsFor;
const SA = 'auth0|tcsuper000000000000000';
const OWN = 'auth0|tcowner000000000000000';
const MEM = 'auth0|tcmember00000000000000';
const OUT = 'auth0|tcoutsider000000000000';
const who = {};
const call = (as, fn, args) => pg.rpc(who[as] || as, fn, args);
async function refused(p, re) { await assert.rejects(p, (e) => { assert.match(e.message, re); return true; }); }

before(async () => {
  const m = await import('./support/supabase-pg.mjs');
  claimsFor = m.claimsFor;
  pg = await m.createDb();
  who.SA = claimsFor(SA, { email: 'boss@example.test', name: 'Boss' });
  who.OWN = claimsFor(OWN, { email: 'own@example.test', name: 'Owner' });
  who.MEM = claimsFor(MEM, { email: 'mem@example.test', name: 'Member' });
  who.OUT = claimsFor(OUT, { email: 'out@example.test', name: 'Outsider' });
  for (const k of ['SA', 'OWN', 'MEM', 'OUT']) await call(k, 'register_me');
  await pg.admin('select app_private.bootstrap_super_admin($1)', [SA]);
});
after(() => pg && pg.close());

let T, T2, cDesign, cOps;
test('team categories: the owner creates, renames and archives them; members and others cannot', async () => {
  T = (await call('OWN', 'team_create', { p_name: 'Studio' })).id;
  T2 = (await call('OWN', 'team_create', { p_name: 'Other' })).id;
  const inv = await call('OWN', 'team_invite_create', { p_team_id: T, p_email: 'mem@example.test' });
  await call('MEM', 'my_invite_accept', { p_invite_id: inv.id });
  cDesign = (await call('OWN', 'team_category_save', { p_team_id: T, p_id: null, p_name: 'Design', p_color: 'pink' })).id;
  cOps = (await call('OWN', 'team_category_save', { p_team_id: T, p_id: null, p_name: 'Ops' })).id;
  await assert.rejects(call('OWN', 'team_category_save', { p_team_id: T, p_id: null, p_name: ' design ' }), (e) => /already has a category/.test(e.message) && e.code === 'PT409');
  await refused(call('MEM', 'team_category_save', { p_team_id: T, p_id: null, p_name: 'Mine' }), /Only the team owner/);
  await refused(call('MEM', 'team_category_archive', { p_id: cOps, p_archived: true }), /Only the team owner/);
  await refused(call('OUT', 'team_category_save', { p_team_id: T, p_id: null, p_name: 'x' }), /Team not found/);
  await refused(call('SA', 'team_category_save', { p_team_id: T, p_id: null, p_name: 'x' }), /Only the team owner/);
  const renamed = await call('OWN', 'team_category_save', { p_team_id: T, p_id: cDesign, p_name: 'Design & UX', p_color: 'pink' });
  assert.equal(renamed.name, 'Design & UX');
  const g = await call('MEM', 'team_get', { p_team_id: T });
  assert.deepEqual(g.categories.map(c => [c.name, c.archived]), [['Design & UX', false], ['Ops', false]]);
});

test('tasks use only their own team’s active categories; archiving keeps them on old tasks', async () => {
  const k1 = (await call('MEM', 'team_task_create', { p_team_id: T, p_title: 'Logo', p_category_id: cDesign })).id;
  const k2 = (await call('OWN', 'team_task_create', { p_team_id: T, p_title: 'Deploy', p_category_id: cOps, p_assignee_id: MEM })).id;
  // Another team's category, or a made-up id, is refused.
  const foreign = (await call('OWN', 'team_category_save', { p_team_id: T2, p_id: null, p_name: 'Elsewhere' })).id;
  await refused(call('OWN', 'team_task_create', { p_team_id: T, p_title: 'x', p_category_id: foreign }), /this team's categories/);
  await refused(call('MEM', 'team_task_update', { p_task_id: k1, p_patch: { category_id: foreign } }), /this team's categories/);
  await refused(call('MEM', 'team_task_update', { p_task_id: k1, p_patch: { category_id: 'not-a-uuid' } }), /this team's categories/);
  // Member: only on tasks they created; on a task assigned to them, status only (unchanged rule).
  await call('MEM', 'team_task_update', { p_task_id: k1, p_patch: { category_id: cOps } });
  await refused(call('MEM', 'team_task_update', { p_task_id: k2, p_patch: { category_id: cDesign } }), /assigned to you/);
  // Archive Ops: still on its tasks, can't be picked for new ones, can be unarchived.
  await call('OWN', 'team_category_archive', { p_id: cOps, p_archived: true });
  let g = await call('OWN', 'team_get', { p_team_id: T });
  assert.deepEqual(g.tasks.map(k => [k.title, k.category_id]).sort(), [['Deploy', cOps], ['Logo', cOps]]);
  assert.equal(g.categories.find(c => c.id === cOps).archived, true);
  await refused(call('OWN', 'team_task_create', { p_team_id: T, p_title: 'y', p_category_id: cOps }), /this team's categories/);
  await call('OWN', 'team_task_update', { p_task_id: k2, p_patch: { title: 'Deploy v2' } }); // editing other fields keeps it
  assert.equal((await call('OWN', 'team_get', { p_team_id: T })).tasks.find(k => k.id === k2).category_id, cOps);
  await call('OWN', 'team_category_archive', { p_id: cOps, p_archived: false });
  // Clearing works.
  await call('MEM', 'team_task_update', { p_task_id: k1, p_patch: { category_id: null } });
  g = await call('OWN', 'team_get', { p_team_id: T });
  assert.equal(g.tasks.find(k => k.id === k1).category_id, null);
  // Nothing personal is in the team: its categories are only the team's own.
  assert.deepEqual(Object.keys(g).sort(), ['categories', 'events', 'loaded_at', 'me', 'members', 'projects', 'tasks', 'team']);
  assert.deepEqual(g.categories.map(c => c.name).sort(), ['Design & UX', 'Ops']);
});

test('“My team tasks”: open tasks assigned to me, in teams I belong to, nothing else', async () => {
  const mine = await call('MEM', 'my_team_tasks');
  assert.deepEqual(mine.map(k => [k.title, k.team_name, k.category && k.category.name]), [['Deploy v2', 'Studio', 'Ops']]);
  assert.deepEqual(await call('OUT', 'my_team_tasks'), []);
  await call('OWN', 'team_remove_member', { p_team_id: T, p_user_id: MEM });
  assert.deepEqual(await call('MEM', 'my_team_tasks'), [], 'leaving the team removes them');
  await refused(pg.rpc(null, 'my_team_tasks'), /not signed in|permission denied/);
});

test('PC Work Time: granted on rollout to the Super Admin only; a computer stops syncing when the grant goes', async () => {
  // Rollout seeded grants for the Super Admin that existed then; this database had none at migration time.
  assert.deepEqual((await call('OWN', 'my_access')).features, []);
  await refused(call('OWN', 'pc_device_create', { p_name: 'Laptop' }), /feature_not_available/);
  await pg.admin("insert into app_private.feature_grants (user_id, feature) values ($1, 'pc_time')", [OWN]);
  const dev = await call('OWN', 'pc_device_create', { p_name: 'Laptop' });
  const today = new Date().toISOString().slice(0, 10);
  await pg.rpc(null, 'pc_agent_sync', { p_key: dev.key, p_days: { [today]: 60 } });
  await pg.admin("delete from app_private.feature_grants where user_id = $1", [OWN]);
  await refused(pg.rpc(null, 'pc_agent_sync', { p_key: dev.key, p_days: { [today]: 120 } }), /feature_not_available/);
  await refused(call('OWN', 'pc_time_summary', { p_from: today, p_to: today }), /feature_not_available/);
});

test('one Super Admin: nobody can be promoted from the app', async () => {
  await refused(call('SA', 'admin_set_role', { p_user_id: OWN, p_role: 'super_admin' }), /single Super Admin/);
  await refused(call('OWN', 'admin_set_role', { p_user_id: OWN, p_role: 'super_admin' }), /super_admin_required/);
  await refused(pg.admin("update public.app_users set role = 'super_admin' where user_id = $1", [OWN]), /app_users_one_super_admin/);
  await call('SA', 'admin_set_role', { p_user_id: OWN, p_role: 'user' }); // other role changes still work
  await call('SA', 'admin_set_role', { p_user_id: OWN, p_role: 'admin' });
  assert.equal((await pg.admin("select count(*)::int n from public.app_users where role = 'super_admin'")).rows[0].n, 1);
});

test('six board tasks, cross-column move, same-column reorder and scoped remark thread', async () => {
  const team = (await call('OWN', 'team_create', { p_name: 'Board and remarks' })).id;
  const invite = await call('OWN', 'team_invite_create', { p_team_id: team, p_email: 'mem@example.test' });
  await call('MEM', 'my_invite_accept', { p_invite_id: invite.id });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    ids.push((await call('OWN', 'team_task_create', {
      p_team_id: team, p_title: 'Card ' + i, p_assignee_id: i < 2 ? MEM : null,
    })).id);
  }
  const board = () => call('MEM', 'team_get', { p_team_id: team });
  assert.equal((await board()).tasks.filter(t => t.status === 'todo').length, 6);
  await call('MEM', 'team_task_move', { p_task_id: ids[0], p_status: 'in_progress' });
  await call('MEM', 'team_task_move', { p_task_id: ids[1], p_status: 'todo', p_before_id: ids[3] });
  const moved = (await board()).tasks;
  assert.equal(moved.find(t => t.id === ids[0]).status, 'in_progress');
  assert.deepEqual(moved.filter(t => t.status === 'todo').map(t => t.id), [ids[2], ids[1], ids[3], ids[4], ids[5]]);
  await refused(call('MEM', 'team_task_move', { p_task_id: ids[2], p_status: 'done' }), /only move tasks/);
  await refused(call('MEM', 'team_task_move', { p_task_id: ids[1], p_status: 'todo', p_before_id: ids[0] }), /drop position changed/);
  const remark = await call('OWN', 'team_remark_add', { p_task_id: ids[0], p_body: 'Can you check this?', p_urgent: true });
  assert.equal((await board()).tasks.find(t => t.id === ids[0]).urgent_remark, true);
  await refused(call('SA', 'team_remarks', { p_task_id: ids[0] }), /Only team members/);
  await refused(call('OUT', 'team_remarks', { p_task_id: ids[0] }), /Team not found/);
  await refused(call('MEM', 'team_remark_add', { p_task_id: ids[1], p_body: 'Wrong task', p_parent_id: remark.id }), /Remark not found/);
  await call('MEM', 'team_remark_add', { p_task_id: ids[0], p_body: 'Yes', p_parent_id: remark.id });
  await call('MEM', 'team_remark_check', { p_task_id: ids[0], p_remark_id: remark.id });
  const thread = await call('MEM', 'team_remarks', { p_task_id: ids[0] });
  assert.ok(thread.find(r => r.id === remark.id).checked_at);
  assert.equal(thread.find(r => r.parent_id === remark.id).body, 'Yes');
  const checked = (await board()).tasks.find(t => t.id === ids[0]);
  assert.equal(checked.urgent_remark, false);
  assert.equal(checked.remark_count, 1);
  assert.equal(checked.status, 'in_progress');
});
