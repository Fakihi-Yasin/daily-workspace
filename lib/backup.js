// Full backup (JSON of every table) and restore with a preview step. Runtime-neutral (Node server + browser build).
//
// Backup format (versioned):
//   { app: 'tableau-de-bord-local', format_version: 1, schema_version: 1, dataset_id, exported_at, exported_from,
//     timezone, tables: { <table>: [ {column: value, ...}, ... ] } }
// Record ids are kept as-is, so an export/import round trip (localhost → browser → future cloud) preserves every id.
const { TABLES, SCHEMA_VERSION, migrate } = require('./schema');
const E = require('./engine');

const APP_ID = 'tableau-de-bord-local';
const FORMAT_VERSION = 1;
const pending = new Map(); // token -> { data, at }

function dump(db, source = 'unknown') {
  const tables = {};
  for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all().map(r => ({ ...r }));
  const meta = Object.fromEntries(tables.meta.map(m => [m.key, m.value]));
  return { app: APP_ID, format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION, dataset_id: meta.dataset_id || null,
    exported_at: new Date().toISOString(), exported_from: source, timezone: E.tz(db), tables };
}

function summary(tables) {
  const c = (t) => (tables[t] || []).length;
  const dates = (tables.tasks || []).map(r => r.date).concat((tables.records || []).map(r => r.date)).filter(Boolean).sort();
  return {
    assets: c('assets'), routines: c('routines'), tasks: c('tasks'), records: c('records'), projects: c('projects'),
    milestones: c('milestones'), sessions: c('sessions'), videos: c('videos'), courses: c('courses'), challenges: c('challenges'),
    first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    asset_names: (tables.assets || []).slice(0, 30).map(a => `${a.name} (${a.kind})`),
  };
}

function validate(data) {
  if (!data || data.app !== APP_ID || typeof data.tables !== 'object') throw E.httpError(400, 'Unrecognized file: not a backup from this app');
  if (data.schema_version > SCHEMA_VERSION || (data.format_version || 1) > FORMAT_VERSION) throw E.httpError(400, 'Backup created by a newer version');
  for (const t of Object.keys(data.tables)) {
    if (!TABLES.includes(t)) throw E.httpError(400, `Unknown table: ${t}`);
    if (!Array.isArray(data.tables[t])) throw E.httpError(400, `Invalid table: ${t}`);
  }
  if (!data.tables.meta || !data.tables.meta.some(m => m.key === 'schema_version')) throw E.httpError(400, 'Incomplete backup');
}

function preview(db, data) {
  validate(data);
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60000) pending.delete(k);
  const token = globalThis.crypto.randomUUID();
  pending.set(token, { data, at: Date.now() });
  return { token, exported_at: data.exported_at, incoming: summary(data.tables), current: summary(dump(db).tables) };
}

function restoreInto(db, data) {
  validate(data);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    for (const t of TABLES) {
      const rows = data.tables[t] || [];
      if (!rows.length) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      for (const row of rows) {
        const keys = Object.keys(row).filter(k => cols.includes(k));
        db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
      }
    }
    db.exec('COMMIT');
    migrate(db); // backups from older versions lack newer columns/categories
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function apply(db, token, ctx) {
  const p = pending.get(token);
  if (!p) throw E.httpError(410, 'Preview expired: reload the file');
  // Safety copy of the data being replaced (a file on the server, a downloaded file in the browser build).
  const safety = ctx && ctx.safetyBackup ? ctx.safetyBackup(dump(db)) : null;
  restoreInto(db, p.data);
  pending.delete(token);
  return { ok: true, safety_backup: safety };
}

module.exports = { dump, preview, apply, restoreInto, summary, validate, APP_ID, FORMAT_VERSION };
