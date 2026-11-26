#!/usr/bin/env node
// Builds the static, sign-in-protected browser version of the dashboard (for Vercel) into dist/.
//
//   AUTH0_DOMAIN=your-tenant.eu.auth0.com AUTH0_CLIENT_ID=xxxx npm run build
//
// Both values are public identifiers of an Auth0 *Single Page Application* (no client secret is
// used or needed). The build fails without them, so an unprotected dashboard can't be produced.
// `npm run build:test` builds dist-test/ with a fake identity provider for automated tests only;
// that provider is refused for dist/ and for any build running on Vercel.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const provider = process.env.AUTH_PROVIDER || 'auth0';
const outdir = path.join(ROOT, process.env.OUT_DIR || (provider === 'test' ? 'dist-test' : 'dist'));

function fail(msg) { console.error('\n✖ Build stopped: ' + msg + '\n'); process.exit(1); }

if (!['auth0', 'test'].includes(provider)) fail(`unknown AUTH_PROVIDER "${provider}"`);
if (provider === 'test' && (process.env.VERCEL || path.basename(outdir) === 'dist')) {
  fail('the test identity provider can never be used for a deployable build (dist/ or Vercel).');
}
const config = { provider };
if (provider === 'auth0') {
  const domain = (process.env.AUTH0_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const clientId = (process.env.AUTH0_CLIENT_ID || '').trim();
  if (!domain || !clientId) fail('AUTH0_DOMAIN and AUTH0_CLIENT_ID must be set (see DEPLOY.md). Refusing to build a dashboard without sign-in.');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) fail(`AUTH0_DOMAIN "${domain}" doesn't look like a domain (expected e.g. my-tenant.eu.auth0.com).`);
  if (!/^[A-Za-z0-9_-]{8,}$/.test(clientId)) fail('AUTH0_CLIENT_ID looks invalid.');
  config.domain = domain;
  config.clientId = clientId;
}

// Optional cloud sync (Supabase). Without these variables the build keeps the browser-only storage.
// Only the PUBLISHABLE key may be used here: it ends up in the JavaScript sent to every visitor.
const sbUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const sbKey = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const audience = (process.env.AUTH0_AUDIENCE || '').trim();
if (sbUrl || sbKey) {
  if (!sbUrl || !sbKey) fail('set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or neither, for browser-only storage).');
  const localTest = provider === 'test' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(sbUrl); // fake sync server, test builds only
  if (!localTest && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(sbUrl)) fail('SUPABASE_URL should look like https://<project-ref>.supabase.co');
  if (/^sb_secret_/i.test(sbKey) || /service_role/i.test(jwtRole(sbKey))) {
    fail('SUPABASE_PUBLISHABLE_KEY is a SECRET / service_role key. Never put it in the frontend: use the publishable key (sb_publishable_…), and rotate the secret key if it was exposed.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(sbKey) && jwtRole(sbKey) !== 'anon') fail('SUPABASE_PUBLISHABLE_KEY should be the publishable key (sb_publishable_…).');
  if (provider === 'auth0' && !audience) fail('AUTH0_AUDIENCE must be set with Supabase sync (the identifier of the Auth0 API whose tokens Supabase accepts, see DEPLOY.md).');
  config.supabase = { url: sbUrl, publishableKey: sbKey };
  if (audience) config.audience = audience;
}
function jwtRole(k) {
  const parts = k.split('.');
  if (parts.length !== 3) return '';
  try { return String(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role || ''); } catch { return ''; }
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(path.join(outdir, 'assets', 'fonts'), { recursive: true });

const r = (p) => path.join(ROOT, p);
esbuild.buildSync({
  entryPoints: [r('web/entry.js')],
  outfile: path.join(outdir, 'assets', 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'eof',
  // sql.js has Node-only branches that are never taken in the browser.
  external: ['fs', 'path', 'crypto'],
  alias: {
    preact: r('public/vendor/preact.js'),
    'preact/hooks': r('public/vendor/hooks.js'),
    htm: r('public/vendor/htm.js'),
    '@auth-provider': r(`web/auth-${provider}.js`),
  },
  logLevel: 'warning',
});

const copy = (from, to) => fs.copyFileSync(r(from), path.join(outdir, to));
copy('public/styles.css', 'assets/styles.css');
copy('public/favicon.svg', 'favicon.svg');
// PC Work Time agent for Ubuntu, downloaded by the install command shown in Settings → PC Work Time.
fs.mkdirSync(path.join(outdir, 'pc-agent'), { recursive: true });
for (const f of ['dw-pc-time.py', 'install.sh', 'uninstall.sh', 'install-macos.sh', 'install-windows.ps1']) copy(`agent/${f}`, `pc-agent/${f}`);
for (const sub of ['gnome-extension', 'browser-extension']) {
  fs.mkdirSync(path.join(outdir, 'pc-agent', sub), { recursive: true });
  for (const f of fs.readdirSync(r(`agent/${sub}`))) copy(`agent/${sub}/${f}`, `pc-agent/${sub}/${f}`);
}
for (const f of fs.readdirSync(r('public/fonts'))) copy(`public/fonts/${f}`, `assets/fonts/${f}`);
copy('node_modules/sql.js/dist/sql-wasm.wasm', 'assets/sql-wasm.wasm');
// Stylesheet lives in /assets/: point font URLs there.
const cssPath = path.join(outdir, 'assets', 'styles.css');
fs.writeFileSync(cssPath, fs.readFileSync(cssPath, 'utf8').replaceAll('url(/fonts/', 'url(/assets/fonts/'));

// Runtime config (public values only) + theme before first paint, as a file so the CSP needs no inline script.
fs.writeFileSync(path.join(outdir, 'assets', 'boot.js'), `window.__DASH_CONFIG = ${JSON.stringify(config)};
window.__DASH_DEFER_MOUNT = true;
try { var t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
`);

const authOrigin = provider === 'auth0' ? `https://${config.domain}` : '';
const syncOrigin = config.supabase ? config.supabase.url : '';
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // data: avatars uploaded by users; blob: resizing a photo before upload; Google profile photos.
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  `connect-src 'self' ${authOrigin} ${syncOrigin}`.replace(/\s+/g, ' ').trim(),
  `frame-src ${authOrigin || "'none'"}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

fs.writeFileSync(path.join(outdir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Today · Dashboard</title>
  <link rel="icon" href="/favicon.svg?v=green" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/styles.css" />
  <script src="/assets/boot.js"></script>
</head>
<body>
  <div id="app"></div>
  <noscript>Enable JavaScript to use the dashboard.</noscript>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>
`);
fs.writeFileSync(path.join(outdir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const size = fs.statSync(path.join(outdir, 'assets', 'app.js')).size;
console.log(`✔ Built ${path.relative(ROOT, outdir)}/ (auth: ${provider}${config.domain ? ' @ ' + config.domain : ''}, storage: ${config.supabase ? 'Supabase sync @ ' + config.supabase.url : 'browser only'}, app.js ${(size / 1024).toFixed(0)} KB)`);
