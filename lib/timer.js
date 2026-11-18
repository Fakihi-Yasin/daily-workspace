// Focus sessions and the coding pause ("Off").
const D = require('./dates');
const E = require('./engine');

const ACTIVE = "state IN ('running','paused','expired')";

// Actual worked seconds; time after the planned end never counts until the user extends.
function actualSec(s, now = Date.now()) {
  let a = s.accumulated_sec;
  if (s.state === 'running' && s.run_started_at) a += Math.floor((now - s.run_started_at) / 1000);
  return Math.min(a, s.planned_sec);
}

// Lazily freeze a running session that reached its planned end.
function settle(db, s, now = Date.now()) {
  if (s && s.state === 'running' && actualSec(s, now) >= s.planned_sec) {
    db.prepare("UPDATE sessions SET state='expired', accumulated_sec=planned_sec, run_started_at=NULL WHERE id=?").run(s.id);
    return db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id);
  }
  return s;
}

function active(db) {
  const s = db.prepare(`SELECT * FROM sessions WHERE ${ACTIVE} ORDER BY id DESC LIMIT 1`).get();
  return s ? decorate(db, settle(db, s)) : null;
}

function decorate(db, s) {
  const p = s.project_id ? db.prepare('SELECT id,name,category_id FROM projects WHERE id=?').get(s.project_id) : null;
  const c = s.category_id ? db.prepare('SELECT id,key,name,color FROM categories WHERE id=?').get(s.category_id) : null;
  const m = s.milestone_id ? db.prepare('SELECT id,title,done FROM milestones WHERE id=?').get(s.milestone_id) : null;
  return { ...s, actual_sec: actualSec(s), project: p, category: c, milestone: m, server_now: Date.now() };
}

// Durations are stored in seconds. Accepts { duration_sec } (preferred) or legacy { minutes }.
const MAX_SEC = 30 * 86400;
function durationSec(b) {
  const sec = b.duration_sec != null ? Math.round(+b.duration_sec) : Math.round(+b.minutes * 60);
  if (!(sec >= 60 && sec <= MAX_SEC)) throw E.httpError(400, 'Duration must be between 1 minute and 30 days');
  return sec;
}

function get(db, id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!s) throw E.httpError(404, 'Session not found');
  return settle(db, s);
}

function start(db, b) {
  if (db.prepare(`SELECT 1 FROM sessions WHERE ${ACTIVE}`).get()) throw E.httpError(409, 'A session is already running');
  const sec = durationSec(b);
  let projectId = b.project_id ? +b.project_id : null;
  let categoryId = b.category_id ? +b.category_id : null;
  let milestoneId = b.milestone_id ? +b.milestone_id : null;
  if (projectId) {
    const p = db.prepare('SELECT id, category_id FROM projects WHERE id=?').get(projectId);
    if (!p) throw E.httpError(400, 'Project not found');
    categoryId = categoryId || p.category_id;
  }
  if (milestoneId && !db.prepare('SELECT 1 FROM milestones WHERE id=? AND project_id=?').get(milestoneId, projectId)) milestoneId = null;
  const label = String(b.task_label || '').trim().slice(0, 200);
  if (!projectId && !label) throw E.httpError(400, 'Choose a project or type a task');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions(date,category_id,project_id,milestone_id,task_label,planned_sec,initial_sec,state,accumulated_sec,run_started_at,started_at)
    VALUES(?,?,?,?,?,?,?, 'running', 0, ?, ?)`).run(E.today(db), categoryId, projectId, milestoneId, label, sec, sec, now, now);
  // Starting a session explicitly means coding again: end any coding "Off".
  cancelOff(db);
  return active(db);
}

function pause(db, id) {
  const s = get(db, id);
  if (s.state !== 'running') return decorate(db, s);
  db.prepare("UPDATE sessions SET state='paused', accumulated_sec=?, run_started_at=NULL WHERE id=?").run(actualSec(s), id);
  return decorate(db, get(db, id));
}

function resume(db, id) {
  const s = get(db, id);
  if (s.state !== 'paused') return decorate(db, s);
  db.prepare("UPDATE sessions SET state='running', run_started_at=? WHERE id=?").run(Date.now(), id);
  return decorate(db, get(db, id));
}

function extend(db, id, body) {
  const s = get(db, id);
  const add = body && typeof body === 'object' ? durationSec(body) : durationSec({ minutes: body });
  if (s.planned_sec + add > MAX_SEC + 86400) throw E.httpError(400, 'Invalid duration');
  if (s.state === 'finished') throw E.httpError(409, 'Session finished');
  if (s.state === 'expired') {
    // "Continuer" after the end: add time and resume immediately.
    db.prepare("UPDATE sessions SET planned_sec=planned_sec+?, state='running', run_started_at=? WHERE id=?").run(add, Date.now(), id);
  } else {
    db.prepare('UPDATE sessions SET planned_sec=planned_sec+? WHERE id=?').run(add, id);
  }
  return decorate(db, get(db, id));
}

function finish(db, id) {
  const s = get(db, id);
  if (s.state === 'finished') return decorate(db, s);
  const a = actualSec(s);
  db.prepare("UPDATE sessions SET state='finished', accumulated_sec=?, run_started_at=NULL, ended_at=?, end_reason=? WHERE id=?")
    .run(a, Date.now(), a >= s.planned_sec ? 'completed' : 'early', id);
  return decorate(db, get(db, id));
}

// ---------- Coding Off ----------
function offStatus(db, now = Date.now()) {
  const p = db.prepare('SELECT * FROM off_periods WHERE cancelled_at IS NULL AND start_at<=? AND end_at>? ORDER BY end_at DESC LIMIT 1').get(now, now);
  return p ? { id: p.id, until: p.end_at, since: p.start_at } : null;
}

function resolveUntil(db, { preset, until_date, until_time }) {
  const tz = E.tz(db);
  const t = E.today(db);
  if (preset === 'tomorrow') return D.localToUTC(tz, D.addDays(t, 1), '00:00');
  if (preset === 'week') return Date.now() + 7 * 86400000;
  if (preset === 'custom') {
    if (!D.isDate(until_date)) throw E.httpError(400, 'Invalid date');
    const ms = D.localToUTC(tz, until_date, /^\d{2}:\d{2}$/.test(until_time || '') ? until_time : '00:00');
    if (ms <= Date.now()) throw E.httpError(400, 'The end must be in the future');
    return ms;
  }
  throw E.httpError(400, 'Invalid choice');
}

function setOff(db, body) {
  if (db.prepare(`SELECT 1 FROM sessions WHERE state IN ('running','paused')`).get()) throw E.httpError(409, 'Finish the current session first');
  const until = resolveUntil(db, body);
  const cur = offStatus(db);
  if (cur) db.prepare('UPDATE off_periods SET end_at=? WHERE id=?').run(until, cur.id);
  else db.prepare('INSERT INTO off_periods(start_at,end_at) VALUES(?,?)').run(Date.now(), until);
  return offStatus(db);
}

function extendOff(db, days) {
  const cur = offStatus(db);
  if (!cur) throw E.httpError(409, 'No active pause');
  db.prepare('UPDATE off_periods SET end_at=end_at+? WHERE id=?').run(Math.round(+days) * 86400000, cur.id);
  return offStatus(db);
}

function cancelOff(db) {
  const cur = offStatus(db);
  if (cur) db.prepare('UPDATE off_periods SET cancelled_at=?, end_at=? WHERE id=?').run(Date.now(), Date.now(), cur.id);
  return null;
}

module.exports = { active, start, pause, resume, extend, finish, offStatus, setOff, extendOff, cancelOff, actualSec };
