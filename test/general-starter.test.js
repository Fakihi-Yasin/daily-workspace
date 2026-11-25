// New accounts start with a general starter set (any kind of work), and the demo shows every feature
// with a made-up team. Existing accounts keep their own data (see flows.test.js for the classic set).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../lib/db');
const A = require('../lib/api');
const { seedDemo } = require('../lib/demo');

const fresh = () => open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-gen-')), 'db.sqlite'));
const JOB_WORDS = /iptv|pinterest|whatsapp|dmca|crochet|tattoo|recipe/i;

test('a new account gets general categories, starter routines and the device time zone', () => {
  const db = fresh();
  A.ensureDefaults(db);
  const cats = A.call(db, 'GET', '/api/categories').map(c => c.name);
  assert.deepEqual(cats, ['Client work', 'Internal projects', 'Marketing & sales', 'Other']);
  const routines = A.call(db, 'GET', '/api/routines').map(r => r.name);
  assert.deepEqual(routines, ['Plan the day', 'Inbox zero', 'End-of-day review']);
  assert.equal(A.call(db, 'GET', '/api/bootstrap').tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(!JOB_WORDS.test(JSON.stringify([cats, routines])));
});

test('the demo shows every feature with general work, and nothing job-specific', () => {
  const db = fresh();
  seedDemo(db);
  const n = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  for (const t of ['assets', 'routines', 'records', 'todos', 'subtasks', 'completions', 'day_scores', 'sessions', 'off_periods',
    'projects', 'milestones', 'courses', 'modules', 'study_logs', 'challenges', 'challenge_goals']) assert.ok(n(t) > 0, `demo has ${t}`);
  const today = A.call(db, 'GET', '/api/today');
  const todos = today.todos;
  assert.ok(todos.some(t => t.title.includes('\n• ')), 'a multiline task with bullets');
  assert.ok(todos.some(t => t.subtasks.some(s => s.done) && t.subtasks.some(s => !s.done)), 'subtasks partly done');
  assert.ok(todos.some(t => t.done), 'a task done today');
  assert.ok(todos.some(t => t.date < today.date && !t.done), 'an overdue task');
  assert.ok(today.cancelled.length >= 1, 'a cancelled task');
  assert.equal(today.reportedIn, 1, 'a routine task moved to today from the last workday');
  assert.ok(today.tasks.some(t => t.note), 'a note on a routine task');
  assert.ok(A.call(db, 'GET', '/api/routines').some(r => r.upcoming.length), 'a routine change scheduled for later');
  const assets = A.call(db, 'GET', '/api/assets').map(a => a.status);
  for (const s of ['active', 'paused', 'pending']) assert.ok(assets.includes(s), `an asset ${s}`);
  const statuses = A.call(db, 'GET', '/api/projects').map(p => p.status).sort();
  assert.deepEqual(statuses, ['done', 'idea', 'in_progress', 'planned', 'planned_date']);
  const h = A.call(db, 'GET', '/api/history/scores');
  assert.ok(h.days.filter(d => d.pct != null).length >= 8, 'two weeks of daily scores');
  const st = A.call(db, 'GET', `/api/stats?from=${h.days[h.days.length - 1].date}&to=${h.today}`);
  assert.deepEqual(st.activity.unitsByRoutine.map(u => u.unit_label).sort(), ['calls made', 'tickets answered']);
  assert.ok(st.coding.sessions > 0 && st.study.total_min > 0);
  const ch = A.call(db, 'GET', '/api/challenges')[0];
  assert.equal(ch.goals.length, 5);
  assert.ok(ch.goals.every(g => g.target_total > 0));
  // No job-specific names anywhere in what the demo shows.
  const text = JSON.stringify({ today, r: A.call(db, 'GET', '/api/routines'), a: A.call(db, 'GET', '/api/assets'), p: A.call(db, 'GET', '/api/projects'),
    c: A.call(db, 'GET', '/api/courses'), ch: A.call(db, 'GET', '/api/challenges'), cats: A.call(db, 'GET', '/api/categories') });
  assert.ok(!JOB_WORDS.test(text), 'demo text is general: ' + (text.match(JOB_WORDS) || [])[0]);
});
