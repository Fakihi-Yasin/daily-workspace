// In-browser backend: runs the same request handlers as the Node server (lib/api.js) against an
// in-memory SQLite database (sql.js), loaded from and saved to the signed-in user's own storage slot.
import A from '../lib/api.js';
import B from '../lib/backup.js';
import S from '../lib/schema.js';
import D from '../lib/demo.js';
import { wrapSqlJs } from './sqljs-adapter.js';
import { decode } from './storage.js';

const clone = (v) => (v === undefined ? { ok: true } : JSON.parse(JSON.stringify(v)));

export function createLocalBackend({ userId, storage, SQL, safetyBackup }) {
  if (!userId) throw new Error('A signed-in user is required');
  let mode = storage.getPref(userId, 'mode') === 'demo' ? 'demo' : 'real';
  const dbs = {};
  const revs = {};
  let closed = false;

  function persist(slot) {
    const db = dbs[slot];
    if (!db || !db.dirty) return;
    db.clearDirty();
    revs[slot] = storage.save(userId, slot, B.dump(db, 'browser'));
  }

  function open(slot) {
    const db = wrapSqlJs(new SQL.Database());
    S.init(db);
    const snap = storage.load(userId, slot);
    if (snap) B.restoreInto(db, decode(snap));
    else if (slot === 'demo') D.seedDemo(db);
    A.ensureDefaults(db);
    dbs[slot] = db;
    revs[slot] = snap ? snap.rev : null;
    if (!snap) db.markDirty();
    persist(slot);
    return db;
  }

  // Another tab of the same account may have saved since we loaded: reload before reading or writing.
  function current() {
    if (closed) throw new Error('Signed out');
    const stored = storage.revision(userId, mode);
    if (dbs[mode] && stored && stored !== revs[mode]) { dbs[mode].close(); delete dbs[mode]; }
    return dbs[mode] || open(mode);
  }

  async function request(method, path, body) {
    const url = new URL(path, 'http://local.invalid');
    if (url.pathname === '/api/mode') {
      if (method === 'POST') { mode = body && body.mode === 'demo' ? 'demo' : 'real'; storage.setPref(userId, 'mode', mode); }
      current();
      return { mode };
    }
    if (url.pathname === '/api/demo/reset' && method === 'POST') {
      if (dbs.demo) { dbs.demo.close(); delete dbs.demo; }
      storage.remove(userId, 'demo');
      if (mode === 'demo') current();
      return { ok: true };
    }
    const db = current();
    const slot = mode;
    const ctx = { db: () => db, source: 'browser', safetyBackup };
    try {
      return clone(await A.handle(ctx, { method }, url, body ? JSON.parse(JSON.stringify(body)) : {}));
    } catch (e) {
      const err = new Error(e.message || 'Error'); err.status = e.status; err.conflict = e.conflict; throw err;
    } finally {
      persist(slot); // GET requests may also write (daily checklist generation, timer expiry)
    }
  }

  return {
    request,
    get mode() { return mode; },
    close() { closed = true; for (const k of Object.keys(dbs)) { try { dbs[k].close(); } catch { /* ignore */ } delete dbs[k]; } },
  };
}
