// Challenges: goals computed from the same records as "Today" — never logged twice.
const D = require('./dates');
const E = require('./engine');
const { tx } = require('./schema');

const METRICS = {
  pin: { label: 'Pins published', asset: true },
  article: { label: 'Articles published', asset: true },
  publication: { label: 'Social posts published', asset: true },
  video: { label: 'Videos produced', routine: true },
  unit: { label: 'Units (custom routine)', routine: true, asset: true },
  routine_done: { label: 'Routine completed', routine: true },
  youtube: { label: 'YouTube videos published', asset: true },
  coding_sessions: { label: 'Focus sessions', category: true },
  coding_minutes: { label: 'Focus minutes', category: true },
  study_minutes: { label: 'Study minutes' },
  milestones: { label: 'Project milestones completed' },
};

function options(db) {
  const t = E.today(db);
  const active = E.activeAssetsOn(db, t);
  const routines = db.prepare('SELECT * FROM routines ORDER BY sort, id').all().map(r => {
    const v = E.versionOn(db, r.id, t);
    const c = v ? v.config : {};
    let assets = [];
    if (r.type === 'counter') {
      if (c.asset_scope === 'kinds') assets = active.filter(a => (c.asset_kinds || []).includes(a.kind));
      if (c.asset_scope === 'list') assets = active.filter(a => (c.asset_ids || []).includes(a.id));
    } else if (r.type === 'social') {
      const ids = new Set();
      for (const s of c.slots || []) {
        const list = s.dest_scope === 'list' ? active.filter(a => (s.destinations || []).includes(a.id)) : active.filter(a => (s.dest_kinds || []).includes(a.kind));
        list.forEach(a => ids.add(a.id));
      }
      assets = active.filter(a => ids.has(a.id));
    }
    return { id: r.id, name: r.name, category: r.category, type: r.type, status: c.status || 'active', unit: c.unit, target: c.target,
      days: c.days || [], slots: (c.slots || []).length, videosPerDay: (c.slots || []).reduce((s, x) => s + (+x.videos || 0), 0),
      assets: assets.map(a => ({ id: a.id, name: a.name, kind: a.kind })) };
  });
  return { routines, categories: db.prepare('SELECT * FROM categories WHERE coding=1 ORDER BY sort').all(),
    youtube: active.filter(a => a.kind === 'youtube').map(a => ({ id: a.id, name: a.name })), metrics: METRICS, today: t };
}

function cleanGoal(g, i) {
  if (!METRICS[g.metric]) throw E.httpError(400, 'Unknown metric');
  const target = Math.round(+g.target);
  if (!(target >= 1 && target <= 100000)) throw E.httpError(400, 'Invalid target');
  const period = ['day', 'week', 'total'].includes(g.period) ? g.period : 'total';
  const ids = Array.isArray(g.asset_ids) ? [...new Set(g.asset_ids.map(Number).filter(Boolean))] : null;
  const days = Array.isArray(g.days) && g.days.length ? [...new Set(g.days.map(Number).filter(d => d >= 0 && d <= 6))] : [0, 1, 2, 3, 4, 5, 6];
  return { label: String(g.label || METRICS[g.metric].label).slice(0, 120), metric: g.metric, routine_id: g.routine_id ? +g.routine_id : null,
    asset_ids: ids && ids.length ? JSON.stringify(ids) : null, per_asset: g.per_asset && ids && ids.length ? 1 : 0, period, days: JSON.stringify(days), target, sort: i };
}

function create(db, b) {
  const name = String(b.name || '').trim().slice(0, 120) || 'Challenge';
  const start = D.isDate(b.start_date) ? b.start_date : E.today(db);
  const end = D.isDate(b.end_date) ? b.end_date : D.addDays(D.addMonths(start, 1), -1);
  if (end < start) throw E.httpError(400, 'The end must come after the start');
  const goals = (b.goals || []).map(cleanGoal);
  if (!goals.length) throw E.httpError(400, 'Add at least one goal');
  return tx(db, () => {
    const r = db.prepare('INSERT INTO challenges(name,start_date,end_date,created_at) VALUES(?,?,?,?)').run(name, start, end, E.nowIso());
    insertGoals(db, r.lastInsertRowid, goals);
    return { id: Number(r.lastInsertRowid) };
  });
}

function insertGoals(db, cid, goals) {
  for (const g of goals) {
    db.prepare('INSERT INTO challenge_goals(challenge_id,label,metric,routine_id,asset_ids,per_asset,period,days,target,sort) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(cid, g.label, g.metric, g.routine_id, g.asset_ids, g.per_asset, g.period, g.days, g.target, g.sort);
  }
}

function update(db, id, b) {
  const c = db.prepare('SELECT * FROM challenges WHERE id=?').get(id);
  if (!c) throw E.httpError(404, 'Not found');
  return tx(db, () => {
    const name = b.name != null ? String(b.name).trim().slice(0, 120) || c.name : c.name;
    const start = D.isDate(b.start_date) ? b.start_date : c.start_date;
    const end = D.isDate(b.end_date) ? b.end_date : c.end_date;
    if (end < start) throw E.httpError(400, 'The end must come after the start');
    db.prepare('UPDATE challenges SET name=?, start_date=?, end_date=?, archived=? WHERE id=?').run(name, start, end, b.archived != null ? (b.archived ? 1 : 0) : c.archived, id);
    if (Array.isArray(b.goals)) {
      const goals = b.goals.map(cleanGoal);
      if (!goals.length) throw E.httpError(400, 'Add at least one goal');
      db.prepare('DELETE FROM challenge_goals WHERE challenge_id=?').run(id);
      insertGoals(db, id, goals);
    }
    return { ok: true };
  });
}

// Returns Map key `${date}|${assetId||0}` -> count, over [from, to].
function counts(db, g, from, to) {
  const m = new Map();
  const add = (date, asset, n = 1) => { const k = `${date}|${asset || 0}`; m.set(k, (m.get(k) || 0) + n); };
  const ids = g.asset_ids ? JSON.parse(g.asset_ids) : null;
  if (['pin', 'article', 'publication', 'video', 'unit', 'youtube'].includes(g.metric)) {
    let sql = 'SELECT date, asset_id FROM records WHERE kind=? AND date>=? AND date<=?';
    const args = [g.metric, from, to];
    if (g.routine_id) { sql += ' AND routine_id=?'; args.push(g.routine_id); }
    for (const r of db.prepare(sql).all(...args)) {
      if (ids && g.metric !== 'video' && !ids.includes(r.asset_id)) continue;
      add(r.date, g.per_asset ? r.asset_id : 0);
    }
  } else if (g.metric === 'routine_done') {
    for (const t of E.tasksFor(db, from, to)) if (t.routine_id === g.routine_id && t.progress.complete) add(t.date, g.per_asset ? t.asset_id : 0);
  } else if (g.metric === 'coding_sessions' || g.metric === 'coding_minutes') {
    const rows = db.prepare("SELECT date, category_id, accumulated_sec FROM sessions WHERE state='finished' AND date>=? AND date<=?").all(from, to);
    for (const s of rows) {
      if (ids && !ids.includes(s.category_id)) continue;
      if (g.metric === 'coding_sessions') { if (s.accumulated_sec >= 60) add(s.date, 0); }
      else add(s.date, 0, s.accumulated_sec / 60);
    }
  } else if (g.metric === 'study_minutes') {
    for (const r of db.prepare('SELECT date, minutes FROM study_logs WHERE date>=? AND date<=?').all(from, to)) add(r.date, 0, r.minutes);
  } else if (g.metric === 'milestones') {
    for (const r of db.prepare('SELECT done_at FROM milestones WHERE done=1 AND done_at>=? AND done_at<=?').all(from, to)) add(r.done_at, 0);
  }
  return m;
}

function goalProgress(db, c, g, today) {
  const ids = g.asset_ids ? JSON.parse(g.asset_ids) : null;
  const units = g.per_asset ? ids : [0];
  const days = JSON.parse(g.days || '[0,1,2,3,4,5,6]');
  const until = today < c.end_date ? today : c.end_date;
  const elapsed = until >= c.start_date;
  const cnt = elapsed ? counts(db, g, c.start_date, until) : new Map();
  const sumOver = (from, to, unit) => {
    let s = 0;
    if (to < from) return 0;
    for (const d of D.eachDay(from, to)) s += cnt.get(`${d}|${unit}`) || 0;
    return s;
  };
  let target = 0, achieved = 0, actual = 0, targetToDate = 0;
  const periods = [];
  if (g.period === 'day') {
    for (const d of D.eachDay(c.start_date, c.end_date)) {
      if (!days.includes(D.weekday(d))) continue;
      periods.push([d, d]);
    }
  } else if (g.period === 'week') {
    for (let s = c.start_date; s <= c.end_date; s = D.addDays(s, 7)) {
      const e = D.addDays(s, 6) < c.end_date ? D.addDays(s, 6) : c.end_date;
      periods.push([s, e]);
    }
  } else periods.push([c.start_date, c.end_date]);
  const breakdown = [];
  for (const u of units) {
    let ua = 0, ut = 0, uact = 0;
    for (const [s, e] of periods) {
      const n = sumOver(s, e < until ? e : until, u);
      ut += g.target; ua += Math.min(n, g.target); uact += n;
      if (s <= until) targetToDate += g.target;
    }
    target += ut; achieved += ua; actual += uact;
    if (g.per_asset) breakdown.push({ asset_id: u, achieved: ua, target: ut, actual: Math.round(uact) });
  }
  achieved = Math.round(achieved * 10) / 10;
  return { ...g, asset_ids: ids, days, target_total: target, achieved, actual: Math.round(actual * 10) / 10,
    pct: target ? Math.min(100, Math.round((achieved / target) * 1000) / 10) : 0,
    pace: targetToDate ? Math.min(100, Math.round((achieved / targetToDate) * 1000) / 10) : null, breakdown, periods: periods.length };
}

function offOverlap(db, c) {
  const tz = E.tz(db);
  const s = D.localToUTC(tz, c.start_date), e = D.localToUTC(tz, D.addDays(c.end_date, 1));
  const rows = db.prepare('SELECT * FROM off_periods WHERE start_at<? AND end_at>?').all(e, s);
  const ms = rows.reduce((sum, r) => sum + Math.max(0, Math.min(e, r.end_at) - Math.max(s, r.start_at)), 0);
  return Math.round((ms / 86400000) * 10) / 10;
}

function list(db) {
  const t = E.today(db);
  const assets = new Map(db.prepare('SELECT id, name, kind FROM assets').all().map(a => [a.id, a]));
  return db.prepare('SELECT * FROM challenges ORDER BY archived, start_date DESC').all().map(c => {
    const goals = db.prepare('SELECT * FROM challenge_goals WHERE challenge_id=? ORDER BY sort, id').all(c.id).map(g => {
      const p = goalProgress(db, c, g, t);
      p.assets = (p.asset_ids || []).map(id => assets.get(id) || { id, name: '(deleted)' });
      return p;
    });
    const overall = goals.length ? Math.round((goals.reduce((s, g) => s + g.pct, 0) / goals.length) * 10) / 10 : 0;
    const total = D.diffDays(c.start_date, c.end_date) + 1;
    const day = Math.max(0, Math.min(total, D.diffDays(c.start_date, t) + 1));
    const hasCoding = goals.some(g => g.metric.startsWith('coding'));
    return { ...c, goals, overall, day, total_days: total, state: t < c.start_date ? 'upcoming' : t > c.end_date ? 'ended' : 'active',
      off_days: hasCoding ? offOverlap(db, c) : 0 };
  });
}

module.exports = { options, create, update, list, METRICS };
