#!/usr/bin/env node
// Local work dashboard — single-user, offline, localhost only.
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./lib/db');
const A = require('./lib/api');

const PORT = +process.env.PORT || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const MODE_FILE = path.join(DATA_DIR, 'mode.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const dbFile = (mode) => path.join(DATA_DIR, mode === 'demo' ? 'demo.sqlite' : 'tableau.sqlite');

let mode = 'real';
try { mode = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode === 'demo' ? 'demo' : 'real'; } catch { /* first run */ }
const dbs = {};
function getDb(m = mode) {
  if (!dbs[m]) {
    const isNew = !fs.existsSync(dbFile(m));
    dbs[m] = open(dbFile(m));
    if (m === 'demo' && isNew) require('./lib/demo').seedDemo(dbs[m]);
    A.ensureDefaults(dbs[m]);
  }
  return dbs[m];
}
getDb();

const BF = require('./lib/backup-file');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ctx = {
  db: () => getDb(),
  source: 'localhost',
  safetyBackup: (data) => BF.writeDump(data, path.join(BACKUP_DIR, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)),
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' };

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 100 * 1024 * 1024) { reject(Object.assign(new Error('File too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000' : 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  // Reject cross-site requests: only this local UI may call the API.
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origin refused' });
  try {
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    if (url.pathname === '/api/mode') {
      if (req.method === 'POST') {
        mode = body.mode === 'demo' ? 'demo' : 'real';
        fs.writeFileSync(MODE_FILE, JSON.stringify({ mode }));
      }
      getDb();
      return send(res, 200, { mode });
    }
    if (url.pathname === '/api/demo/reset' && req.method === 'POST') {
      if (dbs.demo) { dbs.demo.close(); delete dbs.demo; }
      for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile('demo') + s, { force: true });
      getDb('demo');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/backup' && req.method === 'GET') {
      const data = await A.handle(ctx, req, url, body);
      const name = `backup-${mode === 'demo' ? 'demo-' : ''}${new Date().toISOString().slice(0, 10)}.json`;
      return send(res, 200, JSON.stringify(data), { 'Content-Disposition': `attachment; filename="${name}"` });
    }
    const out = await A.handle(ctx, req, url, body);
    send(res, 200, out === undefined ? { ok: true } : out, { 'X-Mode': mode });
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Internal error: ' + e.message, ...(e.conflict ? { conflict: e.conflict } : {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard ready → http://localhost:${PORT}  (data: ${DATA_DIR}, mode: ${mode})`);
});

function shutdown() { for (const d of Object.values(dbs)) { try { d.close(); } catch { /* ignore */ } } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
