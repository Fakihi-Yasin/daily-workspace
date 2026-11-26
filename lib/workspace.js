// Personal workspace settings and helpers: layout (home sections and sidebar, per account), first-login
// starter setups, categories typed on the fly, the calendar, saved views and repeating tasks.
//
// Everything here lives in the account's own dashboard database (the `meta` table and its tables), so
// it is private to the account, synced across its devices, included in its backups, and never part of
// Team Work (teams have their own categories in the shared database).
const D = require('./dates');
const E = require('./engine');

const { httpError, nowIso, J } = E;
const str = (v, max = 500) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);

// ---------- layout ----------
// Home sections: [key, column]. Sidebar items: Today and Settings are always there.
const HOME = { focus: 'main', tasks: 'main', calendar: 'main', projects: 'main', routines: 'main', score: 'side', next: 'side', sessions: 'side', pctime: 'side' };
const NAV = ['projects', 'learning', 'challenges', 'teams', 'views', 'stats'];
const isFresh = (db) => !!E.getMeta(db, 'onboarding'); // accounts created by this version (or later)

function defaultLayout(db) {
  if (!isFresh(db)) {
    // Accounts that existed before customization: exactly the layout they had, nothing new shown.
    const hasAssets = !!db.prepare('SELECT 1 FROM assets LIMIT 1').get();
    const classic = E.getMeta(db, 'profile') !== 'general';
    return {
      home: { order: ['focus', 'tasks', 'routines', 'score', 'next', 'sessions', 'pctime', 'calendar', 'projects'], hidden: ['calendar', 'projects'] },
      nav: { order: NAV.slice(), hidden: ['views'] },
      // Sites & social accounts (Blogging, IPTV, Facebook, Instagram, Pinterest): kept where they're used.
      sites: hasAssets || classic,
    };
  }
  return {
    home: { order: ['tasks', 'projects', 'calendar', 'focus', 'score', 'routines', 'next', 'sessions', 'pctime'], hidden: ['focus', 'score', 'routines', 'next', 'sessions', 'pctime'] },
    nav: { order: NAV.slice(), hidden: ['views'] },
    sites: false,
  };
}

// Stored choices over the defaults; unknown keys dropped, new keys appended (hidden for old accounts).
function cleanList(list, known) { return [...new Set((Array.isArray(list) ? list : []).filter(k => known.includes(k)))]; }
function layoutOf(db) {
  const def = defaultLayout(db);
  const saved = J(E.getMeta(db, 'layout'), null);
  if (!saved) return { ...def, views: [], customized: false };
  const merge = (part, known) => {
    const order = cleanList(saved[part] && saved[part].order, known);
    for (const k of def[part].order) if (!order.includes(k)) order.push(k);
    const hidden = cleanList(saved[part] && saved[part].hidden, known);
    // Sections added in later versions follow the default visibility.
    for (const k of def[part].hidden) if (!(saved[part] && (saved[part].order || []).includes(k)) && !hidden.includes(k)) hidden.push(k);
    return { order, hidden };
  };
  return {
    home: merge('home', Object.keys(HOME)),
    nav: merge('nav', NAV),
    sites: typeof saved.sites === 'boolean' ? saved.sites : def.sites,
    views: cleanViews(saved.views),
    customized: true,
  };
}

function cleanViews(v) {
  return (Array.isArray(v) ? v : []).slice(0, 20).map(x => ({
    id: str(x && x.id, 40) || Math.random().toString(36).slice(2, 10),
    name: str(x && x.name, 60),
    range: ['today', 'week', 'overdue', 'all', 'later'].includes(x && x.range) ? x.range : 'all',
    category_id: x && Number.isInteger(+x.category_id) && +x.category_id > 0 ? +x.category_id : null,
  })).filter(x => x.name);
}

function saveLayout(db, b) {
  const cur = layoutOf(db);
  const next = {
    home: b.home ? { order: cleanList(b.home.order, Object.keys(HOME)), hidden: cleanList(b.home.hidden, Object.keys(HOME)) } : cur.home,
    nav: b.nav ? { order: cleanList(b.nav.order, NAV), hidden: cleanList(b.nav.hidden, NAV) } : cur.nav,
    sites: typeof b.sites === 'boolean' ? b.sites : cur.sites,
    views: b.views !== undefined ? cleanViews(b.views) : cur.views,
  };
  E.setMeta(db, 'layout', JSON.stringify(next));
  return layoutOf(db);
}
function resetLayout(db) {
  const keepViews = layoutOf(db).views;
  db.prepare("DELETE FROM meta WHERE key='layout'").run();
  if (keepViews.length) E.setMeta(db, 'layout', JSON.stringify({ views: keepViews }));
  return layoutOf(db);
}

// ---------- first login: optional starter setups (categories and views only, never sample tasks) ----------
const SETUPS = {
  study: { categories: [['Courses', 'blue'], ['Assignments', 'pink'], ['Exams', 'yellow']], views: [['Exams', 'all', 'Exams'], ['Due this week', 'week', null]], nav: ['learning'] },
  work: { categories: [['Projects', 'blue'], ['Clients', 'mint']], views: [['Due this week', 'week', null]], nav: [] },
  personal: { categories: [['Personal', 'mint'], ['Home', 'sky'], ['Health', 'pink']], views: [], nav: [] },
  blank: { categories: [], views: [], nav: [] },
};
function onboardingState(db) {
  const v = E.getMeta(db, 'onboarding');
  return { pending: v === 'pending', setup: v && v !== 'pending' ? v : null };
}
function applySetup(db, setup) {
  if (!SETUPS[setup] && setup !== 'skip') throw httpError(400, 'Unknown setup');
  const s = SETUPS[setup] || SETUPS.blank;
  const created = [];
  for (const [name, color] of s.categories) created.push(ensureCategory(db, name, color));
  if (s.views.length) {
    const l = layoutOf(db);
    const views = [...l.views];
    for (const [name, range, cat] of s.views) {
      if (views.some(v => v.name.toLowerCase() === name.toLowerCase())) continue;
      const catId = cat ? (db.prepare('SELECT id FROM categories WHERE lower(name)=lower(?)').get(cat) || {}).id || null : null;
      views.push({ id: name.toLowerCase().replace(/\W+/g, '-'), name, range, category_id: catId });
    }
    saveLayout(db, { views, nav: { order: l.nav.order, hidden: l.nav.hidden.filter(k => k !== 'views') } });
  }
  E.setMeta(db, 'onboarding', setup === 'skip' ? 'blank' : setup);
  return { setup, categories: created.length, layout: layoutOf(db) };
}

// ---------- categories ----------
const COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky', 'ink'];
const SUGGESTED = ['Work', 'Study', 'Personal'];
// Find a category by name (case ignored), bringing back an archived one, or create it.
function ensureCategory(db, name, color) {
  const n = str(name, 60);
  if (!n) return null;
  const cur = db.prepare('SELECT * FROM categories WHERE lower(name)=lower(?)').get(n);
  if (cur) { if (cur.archived) db.prepare('UPDATE categories SET archived=0 WHERE id=?').run(cur.id); return cur.id; }
  const key = n.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  const sort = db.prepare("SELECT IFNULL(MAX(sort),0)+1 s FROM categories WHERE key<>'other'").get().s;
  const used = db.prepare('SELECT COUNT(*) n FROM categories').get().n;
  const r = db.prepare('INSERT INTO categories(key,name,color,coding,sort,archived) VALUES(?,?,?,1,?,0)')
    .run(key, n, COLORS.includes(color) ? color : COLORS[used % 5], sort);
  return Number(r.lastInsertRowid);
}
// From a request body: category_name (typed, created on the fly) or category_id; '' / null clears it.
// Returns undefined when the body doesn't mention a category (leave it unchanged).
function categoryFrom(db, b) {
  if (b.category_name !== undefined) return b.category_name ? ensureCategory(db, b.category_name) : null;
  if (b.category_id !== undefined) {
    if (b.category_id === null || b.category_id === '' || +b.category_id === 0) return null;
    const c = db.prepare('SELECT id FROM categories WHERE id=?').get(+b.category_id);
    if (!c) throw httpError(400, 'Unknown category');
    return c.id;
  }
  return undefined;
}
function archiveCategory(db, id, archived) {
  const c = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (!c) throw httpError(404, 'Category not found');
  if (c.key === 'other' && archived) throw httpError(409, '“Other” can’t be archived');
  db.prepare('UPDATE categories SET archived=? WHERE id=?').run(archived ? 1 : 0, id);
  return { id, archived: !!archived };
}

// ---------- repeating tasks ----------
const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'monthly'];
function nextDate(date, repeat) {
  if (repeat === 'daily') return D.addDays(date, 1);
  if (repeat === 'weekly') return D.addDays(date, 7);
  if (repeat === 'weekdays') { let d = D.addDays(date, 1); while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = D.addDays(d, 1); return d; }
  if (repeat === 'monthly') {
    const [y, m, day] = date.split('-').map(Number);
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // days in the next month
    return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  }
  return null;
}
// Completing a repeating task schedules the next one (once), with the same title and category.
function spawnNext(db, t) {
  if (!t.repeat) return null;
  const series = t.series_id || t.id;
  let date = nextDate(t.date, t.repeat);
  const today = E.today(db);
  while (date && date <= today && t.repeat !== 'monthly') date = nextDate(date, t.repeat); // never schedule into the past
  if (!date) return null;
  if (db.prepare('SELECT 1 FROM todos WHERE series_id=? AND date>? AND done=0 AND cancelled_on IS NULL').get(series, t.date)) return null;
  const sort = db.prepare('SELECT IFNULL(MAX(sort),0)+1 s FROM todos WHERE date=?').get(date).s;
  const r = db.prepare('INSERT INTO todos(date,title,done,created_at,sort,category_id,repeat,series_id) VALUES(?,?,0,?,?,?,?,?)')
    .run(date, t.title, nowIso(), sort, t.category_id || null, t.repeat, series);
  if (!t.series_id) db.prepare('UPDATE todos SET series_id=? WHERE id=?').run(series, t.id);
  return Number(r.lastInsertRowid);
}
// Reopening a completed repeating task removes the next one again if it's still untouched.
function unspawnNext(db, t) {
  if (!t.repeat || !(t.series_id || t.id)) return;
  db.prepare(`DELETE FROM todos WHERE series_id=? AND date>? AND done=0 AND cancelled_on IS NULL
    AND NOT EXISTS (SELECT 1 FROM subtasks s WHERE s.todo_id=todos.id)`).run(t.series_id || t.id, t.date);
}

// ---------- calendar and saved views ----------
function openTodos(db) {
  return db.prepare(`SELECT t.id, t.date, t.title, t.category_id, t.repeat, c.name AS category_name, c.color AS category_color
    FROM todos t LEFT JOIN categories c ON c.id=t.category_id
    WHERE t.done=0 AND t.cancelled_on IS NULL ORDER BY t.date, t.sort, t.id`).all();
}
function agenda(db, days = 14) {
  const t = E.today(db);
  const end = D.addDays(t, Math.min(Math.max(+days || 14, 1), 60));
  const todos = openTodos(db);
  const projects = db.prepare(`SELECT p.id, p.name, p.status, p.planned_for, p.next_action, c.name AS category_name, c.color AS category_color
    FROM projects p LEFT JOIN categories c ON c.id=p.category_id WHERE p.status <> 'done'`).all();
  return {
    today: t, end,
    overdue: todos.filter(x => x.date < t).length,
    days: D.eachDay(t, end).map(d => ({
      date: d,
      tasks: todos.filter(x => x.date === d),
      projects: projects.filter(p => p.planned_for === d),
    })).filter(x => x.tasks.length || x.projects.length),
    months: projects.filter(p => /^\d{4}-\d{2}$/.test(p.planned_for) && p.planned_for >= t.slice(0, 7) && p.planned_for <= end.slice(0, 7)),
  };
}
function viewTasks(db, { range = 'all', category_id = null } = {}) {
  const t = E.today(db);
  const weekEnd = D.addDays(t, 6 - ((new Date(t + 'T12:00:00Z').getUTCDay() + 6) % 7)); // through Sunday
  return openTodos(db).filter(x =>
    (range === 'all' || (range === 'today' && x.date <= t) || (range === 'overdue' && x.date < t) ||
     (range === 'week' && x.date <= weekEnd) || (range === 'later' && x.date > weekEnd))
    && (!category_id || x.category_id === +category_id));
}

module.exports = {
  HOME, NAV, SUGGESTED, REPEATS, layoutOf, saveLayout, resetLayout, onboardingState, applySetup,
  ensureCategory, categoryFrom, archiveCategory, nextDate, spawnNext, unspawnNext, agenda, viewTasks,
};
