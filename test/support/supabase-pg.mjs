// TEST ONLY: a local stand-in for the Supabase database, running the real migrations in PGlite
// (Postgres compiled to WebAssembly, in-process). Calls are made the way PostgREST makes them:
// inside a transaction, as the `authenticated` role, with the caller's JWT claims in
// `request.jwt.claims`, so grants, row-level security and SECURITY DEFINER checks all apply.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLAIM_NS = 'https://daily-workspace/';

// What Supabase provides before any migration: API roles, auth.jwt(), and its default privileges
// (everything new in `public` is granted to anon/authenticated — migrations must revoke explicitly).
const SHIM = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

// `afterMigration(file, db)` runs after each migration file (to seed data an older version would have had).
export async function createDb({ afterMigration } = {}) {
  const db = new PGlite();
  await db.exec(SHIM);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (afterMigration) await afterMigration(f, db);
  }

  let queue = Promise.resolve(); // one connection: run requests one after the other
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  // Run `fn(tx)` as an API request: role anon (claims = null) or authenticated with these claims.
  const asRequest = (claims, fn) => serial(async () => {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${claims ? 'authenticated' : 'anon'}`);
      if (claims) await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const r = await fn(db);
      await db.exec('commit');
      return r;
    } catch (e) { await db.exec('rollback').catch(() => {}); throw e; }
  });

  // PostgREST-style RPC: named arguments, JSON result.
  const rpc = (claims, name, args = {}) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('bad function name');
    const keys = Object.keys(args);
    keys.forEach(k => { if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('bad argument name'); });
    const vals = keys.map(k => (args[k] === null || args[k] === undefined ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : String(args[k])));
    const sqlText = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    return asRequest(claims, async (tx) => (await tx.query(sqlText, vals)).rows[0].r);
  };

  return {
    db, rpc, asRequest,
    // Direct SQL as the database owner (the Supabase SQL editor).
    admin: (q, params) => serial(() => db.query(q, params)),
    close: () => db.close(),
  };
}

// Claims like the ones the Auth0 post-login Action puts in the access token.
export function claimsFor(sub, { email, name, verified = true, createdAt } = {}) {
  return { sub, role: 'authenticated', aud: 'https://daily-workspace-sync',
    [CLAIM_NS + 'email']: email ?? null, [CLAIM_NS + 'email_verified']: verified, [CLAIM_NS + 'name']: name ?? null,
    ...(createdAt ? { [CLAIM_NS + 'created_at']: createdAt } : {}) };
}
