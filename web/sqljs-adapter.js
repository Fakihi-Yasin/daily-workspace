// Wraps a sql.js Database with the small subset of the node:sqlite DatabaseSync API the app uses
// (exec, prepare().run/get/all), so lib/*.js runs unchanged in the browser.
// It also tracks whether anything was written, so the backend only saves when data changed.

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v);
const READ_ONLY = /^\s*(SELECT|PRAGMA\s+table_info)/i;

export function wrapSqlJs(sqlDb) {
  let dirty = false;
  const db = {
    raw: sqlDb,
    get dirty() { return dirty; },
    clearDirty() { dirty = false; },
    markDirty() { dirty = true; },
    exec(sql) {
      sqlDb.exec(sql);
      if (!READ_ONLY.test(sql)) dirty = true;
    },
    prepare(sql) {
      return {
        run(...params) {
          const st = sqlDb.prepare(sql);
          try { st.run(params.map(norm)); } finally { st.free(); }
          const changes = sqlDb.getRowsModified();
          if (changes) dirty = true;
          const res = sqlDb.exec('SELECT last_insert_rowid()');
          return { changes, lastInsertRowid: res.length ? res[0].values[0][0] : 0 };
        },
        get(...params) {
          const st = sqlDb.prepare(sql);
          try {
            st.bind(params.map(norm));
            return st.step() ? st.getAsObject() : undefined;
          } finally { st.free(); }
        },
        all(...params) {
          const st = sqlDb.prepare(sql);
          const out = [];
          try {
            st.bind(params.map(norm));
            while (st.step()) out.push(st.getAsObject());
          } finally { st.free(); }
          return out;
        },
      };
    },
    close() { sqlDb.close(); },
  };
  return db;
}
