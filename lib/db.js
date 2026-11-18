// Node storage: SQLite file via the built-in node:sqlite (localhost server, CLI scripts).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const S = require('./schema');

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  return S.init(db);
}

module.exports = { open, tx: S.tx, migrate: S.migrate, TABLES: S.TABLES, SCHEMA_VERSION: S.SCHEMA_VERSION };
