// Roles, User Management and Team Work, enforced by the database (supabase/migrations), tested
// against the real SQL in PGlite with PostgREST-style calls (see test/support/supabase-pg.mjs).
// Cast: one Super Admin, two Admins with separate teams, a brand-new signup, and an account that
// already had a synced dashboard before roles existed. All data is disposable and in memory.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let pg, claimsFor;
const SA = 'auth0|super0000000000000000';
const A = 'auth0|admina000000000000000';
const B = 'auth0|adminb000000000000000';
const NEW = 'auth0|newbie000000000000000';
const LEGACY = 'auth0|legacy000000000000000';
const who = {};
const snap = (rev) => ({ format: 'dashboard-snapshot', version: 1, rev, tables: {} });
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  const m = await import('./support/supabase-pg.mjs');
  claimsFor = m.claimsFor;
  pg = await m.createDb({
    // A dashboard synced before this release (migration 1 only).
    afterMigration: async (file, db) => {
      if (file.startsWith('20261123')) await db.query("insert into public.snapshots (user_id, slot, rev, snapshot) values ($1, 'real', 'legacy-rev-1', $2)", [LEGACY, JSON.stringify(snap('legacy-rev-1'))]);
    },
  });
  who.SA = claimsFor(SA, { email: 'owner@example.test', name: 'Site Owner' });
  who.A = claimsFor(A, { email: 'alice@example.test', name: 'Alice' });
  who.B = claimsFor(B, { email: 'bob@example.test', name: 'Bob' });
  who.NEW = claimsFor(NEW, { email: 'newbie@example.test', name: 'Newbie' });
  who.LEGACY = claimsFor(LEGACY, { email: 'legacy@example.test', name: 'Legacy' });
});
after(() => pg && pg.close());

const call = (as, fn, args) => pg.rpc(who[as] || as, fn, args);
async function refused(p, re = /workspace_access_denied|super_admin_required|permission denied|not signed in/) {
  await assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
}

test('rollout: an account with a synced dashboard keeps access as Admin; nobody is made Super Admin', async () => {
  const rows = (await pg.admin('select user_id, role, status from public.app_users')).rows;
  assert.deepEqual(rows, [{ user_id: LEGACY, role: 'admin', status: 'active' }]);
  const r = await call('LEGACY', 'get_snapshot', { p_slot: 'real', p_with_data: true });
  assert.equal(r.rev, 'legacy-rev-1');
  const s = await call('LEGACY', 'save_snapshot', { p_slot: 'real', p_expected_rev: 'legacy-rev-1', p_new_rev: 'legacy-rev-2', p_snapshot: snap('legacy-rev-2') });
  assert.equal(s.status, 'ok');
  const me = await call('LEGACY', 'register_me');
  assert.equal(me.role, 'admin');
  assert.equal(me.email, 'legacy@example.test', 'name and email filled from the token on next sign-in');
  const audit = (await pg.admin("select actor_id, action, new_value from public.user_audit where target_id = $1", [LEGACY])).rows;
  assert.deepEqual(audit, [{ actor_id: 'migration', action: 'backfill', new_value: 'admin' }]);
});

test('every new signup is registered as User and opens its own dashboard at once, with no team creation or directory access', async () => {
  for (const k of ['SA', 'A', 'B', 'NEW']) {
    const r = await call(k, 'register_me');
    assert.equal(r.role, 'user');
    assert.equal(r.status, 'active');
  }
  // Signing in again never changes the role, and the role can't be passed in.
  await assert.rejects(call('NEW', 'register_me', { role: 'super_admin' }));
  assert.equal((await call('NEW', 'register_me')).role, 'user');
  assert.deepEqual(await call('NEW', 'my_access'), { registered: true, role: 'user', status: 'active' });
  // Their own private dashboard works immediately: empty at first, then saved and read back.
  assert.equal(await call('NEW', 'get_snapshot', { p_slot: 'real', p_with_data: true }), null);
  assert.equal((await call('NEW', 'save_snapshot', { p_slot: 'real', p_expected_rev: null, p_new_rev: 'new-rev-1', p_snapshot: snap('new-rev-1') })).status, 'ok');
  assert.equal((await call('NEW', 'get_snapshot', { p_slot: 'real', p_with_data: true })).snapshot.rev, 'new-rev-1');
  // Team Work: no teams until someone adds them; creating teams stays with Admins.
  assert.deepEqual(await call('NEW', 'team_list', { p_scope: 'mine' }), []);
  assert.deepEqual(await call('NEW', 'team_stats'), { my_teams: 0 });
  await refused(call('NEW', 'team_list', { p_scope: 'all' }), /super_admin_required/);
  await refused(call('NEW', 'team_create', { p_name: 'Sneaky' }));
  await refused(call('NEW', 'admin_list_users'));
  await refused(call('NEW', 'admin_set_role', { p_user_id: NEW, p_role: 'super_admin' }));
  await refused(call('NEW', 'admin_set_status', { p_user_id: LEGACY, p_status: 'blocked' }));
  // Someone else's dashboard stays invisible.
  assert.deepEqual((await pg.asRequest(who.NEW, (tx) => tx.query('select user_id from public.snapshots'))).rows, [{ user_id: NEW }]);
  // Direct table access through the API is closed, even with Supabase's default grants in place.
  await refused(pg.asRequest(who.NEW, (tx) => tx.query('select * from public.app_users')));
  await refused(pg.asRequest(who.NEW, (tx) => tx.query("insert into public.snapshots (user_id, slot, rev, snapshot) values ($1, 'real', 'direct-1', $2)", [LEGACY, JSON.stringify(snap('direct-1'))])), /row-level security|permission denied/);
});

test('signed-out visitors can call nothing', async () => {
  await refused(pg.rpc(null, 'register_me'));
  await refused(pg.rpc(null, 'my_access'));
  await refused(pg.rpc(null, 'team_list', { p_scope: 'all' }));
  await refused(pg.asRequest(null, (tx) => tx.query('select * from public.teams')));
});

test('the first Super Admin is set explicitly from the SQL editor, by Auth0 user id, once', async () => {
  // Not callable through the API, by anyone.
  await refused(pg.asRequest(who.A, (tx) => tx.query('select app_private.bootstrap_super_admin($1)', [A])));
  await assert.rejects(pg.admin('select app_private.bootstrap_super_admin($1)', ['owner@example.test']), /Auth0 user id/);
  await pg.admin('select app_private.bootstrap_super_admin($1)', [SA]);
  await assert.rejects(pg.admin('select app_private.bootstrap_super_admin($1)', [A]), /already exists/);
  assert.equal((await call('SA', 'my_access')).role, 'super_admin');
});

test('User Management: the Super Admin sees every signup and changes roles, with an audit trail', async () => {
  const users = await call('SA', 'admin_list_users');
  assert.deepEqual(users.map(u => u.user_id).sort(), [SA, A, B, NEW, LEGACY].sort());
  const nb = users.find(u => u.user_id === NEW);
  assert.equal(nb.email, 'newbie@example.test');
  assert.equal(nb.role, 'user');
  assert.ok(nb.signed_up_at);

  await call('SA', 'admin_set_role', { p_user_id: A, p_role: 'admin' });
  await call('SA', 'admin_set_role', { p_user_id: B, p_role: 'admin' });
  const audit = await call('SA', 'admin_audit', { p_limit: 10 });
  const last = audit.find(x => x.target.id === B);
  assert.equal(last.actor.id, SA);
  assert.equal(last.action, 'role');
  assert.equal(last.old, 'user');
  assert.equal(last.new, 'admin');
  assert.ok(last.at);
  const bRow = (await call('SA', 'admin_list_users')).find(u => u.user_id === B);
  assert.equal(bRow.role_changed_by.id, SA);
  await assert.rejects(call('SA', 'admin_set_role', { p_user_id: A, p_role: 'owner' }), /Unknown role/);
});

test('Admins cannot list users, change roles or block anyone by calling the backend directly', async () => {
  await refused(call('A', 'admin_list_users'));
  await refused(call('A', 'admin_audit', { p_limit: 5 }));
  await refused(call('A', 'admin_set_role', { p_user_id: A, p_role: 'super_admin' }));
  await refused(call('A', 'admin_set_role', { p_user_id: NEW, p_role: 'admin' }));
  await refused(call('A', 'admin_set_status', { p_user_id: B, p_status: 'blocked' }));
  await refused(pg.asRequest(who.A, (tx) => tx.query("update public.app_users set role = 'super_admin' where user_id = $1", [A])));
  await refused(pg.asRequest(who.A, (tx) => tx.query('select app_private.assert_not_last_super_admin($1)', [A])));
  assert.equal((await call('A', 'my_access')).role, 'admin');
  assert.equal((await call('NEW', 'my_access')).role, 'user');
});

test('the last active Super Admin is protected from demotion and blocking', async () => {
  await assert.rejects(call('SA', 'admin_set_role', { p_user_id: SA, p_role: 'admin' }), /own role/);
  await assert.rejects(call('SA', 'admin_set_status', { p_user_id: SA, p_status: 'blocked' }), /own account/);
  // The guard itself (it also covers two Super Admins demoting each other at the same moment).
  await assert.rejects(pg.admin('select app_private.assert_not_last_super_admin($1)', [SA]), /last active Super Admin/);
  // With a second Super Admin, one can demote the other; a blocked Super Admin doesn't count as active.
  await call('SA', 'admin_set_role', { p_user_id: LEGACY, p_role: 'super_admin' });
  await call('SA', 'admin_set_status', { p_user_id: LEGACY, p_status: 'blocked' });
  await assert.rejects(pg.admin('select app_private.assert_not_last_super_admin($1)', [SA]), /last active Super Admin/);
  await refused(call('LEGACY', 'admin_set_role', { p_user_id: SA, p_role: 'user' }), /workspace_access_denied/);
  await call('SA', 'admin_set_status', { p_user_id: LEGACY, p_status: 'active' });
  await call('SA', 'admin_set_role', { p_user_id: LEGACY, p_role: 'admin' });
});

let TA, TB;
test('Admins create private teams; each sees only their own; creating a team grants no global role', async () => {
  TA = (await call('A', 'team_create', { p_name: 'Alpha' })).id;
  TB = (await call('B', 'team_create', { p_name: 'Bravo' })).id;
  assert.deepEqual((await call('A', 'team_list', { p_scope: 'mine' })).map(t => t.name), ['Alpha']);
  assert.deepEqual((await call('B', 'team_list', { p_scope: 'mine' })).map(t => t.name), ['Bravo']);
  await refused(call('A', 'team_list', { p_scope: 'all' }));
  // PT404: PostgREST answers HTTP 404 (P0002 would be a 500 "server error" on Supabase).
  await assert.rejects(call('A', 'team_get', { p_team_id: TB }), (e) => /Team not found/.test(e.message) && e.code === 'PT404');
  await assert.rejects(call('A', 'team_scores', { p_team_id: TB, p_date: today, p_tz: 'UTC' }), /Team not found/);
  await assert.rejects(call('A', 'team_task_create', { p_team_id: TB, p_title: 'x' }), /Team not found/);
  assert.deepEqual(await call('A', 'team_stats'), { my_teams: 1 }, 'no global team count for an Admin');
  assert.equal((await call('A', 'my_access')).role, 'admin');
  // Super Admin: a separate "All teams" view, and the global count.
  assert.deepEqual((await call('SA', 'team_list', { p_scope: 'all' })).map(t => t.name), ['Alpha', 'Bravo']);
  assert.deepEqual((await call('SA', 'team_list', { p_scope: 'mine' })), []);
  assert.deepEqual(await call('SA', 'team_stats'), { my_teams: 0, total_teams: 2 });
  const view = await call('SA', 'team_get', { p_team_id: TA });
  assert.equal(view.me.access, 'viewer');
  await assert.rejects(call('SA', 'team_task_create', { p_team_id: TA, p_title: 'x' }), /Only team members/);
});

test('adding Admin B to team A grants access to that team only; members cannot manage membership', async () => {
  await assert.rejects(call('A', 'team_add_member', { p_team_id: TA, p_email: 'nobody@example.test' }), /No registered account/);
  // An unverified address never matches (nobody can claim a friend's email by signing up with it).
  await call(claimsFor('auth0|impostor0000000000000', { email: 'friend@example.test', verified: false }), 'register_me');
  await assert.rejects(call('A', 'team_add_member', { p_team_id: TA, p_email: 'friend@example.test' }), /No registered account/);
  const added = await call('A', 'team_add_member', { p_team_id: TA, p_email: ' BOB@example.test ' });
  assert.equal(added.id, B);
  await assert.rejects(call('A', 'team_add_member', { p_team_id: TA, p_email: 'bob@example.test' }), /Already a member/);

  assert.deepEqual((await call('B', 'team_list', { p_scope: 'mine' })).map(t => [t.name, t.my_role]), [['Alpha', 'member'], ['Bravo', 'owner']]);
  assert.deepEqual(await call('B', 'team_stats'), { my_teams: 2 });
  const t = await call('B', 'team_get', { p_team_id: TA });
  assert.equal(t.me.access, 'member');
  assert.deepEqual(t.members.map(m => [m.name, m.email, m.owner]), [['Alice', 'alice@example.test', true], ['Bob', 'bob@example.test', false]]);
  // A still doesn't see B's other team.
  await assert.rejects(call('A', 'team_get', { p_team_id: TB }), /Team not found/);
  // Members can't change membership, rename or delete the team.
  await refused(call('B', 'team_add_member', { p_team_id: TA, p_email: 'newbie@example.test' }), /Only the team owner/);
  await refused(call('B', 'team_remove_member', { p_team_id: TA, p_user_id: A }), /Only the team owner/);
  await refused(call('B', 'team_rename', { p_team_id: TA, p_name: 'Mine now' }), /Only the team owner/);
  await refused(call('B', 'team_delete', { p_team_id: TA }), /Only the team owner/);
  await assert.rejects(call('A', 'team_remove_member', { p_team_id: TA, p_user_id: A }), /owner can't be removed/);
});

let taskForB, taskOfB, taskOfA;
test('tasks: owner manages all; members manage tasks they created and update the status of tasks assigned to them', async () => {
  await assert.rejects(call('A', 'team_task_create', { p_team_id: TA, p_title: 'x', p_assignee_id: SA }), /current team members/);
  await assert.rejects(call('A', 'team_task_create', { p_team_id: TA, p_title: '   ' }), /title/);
  taskForB = (await call('A', 'team_task_create', { p_team_id: TA, p_title: 'Write landing copy', p_assignee_id: B, p_due_date: today })).id;
  taskOfA = (await call('A', 'team_task_create', { p_team_id: TA, p_title: 'Owner only task', p_assignee_id: A })).id;
  taskOfB = (await call('B', 'team_task_create', { p_team_id: TA, p_title: 'Bob plans', p_assignee_id: B, p_due_date: today, p_status: 'in_progress' })).id;

  // Assigned to B, created by A: B may change the status only.
  await call('B', 'team_task_update', { p_task_id: taskForB, p_patch: { status: 'blocked' } });
  await refused(call('B', 'team_task_update', { p_task_id: taskForB, p_patch: { title: 'Renamed' } }), /assigned to you/);
  await refused(call('B', 'team_task_update', { p_task_id: taskForB, p_patch: { assignee_id: A } }), /assigned to you/);
  await refused(call('B', 'team_task_delete', { p_task_id: taskForB }), /owner or the task's creator/);
  // Someone else's task, not assigned to B.
  await refused(call('B', 'team_task_update', { p_task_id: taskOfA, p_patch: { status: 'done' } }), /created or that are assigned/);
  // B's own task: full control, but assignees must be current members.
  await call('B', 'team_task_update', { p_task_id: taskOfB, p_patch: { title: 'Bob plans v2', due_date: today } });
  await assert.rejects(call('B', 'team_task_update', { p_task_id: taskOfB, p_patch: { assignee_id: NEW } }), /current team members/);
  await assert.rejects(call('B', 'team_task_update', { p_task_id: taskOfB, p_patch: { owner: B } }), /Unknown field/);
  // The owner can edit and reassign anything.
  await call('A', 'team_task_update', { p_task_id: taskOfB, p_patch: { assignee_id: A } });
  await call('A', 'team_task_update', { p_task_id: taskOfB, p_patch: { assignee_id: B } });
  // Outsiders and the read-only Super Admin can't touch tasks.
  await assert.rejects(call('NEW', 'team_task_update', { p_task_id: taskForB, p_patch: { status: 'done' } }), /Team not found/);
  await refused(call('SA', 'team_task_update', { p_task_id: taskForB, p_patch: { status: 'done' } }), /Only team members/);
  const t = await call('A', 'team_get', { p_team_id: TA });
  assert.deepEqual(t.tasks.map(k => [k.title, k.status, k.assignee && k.assignee.name]).sort(),
    [['Bob plans v2', 'in_progress', 'Bob'], ['Owner only task', 'todo', 'Alice'], ['Write landing copy', 'blocked', 'Bob']]);
  assert.ok(t.events.length >= 4, 'team activity is recorded');
});

test('daily team score: due that day and done by the end of it; completions counted by completion date', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await call('B', 'team_task_update', { p_task_id: taskOfB, p_patch: { status: 'done' } });
  let s = await call('A', 'team_scores', { p_team_id: TA, p_date: today, p_tz: 'UTC' });
  let bob = s.members.find(m => m.id === B);
  assert.equal(bob.due, 2);
  assert.equal(bob.on_time, 1);
  assert.equal(bob.score, 50);
  assert.deepEqual(bob.completed.map(c => c.title), ['Bob plans v2']);
  // Finished the day after it was due: not on time for its due day; counted as a completion the next day.
  await call('B', 'team_task_update', { p_task_id: taskForB, p_patch: { status: 'done' } });
  await pg.admin("update public.team_tasks set completed_at = ($1::date + time '10:00') at time zone 'UTC' where id = $2", [tomorrow, taskForB]);
  s = await call('A', 'team_scores', { p_team_id: TA, p_date: today, p_tz: 'UTC' });
  bob = s.members.find(m => m.id === B);
  assert.deepEqual([bob.due, bob.on_time, bob.score], [2, 1, 50]);
  const next = (await call('B', 'team_scores', { p_team_id: TA, p_date: tomorrow, p_tz: 'Africa/Casablanca' })).members.find(m => m.id === B);
  assert.deepEqual([next.due, next.score], [0, null]);
  assert.deepEqual(next.completed.map(c => c.title), ['Write landing copy']);
  // Reopening a task removes its completion.
  await call('B', 'team_task_update', { p_task_id: taskOfB, p_patch: { status: 'in_progress' } });
  bob = (await call('A', 'team_scores', { p_team_id: TA, p_date: today, p_tz: 'UTC' })).members.find(m => m.id === B);
  assert.deepEqual([bob.on_time, bob.completed.length], [0, 0]);
  // An unknown timezone falls back to UTC instead of failing.
  assert.equal((await call('A', 'team_scores', { p_team_id: TA, p_date: today, p_tz: 'Mars/Base' })).tz, 'UTC');
});

test('Future Projects: the owner plans them and moves them into active work', async () => {
  await refused(call('B', 'team_project_save', { p_team_id: TA, p_project_id: null, p_title: 'Mine', p_notes: null }), /Only the team owner/);
  const p = (await call('A', 'team_project_save', { p_team_id: TA, p_project_id: null, p_title: 'Spanish site', p_notes: 'After summer' })).id;
  await call('A', 'team_project_save', { p_team_id: TA, p_project_id: p, p_title: 'Spanish site (ES)', p_notes: 'After summer' });
  await refused(call('B', 'team_project_activate', { p_project_id: p, p_assignee_id: B }), /Only the team owner/);
  const r = await call('A', 'team_project_activate', { p_project_id: p, p_assignee_id: B, p_due_date: today });
  await assert.rejects(call('A', 'team_project_activate', { p_project_id: p }), /already in active work/);
  const t = await call('B', 'team_get', { p_team_id: TA });
  const task = t.tasks.find(k => k.id === r.task_id);
  assert.equal(task.title, 'Spanish site (ES)');
  assert.equal(task.assignee.id, B);
  assert.equal(t.projects.find(x => x.id === p).moved_task_id, r.task_id);
});

test('removing B from team A revokes B’s access to it at once; B’s tasks there become unassigned', async () => {
  await call('A', 'team_remove_member', { p_team_id: TA, p_user_id: B });
  await assert.rejects(call('B', 'team_get', { p_team_id: TA }), /Team not found/);
  await assert.rejects(call('B', 'team_task_update', { p_task_id: taskOfB, p_patch: { status: 'done' } }), /Team not found/);
  await assert.rejects(call('B', 'team_scores', { p_team_id: TA, p_date: today, p_tz: 'UTC' }), /Team not found/);
  assert.deepEqual((await call('B', 'team_list', { p_scope: 'mine' })).map(t => t.name), ['Bravo']);
  assert.deepEqual(await call('B', 'team_stats'), { my_teams: 1 });
  const t = await call('A', 'team_get', { p_team_id: TA });
  assert.ok(t.tasks.every(k => !k.assignee || k.assignee.id !== B), 'no task assigned to a non-member');
  assert.deepEqual(t.members.map(m => m.id), [A]);
});

test('blocking B stops an already signed-in session on its next request; unblocking restores it', async () => {
  // B's existing session (same token) works before the block.
  const r0 = await call('B', 'save_snapshot', { p_slot: 'real', p_expected_rev: null, p_new_rev: 'b-rev-0001', p_snapshot: snap('b-rev-0001') });
  assert.equal(r0.status, 'ok');
  await call('SA', 'admin_set_status', { p_user_id: B, p_status: 'blocked' });
  assert.deepEqual(await call('B', 'my_access'), { registered: true, role: 'admin', status: 'blocked' });
  await refused(call('B', 'get_snapshot', { p_slot: 'real', p_with_data: true }), /workspace_access_denied/);
  await refused(call('B', 'save_snapshot', { p_slot: 'real', p_expected_rev: 'b-rev-0001', p_new_rev: 'b-rev-0002', p_snapshot: snap('b-rev-0002') }), /workspace_access_denied/);
  await refused(call('B', 'team_list', { p_scope: 'mine' }), /workspace_access_denied/);
  await refused(call('B', 'team_get', { p_team_id: TB }), /workspace_access_denied/);
  await refused(call('B', 'team_task_create', { p_team_id: TB, p_title: 'x' }), /workspace_access_denied/);
  // Even a direct table read with the old token returns nothing (RLS checks the account too).
  const direct = await pg.asRequest(who.B, (tx) => tx.query('select rev from public.snapshots'));
  assert.equal(direct.rows.length, 0);
  // Signing in again doesn't unblock.
  assert.equal((await call('B', 'register_me')).status, 'blocked');
  const audit = (await call('SA', 'admin_audit', { p_limit: 5 }))[0];
  assert.deepEqual([audit.actor.id, audit.target.id, audit.action, audit.new], [SA, B, 'status', 'blocked']);
  // A blocked account can't be added to a team.
  await assert.rejects(call('A', 'team_add_member', { p_team_id: TA, p_email: 'bob@example.test' }), /No registered account/);

  await call('SA', 'admin_set_status', { p_user_id: B, p_status: 'active' });
  assert.equal((await call('B', 'get_snapshot', { p_slot: 'real', p_with_data: false })).rev, 'b-rev-0001', 'data intact after unblocking');
  assert.deepEqual((await call('B', 'team_list', { p_scope: 'mine' })).map(t => t.name), ['Bravo']);
});

test('demoting an Admin to User keeps their dashboard and teams, but not team management', async () => {
  await call('SA', 'admin_set_role', { p_user_id: B, p_role: 'user' });
  assert.equal((await call('B', 'get_snapshot', { p_slot: 'real', p_with_data: false })).rev, 'b-rev-0001');
  assert.deepEqual((await call('B', 'team_list', { p_scope: 'mine' })).map(t => t.name), ['Bravo']);
  await refused(call('B', 'team_create', { p_name: 'Another' }));
  await refused(call('B', 'team_rename', { p_team_id: TB, p_name: 'Renamed' }));
  await call('SA', 'admin_set_role', { p_user_id: B, p_role: 'admin' });
  assert.equal((await call('B', 'get_snapshot', { p_slot: 'real', p_with_data: false })).rev, 'b-rev-0001');
});

test('a User added to a team works in it, and only in it; blocking them closes everything', async () => {
  const U = 'auth0|usercarol00000000000000';
  who.U = claimsFor(U, { email: 'carol@example.test', name: 'Carol' });
  assert.equal((await call('U', 'register_me')).role, 'user');
  await call('A', 'team_add_member', { p_team_id: TA, p_email: 'carol@example.test' });
  assert.equal((await call('U', 'my_access')).role, 'user', 'joining a team does not change the role');
  assert.deepEqual((await call('U', 'team_list', { p_scope: 'mine' })).map(t => [t.name, t.my_role]), [['Alpha', 'member']]);
  const t = await call('U', 'team_get', { p_team_id: TA });
  assert.equal(t.me.access, 'member');
  const mine = (await call('U', 'team_task_create', { p_team_id: TA, p_title: 'Carol drafts', p_assignee_id: U, p_due_date: today })).id;
  await call('U', 'team_task_update', { p_task_id: mine, p_patch: { status: 'done' } });
  const sc = await call('U', 'team_scores', { p_team_id: TA, p_date: today, p_tz: 'UTC' });
  assert.equal(sc.members.find(m => m.id === U).score, 100);
  // Membership rules are the same as for any member.
  const fromA = (await call('A', 'team_task_create', { p_team_id: TA, p_title: 'Alice keeps this' })).id;
  await refused(call('U', 'team_task_update', { p_task_id: fromA, p_patch: { status: 'done' } }), /created or that are assigned/);
  await refused(call('U', 'team_task_delete', { p_task_id: fromA }), /owner or the task's creator/);
  await refused(call('U', 'team_add_member', { p_team_id: TA, p_email: 'newbie@example.test' }));
  await refused(call('U', 'team_rename', { p_team_id: TA, p_name: 'Mine now' }));
  await refused(call('U', 'team_project_save', { p_team_id: TA, p_project_id: null, p_title: 'x', p_notes: null }));
  // An unrelated team looks like it doesn't exist.
  await assert.rejects(call('U', 'team_get', { p_team_id: TB }), (e) => /Team not found/.test(e.message) && e.code === 'PT404');
  await assert.rejects(call('U', 'team_scores', { p_team_id: TB, p_date: today, p_tz: 'UTC' }), /Team not found/);
  await refused(call('U', 'team_list', { p_scope: 'all' }), /super_admin_required/);
  // Private dashboards: their own only.
  assert.equal(await call('U', 'get_snapshot', { p_slot: 'real', p_with_data: true }), null);
  assert.deepEqual((await pg.asRequest(who.U, (tx) => tx.query('select user_id from public.snapshots'))).rows, []);
  // No user management.
  await refused(call('U', 'admin_list_users'));
  await refused(call('U', 'admin_set_role', { p_user_id: U, p_role: 'admin' }));
  // Blocked: nothing at all, same token.
  await call('SA', 'admin_set_status', { p_user_id: U, p_status: 'blocked' });
  await refused(call('U', 'get_snapshot', { p_slot: 'real', p_with_data: true }), /workspace_access_denied/);
  await refused(call('U', 'save_snapshot', { p_slot: 'real', p_expected_rev: null, p_new_rev: 'blocked-1', p_snapshot: snap('blocked-1') }), /workspace_access_denied/);
  await refused(call('U', 'team_get', { p_team_id: TA }), /workspace_access_denied/);
  await refused(call('U', 'team_list', { p_scope: 'mine' }), /workspace_access_denied/);
  await refused(call('U', 'team_task_create', { p_team_id: TA, p_title: 'x' }), /workspace_access_denied/);
  await refused(pg.asRequest(who.U, (tx) => tx.query("insert into public.snapshots (user_id, slot, rev, snapshot) values ($1, 'real', 'direct-2', $2)", [U, JSON.stringify(snap('direct-2'))])), /row-level security|permission denied/);
  assert.equal((await call('U', 'my_access')).status, 'blocked');
  await call('A', 'team_remove_member', { p_team_id: TA, p_user_id: U });
});

test('personal snapshots stay private: nobody reads another account’s dashboard, Super Admin included', async () => {
  const rows = await pg.asRequest(who.SA, (tx) => tx.query('select user_id from public.snapshots'));
  assert.deepEqual(rows.rows, []);
  assert.equal(await call('SA', 'get_snapshot', { p_slot: 'real', p_with_data: true }), null);
  const mine = await pg.asRequest(who.A, (tx) => tx.query('select user_id from public.snapshots'));
  assert.deepEqual(mine.rows, []);
});

test('only the owner deletes a team; deleting removes its tasks and projects', async () => {
  await call('A', 'team_delete', { p_team_id: TA });
  assert.deepEqual(await call('A', 'team_list', { p_scope: 'mine' }), []);
  const left = (await pg.admin('select count(*)::int as n from public.team_tasks where team_id = $1', [TA])).rows[0].n;
  assert.equal(left, 0);
  assert.deepEqual(await call('SA', 'team_stats'), { my_teams: 0, total_teams: 1 });
});
