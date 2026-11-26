// Cloud sync (web/cloud-store.js): two devices of one account, offline edits, conflicts, retries,
// backup import into the cloud account, and pre-sync browser data left untouched.
// The fake server below applies the same compare-and-swap rules as public.save_snapshot()
// (supabase/migrations); row-level security itself is checked live by scripts/check-rls.mjs.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

// Fake Supabase: rows keyed by the caller's user id (what RLS enforces), CAS on rev.
function fakeServer() {
  const rows = new Map();
  const net = { down: false, loseResponse: false, writes: 0 };
  const remoteFor = (uid) => {
    const guard = () => { if (net.down) throw Object.assign(new Error('No connection'), { offline: true }); };
    const key = (slot) => uid + '/' + slot;
    const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
    return {
      async head(slot) { guard(); const r = rows.get(key(slot)); return r ? { rev: r.rev } : null; },
      async get(slot) { guard(); return copy(rows.get(key(slot))); },
      async save(slot, expected, rev, snapshot) {
        guard();
        const cur = rows.get(key(slot));
        let res;
        if (cur && cur.rev === rev) res = { status: 'ok', rev };
        else if ((cur ? cur.rev : null) !== (expected || null)) res = { status: 'conflict', rev: cur ? cur.rev : null };
        else { rows.set(key(slot), { rev, snapshot: copy(snapshot) }); net.writes++; res = { status: 'ok', rev }; }
        if (net.loseResponse) { net.loseResponse = false; throw Object.assign(new Error('No connection'), { offline: true }); }
        return res;
      },
    };
  };
  return { rows, net, remoteFor };
}

let SQL, createLocalBackend, createLocalStore, createCloudStore;
before(async () => {
  SQL = await require('sql.js')();
  ({ createLocalBackend } = await import('../web/local-backend.js'));
  ({ createLocalStore } = await import('../web/storage.js'));
  ({ createCloudStore } = await import('../web/cloud-store.js'));
});

const ME = 'auth0|me000000000000000000000';
const OTHER = 'auth0|other0000000000000000';
const noTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };

// One "browser": its own localStorage, a cloud store and the real in-browser backend.
async function device(server, { ls = new MemStorage(), uid = ME } = {}) {
  const local = createLocalStore(ls);
  const store = createCloudStore({ ls, userId: uid, remote: server.remoteFor(uid), localStore: local, timers: noTimers });
  await store.init();
  const copies = [];
  const be = createLocalBackend({ userId: uid, storage: store, SQL, safetyBackup: () => 'safety.json', beforeRestore: () => store.ensureFresh(), beforeWrite: () => store.freshen() });
  return { ls, store, be, copies, keep: (snap, which) => copies.push(which), req: (m, p, b) => be.request(m, p, b) };
}
const projectNames = async (d) => (await d.req('GET', '/api/projects')).map(p => p.name).sort();

test('a project created and edited on one device appears on another device of the same account', async () => {
  const srv = fakeServer();
  const a = await device(srv);
  const b = await device(srv);
  await a.req('GET', '/api/today'); await a.req('GET', '/api/stats'); // today's checklist generated (a real write) on A
  const p = await a.req('POST', '/api/projects', { name: 'IPTV Belgium', status: 'in_progress' });
  assert.equal(a.store.status().pending, true, 'pending until the cloud confirms');
  assert.equal(await a.store.push(), 'synced');
  assert.equal(a.store.status().pending, false);

  assert.equal(await b.store.pull(), 'pulled');
  assert.deepEqual(await projectNames(b), ['IPTV Belgium']);
  await b.req('GET', '/api/today'); await b.req('GET', '/api/stats');
  assert.equal(b.store.status().pending, false, 'reading pulled data does not create a new revision');

  await b.req('PUT', `/api/projects/${p.id}`, { name: 'IPTV Belgium (renamed)' });
  await b.store.push();
  await a.store.pull();
  assert.deepEqual(await projectNames(a), ['IPTV Belgium (renamed)']);
  // A fresh browser signing in later loads the cloud copy.
  const c = await device(srv);
  assert.deepEqual(await projectNames(c), ['IPTV Belgium (renamed)']);
});

test('another account never receives my data', async () => {
  const srv = fakeServer();
  const a = await device(srv);
  await a.req('POST', '/api/projects', { name: 'Mine', status: 'idea' });
  await a.store.push();
  const o = await device(srv, { uid: OTHER });
  assert.deepEqual(await projectNames(o), []);
});

test('offline changes are kept, survive a reload and are sent when the connection returns', async () => {
  const srv = fakeServer();
  const ls = new MemStorage();
  const a = await device(srv, { ls });
  await a.req('GET', '/api/today'); await a.store.push();
  srv.net.down = true;
  await a.req('POST', '/api/projects', { name: 'Written offline', status: 'idea' });
  assert.equal(await a.store.push(), 'offline');
  assert.equal(a.store.status().pending, true);
  assert.match(a.store.status().error, /kept on this device/);

  // Tab closed and reopened while still offline: the change is still here.
  const again = await device(srv, { ls });
  assert.equal(again.store.status().state, 'offline');
  assert.deepEqual(await projectNames(again), ['Written offline']);
  srv.net.down = false;
  await again.store.push();
  assert.equal(again.store.status().pending, false);
  assert.deepEqual(await projectNames(await device(srv)), ['Written offline']);
});

test('a retry after a lost response does not write twice', async () => {
  const srv = fakeServer();
  const a = await device(srv);
  await a.req('POST', '/api/projects', { name: 'Once', status: 'idea' });
  srv.net.loseResponse = true;
  assert.equal(await a.store.push(), 'offline');
  const writes = srv.net.writes;
  assert.equal(await a.store.push(), 'synced', 'same revision accepted as already saved');
  assert.equal(srv.net.writes, writes, 'no second write');
  assert.deepEqual(await projectNames(await device(srv)), ['Once']);
});

test('concurrent edits never overwrite the cloud silently; the user picks a version and the other is downloaded', async () => {
  const srv = fakeServer();
  const a = await device(srv);
  await a.req('GET', '/api/today'); await a.store.push();
  const b = await device(srv);
  srv.net.down = true;
  await b.req('POST', '/api/projects', { name: 'From B (offline)', status: 'idea' });
  await b.store.push();
  srv.net.down = false;
  await a.req('POST', '/api/projects', { name: 'From A', status: 'idea' });
  await a.store.push();

  assert.equal(await b.store.push(), 'conflict');
  assert.equal(b.store.status().pending, true, "B's change is still kept");
  assert.deepEqual(await projectNames(await device(srv)), ['From A'], 'cloud untouched by B');
  // While in conflict, further edits on B stay local.
  await b.req('POST', '/api/projects', { name: 'B again', status: 'idea' });
  assert.deepEqual(await projectNames(await device(srv)), ['From A']);

  // Keep this device's version: the cloud version is downloaded first, then replaced explicitly.
  await b.store.resolveKeepDevice(b.keep);
  assert.deepEqual(b.copies, ['cloud']);
  assert.equal(b.store.status().state, 'synced');
  assert.deepEqual(await projectNames(await device(srv)), ['B again', 'From B (offline)']);

  // A now has nothing pending: it simply pulls the new cloud version.
  assert.equal(await a.store.pull(), 'pulled');
  assert.deepEqual(await projectNames(a), ['B again', 'From B (offline)']);
});

test('conflict resolved by using the cloud version downloads this device’s version first', async () => {
  const srv = fakeServer();
  const a = await device(srv); await a.req('GET', '/api/today'); await a.store.push();
  const b = await device(srv);
  srv.net.down = true; await b.req('POST', '/api/projects', { name: 'Local only', status: 'idea' }); srv.net.down = false;
  await a.req('POST', '/api/projects', { name: 'Cloud', status: 'idea' }); await a.store.push();
  assert.equal(await b.store.pull(), 'conflict');
  await b.store.resolveKeepCloud(b.keep);
  assert.deepEqual(b.copies, ['this-device']);
  assert.deepEqual(await projectNames(b), ['Cloud']);
  assert.equal(b.store.status().pending, false);
});

test('a reload with unsynced changes and a newer cloud version starts in conflict, not overwrite', async () => {
  const srv = fakeServer();
  const ls = new MemStorage();
  const a = await device(srv, { ls }); await a.req('GET', '/api/today'); await a.store.push();
  srv.net.down = true; await a.req('POST', '/api/projects', { name: 'Unsynced', status: 'idea' }); srv.net.down = false;
  const other = await device(srv); await other.req('POST', '/api/projects', { name: 'Other device', status: 'idea' }); await other.store.push();
  const reopened = await device(srv, { ls });
  assert.equal(reopened.store.status().state, 'conflict');
  assert.deepEqual(await projectNames(reopened), ['Unsynced'], 'local version still shown');
  assert.deepEqual(await projectNames(await device(srv)), ['Other device'], 'cloud untouched');
});

test('importing a JSON backup into the cloud account: preview first, no duplicates on retry, legacy browser data untouched', async () => {
  const srv = fakeServer();
  const ls = new MemStorage();
  // Pre-sync data of this account in this browser (V1 storage).
  const v1 = createLocalBackend({ userId: ME, storage: createLocalStore(ls), SQL, safetyBackup: () => 'x' });
  await v1.request('POST', '/api/projects', { name: 'Old browser project', status: 'in_progress' });
  const today = (await v1.request('GET', '/api/bootstrap')).today;
  await v1.request('POST', '/api/todos', { title: 'Carry me', date: addDays(today, -2) });
  const exported = JSON.parse(JSON.stringify(await v1.request('GET', '/api/backup')));
  v1.close();
  const legacyBefore = new Map([...ls.m].filter(([k]) => k.startsWith('dash.v1.')));

  const a = await device(srv, { ls });
  assert.deepEqual(await projectNames(a), [], 'cloud account starts empty: nothing imported automatically');
  await a.store.push();

  const pv = await a.req('POST', '/api/restore/preview', exported);
  assert.equal(pv.current.projects, 0); assert.equal(pv.incoming.projects, 1); assert.equal(pv.already_imported, null);
  assert.deepEqual(await projectNames(a), [], 'preview changes nothing');
  await a.req('POST', '/api/restore/apply', { token: pv.token });
  await a.store.push();

  const b = await device(srv);
  assert.deepEqual(await projectNames(b), ['Old browser project'], 'imported data reaches another device');
  // Unfinished task from 2 days ago carries forward as overdue (red indicator) on the other device.
  const todos = (await b.req('GET', '/api/today')).todos;
  const t = todos.find(x => x.title === 'Carry me');
  assert.ok(t && t.overdue && !t.done_for_day, 'carried forward as overdue');

  // Retrying the same import: flagged as already imported, and no duplicate records.
  const pv2 = await a.req('POST', '/api/restore/preview', exported);
  assert.ok(pv2.already_imported);
  await a.req('POST', '/api/restore/apply', { token: pv2.token });
  await a.store.push();
  const back = await (await device(srv)).req('GET', '/api/backup');
  assert.equal(back.tables.projects.length, 1);
  assert.equal(back.tables.todos.filter(x => x.title === 'Carry me').length, 1);
  assert.deepEqual(back.tables.projects.map(p => p.id), exported.tables.projects.map(p => p.id), 'ids kept');

  // The pre-sync browser data was neither modified nor cleared.
  for (const [k, v] of legacyBefore) assert.equal(ls.getItem(k), v, 'legacy key changed: ' + k);
});

test('a restore is refused while this device cannot confirm it holds the latest cloud data', async () => {
  const srv = fakeServer();
  const a = await device(srv); await a.req('GET', '/api/today'); await a.store.push();
  const exported = JSON.parse(JSON.stringify(await a.req('GET', '/api/backup')));
  srv.net.down = true;
  await assert.rejects(a.req('POST', '/api/restore/preview', exported), /connection|offline|sync/i);
  srv.net.down = false;
  const b = await device(srv); await b.req('POST', '/api/projects', { name: 'Newer', status: 'idea' }); await b.store.push();
  // a has nothing pending: it pulls first, so the preview compares against the newest cloud data.
  const pv = await a.req('POST', '/api/restore/preview', exported);
  assert.equal(pv.current.projects, 1);
});

test('automatic writes (today’s checklist) on two devices do not cause a conflict', async () => {
  const srv = fakeServer();
  const a = await device(srv); await a.req('POST', '/api/projects', { name: 'P', status: 'idea' }); await a.store.push();
  const b = await device(srv);
  // Both devices open Today offline-ish: each generates the checklist locally (automatic write).
  await b.req('GET', '/api/today');
  await a.req('GET', '/api/today'); await a.req('POST', '/api/todos', { title: 'Made on A', date: (await a.req('GET', '/api/bootstrap')).today });
  await a.store.push();
  assert.equal(b.store.status().pending, true);
  assert.equal(await b.store.push(), 'pulled', 'automatic-only changes give way to the cloud version');
  assert.equal(b.store.status().state, 'synced');
  assert.deepEqual((await b.req('GET', '/api/today')).todos.map(t => t.title), ['Made on A']);
});

test('a user action first fetches newer cloud data when it has not been checked recently', async () => {
  const srv = fakeServer();
  const a = await device(srv); await a.req('GET', '/api/today'); await a.store.push();
  const b = await device(srv); await b.req('GET', '/api/today');
  await a.req('POST', '/api/projects', { name: 'From A', status: 'idea' }); await a.store.push();
  const realNow = Date.now; Date.now = () => realNow() + 60000; // b's last check is a minute old
  try { await b.req('POST', '/api/projects', { name: 'From B', status: 'idea' }); } finally { Date.now = realNow; }
  assert.equal(await b.store.push(), 'synced', 'no conflict: B wrote on top of A');
  assert.deepEqual(await projectNames(await device(srv)), ['From A', 'From B']);
});

function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

test('a blocked account stops syncing at once: nothing retried, the device keeps its changes and sync state', async () => {
  const srv = fakeServer();
  const a = await device(srv);
  await a.req('POST', '/api/projects', { name: 'Kept locally', status: 'in_progress' });
  assert.equal(await a.store.push(), 'synced');
  const before = a.ls.getItem(`dash.v2.u.${encodeURIComponent(ME)}.real.sync`);
  // The account gets blocked: every call is refused with `denied`.
  const deny = async () => { throw Object.assign(new Error('This account is blocked or waiting for access.'), { denied: true, status: 403 }); };
  const remote = srv.remoteFor(ME);
  remote.head = deny; remote.get = deny; remote.save = deny;
  const b = createCloudStore({ ls: a.ls, userId: ME, remote, localStore: createLocalStore(a.ls), timers: noTimers });
  await b.init();
  assert.equal(b.status().state, 'denied');
  assert.equal(await b.pull(), 'denied', 'stopped: no more requests');
  assert.equal(a.ls.getItem(`dash.v2.u.${encodeURIComponent(ME)}.real.sync`), before, 'sync metadata untouched (no fake "cloud is empty")');
});

test('a rejected access token renews once and a temporary token error does not request login', async () => {
  const { createRpc } = await import('../web/supabase-rpc.js');
  const fresh = [];
  const request = createRpc({
    url: 'https://workspace.test', publishableKey: 'test',
    getToken: async (opts) => { fresh.push(!!opts?.fresh); return opts?.fresh ? 'renewed' : 'expired'; },
    fetchImpl: async (_url, opts) => opts.headers.Authorization === 'Bearer expired'
      ? new Response(JSON.stringify({ code: 'PGRST303', message: 'JWT expired' }), { status: 401 })
      : new Response(JSON.stringify({ status: 'ok' })),
  });
  assert.deepEqual(await request('my_access'), { status: 'ok' });
  assert.deepEqual(fresh, [false, true]);

  const unavailable = createRpc({
    url: 'https://workspace.test', publishableKey: 'test',
    getToken: async () => { throw new Error('Temporary network failure'); },
    fetchImpl: async () => assert.fail('should not send a request without a token'),
  });
  await assert.rejects(unavailable('my_access'), e => !e.auth && /Temporary network failure/.test(e.message));
});
