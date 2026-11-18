// End-to-end checks of the six required flows against a real server process and a real SQLite file.
// Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tableau-test-'));
const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tableau-fresh-'));
let proc, base;

function startServer(dataDir, port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) } });
    p.stdout.on('data', d => { if (String(d).includes('ready')) resolve(p); });
    p.stderr.on('data', d => process.stderr.write(d));
    p.on('exit', c => reject(new Error('server exited ' + c)));
  });
}
const stop = (p) => new Promise(r => { p.removeAllListeners('exit'); p.on('exit', r); p.kill('SIGTERM'); });
async function call(method, url, body, b = base) {
  const r = await fetch(b + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${j.error}`);
  return j;
}
const rawDb = () => new DatabaseSync(path.join(DIR, 'tableau.sqlite'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cat = (day, name) => day.score.categories.find(c => c.category === name);

let today, tomorrow, P = [], sites = [], fb, ig;

before(async () => {
  proc = await startServer(DIR, 4511); base = 'http://127.0.0.1:4511';
  today = (await call('GET', '/api/bootstrap')).today;
  tomorrow = (await call('GET', `/api/today?date=${today}`)).today; // same; compute below
  const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); tomorrow = d.toISOString().slice(0, 10);
  for (const n of ['Canada', 'France']) sites.push((await call('POST', '/api/assets', { kind: 'site_iptv', name: n, from_date: today })).id);
  for (const n of ['Cuisine', 'Crochet']) sites.push((await call('POST', '/api/assets', { kind: 'site_blog', name: n, from_date: today })).id);
  for (const n of ['P1', 'P2', 'P3', 'P4']) P.push((await call('POST', '/api/assets', { kind: 'pinterest', name: n, from_date: today })).id);
  fb = (await call('POST', '/api/assets', { kind: 'facebook', name: 'Page FB', from_date: today })).id;
  ig = (await call('POST', '/api/assets', { kind: 'instagram', name: 'Compte IG', from_date: today })).id;
});
after(async () => { if (proc) await stop(proc); });

test('0. opening the day repeatedly / concurrently never duplicates tasks', async () => {
  const days = await Promise.all(Array.from({ length: 8 }, () => call('GET', '/api/today')));
  const n = days[0].tasks.length;
  assert.ok(days.every(d => d.tasks.length === n));
  const db = rawDb();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE date=?').get(today).n, n);
  db.close();
  // 4 article sites + 4 Pinterest + 2 social slots + WhatsApp
  assert.equal(n, 11);
});

test('1. adding a 5th Pinterest account changes tomorrow, not today', async () => {
  const day = await call('GET', '/api/today');
  const pins = day.tasks.filter(t => t.unit === 'pin');
  const counts = [5, 3, 5, 2];
  for (let a = 0; a < 4; a++) for (let i = 1; i <= counts[a]; i++) await call('POST', `/api/tasks/${pins[a].id}/mark`, { kind: 'pin', idx: i, asset_id: pins[a].asset_id, done: true });
  let d = await call('GET', '/api/today');
  assert.deepEqual([cat(d, 'Pinterest').done, cat(d, 'Pinterest').target, cat(d, 'Pinterest').pct], [15, 20, 75]);

  const p5 = await call('POST', '/api/assets', { kind: 'pinterest', name: 'P5' }); // default effect: tomorrow
  assert.equal(p5.from_date, tomorrow);
  d = await call('GET', '/api/today');
  assert.deepEqual([cat(d, 'Pinterest').done, cat(d, 'Pinterest').target], [15, 20], 'today unchanged');
  const t = await call('GET', `/api/today?date=${tomorrow}`);
  assert.equal(cat(t, 'Pinterest').target, 25, 'tomorrow targets 5 accounts');

  // A target change effective tomorrow does not rewrite today either.
  const r = (await call('GET', '/api/routines')).find(x => x.name === 'Pinterest');
  await call('PUT', `/api/routines/${r.id}`, { config: { ...r.current.config, target: 6 }, from_date: tomorrow });
  d = await call('GET', '/api/today');
  assert.equal(cat(d, 'Pinterest').target, 20);
  assert.equal(cat(await call('GET', `/api/today?date=${tomorrow}`), 'Pinterest').target, 30);
  await call('PUT', `/api/routines/${r.id}`, { config: { ...r.current.config, target: 5 }, from_date: tomorrow });
});

test('2. log & undo Pins, articles, cross-posted video: dashboard, stats and challenge stay in sync', async () => {
  const ch = await call('POST', '/api/challenges', { name: 'Test', start_date: today, goals: [
    { metric: 'pin', period: 'day', per_asset: true, asset_ids: P, target: 5, label: 'pins' },
    { metric: 'article', period: 'total', target: 8, label: 'articles' },
    { metric: 'publication', period: 'day', target: 4, asset_ids: [fb, ig], label: 'pubs' },
    { metric: 'video', period: 'day', target: 2, label: 'videos' },
  ] });
  const snap = async () => {
    const d = await call('GET', '/api/today');
    const s = await call('GET', `/api/stats?from=${today}&to=${today}`);
    const c = (await call('GET', '/api/challenges')).find(x => x.id === ch.id);
    const g = (l) => c.goals.find(x => x.label === l);
    return { d, s, pins: g('pins'), arts: g('articles'), pubs: g('pubs'), vids: g('videos') };
  };
  let s = await snap();
  assert.equal(s.s.activity.pins, 15); assert.equal(s.pins.actual, 15); assert.equal(s.pins.achieved, 15);

  // Extra Pin on a full account: actual 6, goal still capped.
  const p1 = s.d.tasks.find(t => t.asset_id === P[0]);
  const extra = await call('POST', `/api/tasks/${p1.id}/extra`, { kind: 'pin', asset_id: P[0] });
  s = await snap();
  assert.equal(s.d.tasks.find(t => t.id === p1.id).progress.actual, 6);
  assert.equal(s.d.tasks.find(t => t.id === p1.id).progress.pct, 100);
  assert.equal(cat(s.d, 'Pinterest').done, 15);
  assert.equal(s.s.activity.pins, 16); assert.equal(s.pins.actual, 16); assert.equal(s.pins.achieved, 15);
  await call('DELETE', `/api/records/${extra.id}`);
  // Double-click / two tabs: marking the same box twice records it once.
  const p4 = s.d.tasks.find(t => t.asset_id === P[3]);
  await Promise.all([1, 2].map(() => call('POST', `/api/tasks/${p4.id}/mark`, { kind: 'pin', idx: 3, asset_id: P[3], done: true })));
  s = await snap();
  assert.equal(s.s.activity.pins, 16); assert.equal(s.pins.achieved, 16);
  await call('POST', `/api/tasks/${p4.id}/mark`, { kind: 'pin', idx: 3, asset_id: P[3], done: false });
  s = await snap();
  assert.equal(s.s.activity.pins, 15); assert.equal(s.pins.achieved, 15); assert.equal(cat(s.d, 'Pinterest').done, 15);

  // Article log + undo
  const canada = s.d.tasks.find(t => t.unit === 'article' && t.asset_id === sites[0]);
  await call('POST', `/api/tasks/${canada.id}/mark`, { kind: 'article', idx: 1, asset_id: sites[0], done: true });
  s = await snap();
  assert.equal(s.s.activity.articles, 1); assert.equal(s.arts.actual, 1); assert.equal(cat(s.d, 'Articles').done, 1);
  assert.deepEqual(s.s.activity.articlesBySite.map(x => [x.name, x.count]), [['Canada', 1]]);
  await call('POST', `/api/tasks/${canada.id}/mark`, { kind: 'article', idx: 1, asset_id: sites[0], done: false });
  s = await snap();
  assert.equal(s.s.activity.articles, 0); assert.equal(s.arts.actual, 0); assert.equal(cat(s.d, 'Articles').done, 0);

  // One video cross-posted to FB + IG = 1 produced, 2 publications
  const matin = s.d.tasks.find(t => t.slot_key === 'matin');
  await call('POST', `/api/tasks/${matin.id}/mark`, { kind: 'publication', idx: 1, asset_id: fb, done: true });
  await call('POST', `/api/tasks/${matin.id}/mark`, { kind: 'publication', idx: 1, asset_id: ig, done: true });
  s = await snap();
  assert.equal(s.s.activity.videos, 1); assert.equal(s.s.activity.publications, 2);
  assert.deepEqual(s.s.activity.publicationsByPlatform, { facebook: 1, instagram: 1 });
  assert.equal(s.d.tasks.find(t => t.id === matin.id).progress.pct, 100);
  assert.equal(s.pubs.actual, 2); assert.equal(s.vids.actual, 1);
  await call('POST', `/api/tasks/${matin.id}/mark`, { kind: 'publication', idx: 1, asset_id: ig, done: false });
  s = await snap();
  assert.equal(s.s.activity.publications, 1); assert.equal(s.pubs.actual, 1); assert.equal(s.vids.actual, 1);
  assert.equal(s.d.tasks.find(t => t.id === matin.id).progress.pct, 50);

  // "Reporter" moves only the remainder, counted once.
  const p2 = s.d.tasks.find(t => t.asset_id === P[1]); // 3/5
  await call('POST', `/api/tasks/${p2.id}/report`, { to: tomorrow });
  s = await snap();
  assert.equal(cat(s.d, 'Pinterest').target, 18, 'today keeps the 3 done, drops the 2 moved');
  const tm = await call('GET', `/api/today?date=${tomorrow}`);
  const moved = tm.tasks.find(t => t.origin_task_id === p2.id);
  assert.equal(moved.target, 2);
  await call('POST', `/api/tasks/${p2.id}/unreport`);
  assert.equal(cat(await call('GET', '/api/today'), 'Pinterest').target, 20);
});

test('3. timer: start, reload (server restart), extend, finish; actual time excludes pauses', async () => {
  const s0 = await call('POST', '/api/session/start', { category_id: 1, task_label: 'Page tarifs', minutes: 1 });
  await sleep(1200);
  await call('POST', `/api/session/${s0.id}/pause`);
  await sleep(1500); // paused time must not count
  // "Reload": restart the server process; state comes back from SQLite.
  await stop(proc); proc = await startServer(DIR, 4511);
  let st = (await call('GET', '/api/session')).session;
  assert.equal(st.state, 'paused'); assert.ok(st.actual_sec >= 1 && st.actual_sec <= 2, 'paused time not counted: ' + st.actual_sec);
  await call('POST', `/api/session/${s0.id}/resume`);
  st = await call('POST', `/api/session/${s0.id}/extend`, { minutes: 5 });
  assert.equal(st.planned_sec, 360); assert.equal(st.initial_sec, 60);
  await sleep(1100);
  const fin = await call('POST', `/api/session/${s0.id}/finish`);
  assert.equal(fin.state, 'finished'); assert.equal(fin.end_reason, 'early');
  assert.ok(fin.accumulated_sec >= 2 && fin.accumulated_sec <= 4, 'actual ' + fin.accumulated_sec);

  // Expiry: simulate the planned end passing while the app is closed → frozen at planned, asks for a choice.
  const s1 = await call('POST', '/api/session/start', { category_id: 1, task_label: 'Expiry', minutes: 1 });
  const db = rawDb(); db.prepare('UPDATE sessions SET run_started_at=run_started_at-3600000 WHERE id=?').run(s1.id); db.close();
  st = (await call('GET', '/api/session')).session;
  assert.equal(st.state, 'expired'); assert.equal(st.actual_sec, 60, 'an hour away counts only the planned minute');
  st = await call('POST', `/api/session/${s1.id}/extend`, { minutes: 10 }); // "Continuer"
  assert.equal(st.state, 'running');
  const f2 = await call('POST', `/api/session/${s1.id}/finish`);
  assert.ok(f2.accumulated_sec >= 60 && f2.accumulated_sec < 63);
  const stats = await call('GET', `/api/stats?from=${today}&to=${today}`);
  assert.equal(stats.coding.sessions, 2);
  assert.equal(stats.coding.total_sec, fin.accumulated_sec + f2.accumulated_sec);
});

test('4. coding Off for a week keeps publishing tasks; prompt returns when Off ends', async () => {
  const off = await call('POST', '/api/off', { preset: 'week' });
  assert.ok(off.until - Date.now() > 6.9 * 86400000);
  let d = await call('GET', '/api/today');
  assert.ok(d.off); assert.equal(d.session, null);
  assert.equal(d.tasks.length, 11, 'publishing routines still present');
  assert.ok(d.tasks.some(t => t.unit === 'pin') && d.tasks.some(t => t.type === 'social'));
  await call('POST', '/api/off/extend', { days: 1 });
  assert.ok((await call('GET', '/api/today')).off.until > off.until);
  // Time travel: the week is over.
  const db = rawDb(); db.prepare('UPDATE off_periods SET start_at=start_at-8*86400000, end_at=? WHERE cancelled_at IS NULL').run(Date.now() - 1000); db.close();
  d = await call('GET', '/api/today');
  assert.equal(d.off, null, 'Off expired → coding prompt shows again (no session, no off)');
  assert.equal(d.session, null);
});

test('5. undated project: milestones drive its own progress', async () => {
  const cats = await call('GET', '/api/categories');
  const { id } = await call('POST', '/api/projects', { name: 'IPTV Belgique', category_id: cats.find(c => c.key === 'iptv').id, topic: 'Belgique',
    status: 'planned', milestones: ['Domaine', 'Design', 'Développement', 'Déploiement', 'Indexation'] });
  let p = (await call('GET', '/api/projects')).find(x => x.id === id);
  assert.equal(p.status, 'planned'); assert.equal(p.planned_for, ''); assert.equal(p.progress.pct, 0);
  await call('PUT', `/api/milestones/${p.milestones[0].id}`, { done: true });
  await call('PUT', `/api/milestones/${p.milestones[1].id}`, { done: true });
  await call('PUT', `/api/milestones/${p.milestones[2].id}`, { title: 'Développement (WordPress)' });
  p = (await call('GET', '/api/projects')).find(x => x.id === id);
  assert.deepEqual([p.progress.done, p.progress.total, p.progress.pct], [2, 5, 40]);
  await call('PUT', `/api/projects/${id}`, { status: 'planned_date', planned_for: '2027-03' });
  p = (await call('GET', '/api/projects')).find(x => x.id === id);
  assert.equal(p.planned_for, '2027-03');
  const d = await call('GET', '/api/today');
  assert.ok(!d.score.categories.some(c => /projet/i.test(c.category)), 'project progress is not in the daily score');
});

test('6. backup, then restore into a fresh instance', async () => {
  const backup = await call('GET', '/api/backup');
  const fresh = await startServer(DIR2, 4512);
  const b2 = 'http://127.0.0.1:4512';
  try {
    const pv = await call('POST', '/api/restore/preview', backup, b2);
    assert.equal(pv.current.assets, 0); assert.equal(pv.incoming.assets, 11);
    assert.equal((await call('GET', '/api/assets', null, b2)).length, 0, 'preview changes nothing');
    const r = await call('POST', '/api/restore/apply', { token: pv.token }, b2);
    assert.ok(fs.existsSync(r.safety_backup));
    const a = await call('GET', `/api/stats?from=${today}&to=${today}`);
    const b = await call('GET', `/api/stats?from=${today}&to=${today}`, null, b2);
    assert.deepEqual(b.activity, a.activity);
    assert.deepEqual(b.target, a.target);
    assert.equal(b.coding.total_sec, a.coding.total_sec);
    assert.deepEqual((await call('GET', '/api/projects', null, b2)).map(p => p.progress), (await call('GET', '/api/projects')).map(p => p.progress));
    assert.deepEqual((await call('GET', '/api/challenges', null, b2))[0].goals.map(g => g.achieved), (await call('GET', '/api/challenges'))[0].goals.map(g => g.achieved));
  } finally { await stop(fresh); }
});

test('7. focus sessions: seconds kept, day durations, Today + Stats share the record; categories', async () => {
  // A 1-day session survives a restart with its planned duration intact.
  const day = await call('POST', '/api/session/start', { task_label: 'Long build', duration_sec: 86400 });
  assert.equal(day.planned_sec, 86400);
  await stop(proc); proc = await startServer(DIR, 4511);
  let st = (await call('GET', '/api/session')).session;
  assert.equal(st.id, day.id); assert.equal(st.planned_sec, 86400); assert.equal(st.state, 'running');
  await call('POST', `/api/session/${day.id}/extend`, { duration_sec: 5400 });
  assert.equal((await call('GET', '/api/session')).session.planned_sec, 86400 + 5400);
  await call('POST', `/api/session/${day.id}/finish`);
  await assert.rejects(call('POST', '/api/session/start', { task_label: 'x', duration_sec: 31 * 86400 }), /30 days/);

  // A short quick task is saved once, with seconds, and read identically by Today and Stats.
  const s = await call('POST', '/api/session/start', { task_label: 'Short fix', duration_sec: 1500 });
  await sleep(2200);
  const fin = await call('POST', `/api/session/${s.id}/finish`);
  assert.equal(fin.end_reason, 'early'); assert.ok(fin.accumulated_sec >= 2 && fin.accumulated_sec < 5);
  const d = await call('GET', '/api/today');
  const mine = d.sessions.filter(x => x.task_label === 'Short fix');
  assert.equal(mine.length, 1); assert.equal(mine[0].actual_sec, fin.accumulated_sec); assert.equal(mine[0].planned_sec, 1500);
  const stats = await call('GET', `/api/stats?from=${today}&to=${today}`);
  assert.equal(stats.coding.sessions, d.sessions.length);
  assert.equal(stats.coding.total_sec, d.sessions.reduce((a, x) => a + x.actual_sec, 0));

  // Milestone-linked work is logged without completing the milestone.
  const cats = await call('GET', '/api/categories');
  const other = cats.find(c => c.key === 'other');
  assert.ok(other && cats[cats.length - 1].key === 'other', '"Other" exists and is listed last');
  const { id: pid } = await call('POST', '/api/projects', { name: 'Side thing', category_id: other.id, status: 'idea', milestones: ['Prototype'] });
  const proj = (await call('GET', '/api/projects')).find(p => p.id === pid);
  const ms = await call('POST', '/api/session/start', { project_id: pid, milestone_id: proj.milestones[0].id, duration_sec: 600 });
  assert.equal(ms.category_id, other.id); assert.equal(ms.milestone.title, 'Prototype');
  await call('POST', `/api/session/${ms.id}/finish`);
  assert.equal((await call('GET', '/api/projects')).find(p => p.id === pid).milestones[0].done, 0);

  // Creating an existing category name reuses it; renaming onto another name is refused.
  const a = await call('POST', '/api/categories', { name: 'Mobile apps', color: 'sky' });
  const b = await call('POST', '/api/categories', { name: 'mobile APPS', color: 'pink' });
  assert.equal(a.id, b.id); assert.ok(b.existing);
  await assert.rejects(call('PUT', `/api/categories/${a.id}`, { name: 'Other', color: 'sky', coding: true }), /already exists/);
});

test('8. editing an entry: type change keeps id + history, moves sections, duplicate link is refused', async () => {
  const usaIptv = (await call('POST', '/api/assets', { kind: 'site_iptv', name: 'USA', url: 'https://usa-iptv.test', from_date: today })).id;
  const wrong = (await call('POST', '/api/assets', { kind: 'pinterest', name: 'USA', url: 'https://www.USA-iptv.test/', from_date: today })).id;
  const blog = (await call('POST', '/api/assets', { kind: 'pinterest', name: 'Cooking pins', url: 'https://cooking.test', from_date: today })).id;
  let d = await call('GET', '/api/today');
  const pinTask = d.tasks.find(t => t.asset_id === blog && t.unit === 'pin');
  await call('POST', `/api/tasks/${pinTask.id}/mark`, { kind: 'pin', idx: 1, asset_id: blog, done: true }); // history on the entry we'll move

  // Same link already under IPTV sites → 409 with details, and nothing changes.
  const before = (await call('GET', '/api/assets')).find(a => a.id === wrong);
  const r = await fetch(base + `/api/assets/${wrong}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'USA', kind: 'site_iptv', url: before.url }) });
  const j = await r.json();
  assert.equal(r.status, 409); assert.match(j.error, /already has “USA”/); assert.equal(j.conflict.id, usaIptv);
  assert.deepEqual((await call('GET', '/api/assets')).find(a => a.id === wrong), before, 'entry unchanged after refused edit');

  // A real type change: same id, history kept, section + counts + today's routines follow the new type.
  const statsBefore = await call('GET', `/api/stats?from=${today}&to=${today}`);
  const res = await call('PUT', `/api/assets/${blog}`, { name: 'Cooking site', kind: 'site_blog', url: 'https://cooking.test' });
  assert.equal(res.moved, true); assert.equal(res.kind, 'site_blog');
  const moved = (await call('GET', '/api/assets')).find(a => a.id === blog);
  assert.equal(moved.kind, 'site_blog'); assert.equal(moved.name, 'Cooking site');
  const statsAfter = await call('GET', `/api/stats?from=${today}&to=${today}`);
  assert.equal(statsAfter.assetCounts.pinterest.active, statsBefore.assetCounts.pinterest.active - 1);
  assert.equal(statsAfter.assetCounts.site_blog.active, (statsBefore.assetCounts.site_blog?.active || 0) + 1);
  d = await call('GET', '/api/today');
  assert.ok(d.tasks.some(t => t.asset_id === blog && t.unit === 'article'), 'today gets an article task for the corrected type');
  const keptPin = d.tasks.find(t => t.id === pinTask.id);
  assert.ok(keptPin && keptPin.progress.done === 1, 'the Pin already logged today is kept (history)');
  assert.equal(statsAfter.activity.pinsByAccount.find(x => x.asset_id === blog).count, 1, 'Pin history still attributed to the same entry');
  const tomorrowD = await call('GET', `/api/today?date=${tomorrow}`);
  assert.ok(!tomorrowD.tasks.some(t => t.asset_id === blog && t.unit === 'pin') && tomorrowD.tasks.some(t => t.asset_id === blog && t.unit === 'article'), 'future days use the new type');

  // Persists across a restart.
  await stop(proc); proc = await startServer(DIR, 4511);
  assert.equal((await call('GET', '/api/assets')).find(a => a.id === blog).kind, 'site_blog');
});

test('9. deleting one of two entries with the same name + link removes only that id; history and scores stay', async () => {
  const iptv = (await call('POST', '/api/assets', { kind: 'site_iptv', name: 'USA', url: 'https://usa-twin.test', from_date: today })).id;
  const pin = (await call('POST', '/api/assets', { kind: 'pinterest', name: 'USA', url: 'https://usa-twin.test', from_date: today })).id;
  let d = await call('GET', '/api/today');
  const pinTask = d.tasks.find(t => t.asset_id === pin && t.unit === 'pin');
  await call('POST', `/api/tasks/${pinTask.id}/mark`, { kind: 'pin', idx: 1, asset_id: pin, done: true });
  const before = await call('GET', `/api/stats?from=${today}&to=${today}`);
  const scoreBefore = (await call('GET', '/api/today')).score;

  await call('DELETE', `/api/assets/${pin}`);
  const list = await call('GET', '/api/assets');
  assert.ok(!list.some(a => a.id === pin), 'deleted entry gone from the list');
  assert.ok(list.some(a => a.id === iptv && a.name === 'USA' && a.kind === 'site_iptv'), 'twin with the same name + link intact');
  const after = await call('GET', `/api/stats?from=${today}&to=${today}`);
  assert.equal(after.assetCounts.pinterest.active, before.assetCounts.pinterest.active - 1, 'counts refreshed');
  assert.equal(after.assetCounts.site_iptv.active, before.assetCounts.site_iptv.active, 'IPTV count unchanged');
  assert.equal(after.activity.pins, before.activity.pins, 'logged Pin still counted');
  assert.equal(after.activity.pinsByAccount.find(x => x.asset_id === pin).name, 'USA', 'history still resolves the name');
  d = await call('GET', '/api/today');
  assert.ok(d.tasks.some(t => t.id === pinTask.id && t.progress.done === 1), 'today’s worked task kept');
  assert.deepEqual(d.score, scoreBefore, 'today’s score unchanged');
  const tm = await call('GET', `/api/today?date=${tomorrow}`);
  assert.ok(!tm.tasks.some(t => t.asset_id === pin), 'no future tasks for the deleted entry');
  assert.ok(tm.tasks.some(t => t.asset_id === iptv), 'twin still scheduled');
  await assert.rejects(call('PUT', `/api/assets/${pin}`, { name: 'x' }), /Not found/);
  await assert.rejects(call('DELETE', `/api/assets/${pin}`), /no longer exists/);
  // The duplicate-link check ignores deleted entries.
  const third = (await call('POST', '/api/assets', { kind: 'site_other', name: 'USA copy', url: 'https://usa-twin.test', from_date: today })).id;
  await call('PUT', `/api/assets/${third}`, { kind: 'pinterest' });
  // Persists across a restart.
  await stop(proc); proc = await startServer(DIR, 4511);
  const l2 = await call('GET', '/api/assets');
  assert.ok(!l2.some(a => a.id === pin) && l2.some(a => a.id === iptv));
});
