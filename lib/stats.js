// Statistics: actual activity is reported separately from target completion.
const D = require('./dates');
const E = require('./engine');

function range(db, from, to) {
  const t = E.today(db);
  from = D.isDate(from) ? from : t;
  to = D.isDate(to) ? to : from;
  if (to < from) [from, to] = [to, from];
  if (D.diffDays(from, to) > 731) throw E.httpError(400, 'Period limited to 2 years');
  return { from, to };
}

function assetCounts(db) {
  const t = E.today(db);
  const out = {};
  for (const a of db.prepare('SELECT * FROM assets WHERE deleted_on IS NULL').all()) {
    const s = E.assetStatusOn(db, a.id, t) || 'pending';
    out[a.kind] = out[a.kind] || { active: 0, paused: 0, archived: 0, pending: 0 };
    out[a.kind][s]++;
  }
  const digital = db.prepare("SELECT p.status FROM projects p JOIN categories c ON c.id=p.category_id WHERE c.key='digital'").all();
  out.digital_projects = { active: digital.filter(p => p.status !== 'done').length, done: digital.filter(p => p.status === 'done').length };
  const projects = db.prepare('SELECT status FROM projects').all();
  out.projects = { active: projects.filter(p => p.status !== 'done').length, done: projects.filter(p => p.status === 'done').length };
  return out;
}

function stats(db, fromQ, toQ) {
  const { from, to } = range(db, fromQ, toQ);
  const assets = db.prepare('SELECT * FROM assets').all();
  const byId = new Map(assets.map(a => [a.id, a]));
  const recs = db.prepare('SELECT * FROM records WHERE date>=? AND date<=?').all(from, to);
  const tasks = E.tasksFor(db, from, to);
  const allTodos = db.prepare('SELECT * FROM todos WHERE date<=?').all(to);
  const todos = E.todosFor(db, from, to).filter(t => !(t.cancelled_on && t.cancelled_on <= t.date)); // cancelled before their day: never due

  const perAsset = {};
  const kinds = {};
  for (const r of recs) {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    if (r.asset_id) {
      const k = `${r.kind}:${r.asset_id}`;
      perAsset[k] = (perAsset[k] || 0) + 1;
    }
  }
  const listFor = (kind) => Object.entries(perAsset).filter(([k]) => k.startsWith(kind + ':'))
    .map(([k, n]) => { const id = +k.split(':')[1]; const a = byId.get(id); return { asset_id: id, name: a ? a.name : '?', kind: a ? a.kind : '', count: n }; })
    .sort((a, b) => b.count - a.count);

  // Custom counters (unit 'unit', e.g. "calls made"): one total per routine, labelled with its unit.
  const unitsByRoutine = new Map();
  for (const r of recs.filter(r => r.kind === 'unit' && r.routine_id)) {
    const cur = unitsByRoutine.get(r.routine_id) || { routine_id: r.routine_id, count: 0 };
    cur.count++; unitsByRoutine.set(r.routine_id, cur);
  }
  for (const u of unitsByRoutine.values()) {
    const rt = db.prepare('SELECT name FROM routines WHERE id=?').get(u.routine_id);
    const v = E.versionOn(db, u.routine_id, to);
    u.name = rt ? rt.name : 'Routine';
    u.unit_label = (v && v.config && v.config.unit_label) || 'done';
  }

  const pubsByPlatform = {};
  for (const r of recs.filter(r => r.kind === 'publication' || r.kind === 'youtube')) {
    const a = byId.get(r.asset_id);
    const k = a ? a.kind : 'other';
    pubsByPlatform[k] = (pubsByPlatform[k] || 0) + 1;
  }

  const days = {};
  for (const t of tasks) (days[t.date] = days[t.date] || []).push(t);
  // Daily score = the same task count as Today (recurring items + one-off tasks).
  // As recorded on each day (live for today); days without a record have no score (null).
  const daily = D.eachDay(from, to).map(d => {
    const c = E.dayScore(db, d);
    return { date: d, generated: !!days[d], overall: c.pct, done: c.done ?? 0, total: c.total ?? 0 };
  });
  const target = E.scoreOf(tasks);
  const scored = daily.filter(d => d.overall != null);
  const avgDaily = scored.length ? Math.round((scored.reduce((s, d) => s + d.overall, 0) / scored.length) * 10) / 10 : null;

  const sessions = db.prepare(`SELECT s.*, c.name category_name, p.name project_name FROM sessions s LEFT JOIN categories c ON c.id=s.category_id
    LEFT JOIN projects p ON p.id=s.project_id WHERE s.date>=? AND s.date<=? AND s.state='finished'`).all(from, to);
  const coding = { total_sec: 0, planned_sec: 0, sessions: sessions.length, byCategory: {}, byProject: {} };
  for (const s of sessions) {
    coding.total_sec += s.accumulated_sec; coding.planned_sec += s.planned_sec;
    const c = s.category_name || 'No category'; coding.byCategory[c] = (coding.byCategory[c] || 0) + s.accumulated_sec;
    const p = s.project_name || s.task_label || 'Quick task'; coding.byProject[p] = (coding.byProject[p] || 0) + s.accumulated_sec;
  }
  const study = db.prepare('SELECT c.name, SUM(l.minutes) m FROM study_logs l JOIN courses c ON c.id=l.course_id WHERE l.date>=? AND l.date<=? GROUP BY c.id').all(from, to);
  const modulesDone = db.prepare('SELECT COUNT(*) n FROM modules WHERE done=1 AND done_at>=? AND done_at<=?').get(from, to).n;
  const milestonesDone = db.prepare('SELECT COUNT(*) n FROM milestones WHERE done=1 AND done_at>=? AND done_at<=?').get(from, to).n;

  return {
    from, to, assetCounts: assetCounts(db),
    activity: {
      pins: kinds.pin || 0, articles: kinds.article || 0, videos: kinds.video || 0, publications: kinds.publication || 0,
      youtube: kinds.youtube || 0, units: kinds.unit || 0, checks: kinds.check || 0,
      unitsByRoutine: [...unitsByRoutine.values()].sort((a, b) => b.count - a.count),
      pinsByAccount: listFor('pin'), articlesBySite: listFor('article'), publicationsByPlatform: pubsByPlatform,
      publicationsByPage: listFor('publication'), youtubeByChannel: listFor('youtube'),
      tasksCompleted: tasks.filter(t => t.progress.complete).length + allTodos.filter(t => t.done && t.done_on >= from && t.done_on <= to).length,
      tasksScheduled: tasks.filter(t => t.progress.scoreTarget > 0).length + todos.length,
      customDone: allTodos.filter(t => t.done && t.done_on >= from && t.done_on <= to).length, customTotal: todos.length,
      modulesDone, milestonesDone,
    },
    target, daily, avgDaily, coding,
    study: { total_min: study.reduce((s, x) => s + x.m, 0), byCourse: study },
  };
}

function assetDetail(db, id, fromQ, toQ) {
  const { from, to } = range(db, fromQ, toQ);
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  if (!a) throw E.httpError(404, 'Not found');
  const timeline = db.prepare('SELECT from_date, status FROM asset_status WHERE asset_id=? ORDER BY from_date').all(id);
  const tasks = E.tasksFor(db, from, to);
  const days = D.eachDay(from, to).map(date => {
    let done = 0, target = 0;
    for (const t of tasks.filter(t => t.date === date)) {
      if (t.asset_id === id) { done += t.progress.scoreDone; target += t.progress.scoreTarget; }
      else if (t.type === 'social' && (t.meta.destinations || []).includes(id)) {
        target += t.target;
        done += Math.min(t.target, t.records.filter(r => r.kind === 'publication' && r.asset_id === id && r.idx <= t.target).length);
      }
    }
    const recs = db.prepare('SELECT kind, COUNT(*) n FROM records WHERE asset_id=? AND date=? GROUP BY kind').all(id, date);
    return { date, done, target, pct: target ? Math.round((done / target) * 100) : null, records: Object.fromEntries(recs.map(r => [r.kind, r.n])) };
  });
  const totals = {};
  for (const d of days) for (const [k, n] of Object.entries(d.records)) totals[k] = (totals[k] || 0) + n;
  const t = days.reduce((s, d) => ({ done: s.done + d.done, target: s.target + d.target }), { done: 0, target: 0 });
  return { asset: { ...a, status: E.assetStatusOn(db, id, E.today(db)) || 'pending', timeline }, from, to, days, totals,
    target: { ...t, pct: t.target ? Math.round((t.done / t.target) * 1000) / 10 : null } };
}

module.exports = { stats, assetDetail };
