// Cloud-synced storage for the browser build (Supabase), with this browser as an offline cache.
//
// It implements the same synchronous interface as createLocalStore() (see storage.js), so the
// dashboard engine is unchanged. The 'real' slot is cached in localStorage under its own
// namespace (dash.v2…) and synced to the `snapshots` table; the 'demo' slot stays local-only.
// Pre-sync browser data (dash.v1…) is never read, modified or deleted here: it can be imported
// explicitly from Settings → Backup.
//
// Sync rules
//   * Every local save is written to localStorage first and marked "pending" until the cloud
//     confirms it, so a closed tab, an expired session or a network failure never loses a change.
//   * Saves are a compare-and-swap (save_snapshot RPC): the cloud only accepts a write based on the
//     revision this device last synced. A newer cloud version is never overwritten silently: the
//     device enters "conflict" and the user chooses which version to keep (the other one is
//     downloaded as a backup file first).
//   * Retrying a save reuses its revision id, so a retry after a lost response never writes twice.
//   * Without pending changes, newer cloud data is pulled automatically (on focus, every 20 s).
import { encode } from './storage.js';

const NS = 'dash.v2';
const SLOT = 'real';
const POLL_MS = 20000;
const PUSH_DELAY_MS = 600;

export const newRev = () => `${Date.now().toString(36)}-${(globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).slice(0, 13)}`;

// Thin PostgREST client. `getToken` returns the Auth0 access token (Supabase Third-Party Auth).
export function createSupabaseRemote({ url, publishableKey, getToken, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  // Temporary diagnostics for the cloud-sync branch Preview, enabled explicitly by URL.
  const diagnostics = typeof window !== 'undefined'
    && window.location.hostname === 'daily-workspace-git-cloud-sync-fakihiyassin01-9610s-projects.vercel.app'
    && new URLSearchParams(window.location.search).get('sync-debug') === '1';
  const report = (stage, details = {}) => {
    if (!diagnostics) return;
    const record = JSON.stringify({ stage, ...details });
    const root = document.documentElement;
    const previous = JSON.parse(root.dataset.syncDiagnostics || '[]');
    root.dataset.syncDiagnostics = JSON.stringify([...previous.slice(-15), JSON.parse(record)]);
    console.info('Cloud sync diagnostic: ' + record);
  };
  const safeCode = (code) => typeof code === 'string'
    && /^(?:PGRST[0-9]{3}|[0-9A-Z]{5}|UNAUTHORIZED(?:_[A-Z_]{1,32})?|invalid_jwt|permission_denied)$/.test(code)
    ? code : undefined;
  const base = url.replace(/\/+$/, '') + '/rest/v1';
  async function call(path, init = {}) {
    let token;
    try { token = await getToken(); }
    catch (e) {
      report('token retrieval failed', {
        code: /missing refresh token/i.test(e.message) ? 'missing_refresh_token' : undefined,
        offline: !!e.offline,
      });
      throw Object.assign(new Error(e.message || 'Sign-in expired'), { auth: !e.offline, offline: !!e.offline });
    }
    if (diagnostics) {
      try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(payload));
        report('token retrieved', {
          issuerMatches: claims.iss === 'https://dev-fpl2q3wyjaf17edb.us.auth0.com/',
          audienceMatches: [claims.aud].flat().includes('https://daily-workspace-sync'),
          roleMatches: claims.role === 'authenticated',
          rolePresent: Object.hasOwn(claims, 'role'),
        });
      } catch {
        report('token retrieved without readable JWT claims');
      }
    }
    let res;
    report('sending Supabase request');
    try {
      res = await fetchImpl(base + path, { ...init, headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    } catch (e) {
      report('Supabase request failed before an HTTP response');
      throw Object.assign(new Error('No connection to the sync server'), { offline: true });
    }
    report('Supabase HTTP response', { status: res.status });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      report('Supabase response could not be parsed', { status: res.status });
      throw error;
    }
    report('Supabase response received', { status: res.status, code: safeCode(body?.code ?? body?.error_code) });
    if (!res.ok) {
      const msg = (body && (body.message || body.msg || body.error)) || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Sync server: ${msg}`), { status: res.status, auth: res.status === 401 || /jwt|token/i.test(msg) });
    }
    return body;
  }
  return {
    async head(slot) {
      const rows = await call(`/snapshots?select=rev,updated_at&slot=eq.${slot}`);
      return rows[0] || null;
    },
    async get(slot) {
      const rows = await call(`/snapshots?select=rev,snapshot,updated_at&slot=eq.${slot}`);
      return rows[0] || null;
    },
    async save(slot, expectedRev, rev, snapshot) {
      return call('/rpc/save_snapshot', { method: 'POST', body: JSON.stringify({ p_slot: slot, p_expected_rev: expectedRev, p_new_rev: rev, p_snapshot: snapshot }) });
    },
  };
}

export function createCloudStore({ ls = globalThis.localStorage, userId, remote, localStore, onChange = () => {}, timers = globalThis }) {
  const k = (s) => `${NS}.u.${encodeURIComponent(userId)}.${s}`;
  const KEY = k(SLOT), META = k(SLOT + '.sync');
  const readMeta = () => { try { return JSON.parse(ls.getItem(META)) || {}; } catch { return {}; } };
  const writeMeta = (m) => ls.setItem(META, JSON.stringify(m));
  const readSnap = () => { const raw = ls.getItem(KEY); return raw ? JSON.parse(raw) : null; };

  // Sync metadata (localStorage, survives reloads): base = cloud revision this cache was last in sync
  // with; pending = local changes not yet in the cloud; userChanges = some of them come from user actions.
  const status = { state: 'idle', error: null, conflict: null, lastSync: null };
  let pushTimer = null, pollTimer = null, inflight = null, stopped = false, retryDelay = 2000;

  const emit = (patch) => { Object.assign(status, patch); onChange({ ...status, pending: !!readMeta().pending }); };

  function writeLocal(snap, meta) {
    try {
      ls.setItem(KEY, JSON.stringify(snap));
    } catch {
      throw Object.assign(new Error('Browser storage is full: the last change could not be saved on this device. Export a backup (Settings → Backup).'), { storageFull: true });
    }
    writeMeta(meta);
  }

  function adoptCloud(row) {
    writeLocal(row.snapshot, { base: row.rev, pending: false });
    Object.assign(status, { state: 'synced', error: null, conflict: null, lastSync: new Date().toISOString() });
    onChange({ ...status, pending: false, pulled: true }); // the UI reloads its data
  }

  function schedulePush(delay = PUSH_DELAY_MS) {
    if (stopped) return;
    timers.clearTimeout(pushTimer);
    pushTimer = timers.setTimeout(() => { push().catch(() => {}); }, delay);
  }

  function fail(e) {
    if (e.auth) emit({ state: 'signin', error: 'Your session expired. Sign in again to sync. Your changes are kept on this device.' });
    else if (e.offline) emit({ state: 'offline', error: 'Offline. Changes are kept on this device and will sync when the connection returns.' });
    else emit({ state: 'error', error: e.message || String(e) });
  }

  const CONFLICT = 'This dashboard was changed on another device while this one had unsynced changes.';
  let lastCheck = 0;

  // The cloud has a newer version than the one this device's pending changes are based on.
  // If those pending changes are only automatic housekeeping (e.g. today's checklist generated on
  // load), nothing the user did is at stake: take the cloud version, the app re-derives the rest.
  // Otherwise stop and let the user choose (nothing is overwritten on either side).
  async function onNewerCloud(cloudRev) {
    if (!readMeta().userChanges) {
      const row = await remote.get(SLOT);
      if (row && !readMeta().userChanges) { adoptCloud(row); return 'pulled'; }
      if (!row) { writeMeta({ ...readMeta(), base: null }); schedulePush(0); return status.state; }
    }
    emit({ state: 'conflict', error: CONFLICT, conflict: { cloudRev } });
    return status.state;
  }

  // Send local pending changes. Resolves to the resulting state.
  async function push() {
    if (inflight) { await inflight.catch(() => {}); }
    const meta = readMeta();
    if (!meta.pending || status.state === 'conflict' || stopped) return status.state;
    const snap = readSnap();
    if (!snap) return status.state;
    const run = (async () => {
      emit({ state: 'saving' });
      try {
        const r = await remote.save(SLOT, meta.base || null, snap.rev, snap);
        lastCheck = Date.now();
        if (r && r.status === 'ok') {
          // Only clear "pending" if nothing changed locally while the request was in flight.
          const cur = readSnap();
          const stillPending = !(cur && cur.rev === snap.rev);
          writeMeta({ base: r.rev, pending: stillPending, userChanges: stillPending && !!readMeta().userChanges });
          retryDelay = 2000;
          emit({ state: 'synced', error: null, conflict: null, lastSync: new Date().toISOString() });
          if (stillPending) schedulePush(0);
          return status.state;
        }
        return await onNewerCloud(r ? r.rev : null);
      } catch (e) {
        fail(e);
        if (!e.auth) { schedulePush(retryDelay); retryDelay = Math.min(retryDelay * 2, 60000); }
      }
      return status.state;
    })();
    inflight = run;
    try { return await run; } finally { if (inflight === run) inflight = null; }
  }

  // Check the cloud for a newer version and pull it (see onNewerCloud when this device has pending changes).
  async function pull() {
    if (stopped) return status.state;
    if (inflight) { await inflight.catch(() => {}); }
    try {
      const head = await remote.head(SLOT);
      lastCheck = Date.now();
      const meta = readMeta();
      const cloudRev = head ? head.rev : null;
      if (cloudRev === (meta.base || null)) {
        if (meta.pending) return push();
        if (status.state !== 'synced' && status.state !== 'conflict') emit({ state: 'synced', error: null });
        return status.state;
      }
      if (meta.pending) return await onNewerCloud(cloudRev);
      if (!head) return status.state; // cloud row gone and nothing local pending: keep the cache untouched
      const row = await remote.get(SLOT);
      if (row && !readMeta().pending) { adoptCloud(row); return 'pulled'; }
      return status.state;
    } catch (e) { fail(e); return status.state; }
  }

  const store = {
    kind: 'cloud',
    // Called once before the dashboard mounts.
    async init() {
      const meta = readMeta();
      let row;
      try { row = await remote.get(SLOT); }
      catch (e) { fail(e); return status; } // keep working from this device's copy
      const cloudRev = row ? row.rev : null;
      lastCheck = Date.now();
      if (meta.pending) {
        if (cloudRev === (meta.base || null)) { emit({ state: 'idle' }); schedulePush(0); }
        else if (!meta.userChanges && row) adoptCloud(row);
        else emit({ state: 'conflict', error: CONFLICT, conflict: { cloudRev } });
      } else if (row) adoptCloud(row);
      else {
        // Brand-new cloud account. Drop a stale cache from a cloud row that no longer exists.
        if (meta.base) { ls.removeItem(KEY); writeMeta({}); }
        emit({ state: 'synced', lastSync: new Date().toISOString() });
      }
      return status;
    },
    start() {
      stopped = false;
      pollTimer = timers.setInterval(() => { pull(); }, POLL_MS);
    },
    stop() { stopped = true; timers.clearInterval(pollTimer); timers.clearTimeout(pushTimer); },
    status: () => ({ ...status, pending: !!readMeta().pending }),
    push, pull,
    // Before a user action: if the cloud wasn't checked in the last few seconds, check it now (bounded
    // wait), so edits are made on top of the latest version and conflicts stay rare.
    async freshen(maxWaitMs = 2500) {
      if (Date.now() - lastCheck < 8000 || status.state === 'conflict') return;
      let t;
      await Promise.race([pull().catch(() => {}), new Promise(r => { t = timers.setTimeout(r, maxWaitMs); })]);
      timers.clearTimeout(t);
    },
    // Make sure this device has the latest cloud data and nothing unsynced (used before a restore).
    async ensureFresh() {
      if (readMeta().pending) await push();
      if (readMeta().pending) throw new Error(status.error || 'Changes on this device are not synced yet. Try again when sync is back.');
      await pull();
      if (['conflict', 'offline', 'signin', 'error'].includes(status.state)) throw new Error(status.error || 'Sync is not available right now.');
    },
    // Conflict resolution. Both download the version being discarded first (via `keepCopy`).
    async resolveKeepCloud(keepCopy) {
      const row = await remote.get(SLOT);
      const local = readSnap();
      if (local) keepCopy(local, 'this-device');
      if (row) adoptCloud(row); else { ls.removeItem(KEY); writeMeta({}); emit({ state: 'synced', conflict: null, error: null }); }
    },
    async resolveKeepDevice(keepCopy) {
      const row = await remote.get(SLOT);
      if (row) keepCopy(row.snapshot, 'cloud');
      const local = readSnap();
      if (!local) throw new Error('Nothing saved on this device');
      // Rebase the local version on the cloud revision we just saw (and saved as a file): a new
      // revision id makes it a fresh, explicit write.
      const snap = { ...local, rev: newRev() };
      writeLocal(snap, { base: row ? row.rev : null, pending: true, userChanges: true });
      emit({ state: 'idle', conflict: null, error: null });
      return push();
    },

    // ---- storage interface used by the backend ----
    load(uid, slot) {
      if (slot !== SLOT) return localStore.load(uid, slot);
      return readSnap();
    },
    save(uid, slot, backup, { userChange = true } = {}) {
      if (slot !== SLOT) return localStore.save(uid, slot, backup);
      const rev = newRev();
      const meta = readMeta();
      writeLocal(encode(backup, rev), { base: meta.base || null, pending: true, userChanges: !!meta.userChanges || userChange });
      emit({});
      if (status.state !== 'conflict') schedulePush();
      return rev;
    },
    revision(uid, slot) {
      if (slot !== SLOT) return localStore.revision(uid, slot);
      const s = ls.getItem(KEY);
      if (!s) return null;
      const m = /"rev":"([^"]+)"/.exec(s.slice(0, 200));
      return m ? m[1] : readSnap().rev;
    },
    remove(uid, slot) { if (slot !== SLOT) return localStore.remove(uid, slot); throw new Error('Synced data cannot be removed from here'); },
    getPref: (uid, name) => localStore.getPref(uid, name),
    setPref: (uid, name, value) => localStore.setPref(uid, name, value),
    bytesUsed: (uid) => {
      let n = localStore.bytesUsed(uid);
      const p = `${NS}.u.${encodeURIComponent(uid)}.`;
      for (let i = 0; i < ls.length; i++) { const key = ls.key(i); if (key && key.startsWith(p)) n += (key.length + (ls.getItem(key) || '').length) * 2; }
      return n;
    },
  };
  return store;
}
