#!/usr/bin/env node
// Live access check of the Supabase `snapshots` table (row-level security + grants).
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
//   TOKEN_A=<Auth0 access token of test account A> TOKEN_B=<… of test account B> npm run check:rls
//
// Without TOKEN_A/TOKEN_B only the signed-out checks run. Use TEST accounts that are Admins in the
// Preview project: account A's snapshot gets a new revision (same contents). Keys and tokens are
// never printed. Run it against Preview only, never Production.
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const A = process.env.TOKEN_A || '', B = process.env.TOKEN_B || '';
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY'); process.exit(2); }
if (/^sb_secret_/.test(key)) { console.error('Refusing: that is a secret key. This check must run with the publishable key only.'); process.exit(2); }

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) failed++; };
const sub = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub;

async function rest(path, { token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json };
}
const denied = (r) => r.status === 401 || r.status === 403 || (r.json && ['42501', 'PGRST301', 'PGRST302'].includes(r.json.code));
const snap = { format: 'dashboard-snapshot', version: 1, rev: 'rls-check', tables: {} };

console.log('Signed-out visitor (publishable key, no sign-in):');
{
  const r = await rest('/snapshots?select=user_id,rev');
  ok(denied(r) || (Array.isArray(r.json) && r.json.length === 0), `cannot read snapshots (HTTP ${r.status}${r.json && r.json.code ? ' ' + r.json.code : ''})`);
  const w = await rest('/snapshots', { method: 'POST', body: { user_id: 'auth0|someone', slot: 'real', rev: 'rls-check-anon', snapshot: snap } });
  ok(denied(w), `cannot insert (HTTP ${w.status})`);
  const f = await rest('/rpc/save_snapshot', { method: 'POST', body: { p_slot: 'real', p_expected_rev: null, p_new_rev: 'rls-check-anon', p_snapshot: snap } });
  ok(denied(f) || f.status === 404, `cannot call save_snapshot (HTTP ${f.status})`);
  for (const fn of ['register_me', 'my_access', 'admin_list_users', 'team_list', 'get_snapshot']) {
    const r = await rest('/rpc/' + fn, { method: 'POST', body: {} });
    ok(denied(r) || r.status === 404, `cannot call ${fn} (HTTP ${r.status})`);
  }
  for (const t of ['app_users', 'user_audit', 'teams', 'team_members', 'team_tasks', 'team_future_projects', 'team_events']) {
    const r = await rest(`/${t}?select=*&limit=1`);
    ok(denied(r) || (Array.isArray(r.json) && r.json.length === 0), `cannot read ${t} (HTTP ${r.status})`);
  }
  const forged = await rest('/snapshots?select=rev', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.c2lnbmF0dXJl' });
  ok(forged.status === 401 || denied(forged), `a forged token is rejected (HTTP ${forged.status})`);
}

if (A && B) {
  const aId = sub(A), bId = sub(B);
  ok(aId && bId && aId !== bId, 'two different test accounts');
  console.log('\nAccount A (owner):');
  let row = (await rest('/snapshots?select=rev,snapshot&slot=eq.real', { token: A })).json;
  ok(Array.isArray(row), 'A can query its own data');
  const cur = row && row[0];
  const newRev = 'rls-check-' + Date.now().toString(36);
  const saved = await rest('/rpc/save_snapshot', { token: A, method: 'POST', body: { p_slot: 'real', p_expected_rev: cur ? cur.rev : null, p_new_rev: newRev, p_snapshot: cur ? { ...cur.snapshot, rev: newRev } : { ...snap, rev: newRev } } });
  ok(saved.status === 200 && saved.json && saved.json.status === 'ok', `A can save its own snapshot (${saved.json && saved.json.status})`);
  const stale = await rest('/rpc/save_snapshot', { token: A, method: 'POST', body: { p_slot: 'real', p_expected_rev: 'not-the-current-rev', p_new_rev: newRev + 'x', p_snapshot: snap } });
  ok(stale.json && stale.json.status === 'conflict', 'a save based on an old revision is refused (no silent overwrite)');

  console.log('\nRoles and teams (A and B must be Admins of the Preview project):');
  for (const t of ['app_users', 'user_audit', 'teams', 'team_members', 'team_tasks']) {
    const r = await rest(`/${t}?select=*&limit=1`, { token: A });
    ok(denied(r) || (Array.isArray(r.json) && r.json.length === 0), `A cannot read ${t} directly (HTTP ${r.status})`);
  }
  const users = await rest('/rpc/admin_list_users', { token: A, method: 'POST', body: {} });
  const me = (await rest('/rpc/my_access', { token: A, method: 'POST', body: {} })).json || {};
  if (me.role !== 'super_admin') ok(denied(users), `A (an Admin) cannot list users (HTTP ${users.status})`);
  const role = await rest('/rpc/admin_set_role', { token: B, method: 'POST', body: { p_user_id: bId, p_role: 'super_admin' } });
  ok(denied(role) || (role.json && /own role/.test(role.json.message || '')), `B cannot promote itself (HTTP ${role.status})`);
  const bTeams = (await rest('/rpc/team_list', { token: B, method: 'POST', body: { p_scope: 'all' } }));
  const bMe = (await rest('/rpc/my_access', { token: B, method: 'POST', body: {} })).json || {};
  if (bMe.role !== 'super_admin') ok(denied(bTeams), `B (an Admin) cannot list all teams (HTTP ${bTeams.status})`);

  console.log('\nAccount B (another signed-in user):');
  const all = (await rest('/snapshots?select=user_id,rev', { token: B })).json || [];
  ok(Array.isArray(all) && all.every(r => r.user_id === bId), `B only sees its own rows (${all.length} visible)`);
  const target = (await rest(`/snapshots?select=rev&user_id=eq.${encodeURIComponent(aId)}`, { token: B })).json;
  ok(Array.isArray(target) && target.length === 0, "B cannot read A's row even when asking for it");
  const upd = await rest(`/snapshots?user_id=eq.${encodeURIComponent(aId)}`, { token: B, method: 'PATCH', body: { rev: 'hijacked', snapshot: snap }, prefer: 'return=representation' });
  ok(denied(upd) || (Array.isArray(upd.json) && upd.json.length === 0), `B cannot update A's row (HTTP ${upd.status})`);
  const del = await rest(`/snapshots?user_id=eq.${encodeURIComponent(aId)}`, { token: B, method: 'DELETE', prefer: 'return=representation' });
  ok(denied(del) || (Array.isArray(del.json) && del.json.length === 0), `B cannot delete A's row (HTTP ${del.status})`);
  const ins = await rest('/snapshots', { token: B, method: 'POST', body: { user_id: aId, slot: 'real', rev: 'hijacked-insert', snapshot: snap } });
  ok(denied(ins) || ins.status === 409, `B cannot write a row in A's name (HTTP ${ins.status}${ins.json && ins.json.code ? ' ' + ins.json.code : ''})`);

  const after = (await rest('/snapshots?select=rev&slot=eq.real', { token: A })).json;
  ok(after && after[0] && after[0].rev === newRev, "A's row is unchanged after B's attempts");
} else {
  console.log('\n(TOKEN_A / TOKEN_B not set: signed-in isolation checks skipped)');
}

console.log(failed ? `\n✖ ${failed} check(s) failed` : '\n✔ All access checks passed');
process.exit(failed ? 1 : 0);
