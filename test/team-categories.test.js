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

test('remark inbox counts each teammate message, acknowledges only those read and keeps threads in the team', async () => {
  const team = (await call('OWN', 'team_create', { p_name: 'Inbox test' })).id;
  const invite = await call('OWN', 'team_invite_create', { p_team_id: team, p_email: 'mem@example.test' });
  await call('MEM', 'my_invite_accept', { p_invite_id: invite.id });
  const task = (await call('OWN', 'team_task_create', { p_team_id: team, p_title: 'Linked work', p_assignee_id: MEM })).id;
  const linked = await call('OWN', 'team_remark_add', { p_task_id: task, p_body: 'Linked', p_urgent: true });
  const standalone = await call('MEM', 'team_remark_post', { p_team_id: team, p_body: 'Standalone', p_urgent: true });
  const reply = await call('OWN', 'team_remark_post', { p_team_id: team, p_body: 'Answer', p_root_id: standalone.id });
  const inbox = () => call('MEM', 'team_remark_inbox', { p_team_id: team });
  assert.deepEqual((await inbox()).map(r => [r.id,r.unread]).sort(), [[linked.id,1],[standalone.id,1]].sort());
  assert.equal((await inbox()).find(r => r.id===linked.id).task_title,'Linked work');
  await call('MEM', 'team_remark_read', { p_team_id: team, p_ids: [linked.id] });
  assert.equal((await inbox()).find(r => r.id===linked.id).unread,0);
  assert.equal((await inbox()).find(r => r.id===standalone.id).unread,1);
  await call('MEM', 'team_remark_resolve', { p_team_id: team, p_root_id: standalone.id });
  const thread = await call('MEM', 'team_remark_thread', { p_team_id: team, p_root_id: standalone.id });
  assert.ok(thread[0].checked_at);
  assert.equal(thread[1].id,reply.id);
  await refused(call('OUT','team_remark_thread',{p_team_id:team,p_root_id:standalone.id}),/Team not found/);
  await refused(call('SA','team_remark_inbox',{p_team_id:team}),/Only team members/);
});

test('team routines preserve assignment and create one occurrence per date on repeated completion', async () => {
  const team = (await call('OWN', 'team_create', { p_name: 'Routine test' })).id;
  const invite = await call('OWN', 'team_invite_create', { p_team_id: team, p_email: 'mem@example.test' });
  await call('MEM', 'my_invite_accept', { p_invite_id: invite.id });
  const params = { p_team_id:team,p_title:'Weekly review',p_assignee_id:MEM,p_recurrence:'weekly',p_starts_on:'2026-11-27' };
  const r = await call('OWN','team_routine_save',params);
  const cards = () => call('MEM','team_get',{p_team_id:team}).then(x=>x.tasks);
  const [first] = await cards();
  assert.equal(first.assignee.id,MEM);
  const update = status => call('MEM','team_task_move',{p_task_id:first.id,p_status:status});
  await update('done'); await update('todo'); await update('done');
  assert.deepEqual((await cards()).map(t=>t.due_date).sort(),['2026-11-27','2026-12-04']);
  await refused(call('MEM','team_routine_save',{...params,p_id:r.id,p_active:false}),/creator or team owner/);
  await call('OWN','team_routine_save',{...params,p_id:r.id,p_active:false});
  const second = (await cards()).find(t=>t.id!==first.id);
  await call('MEM','team_task_move',{p_task_id:second.id,p_status:'done'});
  assert.equal((await cards()).length,2);
  await call('OWN','team_routine_save',{...params,p_id:r.id,p_active:true});
  assert.deepEqual((await cards()).map(t=>t.due_date).sort(),['2026-11-27','2026-12-04','2026-12-11']);
  await refused(call('OUT','team_routines',{p_team_id:team}),/Team not found/);
});

test('project creator, owner and assignee manage checklists within their authorized context', async () => {
  const team = (await call('OWN','team_create',{p_name:'Project checklist test'})).id;
  for (const [account,email] of [['MEM','mem@example.test'],['OUT','out@example.test']]) {
    const inv = await call('OWN','team_invite_create',{p_team_id:team,p_email:email});
    await call(account,'my_invite_accept',{p_invite_id:inv.id});
  }
  const project = (await call('MEM','team_project_save',{p_team_id:team,p_project_id:null,p_title:'Member project',p_notes:null})).id;
  const item = (await call('MEM','team_checklist_change',{p_project_id:project,p_task_id:null,p_item_id:null,p_title:'Plan'})).id;
  const remove = (await call('MEM','team_checklist_change',{p_project_id:project,p_task_id:null,p_item_id:null,p_title:'Remove me'})).id;
  await call('MEM','team_checklist_change',{p_project_id:project,p_task_id:null,p_item_id:remove,p_remove:true});
  await call('OWN','team_checklist_change',{p_project_id:project,p_task_id:null,p_item_id:item,p_title:'Plan renamed',p_done:true});
  await refused(call('OUT','team_checklist_change',{p_project_id:project,p_task_id:null,p_item_id:item,p_remove:true}),/project creator or team owner/);
  await refused(call('OUT','team_project_delete',{p_project_id:project}),/project creator or team owner/);
  const active = (await call('OWN','team_project_activate',{p_project_id:project,p_assignee_id:OUT})).task_id;
  let board = await call('MEM','team_get',{p_team_id:team});
  assert.deepEqual(board.tasks.find(t=>t.id===active).subtasks,[{id:item,title:'Plan renamed',done:true}]);
  assert.deepEqual(board.projects.find(p=>p.id===project).subtasks,[{id:item,title:'Plan renamed',done:true}]);
  await call('MEM','team_checklist_change',{p_project_id:project,p_task_id:null,p_item_id:item,p_done:false});
  await call('MEM','team_project_delete',{p_project_id:project});
  board = await call('MEM','team_get',{p_team_id:team});
  assert.equal(board.tasks.find(t=>t.id===active).subtasks[0].done,false);
  const task = (await call('MEM','team_task_create',{p_team_id:team,p_title:'Team subtasks',p_subtasks:['One','Two']})).id;
  assert.deepEqual((await call('MEM','team_get',{p_team_id:team})).tasks.find(t=>t.id===task).subtasks.map(x=>x.title),['One','Two']);
  await refused(call('MEM','team_task_create',{p_team_id:team,p_title:'Invalid',p_subtasks:[null]}),/Use up to 30 subtasks/);
  assert.ok(!(await call('MEM','team_get',{p_team_id:team})).tasks.some(t=>t.title==='Invalid'));
  const root = (await call('OWN','team_remark_add',{p_task_id:task,p_body:'Read from outside tab',p_urgent:true})).id;
  const notifications = await call('MEM','team_remark_notifications');
  assert.ok(notifications.some(r=>r.id===root && r.team_id===team && r.title==='Team subtasks'));
  assert.ok(!(await call('SA','team_remark_notifications')).some(r=>r.id===root));
  await call('MEM','team_remark_read',{p_team_id:team,p_ids:[root]});
  assert.ok(!(await call('MEM','team_remark_notifications')).some(r=>r.id===root));
});
