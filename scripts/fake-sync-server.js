#!/usr/bin/env node
// TEST ONLY: an in-memory stand-in for the Supabase REST endpoints the app uses, for browser tests
// of the test build (fake sign-in tokens "test-token.<name>"). Same compare-and-swap rules as
// public.save_snapshot(). Never used by a deployable build.
//   node scripts/fake-sync-server.js 54321
//   SUPABASE_URL=http://localhost:54321 SUPABASE_PUBLISHABLE_KEY=sb_publishable_test npm run build:test
const http = require('node:http');
const port = +(process.argv[2] || 54321);
const rows = new Map(); // `${user}/${slot}` -> { rev, snapshot, updated_at }
let down = false;

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204, {});
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__down') { down = url.searchParams.get('v') === '1'; return send(200, { down }); }
  if (down) { req.socket.destroy(); return; }
  const m = /^Bearer test-token\.(.+)$/.exec(req.headers.authorization || '');
  if (!m) return send(401, { message: 'JWT required' });
  const uid = 'test|' + m[1];
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && url.pathname === '/rest/v1/snapshots') {
      const slot = (url.searchParams.get('slot') || 'eq.real').replace(/^eq\./, '');
      const r = rows.get(`${uid}/${slot}`);
      const cols = (url.searchParams.get('select') || '*').split(',');
      return send(200, r ? [Object.fromEntries(cols.map(c => [c, r[c]]))] : []);
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/save_snapshot') {
      const b = JSON.parse(body);
      const k = `${uid}/${b.p_slot}`;
      const cur = rows.get(k);
      if (cur && cur.rev === b.p_new_rev) return send(200, { status: 'ok', rev: cur.rev });
      if ((cur ? cur.rev : null) !== (b.p_expected_rev || null)) return send(200, { status: 'conflict', rev: cur ? cur.rev : null });
      rows.set(k, { rev: b.p_new_rev, snapshot: b.p_snapshot, updated_at: new Date().toISOString() });
      return send(200, { status: 'ok', rev: b.p_new_rev });
    }
    send(404, { message: 'not found' });
  });
}).listen(port, '127.0.0.1', () => console.log(`Fake sync server (TEST ONLY) → http://localhost:${port}`));
