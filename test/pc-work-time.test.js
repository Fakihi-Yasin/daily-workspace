// PC Work Time: the agent's device key, per-day durations only, settings sync, and access rules —
// against the real migrations in PGlite (see test/support/supabase-pg.mjs). Disposable data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let pg, claimsFor;
const ME = 'auth0|pcowner00000000000000';
const OTHER = 'auth0|pcother00000000000000';
const who = {};
const day = (k) => new Date(Date.now() + k * 86400000).toISOString().slice(0, 10);
const call = (as, fn, args) => pg.rpc(as === null ? null : who[as], fn, args);

before(async () => {
  const m = await import('./support/supabase-pg.mjs');
  claimsFor = m.claimsFor;
  pg = await m.createDb();
  who.ME = claimsFor(ME, { email: 'me@example.test', name: 'Me' });
  who.OTHER = claimsFor(OTHER, { email: 'other@example.test', name: 'Other' });
  who.SA = claimsFor('auth0|pcsuper00000000000000', { email: 'sa@example.test', name: 'SA' });
  for (const k of ['ME', 'OTHER', 'SA']) await call(k, 'register_me');
  await pg.admin('select app_private.bootstrap_super_admin($1)', ['auth0|pcsuper00000000000000']);
  // PC Work Time is granted per account (on rollout: the Super Admin only). These test accounts get it;
  // NOGRANT doesn't.
  for (const u of [ME, OTHER, 'auth0|pcsuper00000000000000']) await pg.admin("insert into app_private.feature_grants (user_id, feature, granted_by) values ($1, 'pc_time', 'test')", [u]);
  who.NOGRANT = claimsFor('auth0|pcnogrant000000000000', { email: 'nogrant@example.test', name: 'No grant' });
  await call('NOGRANT', 'register_me');
});

test('PC Work Time is only for accounts it was granted to; the grant itself is not reachable from the API', async () => {
  assert.deepEqual((await call('ME', 'my_access')).features, ['pc_time']);
  assert.deepEqual((await call('NOGRANT', 'my_access')).features, []);
  for (const [fn, args] of [['pc_device_create', { p_name: 'Laptop' }], ['pc_device_list', {}], ['pc_time_summary', { p_from: '2026-11-01', p_to: '2026-11-30' }],
    ['pc_settings_set', { p_idle_minutes: 5 }], ['pc_history_delete', {}]]) {
    await assert.rejects(call('NOGRANT', fn, args), /feature_not_available/, fn);
  }
  await assert.rejects(pg.asRequest(who.NOGRANT, (tx) => tx.query("insert into app_private.feature_grants (user_id, feature) values ($1, 'pc_time')", ['auth0|pcnogrant000000000000'])), /permission denied/);
});
after(() => pg && pg.close());

let key, deviceId;
test('a signed-in account connects a computer; the key is shown once and only its hash is stored', async () => {
  const r = await call('ME', 'pc_device_create', { p_name: 'Office PC' });
  assert.match(r.key, /^dwpc_[0-9a-f]{64}$/);
  key = r.key; deviceId = r.id;
  const row = (await pg.admin('select encode(key_hash, \'hex\') h from public.pc_devices where id = $1', [deviceId])).rows[0];
  assert.notEqual(row.h, key); assert.equal(row.h.length, 64);
  assert.deepEqual((await call('ME', 'pc_device_list')).map(d => d.name), ['Office PC']);
  assert.ok(!JSON.stringify(await call('ME', 'pc_device_list')).includes(key), 'the list never shows the key');
  assert.deepEqual(await call('OTHER', 'pc_device_list'), [], 'other accounts see nothing');
  await assert.rejects(call(null, 'pc_device_create', { p_name: 'x' }));
});

test('the agent sends per-day totals with its key; retries and older copies never lower a total', async () => {
  const s = await call(null, 'pc_agent_sync', { p_key: key, p_days: { [day(0)]: 3600, [day(-1)]: 7200 }, p_version: 'test' });
  assert.equal(s.idle_minutes, 5); assert.equal(s.paused, false);
  await call(null, 'pc_agent_sync', { p_key: key, p_days: { [day(0)]: 3000 } }); // older copy
  await call(null, 'pc_agent_sync', { p_key: key, p_days: { [day(0)]: 3900 } });
  const sum = await call('ME', 'pc_time_summary', { p_from: day(-6), p_to: day(0) });
  assert.deepEqual(sum.days, [{ day: day(-1), seconds: 7200, work: 0, personal: 0 }, { day: day(0), seconds: 3900, work: 0, personal: 0 }]);
  assert.equal(sum.total, 11100);
  assert.equal(sum.devices, 1);
  // A second computer adds up on the same day.
  const k2 = (await call('ME', 'pc_device_create', { p_name: 'Laptop' })).key;
  await call(null, 'pc_agent_sync', { p_key: k2, p_days: { [day(0)]: 600 } });
  assert.equal((await call('ME', 'pc_time_summary', { p_from: day(0), p_to: day(0) })).total, 4500);
  // Only durations per day are stored: no other columns of activity exist.
});

test('bad input is refused; old and future days are ignored', async () => {
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: 'dwpc_wrong000000000000000000000000', p_days: {} }), /invalid_device_key/);
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: key, p_days: { [day(0)]: 90000 } }), /out of range/);
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: key, p_days: { 'not-a-day': 1 } }), /Invalid day/);
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: key, p_days: [1, 2] }), /at most 40 days/);
  await call(null, 'pc_agent_sync', { p_key: key, p_days: { [day(-60)]: 100, [day(5)]: 100 } });
  assert.equal((await call('ME', 'pc_time_summary', { p_from: day(-70), p_to: day(10) })).total, 7200 + 3900 + 600);
});

test('pause and idle minutes: the latest change wins, from the dashboard or the computer', async () => {
  const t0 = new Date(Date.now() - 60000).toISOString();
  let s = await call(null, 'pc_agent_sync', { p_key: key, p_paused: true, p_paused_at: t0, p_idle_minutes: 10, p_idle_at: t0 });
  assert.equal(s.paused, true); assert.equal(s.idle_minutes, 10);
  s = await call('ME', 'pc_settings_set', { p_paused: false, p_idle_minutes: 7 }); // dashboard, now
  assert.equal(s.paused, false); assert.equal(s.idle_minutes, 7);
  s = await call(null, 'pc_agent_sync', { p_key: key, p_paused: true, p_paused_at: t0 }); // older than the dashboard change
  assert.equal(s.paused, false, 'an older change from the computer does not undo the dashboard');
  await assert.rejects(call('ME', 'pc_settings_set', { p_idle_minutes: 0 }), /between 1 and 120/);
  assert.equal((await call('OTHER', 'pc_time_summary', { p_from: day(0), p_to: day(0) })).settings.idle_minutes, 5, 'settings are per account');
});

test('Activity Details on: only daily Work / Personal totals arrive, never app or site names', async () => {
  const k3 = (await call('ME', 'pc_device_create', { p_name: 'Details PC' })).key;
  await call(null, 'pc_agent_sync', { p_key: k3, p_days: { [day(-2)]: { total: 3600, work: 2400, personal: 600 } } });
  let sum = await call('ME', 'pc_time_summary', { p_from: day(-2), p_to: day(-2) });
  assert.deepEqual([sum.total, sum.work, sum.personal], [3600, 2400, 600]);
  // Reclassified on the computer (same total): the new split replaces the old one.
  await call(null, 'pc_agent_sync', { p_key: k3, p_days: { [day(-2)]: { total: 3600, work: 3000, personal: 0 } } });
  sum = await call('ME', 'pc_time_summary', { p_from: day(-2), p_to: day(-2) });
  assert.deepEqual([sum.work, sum.personal], [3000, 0]);
  // An older, smaller copy changes nothing.
  await call(null, 'pc_agent_sync', { p_key: k3, p_days: { [day(-2)]: { total: 100, work: 100, personal: 0 } } });
  sum = await call('ME', 'pc_time_summary', { p_from: day(-2), p_to: day(-2) });
  assert.deepEqual([sum.total, sum.work], [3600, 3000]);
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: k3, p_days: { [day(-2)]: { total: 100, work: 80, personal: 80 } } }), /out of range/);
  const cols = (await pg.admin("select column_name from information_schema.columns where table_name = 'pc_work_days' order by ordinal_position")).rows.map(r => r.column_name);
  assert.deepEqual(cols, ['device_id', 'user_id', 'day', 'seconds', 'updated_at', 'work_seconds', 'personal_seconds'], 'no column could hold an app or a site');
  await call('ME', 'pc_device_revoke', { p_device_id: (await call('ME', 'pc_device_list')).find(d => d.name === 'Details PC').id });
});

test('nobody else can read or change this account’s PC time', async () => {
  assert.equal((await call('OTHER', 'pc_time_summary', { p_from: day(-6), p_to: day(0) })).total, 0);
  await assert.rejects(call('OTHER', 'pc_device_revoke', { p_device_id: deviceId }), /not found/);
  assert.equal((await call('SA', 'pc_time_summary', { p_from: day(-6), p_to: day(0) })).total, 0, 'a Super Admin sees only their own');
  for (const t of ['pc_devices', 'pc_work_days', 'pc_settings']) {
    await assert.rejects(pg.asRequest(who.ME, (tx) => tx.query(`select * from public.${t}`)), /permission denied/);
    await assert.rejects(pg.asRequest(null, (tx) => tx.query(`select * from public.${t}`)), /permission denied/);
  }
  await assert.rejects(call(null, 'pc_time_summary', { p_from: day(0), p_to: day(0) }));
  await assert.rejects(call(null, 'pc_device_list'));
});

test('a blocked account’s computer is refused; a disconnected computer’s key stops working, its days stay', async () => {
  await call('SA', 'admin_set_status', { p_user_id: ME, p_status: 'blocked' });
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: key, p_days: { [day(0)]: 9999 } }), /workspace_access_denied/);
  await assert.rejects(call('ME', 'pc_time_summary', { p_from: day(0), p_to: day(0) }), /workspace_access_denied/);
  await call('SA', 'admin_set_status', { p_user_id: ME, p_status: 'active' });
  await call('ME', 'pc_device_revoke', { p_device_id: deviceId });
  await assert.rejects(call(null, 'pc_agent_sync', { p_key: key, p_days: {} }), /invalid_device_key/);
  assert.deepEqual((await call('ME', 'pc_device_list')).map(d => d.name), ['Laptop']);
  assert.equal((await call('ME', 'pc_time_summary', { p_from: day(-6), p_to: day(0) })).total, 7200 + 3900 + 600 + 3600, 'incl. the Details PC day');
});

test('Delete history removes the synced totals of this account only', async () => {
  const before = (await call('ME', 'pc_time_summary', { p_from: day(-30), p_to: day(1) })).total;
  assert.ok(before > 0);
  const other = (await call('OTHER', 'pc_device_create', { p_name: 'Other PC' })).key;
  await call(null, 'pc_agent_sync', { p_key: other, p_days: { [day(0)]: 500 } });
  const r = await call('ME', 'pc_history_delete', { p_before: null });
  assert.ok(r.deleted_days > 0);
  assert.equal((await call('ME', 'pc_time_summary', { p_from: day(-30), p_to: day(1) })).total, 0);
  assert.equal((await call('OTHER', 'pc_time_summary', { p_from: day(0), p_to: day(0) })).total, 500, 'other accounts untouched');
  await assert.rejects(call(null, 'pc_history_delete', { p_before: null }));
});

test('deleting the account removes its computers and PC time', async () => {
  await call('SA', 'admin_delete_user', { p_user_id: ME });
  const n = (await pg.admin('select (select count(*) from public.pc_devices where user_id = $1) + (select count(*) from public.pc_work_days where user_id = $1) + (select count(*) from public.pc_settings where user_id = $1) as n', [ME])).rows[0].n;
  assert.equal(Number(n), 0);
});
