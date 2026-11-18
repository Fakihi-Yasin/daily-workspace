// Routine scheduling, task generation, progress and scoring.
const D = require('./dates');
const { tx } = require('./schema');

const nowIso = () => new Date().toISOString();
const J = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

function getMeta(db, key, fb = null) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : fb;
}
function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
function tz(db) { return getMeta(db, 'timezone', 'Africa/Casablanca'); }
function today(db) { return D.todayIn(tz(db)); }

// ---------- Assets ----------
function assetStatusOn(db, assetId, date) {
  const r = db.prepare('SELECT status FROM asset_status WHERE asset_id=? AND from_date<=? ORDER BY from_date DESC LIMIT 1').get(assetId, date);
  return r ? r.status : null; // null = not yet active
}
function activeAssetsOn(db, date) {
  const all = db.prepare('SELECT * FROM assets ORDER BY sort, id').all();
  return all.filter(a => (!a.deleted_on || a.deleted_on > date) && assetStatusOn(db, a.id, date) === 'active');
}

// ---------- Routines ----------
function versionOn(db, routineId, date) {
  const v = db.prepare('SELECT * FROM routine_versions WHERE routine_id=? AND from_date<=? ORDER BY from_date DESC LIMIT 1').get(routineId, date);
  return v ? { ...v, config: J(v.config, {}) } : null;
}

function resolveAssets(cfg, active, scopeKey = 'asset_scope', kindsKey = 'asset_kinds', idsKey = 'asset_ids') {
  const scope = cfg[scopeKey] || 'none';
  if (scope === 'kinds') return active.filter(a => (cfg[kindsKey] || []).includes(a.kind));
  if (scope === 'list') {
    const ids = cfg[idsKey] || [];
    return ids.map(id => active.find(a => a.id === id)).filter(Boolean);
  }
  return [];
}

function desiredTasks(db, date) {
  const routines = db.prepare('SELECT * FROM routines ORDER BY sort, id').all();
  const active = activeAssetsOn(db, date);
  const wd = D.weekday(date);
  const out = [];
  for (const r of routines) {
    const v = versionOn(db, r.id, date);
    if (!v) continue;
    const c = v.config;
    if ((c.status || 'active') !== 'active') continue;
    if (!(c.days || []).includes(wd)) continue;
    const base = { routine_id: r.id, version_id: v.id, category: r.category, type: r.type, time_slot: c.time_slot || '' };
    const key = (assetId, slot) => `g|${date}|${r.id}|${assetId || 0}|${slot || ''}`;
    if (r.type === 'counter') {
      const unit = c.unit || 'unit';
      const assets = resolveAssets(c, active);
      if (c.asset_scope && c.asset_scope !== 'none' && assets.length === 0) continue;
      if (c.target_mode === 'shared' || assets.length === 0) {
        out.push({ ...base, unit, asset_id: null, slot_key: null, label: r.name, target: Math.max(1, +c.target || 1),
          meta: { asset_ids: assets.map(a => a.id), unit_label: c.unit_label || '' }, gen_key: key(0, '') });
      } else {
        for (const a of assets) {
          const t = c.overrides && c.overrides[a.id] != null && c.overrides[a.id] !== '' ? +c.overrides[a.id] : +c.target;
          if (!(t > 0)) continue;
          out.push({ ...base, unit, asset_id: a.id, slot_key: null, label: a.name, target: t,
            meta: { unit_label: c.unit_label || '' }, gen_key: key(a.id, '') });
        }
      }
    } else if (r.type === 'social') {
      for (const s of c.slots || []) {
        const dests = resolveAssets(s, active, 'dest_scope', 'dest_kinds', 'destinations');
        if (!dests.length || !(s.videos > 0)) continue;
        const slotBase = { ...base, unit: 'publication', time_slot: s.time || base.time_slot };
        if (s.mode === 'per_page') {
          for (const a of dests) out.push({ ...slotBase, asset_id: a.id, slot_key: s.key, label: `${s.label} · ${a.name}`, target: +s.videos,
            meta: { destinations: [a.id], slot_label: s.label }, gen_key: key(a.id, s.key) });
        } else {
          out.push({ ...slotBase, asset_id: null, slot_key: s.key, label: s.label, target: +s.videos,
            meta: { destinations: dests.map(a => a.id), slot_label: s.label }, gen_key: key(0, s.key) });
        }
      }
    } else if (r.type === 'check') {
      const list = (c.checklist || []).filter(Boolean);
      out.push({ ...base, unit: 'check', asset_id: null, slot_key: null, label: r.name, target: list.length || 1,
        meta: { checklist: list }, gen_key: key(0, '') });
    }
  }
  return out;
}

const insertTask = (db, date, t, sort) => db.prepare(`INSERT OR IGNORE INTO tasks
  (date,routine_id,version_id,category,type,unit,asset_id,slot_key,label,target,time_slot,meta,gen_key,sort)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(date, t.routine_id, t.version_id, t.category, t.type, t.unit, t.asset_id,
  t.slot_key, t.label, t.target, t.time_slot, JSON.stringify(t.meta), t.gen_key, sort);

// Materialise a day once. Idempotent: gen_key is UNIQUE and the days row marks completion.
function ensureDay(db, date) {
  if (db.prepare('SELECT 1 FROM days WHERE date=?').get(date)) return;
  tx(db, () => {
    if (db.prepare('SELECT 1 FROM days WHERE date=?').get(date)) return;
    desiredTasks(db, date).forEach((t, i) => insertTask(db, date, t, i));
    db.prepare('INSERT OR IGNORE INTO days(date,generated_at) VALUES(?,?)').run(date, nowIso());
    linkYoutube(db, date);
  });
}

// Re-apply configuration to already materialised days >= max(from, today).
// Never touches past days; never deletes a task that has records.
function resync(db, from) {
  const start = from > today(db) ? from : today(db);
  const dates = db.prepare('SELECT date FROM days WHERE date>=? ORDER BY date').all(start).map(r => r.date);
  for (const date of dates) {
    const want = desiredTasks(db, date);
    const wantKeys = new Set(want.map(t => t.gen_key));
    const existing = db.prepare("SELECT t.*, (SELECT COUNT(*) FROM records r WHERE r.task_id=t.id) AS n FROM tasks t WHERE date=? AND gen_key LIKE 'g|%'").all(date);
    for (const e of existing) {
      if (!wantKeys.has(e.gen_key) && e.n === 0 && e.status === 'open') db.prepare('DELETE FROM tasks WHERE id=?').run(e.id);
    }
    want.forEach((t, i) => {
      const e = existing.find(x => x.gen_key === t.gen_key);
      if (!e) insertTask(db, date, t, i);
      else if (e.status === 'open') {
        db.prepare('UPDATE tasks SET version_id=?, label=?, target=?, time_slot=?, meta=?, category=?, sort=? WHERE id=?')
          .run(t.version_id, t.label, t.target, t.time_slot, JSON.stringify(t.meta), t.category, i, e.id);
      }
    });
    linkYoutube(db, date);
  }
}

// YouTube publications come from the video pipeline; attach them to that day's YouTube routine tasks.
function linkYoutube(db, date) {
  const tasks = db.prepare("SELECT * FROM tasks WHERE date=? AND unit='youtube' AND status='open'").all(date);
  const recs = db.prepare("SELECT * FROM records WHERE date=? AND kind='youtube'").all(date);
  for (const r of recs) {
    const cur = r.task_id && tasks.find(t => t.id === r.task_id);
    if (cur) continue;
    const t = tasks.find(t => t.asset_id === r.asset_id) || tasks.find(t => !t.asset_id && (J(t.meta, {}).asset_ids || []).includes(r.asset_id));
    const idx = t ? (db.prepare("SELECT IFNULL(MAX(idx),0)+1 AS i FROM records WHERE task_id=?").get(t.id).i) : 0;
    db.prepare('UPDATE records SET task_id=?, routine_id=?, idx=? WHERE id=?').run(t ? t.id : null, t ? t.routine_id : null, idx, r.id);
  }
}

// ---------- Progress ----------
function taskProgress(task, recs) {
  const meta = typeof task.meta === 'string' ? J(task.meta, {}) : task.meta;
  const own = recs.filter(r => r.task_id === task.id);
  const p = { done: 0, scoreDone: 0, scoreTarget: 0, actual: 0 };
  if (task.type === 'counter') {
    const units = own.filter(r => r.kind === task.unit);
    p.actual = units.length;
    p.done = units.length;
    p.scoreTarget = task.target;
    p.scoreDone = Math.min(units.length, task.target);
    if (!task.asset_id) {
      p.byAsset = {};
      for (const r of units) p.byAsset[r.asset_id || 0] = (p.byAsset[r.asset_id || 0] || 0) + 1;
    }
  } else if (task.type === 'social') {
    const dests = meta.destinations || [];
    const pubs = own.filter(r => r.kind === 'publication');
    p.videos = own.filter(r => r.kind === 'video').length;
    p.actual = pubs.length;
    p.scoreTarget = task.target * dests.length;
    p.scoreDone = Math.min(p.scoreTarget, pubs.filter(r => r.idx <= task.target && dests.includes(r.asset_id)).length);
    p.done = p.scoreDone;
  } else {
    const list = meta.checklist || [];
    const checks = own.filter(r => r.kind === 'check');
    p.scoreTarget = task.target;
    p.scoreDone = list.length ? checks.filter(r => r.idx < list.length).length : Math.min(1, checks.length);
    p.scoreDone = Math.min(p.scoreDone, task.target);
    p.done = p.scoreDone;
    p.actual = checks.length;
  }
  p.complete = p.scoreTarget > 0 && p.scoreDone >= p.scoreTarget;
  p.pct = p.scoreTarget ? Math.round((p.scoreDone / p.scoreTarget) * 100) : null;
  return p;
}

function tasksFor(db, from, to = from) {
  const tasks = db.prepare('SELECT * FROM tasks WHERE date>=? AND date<=? ORDER BY date, sort, id').all(from, to);
  const recs = db.prepare('SELECT * FROM records WHERE date>=? AND date<=? AND task_id IS NOT NULL').all(from, to);
  const byTask = new Map();
  for (const r of recs) { if (!byTask.has(r.task_id)) byTask.set(r.task_id, []); byTask.get(r.task_id).push(r); }
  // Reported-in tasks may hold records of later dates: fetch records per task to be safe.
  return tasks.map(t => {
    const own = byTask.get(t.id) || [];
    const meta = J(t.meta, {});
    return { ...t, meta, records: own, progress: taskProgress({ ...t, meta }, own) };
  });
}

// Daily score: one count of task items for the day.
//   total = recurring task items due that day (each item once, even with a quota) + one-off tasks of that day
//   done  = recurring items whose target is reached (extras don't add) + one-off tasks marked Done
//   pct   = round(done / total × 100); null when nothing is scheduled. Focus sessions never count.
function isDueItem(t) { return t.progress.scoreTarget > 0; } // excludes tasks moved away untouched
function dayCount(tasks, todos = []) {
  const due = tasks.filter(isDueItem);
  const recurring = { done: due.filter(t => t.progress.complete).length, total: due.length };
  const custom = { done: todos.filter(t => t.done).length, total: todos.length };
  const done = recurring.done + custom.done, total = recurring.total + custom.total;
  const cats = new Map();
  for (const t of due) {
    if (!cats.has(t.category)) cats.set(t.category, { category: t.category, done: 0, total: 0 });
    const c = cats.get(t.category); c.total++; if (t.progress.complete) c.done++;
  }
  return { done, total, left: total - done, pct: total ? Math.round((done / total) * 100) : null, recurring, custom, categories: [...cats.values()] };
}
function todosFor(db, from, to = from) {
  return db.prepare('SELECT * FROM todos WHERE date>=? AND date<=? ORDER BY date, sort, id').all(from, to);
}

// Category score = Σ min(done,target) / Σ target. Overall = mean of scheduled category scores.
function scoreOf(tasks) {
  const cats = new Map();
  for (const t of tasks) {
    const p = t.progress;
    if (!p.scoreTarget) continue; // reported-away tasks with no progress are excluded
    if (!cats.has(t.category)) cats.set(t.category, { category: t.category, done: 0, target: 0, actual: 0 });
    const c = cats.get(t.category);
    c.done += p.scoreDone; c.target += p.scoreTarget; c.actual += p.actual;
  }
  const categories = [...cats.values()].map(c => ({ ...c, pct: Math.round((c.done / c.target) * 1000) / 10 }));
  const overall = categories.length ? Math.round((categories.reduce((s, c) => s + c.done / c.target, 0) / categories.length) * 1000) / 10 : null;
  return { categories, overall };
}

// ---------- Records ----------
function getTask(db, id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) throw httpError(404, 'Task not found');
  return t;
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function setMark(db, taskId, { kind, idx = 0, asset_id = null, done }) {
  const t = getTask(db, taskId);
  if (t.status !== 'open') throw httpError(409, 'This task was moved');
  if (t.unit === 'youtube') throw httpError(409, 'YouTube videos are completed from the YouTube section');
  validateKind(t, kind, asset_id);
  return tx(db, () => {
    if (done) {
      const r = db.prepare('INSERT OR IGNORE INTO records(date,task_id,routine_id,kind,asset_id,idx,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(t.date, t.id, t.routine_id, kind, asset_id, idx, nowIso());
      // Publishing a video implies it was produced: record the production once.
      let autoVideo = false;
      if (kind === 'publication') {
        autoVideo = db.prepare('INSERT OR IGNORE INTO records(date,task_id,routine_id,kind,asset_id,idx,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(t.date, t.id, t.routine_id, 'video', null, idx, nowIso()).changes > 0;
      }
      return { changed: r.changes > 0, autoVideo };
    }
    const r = db.prepare('DELETE FROM records WHERE task_id=? AND kind=? AND IFNULL(asset_id,0)=IFNULL(?,0) AND idx=?').run(t.id, kind, asset_id, idx);
    if (kind === 'video') db.prepare("DELETE FROM records WHERE task_id=? AND kind='publication' AND idx=?").run(t.id, idx);
    return { changed: r.changes > 0 };
  });
}

function addExtra(db, taskId, { kind, asset_id = null }) {
  const t = getTask(db, taskId);
  if (t.status !== 'open') throw httpError(409, 'This task was moved');
  if (t.unit === 'youtube') throw httpError(409, 'YouTube videos are completed from the YouTube section');
  validateKind(t, kind, asset_id);
  return tx(db, () => {
    const max = db.prepare('SELECT IFNULL(MAX(idx),0) AS m FROM records WHERE task_id=? AND kind=?').get(t.id, kind).m;
    const idx = Math.max(max, t.type === 'counter' && t.asset_id ? t.target : 0) + 1;
    const r = db.prepare('INSERT INTO records(date,task_id,routine_id,kind,asset_id,idx,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(t.date, t.id, t.routine_id, kind, asset_id, idx, nowIso());
    return { id: Number(r.lastInsertRowid), idx };
  });
}

function removeRecord(db, id) {
  const r = db.prepare('SELECT * FROM records WHERE id=?').get(id);
  if (!r) return { changed: false };
  if (r.kind === 'youtube') throw httpError(409, 'Edit the video in the YouTube section');
  db.prepare('DELETE FROM records WHERE id=?').run(id);
  return { changed: true };
}

function validateKind(t, kind, assetId) {
  const meta = J(t.meta, {});
  const ok = (t.type === 'counter' && kind === t.unit) ||
    (t.type === 'social' && (kind === 'publication' || kind === 'video')) ||
    (t.type === 'check' && kind === 'check');
  if (!ok) throw httpError(400, 'Invalid record type');
  if (t.type === 'counter' && !t.asset_id && (meta.asset_ids || []).length && !(meta.asset_ids || []).includes(assetId)) {
    throw httpError(400, 'Choose the site');
  }
  if (t.type === 'counter' && t.asset_id && assetId !== t.asset_id) throw httpError(400, 'Invalid account');
  if (kind === 'publication' && !(meta.destinations || []).includes(assetId)) throw httpError(400, 'Invalid destination');
}

// ---------- Report (move a task to another date) ----------
function reportTask(db, taskId, toDate) {
  const t = getTask(db, taskId);
  if (t.status !== 'open') throw httpError(409, 'Already moved');
  if (!D.isDate(toDate) || toDate <= t.date) throw httpError(400, 'Choose a later date');
  const [full] = tasksFor(db, t.date).filter(x => x.id === t.id);
  const p = full.progress;
  if (p.complete) throw httpError(409, 'Task already completed');
  if (p.scoreDone > 0 && t.type !== 'counter') throw httpError(409, 'Task already started: finish it or undo the checks first');
  if (t.type === 'counter' && !t.asset_id && p.scoreDone > 0) throw httpError(409, 'Shared goal already started');
  const remaining = t.type === 'counter' ? t.target - p.scoreDone : t.target;
  return tx(db, () => {
    const meta = { ...full.meta, orig_target: t.target, reported_from: t.date };
    db.prepare(`INSERT INTO tasks (date,routine_id,version_id,category,type,unit,asset_id,slot_key,label,target,time_slot,meta,origin_task_id,gen_key,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(toDate, t.routine_id, t.version_id, t.category, t.type, t.unit, t.asset_id, t.slot_key,
      t.label, remaining, t.time_slot, JSON.stringify(meta), t.id, `r|${t.id}`, -1);
    // Original keeps only what was already done, so nothing is counted twice.
    const origMeta = { ...full.meta, orig_target: t.target };
    db.prepare("UPDATE tasks SET status='reported', reported_to=?, target=?, meta=? WHERE id=?")
      .run(toDate, t.type === 'counter' ? p.scoreDone : 0, JSON.stringify(origMeta), t.id);
    return { moved: remaining, to: toDate };
  });
}

function unreportTask(db, taskId) {
  const t = getTask(db, taskId);
  if (t.status !== 'reported') throw httpError(409, 'This task is not moved');
  const moved = db.prepare('SELECT * FROM tasks WHERE origin_task_id=?').get(t.id);
  if (moved && db.prepare('SELECT COUNT(*) n FROM records WHERE task_id=?').get(moved.id).n > 0) {
    throw httpError(409, 'The moved task has already been started');
  }
  return tx(db, () => {
    if (moved) db.prepare('DELETE FROM tasks WHERE id=?').run(moved.id);
    const meta = J(t.meta, {});
    db.prepare("UPDATE tasks SET status='open', reported_to=NULL, target=? WHERE id=?").run(meta.orig_target || t.target, t.id);
    return { ok: true };
  });
}

module.exports = {
  dayCount, todosFor,
  J, nowIso, getMeta, setMeta, tz, today, httpError,
  assetStatusOn, activeAssetsOn, versionOn, desiredTasks, ensureDay, resync, linkYoutube,
  taskProgress, tasksFor, scoreOf, setMark, addExtra, removeRecord, reportTask, unreportTask,
};
