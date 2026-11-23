// In-browser backend: runs the same request handlers as the Node server (lib/api.js) against an
// in-memory SQLite database (sql.js), loaded from and saved to the signed-in user's own storage slot.
import A from '../lib/api.js';
import B from '../lib/backup.js';
import S from '../lib/schema.js';
import D from '../lib/demo.js';
import E from '../lib/engine.js';
import { wrapSqlJs } from './sqljs-adapter.js';
import { decode } from './storage.js';

const clone = (v) => (v === undefined ? { ok: true } : JSON.parse(JSON.stringify(v)));

// A stable fingerprint of a backup's contents, to recognise a file that was already imported.
async function fingerprint(data) {
  const bytes = new TextEncoder().encode(JSON.stringify({ d: data.dataset_id || null, t: data.tables || null }));
  const h = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// beforeRestore (optional, async): called before a restore preview and before applying it; the cloud
// build uses it to make sure this device holds the latest synced data (or refuses with an error).
// beforeWrite (optional, async): called before a user action; the cloud build uses it to fetch newer
// cloud data first when it hasn't checked recently.
export function createLocalBackend({ userId, storage, SQL, safetyBackup, beforeRestore, beforeWrite }) {
  if (!userId) throw new Error('A signed-in user is required');
  let mode = storage.getPref(userId, 'mode') === 'demo' ? 'demo' : 'real';
  const dbs = {};
  const revs = {};
  let closed = false;
  const previewPrints = new Map(); // restore preview token -> fingerprint of the incoming file

  // userChange: the write comes from a user action (not GET-time housekeeping such as generating
  // today's checklist, which is re-derived from any copy of the data).
  function persist(slot, userChange = true) {
    const db = dbs[slot];
    if (!db || !db.dirty) return;
    db.clearDirty();
    revs[slot] = storage.save(userId, slot, B.dump(db, 'browser'), { userChange });
  }

  function open(slot) {
    const db = wrapSqlJs(new SQL.Database());
    S.init(db);
    const snap = storage.load(userId, slot);
    // Loading a snapshot is not a change: only real writes after this point mark the data dirty
    // (otherwise every load or cloud pull would save, and sync, a new revision).
    if (snap) { B.restoreInto(db, decode(snap)); db.clearDirty(); }
    else if (slot === 'demo') D.seedDemo(db);
    A.ensureDefaults(db);
    dbs[slot] = db;
    revs[slot] = snap ? snap.rev : null;
    if (!snap) db.markDirty();
    persist(slot, false);
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
    const isPreview = url.pathname === '/api/restore/preview' && method === 'POST';
    const isApply = url.pathname === '/api/restore/apply' && method === 'POST';
    if ((isPreview || isApply) && beforeRestore) await beforeRestore();
    else if (method !== 'GET' && beforeWrite && mode === 'real') await beforeWrite();
    const db = current();
    const slot = mode;
    const ctx = { db: () => db, source: 'browser', safetyBackup };
    try {
      const res = await A.handle(ctx, { method }, url, body ? JSON.parse(JSON.stringify(body)) : {});
      if (isPreview && res && res.token) {
        // Importing the same file again replaces data with identical records (ids are kept), so it can
        // never create duplicates; the preview also says when this exact file was already imported.
        const print = await fingerprint(body);
        previewPrints.set(res.token, print);
        const last = JSON.parse(E.getMeta(db, 'last_import') || 'null');
        res.already_imported = last && last.sha256 === print ? last.at : null;
      }
      if (isApply && previewPrints.has(body.token)) {
        E.setMeta(db, 'last_import', JSON.stringify({ sha256: previewPrints.get(body.token), at: new Date().toISOString() }));
        previewPrints.delete(body.token);
      }
      return clone(res);
    } catch (e) {
      const err = new Error(e.message || 'Error'); err.status = e.status; err.conflict = e.conflict; throw err;
    } finally {
      persist(slot, method !== 'GET'); // GET requests may also write (daily checklist generation, timer expiry)
    }
  }

  return {
    request,
    get mode() { return mode; },
    close() { closed = true; for (const k of Object.keys(dbs)) { try { dbs[k].close(); } catch { /* ignore */ } delete dbs[k]; } },
  };
}
