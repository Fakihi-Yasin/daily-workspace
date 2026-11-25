#!/usr/bin/env node
// TEST ONLY: a local stand-in for Supabase's REST API, for browser tests of the test build (fake
// sign-in tokens "test-token.<name>"). It runs the REAL migrations in PGlite (in-process Postgres,
// see test/support/supabase-pg.mjs) and calls the database functions the way PostgREST does, so
// roles, blocked status and team membership are enforced by the same SQL as in Supabase.
// Data is in memory only and disappears when the server stops. Never used by a deployable build.
//
//   node scripts/fake-sync-server.js 54321
//   SUPABASE_URL=http://localhost:54321 SUPABASE_PUBLISHABLE_KEY=sb_publishable_test npm run build:test
//
// Test controls (no sign-in): /__down?v=1|0 simulates an outage; /__bootstrap?user=<name> makes
// test|<name> the first Super Admin (what DEPLOY.md does in the Supabase SQL editor).
const http = require('node:http');
const port = +(process.argv[2] || 54321);
let down = false;

(async () => {
  const { createDb, claimsFor } = await import('../test/support/supabase-pg.mjs');
  const pg = await createDb();

  http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.method === 'OPTIONS') return send(204);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__down') { down = url.searchParams.get('v') === '1'; return send(200, { down }); }
    if (url.pathname === '/__bootstrap') {
      return pg.admin('select app_private.bootstrap_super_admin($1) as r', ['test|' + url.searchParams.get('user')])
        .then(r => send(200, r.rows[0]), e => send(400, { message: e.message }));
    }
    if (down) { req.socket.destroy(); return; }
    const m = /^Bearer test-token\.([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    const claims = m ? claimsFor('test|' + m[1], { email: m[1] + '@test.invalid', name: m[1] }) : null;
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const fn = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
      if (req.method !== 'POST' || !fn) return send(404, { message: 'not found' });
      let args;
      try { args = body ? JSON.parse(body) : {}; } catch { return send(400, { message: 'invalid JSON' }); }
      try {
        const r = await pg.rpc(claims, fn[1], args);
        send(200, r === null ? null : r);
      } catch (e) {
        // PostgREST: insufficient privilege → 401 signed out / 403 signed in; other errors → 400.
        const status = e.code === '42501' ? (claims ? 403 : 401) : e.code === '42883' ? 404 : 400;
        send(status, { code: e.code, message: e.message, hint: e.hint || null });
      }
    });
  }).listen(port, '127.0.0.1', () => console.log(`Fake Supabase (TEST ONLY, PGlite) → http://localhost:${port}`));
})();
