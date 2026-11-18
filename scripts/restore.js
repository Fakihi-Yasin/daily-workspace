#!/usr/bin/env node
// Usage: npm run restore -- <fichier.json>          (preview only)
//        npm run restore -- <fichier.json> --yes    (replaces the data; stop the app first)
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db');
const B = require('../lib/backup');
const BF = require('../lib/backup-file');
const file = process.argv[2];
if (!file) { console.error('Give the file: npm run restore -- path/backup.json [--yes]'); process.exit(1); }
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
B.validate(data);
const db = open(path.join(dataDir, 'tableau.sqlite'));
const cur = B.summary(B.dump(db).tables), inc = B.summary(data.tables);
console.log('                 current → backup');
for (const k of ['assets', 'routines', 'tasks', 'records', 'projects', 'milestones', 'sessions', 'videos', 'courses', 'challenges']) {
  console.log(`  ${k.padEnd(12)} ${String(cur[k]).padStart(6)} → ${inc[k]}`);
}
console.log(`  period       ${cur.first_date || '—'}..${cur.last_date || '—'} → ${inc.first_date || '—'}..${inc.last_date || '—'}`);
if (!process.argv.includes('--yes')) { console.log('\nPreview only. Run again with --yes to replace the data.'); db.close(); process.exit(0); }
const safety = BF.writeBackupFile(db, path.join(dataDir, 'backups'), 'before-restore');
B.restoreInto(db, data);
db.close();
console.log(`\nRestored. Safety copy of the previous data: ${safety}`);
