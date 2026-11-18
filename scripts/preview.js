#!/usr/bin/env node
// Serves a built folder (dist/ or dist-test/) locally, the way Vercel serves static files.
//   npm run preview            → http://localhost:4322 (dist/)
//   node scripts/preview.js dist-test 4323
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || 'dist');
const port = +(process.argv[3] || process.env.PORT || 4322);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
if (!fs.existsSync(path.join(dir, 'index.html'))) { console.error(`No build in ${dir}. Run npm run build first.`); process.exit(1); }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dir, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Preview of ${path.basename(dir)}/ → http://localhost:${port}`));
