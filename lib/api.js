// HTTP API handlers (JSON). Each handler receives (db, ctx) and returns JSON-serialisable data.
const D = require('./dates');
const E = require('./engine');
const T = require('./timer');
const S = require('./stats');
const C = require('./challenges');
const B = require('./backup');
const { tx } = require('./schema');

const { J, httpError, nowIso } = E;
const str = (v, max = 500) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
const int = (v, def = 0) => (Number.isFinite(+v) ? Math.round(+v) : def);

const ASSET_KINDS = ['site_iptv', 'site_blog', 'site_other', 'pinterest', 'facebook', 'instagram', 'youtube', 'other'];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0];

// ---------- defaults ----------
// One-time rename of the original French default names (databases created before the English UI).
function migrateToEnglish(db) {
  if (E.getMeta(db, 'lang_en')) return;
  tx(db, () => {
    const cat = { 'Sites IPTV': 'IPTV sites', 'Produits numériques': 'Digital products', 'Sites de blogs': 'Blog sites' };
    for (const [fr, en] of Object.entries(cat)) db.prepare('UPDATE categories SET name=? WHERE name=?').run(en, fr);
    const names = { 'Articles de blog': 'Blog articles', 'Confirmations WhatsApp': 'WhatsApp confirmations' };
    for (const [fr, en] of Object.entries(names)) {
      db.prepare('UPDATE routines SET name=? WHERE name=?').run(en, fr);
      db.prepare('UPDATE tasks SET label=? WHERE label=?').run(en, fr);
    }
    const slot = { Matin: 'Morning', Soir: 'Evening' };
    for (const v of db.prepare('SELECT id, config FROM routine_versions').all()) {
      const c = J(v.config, {});
      let changed = false;
      if (c.unit_label === 'articles publiés') { c.unit_label = 'articles published'; changed = true; }
      for (const s of c.slots || []) if (slot[s.label]) { s.label = slot[s.label]; changed = true; }
      if (changed) db.prepare('UPDATE routine_versions SET config=? WHERE id=?').run(JSON.stringify(c), v.id);
    }
    for (const t of db.prepare("SELECT id, label, meta FROM tasks WHERE type IN ('social','counter')").all()) {
      const m = J(t.meta, {});
      let label = t.label, changed = false;
      if (m.unit_label === 'articles publiés') { m.unit_label = 'articles published'; changed = true; }
      if (slot[m.slot_label]) { m.slot_label = slot[m.slot_label]; changed = true; }
      for (const [fr, en] of Object.entries(slot)) if (label === fr || label.startsWith(fr + ' · ')) { label = en + label.slice(fr.length); changed = true; }
      if (changed) db.prepare('UPDATE tasks SET label=?, meta=? WHERE id=?').run(label, JSON.stringify(m), t.id);
    }
    E.setMeta(db, 'lang_en', '1');
  });
}

function ensureDefaults(db) {
  migrateToEnglish(db);
  E.backfillDayScores(db);
  if (E.getMeta(db, 'defaults_seeded')) return;
  const t = E.today(db);
  tx(db, () => {
    const add = (name, category, type, config, sort) => {
      const r = db.prepare('INSERT INTO routines(name,category,type,created_at,sort) VALUES(?,?,?,?,?)').run(name, category, type, nowIso(), sort);
      db.prepare('INSERT INTO routine_versions(routine_id,from_date,config,created_at) VALUES(?,?,?,?)')
        .run(r.lastInsertRowid, t, JSON.stringify({ status: 'active', ...config }), nowIso());
    };
    // Starter routines for a new account: general enough for any job, easy to edit or archive in
    // Settings → Routines. (Accounts created before the general set keep their own routines.)
    const weekdays = [1, 2, 3, 4, 5];
    if (E.getMeta(db, 'profile') === 'general') {
      add('Plan the day', 'Planning', 'check', { days: weekdays, checklist: ['Check calendar and messages', 'Pick the top 3 priorities'], time_slot: 'Morning' }, 1);
      add('Inbox zero', 'Communication', 'check', { days: weekdays, checklist: [], time_slot: '' }, 2);
      add('End-of-day review', 'Planning', 'check', { days: weekdays, checklist: ['Update task statuses', 'Plan tomorrow'], time_slot: 'Evening' }, 3);
    } else {
      add('Blog articles', 'Articles', 'counter', { days: [1, 2, 3, 4, 5, 6], unit: 'article', unit_label: 'articles published',
        asset_scope: 'kinds', asset_kinds: ['site_iptv', 'site_blog'], target_mode: 'per_asset', target: 1, overrides: {}, time_slot: '' }, 1);
      add('Pinterest', 'Pinterest', 'counter', { days: ALL_DAYS, unit: 'pin', unit_label: 'Pins',
        asset_scope: 'kinds', asset_kinds: ['pinterest'], target_mode: 'per_asset', target: 5, overrides: {}, time_slot: '' }, 2);
      add('Facebook & Instagram', 'Facebook & Instagram', 'social', { days: ALL_DAYS, slots: [
        { key: 'matin', label: 'Morning', time: '09:00', videos: 1, mode: 'shared', dest_scope: 'kinds', dest_kinds: ['facebook', 'instagram'], destinations: [] },
        { key: 'soir', label: 'Evening', time: '19:00', videos: 1, mode: 'shared', dest_scope: 'kinds', dest_kinds: ['facebook', 'instagram'], destinations: [] },
      ] }, 3);
      add('WhatsApp confirmations', 'WhatsApp', 'check', { days: ALL_DAYS, checklist: [], time_slot: '' }, 4);
    }
    E.setMeta(db, 'defaults_seeded', '1');
  });
}

// ---------- serialisers ----------
// Lists exclude deleted entries; Today keeps them (includeDeleted) so past tasks still show their names.
function assetsWithStatus(db, includeDeleted = false) {
  const t = E.today(db);
  return db.prepare(`SELECT * FROM assets ${includeDeleted ? '' : 'WHERE deleted_on IS NULL'} ORDER BY sort, id`).all().map(a => {
    const timeline = db.prepare('SELECT from_date, status FROM asset_status WHERE asset_id=? ORDER BY from_date').all(a.id);
    const current = E.assetStatusOn(db, a.id, t);
    const upcoming = timeline.filter(x => x.from_date > t);
    return { ...a, status: current || 'pending', timeline, upcoming };
  });
}

function routinesFull(db) {
  const t = E.today(db);
  return db.prepare('SELECT * FROM routines ORDER BY sort, id').all().map(r => {
    const versions = db.prepare('SELECT * FROM routine_versions WHERE routine_id=? ORDER BY from_date').all(r.id).map(v => ({ ...v, config: J(v.config, {}) }));
    const current = E.versionOn(db, r.id, t);
    const upcoming = versions.filter(v => v.from_date > t);
    return { ...r, current, upcoming, versions };
  });
}

function categoriesAll(db) { return db.prepare("SELECT * FROM categories ORDER BY key='other', sort, id").all(); }

// ---------- Today ----------
function todayPayload(db, date) {
  const t = E.today(db);
  date = D.isDate(date) ? date : t;
  // A past day that was never set up stays empty: generating it now would use today's routines and
  // invent a score for a day that has no record.
  const generatedBefore = !!db.prepare('SELECT 1 FROM days WHERE date=?').get(date);
  if (date >= t && date <= D.addDays(t, 14)) E.ensureDay(db, date);
  if (date !== t) E.ensureDay(db, t);
  if (date === t) E.recordDayScore(db, t);
  const tasks = E.tasksFor(db, date);
  const score = E.scoreOf(tasks);
  const todos = E.todosForDay(db, date);
  const reportedIn = tasks.filter(x => x.origin_task_id);
  return {
    date, today: t, tz: E.tz(db),
    tasks, score, todos, count: E.dayCount(tasks, todos), reportedIn: reportedIn.length,
    cancelled: E.cancelledForDay(db, date),
    // The daily score of this date: live for today, as recorded for a past day, or null (No score recorded).
    dayScore: E.dayScore(db, date),
    unrecorded: date < t && !generatedBefore,
    session: T.active(db), off: T.offStatus(db),
    lastSession: db.prepare("SELECT s.*, p.name AS project_name FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE state='finished' ORDER BY ended_at DESC LIMIT 1").get() || null,
    codingToday: db.prepare("SELECT IFNULL(SUM(accumulated_sec),0) AS s FROM sessions WHERE date=? AND state='finished'").get(date).s,
    sessions: sessionsOn(db, date),
    assets: assetsWithStatus(db, true),
    generated: !!db.prepare('SELECT 1 FROM days WHERE date=?').get(date),
  };
}

// Finished focus sessions of a day — the same records Stats reads.
function sessionsOn(db, date) {
  return db.prepare(`SELECT s.id, s.task_label, s.planned_sec, s.accumulated_sec AS actual_sec, s.started_at, s.ended_at, s.end_reason,
      s.project_id, p.name AS project_name, c.name AS category_name, c.color AS category_color, s.milestone_id, m.title AS milestone_title, m.done AS milestone_done
    FROM sessions s LEFT JOIN projects p ON p.id=s.project_id LEFT JOIN categories c ON c.id=s.category_id LEFT JOIN milestones m ON m.id=s.milestone_id
    WHERE s.date=? AND s.state='finished' ORDER BY s.ended_at DESC`).all(date);
}

// ---------- One-off tasks ("My tasks") ----------
function createTodo(db, b) {
  const title = str(b.title, 1000);
  if (!title) throw httpError(400, 'Give the task a title');
  const date = D.isDate(b.date) ? b.date : E.today(db);
  const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM todos WHERE date=?').get(date).s;
  const done = b.done ? 1 : 0;
  const doneOn = done ? (D.isDate(b.done_on) ? b.done_on : E.today(db)) : null;
  const r = db.prepare('INSERT INTO todos(date,title,done,done_at,done_on,created_at,sort) VALUES(?,?,?,?,?,?,?)')
    .run(date, title, done, done ? nowIso() : null, doneOn, nowIso(), b.sort != null ? int(b.sort) : sort);
  return db.prepare('SELECT * FROM todos WHERE id=?').get(Number(r.lastInsertRowid));
}
// Completion history: a row per Done, on the local day credited; reopening removes it.
function logCompletion(db, { kind, todo, sub, on, at }) {
  db.prepare('INSERT INTO completions(kind,todo_id,subtask_id,title,parent_title,done_on,done_at,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(kind, todo.id, sub ? sub.id : null, sub ? sub.title : todo.title, sub ? todo.title : null, on, at, 'live', nowIso());
}
function unlogCompletion(db, kind, id) {
  if (kind === 'todo') db.prepare("DELETE FROM completions WHERE kind='todo' AND todo_id=?").run(id);
  else db.prepare("DELETE FROM completions WHERE kind='subtask' AND subtask_id=?").run(id);
}
// The day credited for a Done: today, or the day being viewed when correcting a past day (never before the task's date).
const creditDay = (db, on, from) => { const today = E.today(db); return D.isDate(on) && on <= today && on >= from ? on : today; };

function updateTodo(db, id, b) {
  const t = db.prepare('SELECT * FROM todos WHERE id=?').get(id);
  if (!t) throw httpError(404, 'Task not found');
  const title = b.title != null ? str(b.title, 1000) : t.title;
  if (!title) throw httpError(400, 'Give the task a title');
  const done = b.done != null ? (b.done ? 1 : 0) : t.done;
  if (done && t.cancelled_on && b.done != null && !t.done) throw httpError(409, 'This task is cancelled: reopen it first');
  let doneOn = t.done_on;
  if (b.done != null) doneOn = done ? creditDay(db, b.on, t.date) : null;
  const doneAt = done ? (b.done != null && !t.done ? nowIso() : (t.done_at || nowIso())) : null;
  const pastDay = b.done != null && done !== t.done ? (done ? doneOn : t.done_on) : null;
  return E.correctPastDay(db, pastDay, () => tx(db, () => {
    db.prepare('UPDATE todos SET title=?, done=?, done_at=?, done_on=? WHERE id=?').run(title, done, doneAt, doneOn, id);
    if (b.done != null && done !== t.done) {
      if (done) {
        const cur = { ...t, title };
        logCompletion(db, { kind: 'todo', todo: cur, on: doneOn, at: doneAt });
        // "Complete all subtasks": unfinished subtasks are completed on the same day; "parent only" leaves them open.
        if (b.subtasks === 'all') {
          for (const st of db.prepare('SELECT * FROM subtasks WHERE todo_id=? AND done=0').all(id)) {
            db.prepare('UPDATE subtasks SET done=1, done_at=?, done_on=? WHERE id=?').run(doneAt, doneOn, st.id);
            logCompletion(db, { kind: 'subtask', todo: cur, sub: st, on: doneOn, at: doneAt });
          }
        }
      } else unlogCompletion(db, 'todo', id);
    }
    return db.prepare('SELECT * FROM todos WHERE id=?').get(id);
  }));
}

// Cancel: kept in history as Cancelled, out of active lists, Overdue, Next action and scores from today on.
function cancelTodo(db, id, cancel) {
  const t = db.prepare('SELECT * FROM todos WHERE id=?').get(id);
  if (!t) throw httpError(404, 'Task not found');
  if (cancel) {
    if (t.done) throw httpError(409, 'This task is already done');
    if (t.cancelled_on) return t;
    // Cancelled on today (or on the task's own date if it's still in the future).
    const on = t.date > E.today(db) ? t.date : E.today(db);
    db.prepare('UPDATE todos SET cancelled_on=?, cancelled_at=? WHERE id=?').run(on, nowIso(), id);
  } else {
    db.prepare('UPDATE todos SET cancelled_on=NULL, cancelled_at=NULL WHERE id=?').run(id);
  }
  return db.prepare('SELECT * FROM todos WHERE id=?').get(id);
}

// ---------- Subtasks ----------
function addSubtask(db, todoId, b) {
  const t = db.prepare('SELECT * FROM todos WHERE id=?').get(todoId);
  if (!t) throw httpError(404, 'Task not found');
  const title = str(b.title, 1000);
  if (!title) throw httpError(400, 'Give the subtask a title');
  const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM subtasks WHERE todo_id=?').get(todoId).s;
  const r = db.prepare('INSERT INTO subtasks(todo_id,title,done,created_at,sort) VALUES(?,?,0,?,?)').run(todoId, title, nowIso(), sort);
  return db.prepare('SELECT * FROM subtasks WHERE id=?').get(Number(r.lastInsertRowid));
}
function updateSubtask(db, id, b) {
  const st = db.prepare('SELECT * FROM subtasks WHERE id=?').get(id);
  if (!st) throw httpError(404, 'Subtask not found');
  const todo = db.prepare('SELECT * FROM todos WHERE id=?').get(st.todo_id);
  const title = b.title != null ? str(b.title, 1000) : st.title;
  if (!title) throw httpError(400, 'Give the subtask a title');
  const done = b.done != null ? (b.done ? 1 : 0) : st.done;
  return tx(db, () => {
    let doneOn = st.done_on, doneAt = st.done_at;
    if (b.done != null && done !== st.done) {
      if (done) {
        doneOn = creditDay(db, b.on, todo.date); doneAt = nowIso();
        logCompletion(db, { kind: 'subtask', todo, sub: { ...st, title }, on: doneOn, at: doneAt });
      } else { doneOn = null; doneAt = null; unlogCompletion(db, 'subtask', id); }
    }
    db.prepare('UPDATE subtasks SET title=?, done=?, done_at=?, done_on=? WHERE id=?').run(title, done, doneAt, doneOn, id);
    return db.prepare('SELECT * FROM subtasks WHERE id=?').get(id);
  });
}

// ---------- History ----------
// Every date with recorded activity (generated checklist, one-off tasks, completions, records, saved
// score), newest first, with the score of that day (null = No score recorded).
function scoreHistory(db) {
  const t = E.today(db);
  const dates = db.prepare(`SELECT date FROM days WHERE date<=? UNION SELECT date FROM todos WHERE date<=?
    UNION SELECT done_on AS date FROM completions WHERE done_on<=? UNION SELECT date FROM records WHERE date<=?
    UNION SELECT date FROM day_scores WHERE date<=? ORDER BY date DESC`).all(t, t, t, t, t).map(r => r.date);
  return { today: t, days: dates.map(d => {
    const s = E.dayScore(db, d);
    return { date: d, pct: s.pct, done: s.done ?? null, total: s.total ?? null, source: s.source };
  }) };
}

// Tasks completed on a date (the local day they were marked Done). One-off tasks come from the
// completion log (outlives edits and deletion); routine items from their check records.
function completionsOn(db, date) {
  if (!D.isDate(date)) throw httpError(400, 'Invalid date');
  const since = E.getMeta(db, 'completion_log_since') || date;
  const rows = db.prepare('SELECT * FROM completions WHERE done_on=? ORDER BY COALESCE(done_at, created_at), id').all(date);
  const curTodo = db.prepare('SELECT title FROM todos WHERE id=?');
  const curSub = db.prepare('SELECT title FROM subtasks WHERE id=?');
  const items = [];
  const byTodo = new Map();
  for (const r of rows.filter(r => r.kind === 'todo')) {
    const now = r.todo_id != null && curTodo.get(r.todo_id);
    const it = { kind: 'todo', todo_id: r.todo_id, title: now ? now.title : r.title, done_at: r.done_at, source: r.source, deleted: !now, subtasks: [] };
    items.push(it); if (r.todo_id != null) byTodo.set(r.todo_id, it);
  }
  for (const r of rows.filter(r => r.kind === 'subtask')) {
    const now = r.subtask_id != null && curSub.get(r.subtask_id);
    const st = { title: now ? now.title : r.title, done_at: r.done_at };
    let parent = byTodo.get(r.todo_id);
    if (!parent) { // subtask done that day, parent not: listed under its parent, not counted as a task
      const p = r.todo_id != null && curTodo.get(r.todo_id);
      parent = { kind: 'parent', todo_id: r.todo_id, title: p ? p.title : (r.parent_title || 'Task'), done_at: null, subtasks: [], not_completed: true };
      items.push(parent); byTodo.set(r.todo_id, parent);
    }
    parent.subtasks.push(st);
  }
  // Routine items whose target was reached on that day's checklist, timed by the record that completed them.
  for (const t of E.tasksFor(db, date).filter(t => t.progress.scoreTarget > 0 && t.progress.complete)) {
    const at = t.records.map(r => r.created_at).filter(Boolean).sort();
    items.push({ kind: 'routine', title: t.category === t.label ? t.label : `${t.category} · ${t.label}`, done_at: at.length ? at[Math.min(at.length, t.progress.scoreTarget) - 1] : null });
  }
  items.sort((a, b) => (a.done_at || '9') < (b.done_at || '9') ? -1 : (a.done_at || '9') > (b.done_at || '9') ? 1 : 0);
  const count = items.filter(i => i.kind !== 'parent').length;
  // Before the completion log existed, one-off tasks deleted since then can't be known.
  const history = date >= since ? 'complete' : count || items.length ? 'partial' : 'none';
  return { date, count, items, history, log_since: since };
}

// ---------- Assets ----------
function createAsset(db, b) {
  const kind = ASSET_KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) throw httpError(400, 'Invalid type');
  const name = str(b.name, 120);
  if (!name) throw httpError(400, 'Name is required');
  const from = D.isDate(b.from_date) ? b.from_date : D.addDays(E.today(db), 1);
  if (from < E.today(db)) throw httpError(400, 'The effective date cannot be in the past');
  return tx(db, () => {
    const r = db.prepare('INSERT INTO assets(kind,name,url,notes,created_at,sort) VALUES(?,?,?,?,?,?)')
      .run(kind, name, str(b.url, 500), str(b.notes, 2000), nowIso(), int(b.sort, 0));
    db.prepare('INSERT INTO asset_status(asset_id,from_date,status,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid, from, 'active', nowIso());
    E.resync(db, from);
    return { id: Number(r.lastInsertRowid), from_date: from };
  });
}

const KIND_PLURAL = { site_iptv: 'IPTV sites', site_blog: 'Blog sites', site_other: 'Other sites', pinterest: 'Pinterest accounts',
  facebook: 'Facebook pages', instagram: 'Instagram accounts', youtube: 'YouTube channels', other: 'Others' };
// Same link regardless of protocol, "www.", letter case or a trailing slash.
const sameLink = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

// Edit name / type / link / notes in place: the id (and so all history) stays the same.
function updateAsset(db, id, b) {
  const a = db.prepare('SELECT * FROM assets WHERE id=? AND deleted_on IS NULL').get(id);
  if (!a) throw httpError(404, 'Not found');
  const name = b.name != null ? str(b.name, 120) : a.name;
  if (!name) throw httpError(400, 'Name is required');
  if (b.kind != null && !ASSET_KINDS.includes(b.kind)) throw httpError(400, 'Invalid type');
  const kind = b.kind != null ? b.kind : a.kind;
  const url = b.url != null ? str(b.url, 500) : a.url;
  const notes = b.notes != null ? str(b.notes, 2000) : a.notes;
  // Never create a duplicate: the destination type already has an entry with this link.
  if (sameLink(url) && (kind !== a.kind || sameLink(url) !== sameLink(a.url))) {
    const dup = db.prepare('SELECT * FROM assets WHERE kind=? AND id<>? AND deleted_on IS NULL').all(kind, id).find(x => sameLink(x.url) === sameLink(url));
    if (dup) {
      const e = httpError(409, `${KIND_PLURAL[kind]} already has “${dup.name}” with this link. Nothing was changed. Cancel this edit and pause or archive the mistaken entry instead.`);
      e.conflict = { id: dup.id, name: dup.name, kind: dup.kind, url: dup.url, status: E.assetStatusOn(db, dup.id, E.today(db)) || 'pending' };
      throw e;
    }
  }
  const t = E.today(db);
  return tx(db, () => {
    db.prepare('UPDATE assets SET name=?, kind=?, url=?, notes=? WHERE id=?').run(name, kind, url, notes, id);
    // A rename also updates labels of open tasks from today on (history keeps its labels).
    if (name !== a.name) {
      db.prepare("UPDATE tasks SET label=? WHERE asset_id=? AND date>=? AND type='counter' AND label=?").run(name, id, t, a.name);
    }
    // A type change applies from today: today's untouched tasks of the old type are replaced by the new
    // type's routines. Past days, and any task already worked on, keep their records.
    if (kind !== a.kind) E.resync(db, t);
    return { ok: true, kind, moved: kind !== a.kind, from_date: kind !== a.kind ? t : null };
  });
}

// Delete one entry, by its unique id. It leaves lists, counts and routines from today; past days keep
// their tasks, records and scores (the row stays, marked deleted_on, so history still shows its name).
function deleteAsset(db, id) {
  const a = db.prepare('SELECT * FROM assets WHERE id=? AND deleted_on IS NULL').get(id);
  if (!a) throw httpError(404, 'This entry no longer exists');
  const t = E.today(db);
  return tx(db, () => {
    db.prepare('UPDATE assets SET deleted_on=? WHERE id=?').run(t, id);
    E.resync(db, t); // drops today's untouched tasks for it; tasks with records stay
    return { ok: true, id, deleted_on: t };
  });
}
function restoreAsset(db, id) {
  const a = db.prepare('SELECT * FROM assets WHERE id=? AND deleted_on IS NOT NULL').get(id);
  if (!a) throw httpError(404, 'Not found');
  return tx(db, () => {
    db.prepare('UPDATE assets SET deleted_on=NULL WHERE id=?').run(id);
    E.resync(db, E.today(db));
    return { ok: true, id };
  });
}

function setAssetStatus(db, id, b) {
  if (!db.prepare('SELECT 1 FROM assets WHERE id=? AND deleted_on IS NULL').get(id)) throw httpError(404, 'Not found');
  const status = ['active', 'paused', 'archived'].includes(b.status) ? b.status : null;
  if (!status) throw httpError(400, 'Invalid status');
  const from = D.isDate(b.from_date) ? b.from_date : D.addDays(E.today(db), 1);
  if (from < E.today(db)) throw httpError(400, 'The effective date cannot be in the past');
  return tx(db, () => {
    // A new change replaces any later scheduled change.
    db.prepare('DELETE FROM asset_status WHERE asset_id=? AND from_date>=?').run(id, from);
    db.prepare('INSERT INTO asset_status(asset_id,from_date,status,created_at) VALUES(?,?,?,?)').run(id, from, status, nowIso());
    E.resync(db, from);
    return { ok: true, from_date: from };
  });
}

// ---------- Routines ----------
function cleanConfig(type, c) {
  const days = Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter(d => d >= 0 && d <= 6))] : ALL_DAYS;
  const base = { status: ['active', 'paused', 'archived'].includes(c.status) ? c.status : 'active', days, time_slot: str(c.time_slot, 40) };
  const ids = v => (Array.isArray(v) ? v.map(Number).filter(Boolean) : []);
  const kinds = v => (Array.isArray(v) ? v.filter(k => ASSET_KINDS.includes(k)) : []);
  if (type === 'counter') {
    const overrides = {};
    for (const [k, v] of Object.entries(c.overrides || {})) if (v !== '' && v != null && Number.isFinite(+v)) overrides[k] = Math.max(0, int(v));
    return { ...base, unit: ['pin', 'article', 'unit', 'youtube'].includes(c.unit) ? c.unit : 'unit', unit_label: str(c.unit_label, 40),
      asset_scope: ['kinds', 'list', 'none'].includes(c.asset_scope) ? c.asset_scope : 'none', asset_kinds: kinds(c.asset_kinds), asset_ids: ids(c.asset_ids),
      target_mode: c.target_mode === 'shared' ? 'shared' : 'per_asset', target: Math.max(1, Math.min(200, int(c.target, 1))), overrides };
  }
  if (type === 'social') {
    const slots = (c.slots || []).slice(0, 10).map((s, i) => ({
      key: str(s.key, 30) || `slot${i + 1}`, label: str(s.label, 40) || `Slot ${i + 1}`, time: str(s.time, 10),
      videos: Math.max(0, Math.min(20, int(s.videos, 1))), mode: s.mode === 'per_page' ? 'per_page' : 'shared',
      dest_scope: s.dest_scope === 'list' ? 'list' : 'kinds', dest_kinds: kinds(s.dest_kinds), destinations: ids(s.destinations),
    }));
    const keys = new Set();
    for (const s of slots) { while (keys.has(s.key)) s.key += 'x'; keys.add(s.key); }
    return { ...base, slots };
  }
  return { ...base, checklist: (c.checklist || []).map(x => str(x, 120)).filter(Boolean).slice(0, 20) };
}

function createRoutine(db, b) {
  const type = ['counter', 'social', 'check'].includes(b.type) ? b.type : null;
  if (!type) throw httpError(400, 'Invalid type');
  const name = str(b.name, 80);
  if (!name) throw httpError(400, 'Name is required');
  const from = D.isDate(b.from_date) ? b.from_date : E.today(db);
  if (from < E.today(db)) throw httpError(400, 'The effective date cannot be in the past');
  return tx(db, () => {
    const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM routines').get().s;
    const r = db.prepare('INSERT INTO routines(name,category,type,created_at,sort) VALUES(?,?,?,?,?)').run(name, str(b.category, 60) || name, type, nowIso(), sort);
    db.prepare('INSERT INTO routine_versions(routine_id,from_date,config,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid, from, JSON.stringify(cleanConfig(type, b.config || {})), nowIso());
    E.resync(db, from);
    return { id: Number(r.lastInsertRowid), from_date: from };
  });
}

function updateRoutine(db, id, b) {
  const r = db.prepare('SELECT * FROM routines WHERE id=?').get(id);
  if (!r) throw httpError(404, 'Not found');
  return tx(db, () => {
    if (b.name != null || b.category != null) {
      const name = b.name != null ? str(b.name, 80) : r.name;
      if (!name) throw httpError(400, 'Name is required');
      const category = b.category != null ? (str(b.category, 60) || name) : r.category;
      db.prepare('UPDATE routines SET name=?, category=? WHERE id=?').run(name, category, id);
      // Labels/categories of today's and future open tasks follow; past days keep their snapshot.
      db.prepare("UPDATE tasks SET category=? WHERE routine_id=? AND date>=? AND status='open'").run(category, id, E.today(db));
      if (r.type !== 'social') db.prepare("UPDATE tasks SET label=? WHERE routine_id=? AND date>=? AND asset_id IS NULL AND label=?").run(name, id, E.today(db), r.name);
    }
    let from = null;
    if (b.config) {
      from = D.isDate(b.from_date) ? b.from_date : D.addDays(E.today(db), 1);
      if (from < E.today(db)) throw httpError(400, 'The effective date cannot be in the past');
      db.prepare('DELETE FROM routine_versions WHERE routine_id=? AND from_date>?').run(id, from);
      db.prepare(`INSERT INTO routine_versions(routine_id,from_date,config,created_at) VALUES(?,?,?,?)
        ON CONFLICT(routine_id,from_date) DO UPDATE SET config=excluded.config, created_at=excluded.created_at`)
        .run(id, from, JSON.stringify(cleanConfig(r.type, b.config)), nowIso());
      E.resync(db, from);
    }
    return { ok: true, from_date: from };
  });
}

function cancelUpcomingVersion(db, versionId) {
  const v = db.prepare('SELECT * FROM routine_versions WHERE id=?').get(versionId);
  if (!v) throw httpError(404, 'Not found');
  if (v.from_date <= E.today(db)) throw httpError(409, 'This version is already in effect');
  db.prepare('DELETE FROM routine_versions WHERE id=?').run(versionId);
  E.resync(db, v.from_date);
  return { ok: true };
}

// ---------- Categories ----------
function saveCategory(db, b, id) {
  const name = str(b.name, 60);
  if (!name) throw httpError(400, 'Name is required');
  const color = ['blue', 'pink', 'mint', 'yellow', 'sky', 'ink'].includes(b.color) ? b.color : 'blue';
  const dup = db.prepare('SELECT id FROM categories WHERE lower(name)=lower(?) AND id IS NOT ?').get(name, id || null);
  if (id) {
    if (dup) throw httpError(409, 'A category with this name already exists');
    db.prepare('UPDATE categories SET name=?, color=?, coding=? WHERE id=?').run(name, color, b.coding ? 1 : 0, id);
    return { id };
  }
  if (dup) return { id: dup.id, existing: true }; // creating an existing name reuses it instead of duplicating
  const key = name.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM categories').get().s;
  const r = db.prepare('INSERT INTO categories(key,name,color,coding,sort) VALUES(?,?,?,?,?)').run(key, name, color, b.coding === false ? 0 : 1, sort);
  return { id: Number(r.lastInsertRowid) };
}

// ---------- Projects ----------
const PROJECT_STATUS = ['idea', 'planned', 'planned_date', 'in_progress', 'done'];
function projectsAll(db) {
  const ms = db.prepare('SELECT * FROM milestones ORDER BY sort, id').all();
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(p => {
    const m = ms.filter(x => x.project_id === p.id);
    const done = m.filter(x => x.done).length;
    const coding = db.prepare("SELECT IFNULL(SUM(accumulated_sec),0) s FROM sessions WHERE project_id=? AND state='finished'").get(p.id).s;
    return { ...p, links: J(p.links, []), milestones: m, progress: { done, total: m.length, pct: m.length ? Math.round((done / m.length) * 100) : null }, coding_sec: coding };
  });
}
function projectFields(b, cur = {}) {
  const status = PROJECT_STATUS.includes(b.status) ? b.status : (cur.status || 'idea');
  let planned = b.planned_for != null ? str(b.planned_for, 10) : (cur.planned_for || '');
  if (planned && !/^\d{4}-\d{2}(-\d{2})?$/.test(planned)) throw httpError(400, 'Invalid date or month');
  if (status === 'planned_date' && !planned) throw httpError(400, 'Enter a date or an approximate month');
  if (status === 'idea' || status === 'planned') planned = '';
  const links = Array.isArray(b.links) ? b.links.map(l => str(l, 500)).filter(Boolean).slice(0, 20) : J(cur.links, []);
  return {
    name: b.name != null ? str(b.name, 120) : cur.name, category_id: b.category_id !== undefined ? (int(b.category_id) || null) : (cur.category_id ?? null),
    topic: b.topic != null ? str(b.topic, 120) : (cur.topic || ''), links: JSON.stringify(links),
    notes: b.notes != null ? str(b.notes, 5000) : (cur.notes || ''), next_action: b.next_action != null ? str(b.next_action, 300) : (cur.next_action || ''),
    status, planned_for: planned,
  };
}
function createProject(db, b) {
  const f = projectFields(b);
  if (!f.name) throw httpError(400, 'Name is required');
  return tx(db, () => {
    const r = db.prepare('INSERT INTO projects(name,category_id,topic,links,notes,next_action,status,planned_for,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(f.name, f.category_id, f.topic, f.links, f.notes, f.next_action, f.status, f.planned_for, nowIso(), nowIso());
    (b.milestones || []).map(m => str(m, 120)).filter(Boolean).forEach((m, i) =>
      db.prepare('INSERT INTO milestones(project_id,title,sort) VALUES(?,?,?)').run(r.lastInsertRowid, m, i));
    return { id: Number(r.lastInsertRowid) };
  });
}
function updateProject(db, id, b) {
  const cur = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!cur) throw httpError(404, 'Not found');
  const f = projectFields(b, cur);
  if (!f.name) throw httpError(400, 'Name is required');
  db.prepare('UPDATE projects SET name=?,category_id=?,topic=?,links=?,notes=?,next_action=?,status=?,planned_for=?,updated_at=? WHERE id=?')
    .run(f.name, f.category_id, f.topic, f.links, f.notes, f.next_action, f.status, f.planned_for, nowIso(), id);
  return { ok: true };
}
function touchProject(db, pid) { db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), pid); }

// ---------- YouTube ----------
const STAGES = ['idea', 'script', 'recording', 'editing', 'published'];
function saveVideo(db, b, id) {
  const cur = id ? db.prepare('SELECT * FROM videos WHERE id=?').get(id) : null;
  if (id && !cur) throw httpError(404, 'Not found');
  const channel = b.channel_id != null ? int(b.channel_id) : cur && cur.channel_id;
  if (!db.prepare("SELECT 1 FROM assets WHERE id=? AND kind='youtube'").get(channel)) throw httpError(400, 'Channel is required');
  const title = b.title != null ? str(b.title, 200) : cur.title;
  if (!title) throw httpError(400, 'Title is required');
  const stage = STAGES.includes(b.stage) ? b.stage : (cur ? cur.stage : 'idea');
  const planned = b.planned_date != null ? str(b.planned_date, 10) : (cur ? cur.planned_date : '');
  let published = b.published_date != null ? str(b.published_date, 10) : (cur ? cur.published_date : '');
  if (stage === 'published' && !D.isDate(published)) published = E.today(db);
  if (stage !== 'published') published = '';
  const url = b.url != null ? str(b.url, 500) : (cur ? cur.url : '');
  const notes = b.notes != null ? str(b.notes, 5000) : (cur ? cur.notes : '');
  return tx(db, () => {
    let vid = id;
    if (id) db.prepare('UPDATE videos SET channel_id=?,title=?,stage=?,planned_date=?,published_date=?,url=?,notes=? WHERE id=?').run(channel, title, stage, planned, published, url, notes, id);
    else vid = Number(db.prepare('INSERT INTO videos(channel_id,title,stage,planned_date,published_date,url,notes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(channel, title, stage, planned, published, url, notes, nowIso()).lastInsertRowid);
    // Only published videos count as publications: keep exactly one record per published video.
    const rec = db.prepare("SELECT * FROM records WHERE kind='youtube' AND video_ref=?").get(vid);
    if (stage === 'published') {
      if (!rec || rec.date !== published || rec.asset_id !== channel) {
        if (rec) db.prepare('DELETE FROM records WHERE id=?').run(rec.id);
        db.prepare("INSERT INTO records(date,task_id,routine_id,kind,asset_id,idx,video_ref,created_at) VALUES(?,NULL,NULL,'youtube',?,0,?,?)").run(published, channel, vid, nowIso());
        E.linkYoutube(db, published);
      }
    } else if (rec) db.prepare('DELETE FROM records WHERE id=?').run(rec.id);
    return { id: vid };
  });
}

// ---------- Formation ----------
function coursesAll(db) {
  const mods = db.prepare('SELECT * FROM modules ORDER BY sort, id').all();
  const logs = db.prepare('SELECT * FROM study_logs ORDER BY date DESC, id DESC').all();
  return db.prepare('SELECT * FROM courses ORDER BY status, created_at DESC').all().map(c => {
    const m = mods.filter(x => x.course_id === c.id);
    const done = m.filter(x => x.done).length;
    const l = logs.filter(x => x.course_id === c.id);
    return { ...c, modules: m, logs: l.slice(0, 20), study_minutes: l.reduce((s, x) => s + x.minutes, 0),
      progress: { done, total: m.length, pct: m.length ? Math.round((done / m.length) * 100) : null } };
  });
}

// ---------- Router ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), fn });

on('GET', '/api/bootstrap', (db) => ({ today: E.today(db), tz: E.tz(db), categories: categoriesAll(db), assets: assetsWithStatus(db), routines: routinesFull(db) }));
on('GET', '/api/today', (db, { q }) => todayPayload(db, q.get('date')));

on('POST', '/api/tasks/:id/mark', (db, { p, b }) => E.setMark(db, +p.id, { kind: b.kind, idx: int(b.idx), asset_id: b.asset_id == null ? null : int(b.asset_id), done: !!b.done }));
on('POST', '/api/tasks/:id/extra', (db, { p, b }) => E.addExtra(db, +p.id, { kind: b.kind, asset_id: b.asset_id == null ? null : int(b.asset_id) }));
on('DELETE', '/api/records/:id', (db, { p }) => {
  const rec = db.prepare('SELECT r.date FROM records r WHERE r.id=?').get(+p.id);
  return E.correctPastDay(db, rec && rec.date, () => E.removeRecord(db, +p.id)); // correcting a past day
});
on('POST', '/api/tasks/:id/report', (db, { p, b }) => E.reportTask(db, +p.id, b.to));
on('POST', '/api/tasks/:id/unreport', (db, { p }) => E.unreportTask(db, +p.id));
on('PUT', '/api/tasks/:id/note', (db, { p, b }) => { db.prepare('UPDATE tasks SET note=? WHERE id=?').run(str(b.note, 2000), +p.id); return { ok: true }; });

on('POST', '/api/todos', (db, { b }) => createTodo(db, b));
on('PUT', '/api/todos/:id', (db, { p, b }) => updateTodo(db, +p.id, b));
on('POST', '/api/todos/:id/cancel', (db, { p }) => cancelTodo(db, +p.id, true));
on('POST', '/api/todos/:id/reopen', (db, { p }) => cancelTodo(db, +p.id, false));
on('POST', '/api/todos/:id/subtasks', (db, { p, b }) => addSubtask(db, +p.id, b));
on('PUT', '/api/subtasks/:id', (db, { p, b }) => updateSubtask(db, +p.id, b));
on('DELETE', '/api/subtasks/:id', (db, { p }) => { db.prepare('DELETE FROM subtasks WHERE id=?').run(+p.id); return { ok: true }; });
on('GET', '/api/history/scores', (db) => scoreHistory(db));
on('GET', '/api/history/completions', (db, { q }) => completionsOn(db, q.get('date')));
// Delete keeps its completion history; the response holds what's needed to undo it exactly.
on('DELETE', '/api/todos/:id', (db, { p }) => {
  const t = db.prepare('SELECT * FROM todos WHERE id=?').get(+p.id);
  if (!t) throw httpError(404, 'Task not found');
  const subtasks = db.prepare('SELECT * FROM subtasks WHERE todo_id=?').all(+p.id);
  tx(db, () => {
    db.prepare('DELETE FROM subtasks WHERE todo_id=?').run(+p.id);
    db.prepare('DELETE FROM todos WHERE id=?').run(+p.id);
  });
  return { ok: true, deleted: t, subtasks };
});
// Undo a delete: same id and subtasks, so history still points at it.
on('POST', '/api/todos/undelete', (db, { b }) => {
  const t = b.deleted;
  if (!t || !Number.isInteger(t.id) || db.prepare('SELECT 1 FROM todos WHERE id=?').get(t.id)) throw httpError(409, 'Cannot undo');
  const cols = db.prepare('PRAGMA table_info(todos)').all().map(c => c.name).filter(c => c in t);
  const scols = db.prepare('PRAGMA table_info(subtasks)').all().map(c => c.name);
  tx(db, () => {
    db.prepare(`INSERT INTO todos(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => t[c]));
    for (const st of (b.subtasks || []).filter(x => x && x.todo_id === t.id && !db.prepare('SELECT 1 FROM subtasks WHERE id=?').get(x.id))) {
      const k = scols.filter(c => c in st);
      db.prepare(`INSERT INTO subtasks(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`).run(...k.map(c => st[c]));
    }
  });
  return { ok: true };
});
on('GET', '/api/assets', (db) => assetsWithStatus(db));
on('POST', '/api/assets', (db, { b }) => createAsset(db, b));
on('PUT', '/api/assets/:id', (db, { p, b }) => updateAsset(db, +p.id, b));
on('POST', '/api/assets/:id/status', (db, { p, b }) => setAssetStatus(db, +p.id, b));
on('DELETE', '/api/assets/:id', (db, { p }) => deleteAsset(db, +p.id));
on('POST', '/api/assets/:id/restore', (db, { p }) => restoreAsset(db, +p.id));

on('GET', '/api/routines', (db) => routinesFull(db));
on('POST', '/api/routines', (db, { b }) => createRoutine(db, b));
on('PUT', '/api/routines/:id', (db, { p, b }) => updateRoutine(db, +p.id, b));
on('DELETE', '/api/routine-versions/:id', (db, { p }) => cancelUpcomingVersion(db, +p.id));

on('GET', '/api/session', (db) => ({ session: T.active(db), off: T.offStatus(db) }));
on('POST', '/api/session/start', (db, { b }) => T.start(db, b));
on('POST', '/api/session/:id/pause', (db, { p }) => T.pause(db, +p.id));
on('POST', '/api/session/:id/resume', (db, { p }) => T.resume(db, +p.id));
on('POST', '/api/session/:id/extend', (db, { p, b }) => T.extend(db, +p.id, b));
on('POST', '/api/session/:id/finish', (db, { p }) => T.finish(db, +p.id));
on('GET', '/api/sessions', (db, { q }) => db.prepare(`SELECT s.*, p.name project_name, c.name category_name FROM sessions s
  LEFT JOIN projects p ON p.id=s.project_id LEFT JOIN categories c ON c.id=s.category_id WHERE s.state='finished' ORDER BY s.started_at DESC LIMIT ?`).all(int(q.get('limit'), 30)));
on('POST', '/api/off', (db, { b }) => T.setOff(db, b));
on('POST', '/api/off/extend', (db, { b }) => T.extendOff(db, b.days));
on('DELETE', '/api/off', (db) => T.cancelOff(db));

on('GET', '/api/categories', (db) => categoriesAll(db));
on('POST', '/api/categories', (db, { b }) => saveCategory(db, b));
on('PUT', '/api/categories/:id', (db, { p, b }) => saveCategory(db, b, +p.id));

on('GET', '/api/projects', (db) => projectsAll(db));
on('POST', '/api/projects', (db, { b }) => createProject(db, b));
on('PUT', '/api/projects/:id', (db, { p, b }) => updateProject(db, +p.id, b));
on('DELETE', '/api/projects/:id', (db, { p }) => { db.prepare('UPDATE sessions SET project_id=NULL WHERE project_id=?').run(+p.id); db.prepare('DELETE FROM projects WHERE id=?').run(+p.id); return { ok: true }; });
on('POST', '/api/projects/:id/milestones', (db, { p, b }) => {
  const title = str(b.title, 120); if (!title) throw httpError(400, 'Title is required');
  const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM milestones WHERE project_id=?').get(+p.id).s;
  const r = db.prepare('INSERT INTO milestones(project_id,title,sort) VALUES(?,?,?)').run(+p.id, title, sort); touchProject(db, +p.id);
  return { id: Number(r.lastInsertRowid) };
});
on('PUT', '/api/milestones/:id', (db, { p, b }) => {
  const m = db.prepare('SELECT * FROM milestones WHERE id=?').get(+p.id); if (!m) throw httpError(404, 'Not found');
  const done = b.done != null ? (b.done ? 1 : 0) : m.done;
  db.prepare('UPDATE milestones SET title=?, done=?, done_at=?, sort=? WHERE id=?').run(b.title != null ? (str(b.title, 120) || m.title) : m.title, done,
    done ? (m.done_at || E.today(db)) : null, b.sort != null ? int(b.sort) : m.sort, m.id);
  touchProject(db, m.project_id); return { ok: true };
});
on('DELETE', '/api/milestones/:id', (db, { p }) => { db.prepare('DELETE FROM milestones WHERE id=?').run(+p.id); return { ok: true }; });

on('GET', '/api/videos', (db) => db.prepare('SELECT v.*, a.name channel_name FROM videos v LEFT JOIN assets a ON a.id=v.channel_id ORDER BY v.created_at DESC').all());
on('POST', '/api/videos', (db, { b }) => saveVideo(db, b));
on('PUT', '/api/videos/:id', (db, { p, b }) => saveVideo(db, b, +p.id));
on('DELETE', '/api/videos/:id', (db, { p }) => { db.prepare("DELETE FROM records WHERE kind='youtube' AND video_ref=?").run(+p.id); db.prepare('DELETE FROM videos WHERE id=?').run(+p.id); return { ok: true }; });

on('GET', '/api/courses', (db) => coursesAll(db));
on('POST', '/api/courses', (db, { b }) => {
  const name = str(b.name, 120); if (!name) throw httpError(400, 'Name is required');
  const r = db.prepare('INSERT INTO courses(name,kind,link,notes,created_at) VALUES(?,?,?,?,?)').run(name, b.kind === 'skill' ? 'skill' : 'course', str(b.link), str(b.notes, 5000), nowIso());
  (b.modules || []).map(m => str(m, 120)).filter(Boolean).forEach((m, i) => db.prepare('INSERT INTO modules(course_id,title,sort) VALUES(?,?,?)').run(r.lastInsertRowid, m, i));
  return { id: Number(r.lastInsertRowid) };
});
on('PUT', '/api/courses/:id', (db, { p, b }) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(+p.id); if (!c) throw httpError(404, 'Not found');
  db.prepare('UPDATE courses SET name=?, kind=?, link=?, notes=?, status=? WHERE id=?').run(b.name != null ? (str(b.name, 120) || c.name) : c.name,
    b.kind ? (b.kind === 'skill' ? 'skill' : 'course') : c.kind, b.link != null ? str(b.link) : c.link, b.notes != null ? str(b.notes, 5000) : c.notes,
    ['active', 'paused', 'done'].includes(b.status) ? b.status : c.status, c.id);
  return { ok: true };
});
on('DELETE', '/api/courses/:id', (db, { p }) => { db.prepare('DELETE FROM courses WHERE id=?').run(+p.id); return { ok: true }; });
on('POST', '/api/courses/:id/modules', (db, { p, b }) => {
  const title = str(b.title, 120); if (!title) throw httpError(400, 'Title is required');
  const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM modules WHERE course_id=?').get(+p.id).s;
  return { id: Number(db.prepare('INSERT INTO modules(course_id,title,sort) VALUES(?,?,?)').run(+p.id, title, sort).lastInsertRowid) };
});
on('PUT', '/api/modules/:id', (db, { p, b }) => {
  const m = db.prepare('SELECT * FROM modules WHERE id=?').get(+p.id); if (!m) throw httpError(404, 'Not found');
  const done = b.done != null ? (b.done ? 1 : 0) : m.done;
  db.prepare('UPDATE modules SET title=?, done=?, done_at=? WHERE id=?').run(b.title != null ? (str(b.title, 120) || m.title) : m.title, done, done ? (m.done_at || E.today(db)) : null, m.id);
  return { ok: true };
});
on('DELETE', '/api/modules/:id', (db, { p }) => { db.prepare('DELETE FROM modules WHERE id=?').run(+p.id); return { ok: true }; });
on('POST', '/api/courses/:id/study', (db, { p, b }) => {
  const minutes = int(b.minutes); if (!(minutes > 0 && minutes <= 1440)) throw httpError(400, 'Invalid minutes');
  const date = D.isDate(b.date) ? b.date : E.today(db);
  return { id: Number(db.prepare('INSERT INTO study_logs(course_id,date,minutes,note,created_at) VALUES(?,?,?,?,?)').run(+p.id, date, minutes, str(b.note, 300), nowIso()).lastInsertRowid) };
});
on('DELETE', '/api/study/:id', (db, { p }) => { db.prepare('DELETE FROM study_logs WHERE id=?').run(+p.id); return { ok: true }; });

on('GET', '/api/challenges', (db) => C.list(db));
on('GET', '/api/challenges/options', (db) => C.options(db));
on('POST', '/api/challenges', (db, { b }) => C.create(db, b));
on('PUT', '/api/challenges/:id', (db, { p, b }) => C.update(db, +p.id, b));
on('DELETE', '/api/challenges/:id', (db, { p }) => { db.prepare('DELETE FROM challenges WHERE id=?').run(+p.id); return { ok: true }; });

on('GET', '/api/stats', (db, { q }) => S.stats(db, q.get('from'), q.get('to')));
on('GET', '/api/stats/asset/:id', (db, { p, q }) => S.assetDetail(db, +p.id, q.get('from'), q.get('to')));

on('GET', '/api/settings', (db) => ({ timezone: E.tz(db) }));
on('PUT', '/api/settings', (db, { b }) => {
  if (b.timezone != null) { if (!D.isValidTz(b.timezone)) throw httpError(400, 'Unknown timezone'); E.setMeta(db, 'timezone', b.timezone); }
  return { timezone: E.tz(db) };
});

on('GET', '/api/backup', (db, { ctx }) => B.dump(db, ctx.source));
on('POST', '/api/restore/preview', (db, { b }) => B.preview(db, b));
on('POST', '/api/restore/apply', (db, { b, ctx }) => { const r = B.apply(db, b.token, ctx); E.backfillDayScores(db); return r; });

// After any change, today's recorded score follows it (past days only change through correctPastDay).
function afterChange(db) {
  try {
    const t = E.today(db);
    if (db.prepare('SELECT 1 FROM days WHERE date=?').get(t)) E.recordDayScore(db, t);
  } catch { /* the change itself succeeded; the score is recorded on the next change or visit */ }
}

async function handle(ctx, req, url, body) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const db = ctx.db();
    const args = { p: m.groups || {}, q: url.searchParams, b: body || {}, ctx };
    // A check on a past day's routine task corrects that day's recorded score.
    const pastTask = req.method === 'POST' && /^\/api\/tasks\/\d+\/(mark|extra)$/.test(url.pathname)
      ? (db.prepare('SELECT date FROM tasks WHERE id=?').get(+args.p.id) || {}).date : null;
    const res = pastTask ? E.correctPastDay(db, pastTask, () => r.fn(db, args)) : r.fn(db, args);
    if (req.method !== 'GET') afterChange(db);
    return res;
  }
  throw httpError(404, 'Unknown route');
}

// Same routes, called directly and synchronously (used to build the demo through the real API logic).
function call(db, method, path, body) {
  const url = new URL(path, 'http://local');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const res = r.fn(db, { p: m.groups || {}, q: url.searchParams, b: body || {}, ctx: { db: () => db } });
    if (method !== 'GET') afterChange(db);
    return res;
  }
  throw httpError(404, 'Unknown route ' + method + ' ' + path);
}

module.exports = { handle, call, ensureDefaults, todayPayload, createAsset, setAssetStatus, createRoutine, updateRoutine, saveVideo, createProject, ASSET_KINDS };
