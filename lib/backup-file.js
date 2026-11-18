// Node-only: write a backup JSON file to disk (server safety copies and the CLI).
const fs = require('node:fs');
const path = require('node:path');
const B = require('./backup');

function writeBackupFile(db, dir, prefix = 'backup') {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${prefix}-${stamp}.json`);
  return writeDump(B.dump(db, 'localhost-cli'), file);
}
function writeDump(data, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}
module.exports = { writeBackupFile, writeDump };
