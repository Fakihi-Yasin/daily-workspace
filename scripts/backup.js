#!/usr/bin/env node
// Usage: npm run backup            -> data/backups/sauvegarde-<date>.json
//        npm run backup -- <dir>   -> custom folder
process.removeAllListeners('warning');
const path = require('node:path');
const { open } = require('../lib/db');
const B = require('../lib/backup');
const BF = require('../lib/backup-file');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const out = path.resolve(process.argv[2] || path.join(dataDir, 'backups'));
const db = open(path.join(dataDir, 'tableau.sqlite'));
const file = BF.writeBackupFile(db, out);
const s = B.summary(B.dump(db).tables);
db.close();
console.log(`Backup written: ${file}`);
console.log(`  ${s.assets} sites/accounts, ${s.routines} routines, ${s.records} records, ${s.projects} projects, ${s.sessions} sessions`);
