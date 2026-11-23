// Browser (Vercel) entry: sign-in gate first; the dashboard only mounts for an authenticated user,
// with a backend bound to that user's own storage slot.
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createAuth } from '@auth-provider';
import { createLocalBackend } from './local-backend.js';
import { createLocalStore, decode, ACTIVE_USER_KEY } from './storage.js';
import { createCloudStore, createSupabaseRemote } from './cloud-store.js';
import { mount } from '../public/js/app.js';
import { downloadJson, bus } from '../public/js/lib.js';

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
        <p class="muted">Access is by invitation. ${cfg.supabase ? 'Your dashboard syncs across your signed-in devices.' : 'Your dashboard data stays in this browser.'}</p>
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

  const local = createLocalStore(window.localStorage);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  let storage = local;
  let sync = null;
  if (cfg.supabase) {
    root.innerHTML = '<main class="signin"><p class="muted">Loading your data…</p></main>';
    sync = createSyncController(auth, local);
    storage = sync.store;
    await storage.init();
    storage.start();
  }
  const SQL = await initSqlJs({ locateFile: (f) => '/assets/' + f });
  const backend = createLocalBackend({
    userId: auth.user.id,
    storage,
    SQL,
    // Before a restore replaces data, the current data is downloaded as a file.
    safetyBackup: (data) => { const name = `dashboard-before-restore-${stamp()}.json`; downloadJson(data, name); return name; },
    beforeRestore: sync ? () => storage.ensureFresh() : undefined,
    beforeWrite: sync ? () => storage.freshen() : undefined,
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
    storageKind: sync ? 'cloud' : 'browser',
    sync: sync && sync.api,
    // Dashboard data saved in this browser before cloud sync (never modified or deleted by the app).
    legacyBackup: () => { if (!sync) return null; try { const s = local.load(auth.user.id, 'real'); return s ? decode(s) : null; } catch { return null; } },
    bytesUsed: () => storage.bytesUsed(auth.user.id),
    logout: async () => {
      if (sync && storage.status().pending && !window.confirm('Some changes have not reached the cloud yet. They stay saved in this browser and will sync the next time you sign in here. Sign out anyway?')) return;
      if (sync) storage.stop();
      backend.close();
      root.innerHTML = '';
      window.localStorage.removeItem(ACTIVE_USER_KEY);
      await auth.logout();
    },
  };
  root.innerHTML = ''; // remove the full-height "Loading…" placeholder, or it stays under the dashboard as empty scroll space
  mount(root);
}

// Cloud sync (Supabase) wiring: status for the UI, retries on reconnect/focus, conflict actions.
function createSyncController(auth, local) {
  const listeners = new Set();
  let last = { state: 'idle' };
  const remote = createSupabaseRemote({ url: cfg.supabase.url, publishableKey: cfg.supabase.publishableKey, getToken: auth.getToken });
  const store = createCloudStore({
    ls: window.localStorage, userId: auth.user.id, remote, localStore: local,
    onChange: (s) => { last = s; listeners.forEach(fn => fn(s)); if (s.pulled) bus.emit(false); },
  });
  const keepCopy = (snap, which) => downloadJson(decode(snap), `dashboard-${which}-version-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  const refresh = () => { bus.emit(false); };
  window.addEventListener('online', () => { store.push().then(() => store.pull()); });
  window.addEventListener('focus', () => { store.pull(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.push(); });
  window.addEventListener('beforeunload', (e) => { if (store.status().pending) { store.push(); e.preventDefault(); e.returnValue = ''; } });
  return {
    store,
    api: {
      status: () => store.status(),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      retry: async () => { await store.push(); await store.pull(); refresh(); },
      signInAgain: () => auth.login(),
      keepCloud: async () => { await store.resolveKeepCloud(keepCopy); refresh(); },
      keepDevice: async () => { await store.resolveKeepDevice(keepCopy); refresh(); },
      get last() { return last; },
    },
  };
}

start();
