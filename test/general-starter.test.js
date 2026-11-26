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

test('a new account starts blank: no sample tasks, routines or categories; layout with Tasks, Calendar, Projects', () => {
  const db = fresh();
  A.ensureDefaults(db);
  assert.deepEqual(A.call(db, 'GET', '/api/categories').map(c => c.name), ['Other']);
  assert.deepEqual(A.call(db, 'GET', '/api/routines'), []);
  const today = A.call(db, 'GET', '/api/today');
  assert.deepEqual([today.todos.length, today.tasks.length], [0, 0], 'no sample tasks');
  assert.equal(A.call(db, 'GET', '/api/bootstrap').tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const ws = A.call(db, 'GET', '/api/workspace');
  assert.deepEqual(ws.onboarding, { pending: true, setup: null }, 'first login offers the starter setups');
  const shown = ws.layout.home.order.filter(k => !ws.layout.home.hidden.includes(k));
  assert.deepEqual(shown, ['tasks', 'projects', 'calendar']);
  assert.equal(ws.layout.sites, false, 'no sites & social sections by default');
  assert.ok(ws.layout.nav.hidden.includes('views'), 'saved views stay out of the way');
  assert.deepEqual(ws.suggested, ['Work', 'Study', 'Personal']);
});

test('starter setups only add categories and views; Start blank adds nothing; everything can change later', () => {
  const blank = fresh(); A.ensureDefaults(blank);
  A.call(blank, 'POST', '/api/workspace/setup', { setup: 'blank' });
  assert.deepEqual(A.call(blank, 'GET', '/api/categories').map(c => c.name), ['Other']);
  assert.deepEqual(A.call(blank, 'GET', '/api/workspace').onboarding, { pending: false, setup: 'blank' });
  assert.equal(A.call(blank, 'GET', '/api/today').todos.length, 0);

  const study = fresh(); A.ensureDefaults(study);
  A.call(study, 'POST', '/api/workspace/setup', { setup: 'study' });
  assert.deepEqual(A.call(study, 'GET', '/api/categories').map(c => c.name), ['Courses', 'Assignments', 'Exams', 'Other']);
  const ws = A.call(study, 'GET', '/api/workspace');
  assert.deepEqual(ws.layout.views.map(v => v.name), ['Exams', 'Due this week']);
  assert.ok(!ws.layout.nav.hidden.includes('views'), 'their saved views are in the sidebar');
  assert.equal(A.call(study, 'GET', '/api/today').todos.length, 0, 'still no tasks');
  // Running a setup again never duplicates; work adds its own.
  A.call(study, 'POST', '/api/workspace/setup', { setup: 'study' });
  A.call(study, 'POST', '/api/workspace/setup', { setup: 'work' });
  assert.deepEqual(A.call(study, 'GET', '/api/categories').map(c => c.name), ['Courses', 'Assignments', 'Exams', 'Projects', 'Clients', 'Other']);
  assert.throws(() => A.call(study, 'POST', '/api/workspace/setup', { setup: 'nope' }), /Unknown setup/);
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
