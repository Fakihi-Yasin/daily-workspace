// Demo data, written ONLY into the separate demo database (never into real data).
//
// A small, made-up team ("Northwind Studio": client projects, marketing and customer support), so
// anyone can see every feature with work that looks like theirs. Built through the app's own API
// routes wherever possible, so the demo follows the same rules as real use. Covers:
//   Today: starter routines with checklists, custom counters (tickets, calls), a blog counter on a
//          site, social posts on two pages, a routine change scheduled for later, a task moved to
//          another day, a note on a task, one-off tasks (multiline with bullets, subtasks partly done,
//          done, cancelled, overdue, scheduled for later), 14 days of history with daily scores and
//          completion history, finished focus sessions, a past "Off" period.
//   Settings: sites and pages with an active, a paused and an upcoming one; general categories.
//   Projects: every status, milestones, next actions, focus time per project and milestone.
//   Learning: a course and a skill with modules and study time.
//   Challenges: goals on a routine, a custom counter, focus sessions, study time and milestones.
// Team Work and Users use the real shared database and are not part of the demo.
const D = require('./dates');
const E = require('./engine');
const A = require('./api');
const C = require('./challenges');

function seedDemo(db) {
  A.ensureDefaults(db);
  const api = (method, path, body) => A.call(db, method, path, body);
  const t = E.today(db);
  // The demo's own categories and routines (real new accounts start blank and choose a setup).
  const cat = db.prepare('INSERT OR IGNORE INTO categories(key,name,color,coding,sort) VALUES(?,?,?,?,?)');
  cat.run('client', 'Client work', 'blue', 1, 1);
  cat.run('internal', 'Internal projects', 'mint', 1, 2);
  cat.run('growth', 'Marketing & sales', 'pink', 1, 3);
  for (const [name, category, checklist, slot] of [['Plan the day', 'Planning', ['Check calendar and messages', 'Pick the top 3 priorities'], 'Morning'],
    ['Inbox zero', 'Communication', [], ''], ['End-of-day review', 'Planning', ['Update task statuses', 'Plan tomorrow'], 'Evening']]) {
    api('POST', '/api/routines', { name, category, type: 'check', config: { days: [1, 2, 3, 4, 5], checklist, time_slot: slot } });
  }
  // Every section on, the extras in the sidebar, and a saved view, so the demo shows everything.
  E.setMeta(db, 'onboarding', 'work');
  api('PUT', '/api/workspace/layout', { home: { order: ['focus', 'tasks', 'calendar', 'projects', 'routines', 'score', 'next', 'sessions', 'pctime'], hidden: [] },
    nav: { order: ['projects', 'learning', 'challenges', 'teams', 'views', 'stats'], hidden: [] }, sites: true,
    views: [{ id: 'client-week', name: 'Client work this week', range: 'week', category_id: db.prepare("SELECT id FROM categories WHERE key='client'").get().id }] });
  const start = D.addDays(t, -20);
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const at = (date, h, m = 0) => `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

  // ---------- sites, pages and channels (active since the start, one paused, one upcoming)
  const asset = (kind, name, url = '', status = 'active', from = start) => {
    const r = db.prepare('INSERT INTO assets(kind,name,url,notes,created_at) VALUES(?,?,?,?,?)').run(kind, name, url, '', E.nowIso());
    db.prepare('INSERT INTO asset_status(asset_id,from_date,status,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid, from, 'active', E.nowIso());
    if (status !== 'active') db.prepare('INSERT INTO asset_status(asset_id,from_date,status,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid, D.addDays(t, -6), status, E.nowIso());
    return Number(r.lastInsertRowid);
  };
  asset('site_other', 'Company website', 'https://northwind.example');
  asset('site_blog', 'Northwind blog', 'https://blog.northwind.example');
  asset('site_blog', 'Old product blog', 'https://news.northwind.example', 'paused');
  const fb = asset('facebook', 'Northwind Studio (Facebook)');
  const ig = asset('instagram', '@northwind.studio');
  asset('instagram', '@northwind.careers', '', 'active', D.addDays(t, 5)); // starts later: shown as Upcoming
  asset('other', 'Support inbox');

  // ---------- routines (in addition to the starter ones), effective since the start
  const weekdays = [1, 2, 3, 4, 5];
  api('POST', '/api/routines', { name: 'Customer support', category: 'Support', type: 'counter', config: { days: weekdays, unit: 'unit', unit_label: 'tickets answered', asset_scope: 'none', target_mode: 'shared', target: 5, time_slot: '' } });
  const sales = api('POST', '/api/routines', { name: 'Sales outreach', category: 'Sales', type: 'counter', config: { days: weekdays, unit: 'unit', unit_label: 'calls made', asset_scope: 'none', target_mode: 'shared', target: 3, time_slot: 'Afternoon' } }).id;
  api('POST', '/api/routines', { name: 'Blog articles', category: 'Content', type: 'counter', config: { days: [2, 4], unit: 'article', unit_label: 'articles published', asset_scope: 'kinds', asset_kinds: ['site_blog'], target_mode: 'per_asset', target: 1, time_slot: '' } });
  api('POST', '/api/routines', { name: 'Social posts', category: 'Marketing', type: 'social', config: { days: [1, 3, 5], slots: [
    { key: 'am', label: 'Morning post', time: '09:30', videos: 1, mode: 'shared', dest_scope: 'list', destinations: [fb, ig] }] } });
  db.prepare('UPDATE routine_versions SET from_date=?').run(start);
  db.prepare('DELETE FROM tasks').run(); db.prepare('DELETE FROM days').run(); // regenerated below from the start date
  // A change already scheduled: more calls per day from next Monday (shown as "From …" in Settings).
  const nextMonday = D.addDays(t, ((8 - new Date(t + 'T12:00:00Z').getUTCDay()) % 7) || 7);
  api('PUT', `/api/routines/${sales}`, { from_date: nextMonday, config: { days: weekdays, unit: 'unit', unit_label: 'calls made', asset_scope: 'none', target_mode: 'shared', target: 4, time_slot: 'Afternoon' } });

  // ---------- the last 14 days: routine progress, one-off tasks, scores
  const doneTodo = (date, title, h) => {
    const id = api('POST', '/api/todos', { date, title }).id;
    api('PUT', `/api/todos/${id}`, { done: true, on: date });
    db.prepare('UPDATE todos SET done_at=? WHERE id=?').run(at(date, h, 15), id);
    db.prepare("UPDATE completions SET done_at=? WHERE kind='todo' AND todo_id=?").run(at(date, h, 15), id);
    return id;
  };
  const pastTodos = ['Send invoice to Acme Inc.', 'Review the homepage copy', 'Book the team retrospective', 'Update the pricing sheet',
    'Answer the partnership email', 'Prepare the client demo', 'Clean up the shared drive', 'Write the release notes'];
  let lastWorkday = D.addDays(t, -1);
  while (![1, 2, 3, 4, 5].includes(new Date(lastWorkday + 'T12:00:00Z').getUTCDay())) lastWorkday = D.addDays(lastWorkday, -1);
  for (let d = D.addDays(t, -14); d < t; d = D.addDays(d, 1)) {
    E.ensureDay(db, d);
    for (const task of E.tasksFor(db, d)) {
      const level = rand();
      if (d === lastWorkday && task.label === 'Sales outreach') continue; // left untouched: moved to today below
      if (task.type === 'counter') {
        const n = Math.round(task.target * Math.min(1.4, level + 0.25));
        const sites = task.meta.asset_ids || [];
        for (let i = 1; i <= n; i++) {
          if (i <= task.target) E.setMark(db, task.id, { kind: task.unit, idx: i, asset_id: task.asset_id || null, done: true });
          else E.addExtra(db, task.id, { kind: task.unit, asset_id: task.asset_id || sites[i % Math.max(1, sites.length)] || null });
        }
      } else if (task.type === 'social') {
        for (const dest of task.meta.destinations) if (rand() < 0.8) E.setMark(db, task.id, { kind: 'publication', idx: 1, asset_id: dest, done: true });
      } else {
        const items = Math.max(1, (task.meta.checklist || []).length);
        for (let i = 0; i < items; i++) if (level > 0.2 + i * 0.15) E.setMark(db, task.id, { kind: 'check', idx: i, done: true });
      }
    }
    const k = D.diffDays(d, t);
    if (k % 2 === 0) doneTodo(d, pastTodos[(k / 2) % pastTodos.length], 10 + (k % 6));
    db.prepare('UPDATE records SET created_at=? WHERE date=?').run(at(d, 9 + Math.floor(rand() * 8), Math.floor(rand() * 60)), d);
    E.recordDayScore(db, d);
  }
  // Tasks of each past day were done through the day, not all at once.
  for (const r of db.prepare('SELECT id, date FROM records WHERE date<?').all(t)) db.prepare('UPDATE records SET created_at=? WHERE id=?').run(at(r.date, 8 + Math.floor(rand() * 10), Math.floor(rand() * 60)), r.id);

  // An overdue task (from 3 days ago, still open) and one cancelled.
  api('POST', '/api/todos', { date: D.addDays(t, -3), title: 'Send the signed contract back to Acme Inc.' });
  const dropped = api('POST', '/api/todos', { date: D.addDays(t, -2), title: 'Order new office chairs' }).id;
  api('POST', `/api/todos/${dropped}/cancel`);

  // ---------- today
  E.ensureDay(db, t);
  const missed = E.tasksFor(db, lastWorkday).find(x => x.label === 'Sales outreach' && x.progress.done === 0);
  if (missed) api('POST', `/api/tasks/${missed.id}/report`, { to: t }); // "Moved to today" from the last workday
  const plan = E.tasksFor(db, t).find(x => x.label === 'Plan the day');
  if (plan) { E.setMark(db, plan.id, { kind: 'check', idx: 0, done: true }); api('PUT', `/api/tasks/${plan.id}/note`, { note: 'Priorities: client demo, onboarding guide, hiring post.' }); }
  const support = E.tasksFor(db, t).find(x => x.label === 'Customer support');
  if (support) for (let i = 1; i <= 2; i++) E.setMark(db, support.id, { kind: 'unit', idx: i, done: true });

  api('POST', '/api/todos', { date: t, title: 'Prepare the client demo for Acme Inc.\n• Update the slides\n• Rehearse the walkthrough\n• Send the meeting link', category_name: 'Client work' });
  api('POST', '/api/todos', { date: D.addDays(t, 2), title: 'Send the weekly status report', category_name: 'Client work', repeat: 'weekly' });
  const onboarding = api('POST', '/api/todos', { date: t, title: 'Draft the customer onboarding guide' }).id;
  const subs = ['Outline the steps', 'Write the welcome email', 'Add screenshots', 'Ask support to review'].map(title => api('POST', `/api/todos/${onboarding}/subtasks`, { title }).id);
  api('PUT', `/api/subtasks/${subs[0]}`, { done: true, on: t });
  api('PUT', `/api/subtasks/${subs[1]}`, { done: true, on: t });
  doneTodo(t, 'Reply to the new client brief', 9);
  api('POST', '/api/todos', { date: t, title: 'Publish the job post for a support specialist' });
  api('POST', '/api/todos', { date: D.addDays(t, 2), title: 'Quarterly planning meeting' });
  api('POST', '/api/todos', { date: D.addDays(t, 6), title: 'Renew the domain name' });

  // ---------- projects: every status, milestones, focus time
  const cats = Object.fromEntries(db.prepare('SELECT key, id FROM categories').all().map(c => [c.key, c.id]));
  const redesign = A.createProject(db, { name: 'Website redesign', category_id: cats.client, topic: 'Acme Inc.', status: 'in_progress',
    next_action: 'Finish the pricing page design', milestones: ['Discovery', 'Wireframes', 'Visual design', 'Build', 'Launch'] }).id;
  const ms = db.prepare('SELECT id, sort FROM milestones WHERE project_id=? ORDER BY sort').all(redesign);
  db.prepare('UPDATE milestones SET done=1, done_at=? WHERE project_id=? AND sort<2').run(D.addDays(t, -6), redesign);
  A.createProject(db, { name: 'Customer onboarding guide', category_id: cats.internal, topic: 'Support', status: 'planned', next_action: 'List the top 10 customer questions', milestones: ['Questions', 'Draft', 'Review', 'Publish'] });
  A.createProject(db, { name: 'Spring campaign', category_id: cats.growth, topic: 'Newsletter + social', status: 'planned_date', planned_for: D.addDays(t, 40).slice(0, 7), milestones: ['Brief', 'Assets', 'Schedule', 'Report'] });
  A.createProject(db, { name: 'Customer feedback survey', category_id: cats.internal, topic: 'Product', status: 'idea' });
  const done = A.createProject(db, { name: 'Brand guidelines', category_id: cats.growth, topic: 'Design', status: 'done', milestones: ['Logo', 'Colors', 'Templates'] }).id;
  db.prepare('UPDATE milestones SET done=1, done_at=? WHERE project_id=?').run(D.addDays(t, -10), done);
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue;
    const d = D.addDays(t, -i);
    const sec = Math.round(1500 + rand() * 2400);
    const m = ms[i % 3 === 0 ? 1 : 2];
    const startMs = new Date(at(d, 10)).getTime();
    db.prepare("INSERT INTO sessions(date,category_id,project_id,milestone_id,task_label,planned_sec,initial_sec,state,accumulated_sec,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,?, 'finished',?,?,?,?)")
      .run(d, cats.client, redesign, m.id, i % 3 === 0 ? 'Wireframes' : 'Pricing page', 3600, 3600, sec, startMs, startMs + sec * 1000, sec >= 3600 ? 'completed' : 'early');
  }
  { // a short focus session today, on a quick task
    const startMs = Date.now() - 50 * 60000;
    db.prepare("INSERT INTO sessions(date,category_id,project_id,task_label,planned_sec,initial_sec,state,accumulated_sec,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?, 'finished',?,?,?,?)")
      .run(t, cats.growth, null, 'Write the newsletter intro', 1500, 1500, 1500, startMs, startMs + 1500000, 'completed');
  }
  // A day off last week: focus prompts were paused.
  const offStart = new Date(at(D.addDays(t, -4), 0)).getTime();
  db.prepare('INSERT INTO off_periods(start_at,end_at) VALUES(?,?)').run(offStart, offStart + 86400000);

  // ---------- learning
  const course = api('POST', '/api/courses', { name: 'Project management fundamentals', modules: ['Scope and goals', 'Planning and estimates', 'Running meetings', 'Risks and changes', 'Closing a project'] }).id;
  const mods = db.prepare('SELECT id FROM modules WHERE course_id=? ORDER BY sort').all(course);
  for (const m of mods.slice(0, 3)) api('PUT', `/api/modules/${m.id}`, { done: true });
  db.prepare('UPDATE modules SET done_at=? WHERE course_id=? AND done=1').run(D.addDays(t, -3), course);
  [[-9, 40], [-6, 30], [-3, 45], [-1, 25]].forEach(([k, minutes]) => api('POST', `/api/courses/${course}/study`, { date: D.addDays(t, k), minutes, note: '' }));
  const skill = api('POST', '/api/courses', { name: 'Public speaking', kind: 'skill', modules: ['Structure a talk', 'Slides that help', 'Handle questions'] }).id;
  api('POST', `/api/courses/${skill}/study`, { date: D.addDays(t, -2), minutes: 20, note: 'Practised the client demo' });

  // ---------- challenge
  const routineId = (name) => (db.prepare('SELECT id FROM routines WHERE name=?').get(name) || {}).id;
  C.create(db, { name: 'Focused month', start_date: D.addDays(t, -10), goals: [
    { metric: 'routine_done', label: 'Plan the day every weekday', routine_id: routineId('Plan the day'), period: 'week', target: 5 },
    { metric: 'unit', label: '25 tickets answered a week', routine_id: routineId('Customer support'), period: 'week', target: 25 },
    { metric: 'coding_sessions', label: '3 focus sessions a week', period: 'week', target: 3 },
    { metric: 'study_minutes', label: '4 hours of learning', period: 'total', target: 240 },
    { metric: 'milestones', label: '3 project milestones', period: 'total', target: 3 },
  ] });

  E.recordDayScore(db, t);
  E.setMeta(db, 'is_demo', '1');
}

module.exports = { seedDemo };
