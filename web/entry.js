// Browser (Vercel) entry: sign-in gate first; the dashboard only mounts for an authenticated user,
// with a backend bound to that user's own storage slot.
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createAuth } from '@auth-provider';
import { createLocalBackend } from './local-backend.js';
import { createLocalStore, ACTIVE_USER_KEY } from './storage.js';
import { mount } from '../public/js/app.js';
import { downloadJson } from '../public/js/lib.js';

const cfg = window.__DASH_CONFIG || {};
const root = document.getElementById('app');

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function signInScreen(auth, error) {
  const test = auth && auth.provider === 'test';
  root.innerHTML = `
    <main class="signin">
      <div class="signin-card card">
        <div class="brand signin-brand"><i>✓</i><span>Dashboard</span></div>
        <h1>Sign in</h1>
        <p class="muted">Access is by invitation. Your dashboard data stays in this browser.</p>
        ${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''}
        ${test
          ? `<p class="notice"><strong>Test build</strong> — fake identity provider for automated tests. Never deployed.</p>
             <form id="test-login" class="row wrap"><input id="test-user" type="text" placeholder="test account name" aria-label="Test account" required style="flex:1" />
             <button class="btn primary">Sign in (test)</button></form>`
          : `<button id="login" class="btn primary lg" ${auth ? '' : 'disabled'}>Sign in</button>`}
      </div>
    </main>`;
  const btn = document.getElementById('login');
  if (btn && auth) btn.addEventListener('click', () => { btn.disabled = true; auth.login(); });
  // Someone signed in from another tab: load that account here too.
  window.addEventListener('storage', (e) => { if (e.key === ACTIVE_USER_KEY && e.newValue) window.location.reload(); });
  const form = document.getElementById('test-login');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); auth.login(document.getElementById('test-user').value.trim()); });
}

async function start() {
  root.innerHTML = '<main class="signin"><p class="muted">Loading…</p></main>';
  let auth;
  try {
    auth = await createAuth(cfg);
  } catch (e) {
    return signInScreen(null, 'Sign-in is unavailable: ' + (e.message || e));
  }
  if (!auth.user) return signInScreen(auth, auth.error);

  const storage = createLocalStore(window.localStorage);
  const SQL = await initSqlJs({ locateFile: (f) => '/assets/' + f });
  const backend = createLocalBackend({
    userId: auth.user.id,
    storage,
    SQL,
    // Before a restore replaces data, the current data is downloaded as a file.
    safetyBackup: (data) => { const name = `dashboard-before-restore-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; downloadJson(data, name); return name; },
  });

  // Signing in as someone else in another tab: drop this account's data from the screen immediately.
  window.localStorage.setItem(ACTIVE_USER_KEY, auth.user.id);
  window.addEventListener('storage', (e) => {
    if (e.key === ACTIVE_USER_KEY && e.newValue !== auth.user.id) { backend.close(); root.innerHTML = ''; window.location.reload(); }
  });

  window.__dash = {
    backend,
    user: auth.user,
    provider: auth.provider,
    storageKind: 'browser',
    bytesUsed: () => storage.bytesUsed(auth.user.id),
    logout: async () => {
      backend.close();
      root.innerHTML = '';
      window.localStorage.removeItem(ACTIVE_USER_KEY);
      await auth.logout();
    },
  };
  mount(root);
}

start();
