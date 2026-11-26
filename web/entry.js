// Browser (Vercel) entry: sign-in gate first; the dashboard only mounts for an authenticated user,
// with a backend bound to that user's own storage slot.
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createAuth } from '@auth-provider';
import { createLocalBackend } from './local-backend.js';
import { createLocalStore, decode, ACTIVE_USER_KEY } from './storage.js';
import { createCloudStore, createSupabaseRemote } from './cloud-store.js';
import { createRpc } from './supabase-rpc.js';
import { mount } from '../public/js/app.js';
import { render } from 'preact';
import { downloadJson, bus } from '../public/js/lib.js';

const cfg = window.__DASH_CONFIG || {};
const root = document.getElementById('app');

// An invite link (#/invite/<token>) survives sign-in, sign-up and signing out to switch accounts.
const PENDING_INVITE = 'dash.pendingInvite';
const inviteInHash = () => (/^#\/invite\/([A-Za-z0-9_-]{20,200})$/.exec(window.location.hash) || [])[1];
function rememberInvite() {
  const t = inviteInHash();
  try { if (t) window.localStorage.setItem(PENDING_INVITE, t); return t || window.localStorage.getItem(PENDING_INVITE); } catch { return t; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function signInScreen(auth, error) {
  const test = auth && auth.provider === 'test';
  root.innerHTML = `
    <main class="signin">
      <div class="signin-card card">
        <div class="brand signin-brand"><i>✓</i><span>Dashboard</span></div>
        <h1>Sign in</h1>
        ${rememberInvite() ? `<p class="notice blue" role="note"><strong>You’ve been invited to join a team.</strong> Sign in, or create an account, with the email address the invite was sent to.</p>` : ''}
        <p class="muted">Access is by invitation. ${cfg.supabase ? 'Your dashboard syncs across your signed-in devices.' : 'Your dashboard data stays in this browser.'}</p>
        ${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''}
        ${test
          ? `<p class="notice"><strong>Test build</strong> — fake identity provider for automated tests. Never deployed.</p>
             <form id="test-login" class="row wrap"><input id="test-user" type="text" placeholder="test account name" aria-label="Test account" required style="flex:1" />
             <button class="btn primary">Sign in (test)</button></form>`
          : `<div class="row wrap"><button id="login" class="btn primary lg" ${auth ? '' : 'disabled'}>Sign in</button>
             ${rememberInvite() ? `<button id="signup" class="btn lg" ${auth ? '' : 'disabled'}>Create an account</button>` : ''}</div>`}
      </div>
    </main>`;
  const btn = document.getElementById('login');
  if (btn && auth) btn.addEventListener('click', () => { btn.disabled = true; auth.login(); });
  const up = document.getElementById('signup');
  if (up && auth) up.addEventListener('click', () => { up.disabled = true; auth.login({ signup: true }); });
  // Someone signed in from another tab: load that account here too.
  window.addEventListener('storage', (e) => { if (e.key === ACTIVE_USER_KEY && e.newValue) window.location.reload(); });
  const form = document.getElementById('test-login');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); auth.login(document.getElementById('test-user').value.trim()); });
}

async function start() {
  root.innerHTML = '<main class="signin"><p class="muted">Loading…</p></main>';
  rememberInvite();
  let auth;
  try {
    auth = await createAuth({ ...cfg, resume: !!window.localStorage.getItem(ACTIVE_USER_KEY) });
  } catch (e) {
    return signInScreen(null, 'Sign-in is unavailable: ' + (e.message || e));
  }
  let redirecting = false;
  const reauthenticate = async () => {
    if (redirecting || navigator.onLine === false) return;
    redirecting = true;
    try { await auth.login(); }
    catch { redirecting = false; }
  };

  if (!auth.user) {
    signInScreen(auth, auth.error);
    if (auth.sessionExpired) void reauthenticate();
    return;
  }

  // With Supabase, the database decides who may use the workspace: every active account (any role)
  // gets its own dashboard; a blocked account is refused.
  let rpc = null, access = null;
  if (cfg.supabase) {
    const request = createRpc({ url: cfg.supabase.url, publishableKey: cfg.supabase.publishableKey, getToken: auth.getToken });
    rpc = async (name, args) => {
      try { return await request(name, args); }
      catch (e) { if (e.auth) void reauthenticate(); throw e; }
    };
    root.innerHTML = '<main class="signin"><p class="muted">Checking access…</p></main>';
    access = await checkAccess(rpc, auth);
    if (!access) return;
    if (!hasWorkspace(access)) return gateScreen(auth, access);
  }

  const local = createLocalStore(window.localStorage);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  let storage = local;
  let sync = null;
  let monitor = null;
  if (cfg.supabase) {
    root.innerHTML = '<main class="signin"><p class="muted">Loading your data…</p></main>';
    sync = createSyncController(auth, local, rpc, () => monitor && monitor.check(), () => redirecting);
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
    // Role from the database ('user' | 'admin' | 'super_admin'), or null without Supabase (no roles, no Team Work).
    role: access ? access.role : null,
    features: (access && access.features) || [],
    // Database functions for Team Work and User Management; a refusal re-checks this account's access.
    rpc: rpc ? async (name, args) => {
      try { return await rpc(name, args); }
      catch (e) { if (e.denied) monitor && monitor.check(); throw e; }
    } : null,
    provider: auth.provider,
    // Own profile (display name, photo) from the database; Team Work and Users show the same avatar.
    profile: access && access.profile ? access.profile : null,
    // Re-read this account with a fresh sign-in token (e.g. after confirming the email address).
    refreshMe: rpc ? async () => {
      try { await auth.getToken({ fresh: true }); } catch (e) { if (e.auth) void reauthenticate(); throw e; }
      const me = await rpc('register_me');
      window.__dash.profile = me.profile || window.__dash.profile;
      return me;
    } : null,
    // Team invites: /api/invite saves the invitation and emails it when a provider is set up (api/_invite.mjs).
    sendInvite: rpc ? async (teamId, email) => {
      let token;
      try { token = await auth.getToken({ fresh: true }); } catch (e) { if (e.auth) void reauthenticate(); throw e; }
      let res;
      try {
        res = await fetch('/api/invite', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ team_id: teamId, email }) });
      } catch { throw Object.assign(new Error('No connection to the server. No invite was sent.'), { offline: true }); }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      // 200 = the invitation is saved; body.emailed says whether an email actually went out.
      if (!res.ok || !body || body.saved !== true) throw Object.assign(new Error((body && body.message) || `The invite wasn’t sent (HTTP ${res.status}).`), { status: res.status, code: body && body.code, missing: body && body.missing });
      return body;
    } : null,
    clearPendingInvite: () => { try { window.localStorage.removeItem(PENDING_INVITE); } catch { /* none */ } },
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
  // Back from sign-in / sign-up / switching accounts with an invite still open: show it.
  let pending = null;
  try { pending = window.localStorage.getItem(PENDING_INVITE); } catch { /* none */ }
  if (rpc && pending && (!window.location.hash || inviteInHash())) window.location.hash = '#/invite/' + pending;
  root.innerHTML = ''; // remove the full-height "Loading…" placeholder, or it stays under the dashboard as empty scroll space
  mount(root);

  if (rpc) {
    // A role change or a block applies to this already-open browser on its next check.
    monitor = startAccessMonitor(rpc, auth, access, (next) => {
      render(null, root); // unmount the dashboard first: nothing of it stays on screen
      if (sync) storage.stop();
      backend.close();
      window.__dash = null;
      gateScreen(auth, next);
    });
  }
}

// Every active account opens its own dashboard, whatever its role ('user' is the default for new
// signups). Only a blocked account is kept out. The database enforces the same rule on every call.
const hasWorkspace = (a) => !!a && a.status === 'active';
const accessKey = (auth) => `dash.v2.u.${encodeURIComponent(auth.user.id)}.access`;

// Registers this account on first sign-in (as 'admin') and returns its role and status. Offline, the
// last known answer for this account in this browser is used so the personal dashboard still opens
// from its local copy; the database re-checks on every sync request anyway.
async function checkAccess(rpc, auth) {
  try {
    const me = await rpc('register_me');
    // Features granted to this account (e.g. PC Work Time); the database enforces them on every call.
    try { me.features = (await rpc('my_access')).features || []; } catch { me.features = []; }
    window.localStorage.setItem(accessKey(auth), JSON.stringify({ role: me.role, status: me.status, features: me.features }));
    return me;
  } catch (e) {
    if (e.offline) {
      let cached = null;
      try { cached = JSON.parse(window.localStorage.getItem(accessKey(auth))); } catch { /* none */ }
      if (cached) return { ...cached, offline: true };
    }
    if (e.auth) { signInScreen(auth); return null; }
    gateScreen(auth, { error: e.offline ? 'You are offline, and this browser has never checked your access. Connect and try again.' : 'Could not check your access: ' + (e.message || e) });
    return null;
  }
}

function startAccessMonitor(rpc, auth, access, revoke) {
  let running = false, done = false;
  async function check() {
    if (running || done) return;
    running = true;
    try {
      const a = await rpc('my_access');
      window.localStorage.setItem(accessKey(auth), JSON.stringify({ role: a.role, status: a.status, features: a.features || [] }));
      if (!hasWorkspace(a)) { done = true; clearInterval(timer); revoke(a); }
      else if (a.role !== access.role) { done = true; window.location.reload(); } // role changed: rebuild the sidebar
    } catch { /* offline or a transient error: the next check retries */ }
    finally { running = false; }
  }
  const timer = setInterval(check, 20000);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  return { check };
}

// "Blocked", or an access-check error. Never shows any workspace data.
function gateScreen(auth, a) {
  const blocked = !a.error && a.status === 'blocked';
  const title = blocked ? 'This account is blocked' : 'Can’t open the workspace';
  const text = blocked ? 'Access to this workspace has been turned off for your account. Contact the workspace owner if you think this is a mistake.'
    : esc(a.error || 'Your account could not be checked. Try again in a moment.');
  root.innerHTML = `
    <main class="signin">
      <div class="signin-card card gate" role="${blocked ? 'alert' : 'status'}">
        <div class="brand signin-brand"><i>✓</i><span>Dashboard</span></div>
        <h1>${title}</h1>
        <p class="muted">${text}</p>
        <p class="gate-who"><strong>${esc(auth.user.name || auth.user.email || '')}</strong>${auth.user.email && auth.user.email !== auth.user.name ? `<br><span class="muted">${esc(auth.user.email)}</span>` : ''}</p>
        <div class="row wrap">
          ${blocked ? '' : '<button id="gate-retry" class="btn primary">Check again</button>'}
          <button id="gate-out" class="btn">Sign out</button>
        </div>
      </div>
    </main>`;
  const retry = document.getElementById('gate-retry');
  if (retry) retry.addEventListener('click', () => window.location.reload());
  document.getElementById('gate-out').addEventListener('click', async () => {
    window.localStorage.removeItem(ACTIVE_USER_KEY);
    await auth.logout();
  });
}

// Cloud sync (Supabase) wiring: status for the UI, retries on reconnect/focus, conflict actions.
function createSyncController(auth, local, rpc, onDenied, isRedirecting) {
  const listeners = new Set();
  let last = { state: 'idle' };
  const remote = createSupabaseRemote({ rpc });
  const store = createCloudStore({
    ls: window.localStorage, userId: auth.user.id, remote, localStore: local,
    onChange: (s) => { last = s; listeners.forEach(fn => fn(s)); if (s.pulled) bus.emit(false); if (s.state === 'denied') onDenied(); },
  });
  const keepCopy = (snap, which) => downloadJson(decode(snap), `dashboard-${which}-version-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  const refresh = () => { bus.emit(false); };
  window.addEventListener('online', () => { store.push().then(() => store.pull()); });
  window.addEventListener('focus', () => { store.pull(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.push(); });
  window.addEventListener('beforeunload', (e) => { if (store.status().pending && !isRedirecting()) { store.push(); e.preventDefault(); e.returnValue = ''; } });
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
