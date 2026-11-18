// Storage interface for the browser build.
//
// The dashboard engine never touches storage directly: the local backend loads and saves whole
// per-user snapshots through an object with this shape:
//
//   load(userId, slot)            -> snapshot | null
//   save(userId, slot, snapshot)  -> revision string
//   revision(userId, slot)        -> revision string | null   (cheap; detects writes from another tab)
//   remove(userId, slot)
//   getPref(userId, name) / setPref(userId, name, value)
//
// `slot` is 'real' or 'demo'. A future Supabase adapter only has to implement the same methods
// (e.g. a `snapshots` table keyed by user_id + slot, protected by row-level security).
//
// Snapshot format v1 (compact, columns stored once per table):
//   { format: 'dashboard-snapshot', version: 1, rev, saved_at, schema_version, dataset_id,
//     tables: { <table>: { c: [columns], r: [[values], ...] } } }
// encode()/decode() convert to and from the versioned backup format used for export/import.

const PREFIX = 'dash.v1';
export const ACTIVE_USER_KEY = `${PREFIX}.activeUser`;

export function encode(backup, rev) {
  const tables = {};
  for (const [name, rows] of Object.entries(backup.tables)) {
    const c = rows.length ? Object.keys(rows[0]) : [];
    tables[name] = { c, r: rows.map(row => c.map(k => row[k])) };
  }
  return { format: 'dashboard-snapshot', version: 1, rev, saved_at: new Date().toISOString(), schema_version: backup.schema_version,
    dataset_id: backup.dataset_id || null, timezone: backup.timezone, tables };
}

export function decode(snap) {
  if (!snap || snap.format !== 'dashboard-snapshot') throw new Error('Unrecognized saved data');
  if (snap.version > 1) throw new Error('Saved data comes from a newer version of the app');
  const tables = {};
  for (const [name, t] of Object.entries(snap.tables)) tables[name] = t.r.map(vals => Object.fromEntries(t.c.map((k, i) => [k, vals[i]])));
  return { app: 'tableau-de-bord-local', format_version: 1, schema_version: snap.schema_version, dataset_id: snap.dataset_id,
    exported_at: snap.saved_at, exported_from: 'browser', timezone: snap.timezone, tables };
}

export class StorageFullError extends Error {}

export function createLocalStore(ls = globalThis.localStorage) {
  const key = (userId, slot) => `${PREFIX}.u.${encodeURIComponent(userId)}.${slot}`;
  return {
    kind: 'localStorage',
    load(userId, slot) {
      const raw = ls.getItem(key(userId, slot));
      return raw ? JSON.parse(raw) : null;
    },
    save(userId, slot, backup) {
      const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        ls.setItem(key(userId, slot), JSON.stringify(encode(backup, rev)));
        ls.setItem(key(userId, slot) + '.rev', rev);
      } catch (e) {
        throw new StorageFullError('Browser storage is full: export a backup now (Settings → Backup). The last change is not saved.');
      }
      return rev;
    },
    revision(userId, slot) { return ls.getItem(key(userId, slot) + '.rev'); },
    remove(userId, slot) { ls.removeItem(key(userId, slot)); ls.removeItem(key(userId, slot) + '.rev'); },
    getPref(userId, name) { return ls.getItem(`${PREFIX}.u.${encodeURIComponent(userId)}.pref.${name}`); },
    setPref(userId, name, value) { ls.setItem(`${PREFIX}.u.${encodeURIComponent(userId)}.pref.${name}`, value); },
    bytesUsed(userId) {
      let n = 0;
      const p = `${PREFIX}.u.${encodeURIComponent(userId)}.`;
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(p)) n += (k.length + (ls.getItem(k) || '').length) * 2; }
      return n;
    },
  };
}
