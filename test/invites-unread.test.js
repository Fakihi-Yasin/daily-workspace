// Invites by email (database + the /api/invite mailer), profiles, unread team tasks and Super Admin
// team deletion — against the real SQL in PGlite (test/support/supabase-pg.mjs). Disposable data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let pg, claimsFor, handleInvite;
const SA = 'auth0|super0000000000000000';
const OWN = 'auth0|owner0000000000000000';   // regular Admin, team owner
const MEM = 'auth0|member000000000000000';   // regular Admin, member
const OUT = 'auth0|outsider0000000000000';   // regular Admin, no team
const NEWBIE = 'auth0|newbie00000000000000';  // not registered when invited
const G = 'google-oauth2|1234567890123456789';
const who = {};
const call = (as, fn, args) => pg.rpc(who[as] || as, fn, args);
async function refused(p, re = /workspace_access_denied|super_admin_required|permission denied|not signed in|Only the team owner/) {
  await assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
}

// Routes the mailer's Supabase REST calls into PGlite with the token's claims, and captures emails.
const tokens = new Map();
const sentMail = [];
let mailFails = false;
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  if (url === 'https://api.resend.com/emails') {
    assert.equal(init.headers.Authorization, 'Bearer re_test_key');
    if (mailFails) return new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 });
    sentMail.push(body);
    return new Response(JSON.stringify({ id: 'msg_' + sentMail.length }), { status: 200 });
  }
  const m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url);
  const claims = tokens.get(init.headers.Authorization.replace('Bearer ', '')) || null;
  try { return new Response(JSON.stringify(await pg.rpc(claims, m[1], body)), { status: 200 }); }
  catch (e) {
    const pt = /^PT(\d{3})$/.exec(e.code || '');
    return new Response(JSON.stringify({ message: e.message, code: e.code }), { status: pt ? +pt[1] : e.code === '42501' ? 403 : 400 });
  }
}
const ENV = { RESEND_API_KEY: 're_test_key', INVITE_FROM_EMAIL: 'Dashboard <invites@example.test>', APP_URL: 'https://app.example.test', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };
const post = (as, body, env = ENV) => handleInvite({ method: 'POST', headers: { authorization: 'Bearer tok-' + as + '-0000000000' }, body: JSON.stringify(body) }, env, fakeFetch);
const tokenFromMail = (mail) => /#\/invite\/([a-f0-9]{64})/.exec(mail.text)[1];

before(async () => {
  const m = await import('./support/supabase-pg.mjs');
  claimsFor = m.claimsFor;
  ({ handleInvite } = await import('../api/_invite.mjs'));
  pg = await m.createDb();
  who.SA = claimsFor(SA, { email: 'boss@example.test', name: 'Site Owner' });
  who.OWN = claimsFor(OWN, { email: 'osm@example.test', name: 'OSM BEN' });
  who.MEM = claimsFor(MEM, { email: 'bianco@example.test', name: 'Bianco Verde' });
  who.OUT = claimsFor(OUT, { email: 'out@example.test', name: 'Outsider' });
  who.G = claimsFor(G, { email: 'gee@example.test', name: 'Gee' });
  for (const k of ['SA', 'OWN', 'MEM', 'OUT', 'G']) { await call(k, 'register_me'); tokens.set('tok-' + k + '-0000000000', who[k]); }
  await pg.admin('select app_private.bootstrap_super_admin($1)', [SA]);
});
after(() => pg && pg.close());

let T1, T2;
const NOMAIL = { ...ENV, RESEND_API_KEY: '', INVITE_FROM_EMAIL: '' };
test('no email provider: the invitation is saved, the answer says clearly that no email was sent, and is the same for any address', async () => {
  T1 = (await call('OWN', 'team_create', { p_name: 'Launch crew' })).id;
  T2 = (await call('OWN', 'team_create', { p_name: 'Second team' })).id;
  const reg = await post('OWN', { team_id: T2, email: 'out@example.test' }, NOMAIL); // registered + verified
  const unreg = await post('OWN', { team_id: T2, email: 'nobody-here@example.test' }, NOMAIL); // never signed up
  for (const r of [reg, unreg]) {
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.saved, r.body.emailed, r.body.sent, r.body.code], [true, false, undefined, 'email_not_configured']);
    assert.match(r.body.message, /no email was sent/);
    assert.deepEqual(r.body.missing, ['RESEND_API_KEY', 'INVITE_FROM_EMAIL']);
  }
  assert.deepEqual(reg.body.message, unreg.body.message, 'nothing reveals which address has an account');
  assert.deepEqual(Object.keys(reg.body).sort(), Object.keys(unreg.body).sort());
  assert.equal(sentMail.length, 0, 'no email');
  // The test outbox can never be used on Vercel.
  assert.equal((await post('OWN', { team_id: T2, email: 'x@example.test' }, { ...NOMAIL, INVITE_TEST_OUTBOX: '/tmp/x', VERCEL: '1' })).body.emailed, false);
  await pg.admin("update public.team_invites set status = 'revoked' where email = 'x@example.test'");
});

test('in-app invitation: the registered recipient sees it under Invitations and joins only that team, only on Accept', async () => {
  // Before accepting: listed for them, not a member, nothing else visible.
  let mine = await call('OUT', 'my_invites');
  assert.equal(mine.email_verified, true);
  assert.deepEqual(mine.invites.map(i => [i.team_name, i.inviter.name]), [['Second team', 'OSM BEN']]);
  assert.equal((await call('OUT', 'team_unread')).invites, 1);
  assert.deepEqual(await call('OUT', 'team_list', { p_scope: 'mine' }), []);
  await assert.rejects(call('OUT', 'team_get', { p_team_id: T2 }), /Team not found/);
  // Other accounts can't see, accept or decline it.
  assert.deepEqual((await call('MEM', 'my_invites')).invites, []);
  await assert.rejects(call('MEM', 'my_invite_accept', { p_invite_id: mine.invites[0].id }), /Invite not found/);
  await assert.rejects(call('MEM', 'my_invite_decline', { p_invite_id: mine.invites[0].id }), /Invite not found/);
  // The owner sees it pending, "in the app only"; regular Admins never get account details.
  const pending = await call('OWN', 'team_invite_list', { p_team_id: T2 });
  assert.deepEqual(pending.map(i => [i.email, i.emailed]).sort(), [['nobody-here@example.test', false], ['out@example.test', false]]);
  assert.ok(pending.every(i => Object.keys(i).sort().join() === 'created_at,email,emailed,expires_at,id,sent_at'), 'no name, account id or registration flag');
  // Accept.
  assert.deepEqual(await call('OUT', 'my_invite_accept', { p_invite_id: mine.invites[0].id }), { team_id: T2 });
  assert.deepEqual((await call('OUT', 'team_list', { p_scope: 'mine' })).map(t => [t.name, t.my_role]), [['Second team', 'member']]);
  await assert.rejects(call('OUT', 'team_get', { p_team_id: T1 }), /Team not found/, 'only that team');
  assert.equal((await call('OUT', 'my_access')).role, 'admin', 'role unchanged');
  await assert.rejects(call('OUT', 'my_invite_accept', { p_invite_id: mine.invites[0].id }), /already used/);
  assert.deepEqual((await call('OUT', 'my_invites')).invites, []);
  assert.equal((await call('OUT', 'team_unread')).invites, 0);
  // An unconfirmed email sees only that something is waiting, after confirming it shows up.
  const later = 'auth0|later000000000000000';
  const unv = claimsFor(later, { email: 'nobody-here@example.test', name: 'Later', verified: false });
  await call(unv, 'register_me');
  assert.deepEqual(await call(unv, 'my_invites'), { email_verified: false, waiting: 1, invites: [] });
  await assert.rejects(call(unv, 'my_invite_accept', { p_invite_id: pending.find(i => i.email === 'nobody-here@example.test').id }), /Confirm your email/);
  const ver = claimsFor(later, { email: 'nobody-here@example.test', name: 'Later', verified: true });
  await call(ver, 'register_me');
  const inv = (await call(ver, 'my_invites')).invites;
  assert.equal(inv.length, 1);
  // Decline: it disappears, nobody joins, the owner sees it gone.
  await call(ver, 'my_invite_decline', { p_invite_id: inv[0].id });
  assert.deepEqual((await call(ver, 'my_invites')).invites, []);
  await assert.rejects(call(ver, 'team_get', { p_team_id: T2 }), /Team not found/);
  assert.deepEqual(await call('OWN', 'team_invite_list', { p_team_id: T2 }), []);
  // Leave T2 as it was for the later tests.
  await call('OWN', 'team_remove_member', { p_team_id: T2, p_user_id: OUT });
});

test('invite by email: the same answer for a registered and an unregistered address; only the owner can invite', async () => {
  const a = await post('OWN', { team_id: T1, email: 'bianco@example.test' }); // registered
  const b = await post('OWN', { team_id: T1, email: 'New.Person@Example.test' }); // never signed up
  assert.deepEqual([a.status, a.body.sent, a.body.emailed, a.body.message], [200, true, true, 'Invite sent']);
  assert.deepEqual([b.status, b.body.sent, b.body.emailed, b.body.message], [200, true, true, 'Invite sent']);
  assert.deepEqual(Object.keys(a.body).sort(), Object.keys(b.body).sort(), 'identical shape');
  assert.equal(sentMail.length, 2);
  assert.deepEqual(sentMail.map(x => x.to[0]), ['bianco@example.test', 'new.person@example.test']);
  assert.match(sentMail[0].subject, /OSM BEN invited you to the team “Launch crew”/);
  assert.match(sentMail[0].text, /https:\/\/app\.example\.test\/#\/invite\/[a-f0-9]{64}/);
  // Only a hash of the token is stored.
  const rows = (await pg.admin('select token_hash, status from public.team_invites where team_id = $1 order by created_at', [T1])).rows;
  assert.ok(rows.every(r => r.status === 'sent' && !sentMail.some(m => m.text.includes(r.token_hash))));
  // Members, other Admins and the Super Admin (not owner) can't invite to this team; signed-out neither.
  assert.equal((await post('OUT', { team_id: T1, email: 'z@example.test' })).status, 404);
  await refused(call('SA', 'team_invite_create', { p_team_id: T1, p_email: 'z@example.test' }));
  await refused(pg.rpc(null, 'team_invite_create', { p_team_id: T1, p_email: 'z@example.test' }));
  assert.equal((await handleInvite({ method: 'POST', headers: {}, body: '{}' }, ENV, fakeFetch)).status, 401);
  assert.equal((await post('OWN', { team_id: T1, email: 'not-an-email' })).status, 400);
  assert.equal(sentMail.length, 2, 'nothing else was emailed');
});

test('a failed email says no email was sent; never "Invite sent"', async () => {
  mailFails = true;
  const r = await post('OWN', { team_id: T1, email: 'fail@example.test' });
  mailFails = false;
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.saved, r.body.emailed, r.body.sent, r.body.code], [true, false, undefined, 'email_failed']);
  assert.match(r.body.message, /no email was sent: the email service refused it \(HTTP 403/);
  assert.equal((await pg.admin("select status from public.team_invites where email = 'fail@example.test'")).rows[0].status, 'pending');
  await call('OWN', 'team_invite_revoke', { p_invite_id: (await call('OWN', 'team_invite_list', { p_team_id: T1 })).find(i => i.email === 'fail@example.test').id });
});

test('an unregistered invitee registers, confirms the same email, and joins that team only, once', async () => {
  const token = tokenFromMail(sentMail[1]);
  // Signs up with the invited email; Auth0 hasn't confirmed it yet.
  who.NEWBIE = claimsFor(NEWBIE, { email: 'new.person@example.test', name: 'New Person', verified: false });
  const reg = await call('NEWBIE', 'register_me');
  assert.equal(reg.role, 'admin', 'the usual role for a new account');
  let peek = await call('NEWBIE', 'team_invite_peek', { p_token: token });
  assert.deepEqual([peek.state, peek.team_name, peek.inviter_name, peek.email_matches, peek.my_email_verified], ['ok', 'Launch crew', 'OSM BEN', true, false]);
  assert.equal(peek.invited_email, 'n•••••••••@example.test', 'masked');
  await assert.rejects(call('NEWBIE', 'team_invite_accept', { p_token: token }), /Confirm your email/);
  // Someone else signed in with the link can't use it.
  await assert.rejects(call('OUT', 'team_invite_accept', { p_token: token }), /different email address/);
  assert.equal((await call('OUT', 'team_invite_peek', { p_token: token })).email_matches, false);
  // Email confirmed → next token carries email_verified.
  who.NEWBIE = claimsFor(NEWBIE, { email: 'new.person@example.test', name: 'New Person', verified: true });
  await call('NEWBIE', 'register_me');
  peek = await call('NEWBIE', 'team_invite_peek', { p_token: token });
  assert.equal(peek.my_email_verified, true);
  assert.deepEqual(await call('NEWBIE', 'team_invite_accept', { p_token: token }), { team_id: T1 });
  assert.deepEqual((await call('NEWBIE', 'team_list', { p_scope: 'mine' })).map(t => [t.name, t.my_role]), [['Launch crew', 'member']]);
  await assert.rejects(call('NEWBIE', 'team_get', { p_team_id: T2 }), /Team not found/, 'only that team');
  assert.equal((await call('NEWBIE', 'my_access')).role, 'admin', 'role unchanged');
  // Single use.
  await assert.rejects(call('NEWBIE', 'team_invite_accept', { p_token: token }), /already used/);
  assert.equal((await call('NEWBIE', 'team_invite_peek', { p_token: token })).state, 'used');
  assert.ok(!(await call('OWN', 'team_invite_list', { p_team_id: T1 })).some(i => i.email === 'new.person@example.test'), 'no longer pending');
});

test('invites expire, can be cancelled, and a new invite replaces the old one; roles never change', async () => {
  // The registered member accepts theirs, after it was re-sent (the first link stops working).
  const first = tokenFromMail(sentMail[0]);
  await post('OWN', { team_id: T1, email: 'bianco@example.test' });
  const second = tokenFromMail(sentMail[sentMail.length - 1]);
  assert.equal((await call('MEM', 'team_invite_peek', { p_token: first })).state, 'revoked');
  assert.deepEqual(await call('MEM', 'team_invite_accept', { p_token: second }), { team_id: T1 });
  assert.equal((await call('MEM', 'my_access')).role, 'admin');
  // Expired.
  await post('OWN', { team_id: T2, email: 'out@example.test' });
  const exp = tokenFromMail(sentMail[sentMail.length - 1]);
  await pg.admin("update public.team_invites set expires_at = now() - interval '1 minute' where email = 'out@example.test' and team_id = $1", [T2]);
  assert.equal((await call('OUT', 'team_invite_peek', { p_token: exp })).state, 'expired');
  await assert.rejects(call('OUT', 'team_invite_accept', { p_token: exp }), /expired/);
  // Cancelled by the owner.
  await post('OWN', { team_id: T2, email: 'out@example.test' });
  const can = tokenFromMail(sentMail[sentMail.length - 1]);
  const pending = await call('OWN', 'team_invite_list', { p_team_id: T2 });
  assert.equal(pending.length, 1);
  await refused(call('MEM', 'team_invite_list', { p_team_id: T1 }));
  await call('OWN', 'team_invite_revoke', { p_invite_id: pending[0].id });
  await assert.rejects(call('OUT', 'team_invite_accept', { p_token: can }), /cancelled/);
  assert.equal((await call('OUT', 'team_invite_peek', { p_token: 'nonsense-token-000000000000' })).state, 'invalid');
  await assert.rejects(call('OWN', 'team_invite_create', { p_team_id: T1, p_email: 'bianco@example.test' }), /already in this team/);
});

test('profiles: own display name and photo; avatars visible to teammates and Super Admins only', async () => {
  let p = await call('MEM', 'profile_set_name', { p_display_name: '  Bianco   V. ' });
  assert.equal(p.name, 'Bianco V.');
  assert.equal(p.photo_v, null);
  // Signing in again doesn't overwrite the chosen name; others see it.
  await call('MEM', 'register_me');
  assert.equal((await call('OWN', 'team_get', { p_team_id: T1 })).members.find(m => m.id === MEM).name, 'Bianco V.');
  assert.equal((await call('SA', 'admin_list_users')).find(u => u.user_id === MEM).name, 'Bianco V.');
  await assert.rejects(call('MEM', 'profile_set_name', { p_display_name: 'x'.repeat(81) }), /80 characters/);
  // Photo: images only.
  await assert.rejects(call('MEM', 'profile_set_photo', { p_data: 'data:text/html;base64,PHNjcmlwdD4=' }), /JPEG, PNG or WebP/);
  await assert.rejects(call('MEM', 'profile_set_photo', { p_data: 'javascript:alert(1)' }), /JPEG, PNG or WebP/);
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  p = await call('MEM', 'profile_set_photo', { p_data: img });
  assert.equal(p.photo_kind, 'upload');
  const v = p.photo_v;
  assert.ok(v);
  const member = (await call('OWN', 'team_get', { p_team_id: T1 })).members.find(m => m.id === MEM);
  assert.equal(member.photo_v, v);
  assert.deepEqual(await call('OWN', 'profile_photos', { p_ids: [MEM] }), { [MEM]: img }, 'a teammate sees it');
  assert.deepEqual(await call('SA', 'profile_photos', { p_ids: [MEM] }), { [MEM]: img }, 'the Super Admin sees it');
  assert.deepEqual(await call('OUT', 'profile_photos', { p_ids: [MEM] }), {}, 'a stranger does not');
  assert.equal((await call('SA', 'admin_list_users')).find(u => u.user_id === MEM).photo_v, v);
  // Google photo: only for Google accounts, only Google's image host.
  await assert.rejects(call('MEM', 'profile_use_google_photo', { p_url: 'https://lh3.googleusercontent.com/a/abc' }), /signs in with Google/);
  await assert.rejects(call('G', 'profile_use_google_photo', { p_url: 'https://evil.example/a.png' }), /Google profile photo/);
  assert.equal((await call('G', 'profile_use_google_photo', { p_url: 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c' })).photo_kind, 'google');
  assert.deepEqual(await call('G', 'profile_photos', { p_ids: [G] }), { [G]: 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c' });
  // Remove → initials again.
  p = await call('MEM', 'profile_remove_photo', {});
  assert.deepEqual([p.photo_kind, p.photo_v], [null, null]);
  assert.deepEqual(await call('OWN', 'profile_photos', { p_ids: [MEM] }), {});
  await refused(pg.rpc(null, 'profile_set_name', { p_display_name: 'x' }));
});

test('unread: two tasks created by a teammate while the other is away show +2 until they open that board', async () => {
  // Joined just now: nothing old counts.
  assert.deepEqual(await call('MEM', 'team_unread'), { total: 0, teams: {}, invites: 0 });
  await call('OWN', 'team_task_create', { p_team_id: T1, p_title: 'Draft the brief' });
  await call('OWN', 'team_task_create', { p_team_id: T1, p_title: 'Book the venue', p_assignee_id: MEM });
  // Their own tasks don't count for them; edits and status changes don't count for anyone.
  const mine = (await call('MEM', 'team_task_create', { p_team_id: T1, p_title: 'My own idea' })).id;
  await call('MEM', 'team_task_update', { p_task_id: mine, p_patch: { title: 'My own idea v2', status: 'in_progress' } });
  assert.deepEqual(await call('MEM', 'team_unread'), { total: 2, teams: { [T1]: 2 }, invites: 0 });
  const ownerView = await call('OWN', 'team_unread');
  assert.equal(ownerView.teams[T1], 1, 'the owner sees only the member’s task');
  // Opening the board: tasks load, then that team is marked seen (survives reloads and devices).
  const board = await call('MEM', 'team_get', { p_team_id: T1 });
  assert.ok(board.loaded_at);
  await call('MEM', 'team_mark_seen', { p_team_id: T1, p_upto: board.loaded_at });
  assert.deepEqual(await call('MEM', 'team_unread'), { total: 0, teams: {}, invites: 0 });
  assert.equal((await call('OWN', 'team_unread')).teams[T1], 1, 'only the caller’s count was cleared');
  // A task added after the board loaded still counts.
  await call('OWN', 'team_task_create', { p_team_id: T1, p_title: 'Later task' });
  await call('MEM', 'team_mark_seen', { p_team_id: T1, p_upto: board.loaded_at });
  assert.deepEqual(await call('MEM', 'team_unread'), { total: 1, teams: { [T1]: 1 }, invites: 0 });
  // Outsiders and a non-member Super Admin: nothing counted, nothing written.
  assert.deepEqual(await call('OUT', 'team_unread'), { total: 0, teams: {}, invites: 0 });
  await call('SA', 'team_mark_seen', { p_team_id: T1 });
  assert.equal((await pg.admin('select count(*)::int n from public.team_task_seen where user_id = $1', [SA])).rows[0].n, 0);
  await assert.rejects(call('OUT', 'team_mark_seen', { p_team_id: T1 }), /Team not found/);
});

test('Super Admin deletes any team (not a member); others cannot; audited; nothing else touched', async () => {
  await call('MEM', 'save_snapshot', { p_slot: 'real', p_expected_rev: null, p_new_rev: 'mem-rev-1', p_snapshot: { format: 'dashboard-snapshot', version: 1, rev: 'mem-rev-1', tables: {} } });
  await call('OWN', 'team_task_create', { p_team_id: T2, p_title: 'Other team task' });
  await post('OWN', { team_id: T1, email: 'pending@example.test' });
  // A member and an unrelated Admin can't delete it.
  await refused(call('MEM', 'team_delete', { p_team_id: T1 }), /Only the team owner/);
  await assert.rejects(call('OUT', 'team_delete', { p_team_id: T1 }), /Team not found/);
  assert.equal((await call('SA', 'team_get', { p_team_id: T1 })).me.access, 'viewer');
  const r = await call('SA', 'team_delete', { p_team_id: T1 });
  assert.equal(r.deleted, T1);
  assert.equal(r.members, 3);
  // Gone for every member, with their badge for it.
  for (const k of ['OWN', 'MEM', 'NEWBIE']) {
    assert.ok(!(await call(k, 'team_list', { p_scope: 'mine' })).some(t => t.id === T1));
    assert.equal((await call(k, 'team_unread')).teams[T1], undefined);
  }
  for (const t of ['team_tasks', 'team_members', 'team_invites', 'team_task_seen', 'team_events']) {
    assert.equal((await pg.admin(`select count(*)::int n from public.${t} where team_id = $1`, [T1])).rows[0].n, 0, t);
  }
  // Accounts, personal dashboards and the other team are untouched.
  assert.equal((await call('SA', 'admin_list_users')).length, 7);
  assert.equal((await call('MEM', 'get_snapshot', { p_slot: 'real', p_with_data: false })).rev, 'mem-rev-1');
  assert.equal((await call('OWN', 'team_get', { p_team_id: T2 })).tasks.length, 1);
  assert.equal((await call('MEM', 'my_access')).role, 'admin');
  // Audit: who, the team's name, when.
  const a = (await call('SA', 'admin_audit', { p_limit: 5 }))[0];
  assert.deepEqual([a.action, a.actor.id, a.target.id, a.target.name, a.target.team], ['team_delete', SA, T1, 'Launch crew', true]);
  assert.match(a.new, /task\(s\).*3 member\(s\); owner OSM BEN/);
  assert.ok(a.at);
  // The owner's own permission is unchanged.
  await call('OWN', 'team_delete', { p_team_id: T2 });
  assert.equal((await call('SA', 'admin_audit', { p_limit: 1 }))[0].actor.id, OWN);
  await assert.rejects(call('SA', 'team_delete', { p_team_id: T2 }), /Team not found/);
});
