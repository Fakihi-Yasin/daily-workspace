// Database schema, seeding and migrations — shared by the Node server and the browser (Vercel) build.
const D = require('./dates');
// 2: subtasks, completion log, recorded daily scores, cancelled one-off tasks.
// Older backups/snapshots (1) load and are upgraded by migrate(); newer data is refused by older versions.
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- site_iptv | site_blog | site_other | pinterest | facebook | instagram | youtube | other
  name TEXT NOT NULL,
  url TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
-- Status timeline so that changes only affect schedules from their effective date.
CREATE TABLE IF NOT EXISTS asset_status (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_date TEXT NOT NULL,
  status TEXT NOT NULL,          -- active | paused | archived
  created_at TEXT NOT NULL,
  UNIQUE(asset_id, from_date)
);

CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,        -- score group label, e.g. "Pinterest"
  type TEXT NOT NULL,            -- counter | social | check
  created_at TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS routine_versions (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  from_date TEXT NOT NULL,
  config TEXT NOT NULL,          -- JSON
  created_at TEXT NOT NULL,
  UNIQUE(routine_id, from_date)
);

CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, generated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  routine_id INTEGER NOT NULL,
  version_id INTEGER,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  unit TEXT NOT NULL,            -- pin | article | unit | youtube | publication | check
  asset_id INTEGER,
  slot_key TEXT,
  label TEXT NOT NULL,
  target INTEGER NOT NULL,
  time_slot TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',   -- open | reported
  reported_to TEXT,
  origin_task_id INTEGER,
  note TEXT DEFAULT '',
  gen_key TEXT NOT NULL UNIQUE,
  sort INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_date ON tasks(date);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  task_id INTEGER,
  routine_id INTEGER,
  kind TEXT NOT NULL,            -- pin | article | unit | video | publication | check | youtube
  asset_id INTEGER,
  idx INTEGER NOT NULL DEFAULT 0,
  video_ref INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS records_unique ON records(task_id, kind, IFNULL(asset_id, 0), idx) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS records_video ON records(video_ref) WHERE kind = 'youtube';
CREATE INDEX IF NOT EXISTS records_date ON records(date);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  coding INTEGER NOT NULL DEFAULT 1,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  topic TEXT DEFAULT '',
  links TEXT DEFAULT '[]',
  notes TEXT DEFAULT '',
  next_action TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idea',   -- idea | planned | planned_date | in_progress | done
  planned_for TEXT DEFAULT '',            -- YYYY-MM-DD or YYYY-MM (approx month)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  category_id INTEGER,
  project_id INTEGER,
  task_label TEXT DEFAULT '',
  planned_sec INTEGER NOT NULL,
  initial_sec INTEGER NOT NULL,
  state TEXT NOT NULL,           -- running | paused | expired | finished
  accumulated_sec INTEGER NOT NULL DEFAULT 0,
  run_started_at INTEGER,        -- epoch ms of current running stretch
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT                -- completed | early
);

CREATE TABLE IF NOT EXISTS off_periods (
  id INTEGER PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  cancelled_at INTEGER
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'idea',    -- idea | script | recording | editing | published
  planned_date TEXT DEFAULT '',
  published_date TEXT DEFAULT '',
  url TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'course',  -- course | skill
  link TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS study_logs (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
-- One-off tasks for a specific date ("My tasks" on Today). Never repeat.
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS todos_date ON todos(date);

-- Checklist items inside a one-off task. They never count as separate tasks in the daily score.
CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  done_on TEXT,
  created_at TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subtasks_todo ON subtasks(todo_id);

-- Completion history: one row each time a one-off task (or subtask) is marked Done, on the local day it
-- was marked. No foreign keys: rows outlive later edits, rescheduling and deletion. Reopening removes it.
CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- todo | subtask
  todo_id INTEGER,
  subtask_id INTEGER,
  title TEXT NOT NULL,           -- title when completed (current title is shown while the task exists)
  parent_title TEXT,
  done_on TEXT NOT NULL,
  done_at TEXT,
  source TEXT NOT NULL DEFAULT 'live',   -- live | backfill (reconstructed from older data)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS completions_day ON completions(done_on);

-- Daily score as recorded for each day, so later deletions, cancellations or moves don't rewrite it.
CREATE TABLE IF NOT EXISTS day_scores (
  date TEXT PRIMARY KEY,
  done INTEGER NOT NULL,
  total INTEGER NOT NULL,
  pct INTEGER,
  detail TEXT DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'live',   -- live | backfill
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_goals (
  id INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  metric TEXT NOT NULL,          -- pin | article | video | publication | unit | routine_done | coding_sessions | coding_minutes | study_minutes | youtube | milestones
  routine_id INTEGER,
  asset_ids TEXT,                -- JSON snapshot taken at creation, null = not asset-scoped
  per_asset INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL,          -- day | week | total
  days TEXT DEFAULT '[0,1,2,3,4,5,6]',
  target INTEGER NOT NULL,
  sort INTEGER DEFAULT 0
);
`;

// Tables included in backups, in insertion order (parents first).
const TABLES = ['meta', 'assets', 'asset_status', 'routines', 'routine_versions', 'days', 'tasks', 'records',
  'categories', 'projects', 'milestones', 'sessions', 'off_periods', 'videos', 'courses', 'modules',
  'study_logs', 'challenges', 'challenge_goals', 'todos', 'subtasks', 'completions', 'day_scores'];

// Create tables, seed a brand-new database, run migrations. Works with node:sqlite and the browser adapter.
function init(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!v) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
    seedBase(db);
  }
  migrate(db);
  return db;
}

// Additive, idempotent migrations for databases created by earlier versions.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!cols.includes('milestone_id')) db.exec('ALTER TABLE sessions ADD COLUMN milestone_id INTEGER');
  // Deleted entries keep their row (and id) so past activity still resolves; they drop out from deleted_on.
  if (!db.prepare('PRAGMA table_info(assets)').all().some(c => c.name === 'deleted_on')) db.exec('ALTER TABLE assets ADD COLUMN deleted_on TEXT');
  // The local day a one-off task was completed (credit goes to that day; overdue tasks carry until then).
  if (!db.prepare('PRAGMA table_info(todos)').all().some(c => c.name === 'done_on')) {
    db.exec('ALTER TABLE todos ADD COLUMN done_on TEXT');
    db.exec('UPDATE todos SET done_on=date WHERE done=1 AND done_on IS NULL');
  }
  // v2: cancelled one-off tasks (kept in history, out of active lists and later scores). Old rows: not cancelled.
  const todoCols = db.prepare('PRAGMA table_info(todos)').all().map(c => c.name);
  if (!todoCols.includes('cancelled_on')) db.exec('ALTER TABLE todos ADD COLUMN cancelled_on TEXT');
  if (!todoCols.includes('cancelled_at')) db.exec('ALTER TABLE todos ADD COLUMN cancelled_at TEXT');
  // v2: completion history starts now. Older completions are reconstructed from tasks still marked done
  // (tasks deleted before this version left no trace, so days before this date are flagged "partial").
  if (!db.prepare("SELECT 1 FROM meta WHERE key='completion_log_since'").get()) {
    const tzRow = db.prepare("SELECT value FROM meta WHERE key='timezone'").get();
    db.prepare("INSERT INTO meta(key,value) VALUES('completion_log_since',?)").run(D.todayIn((tzRow && tzRow.value) || 'Africa/Casablanca'));
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO completions(kind,todo_id,title,done_on,done_at,source,created_at)
    SELECT 'todo', t.id, t.title, COALESCE(t.done_on, t.date), t.done_at, 'backfill', ? FROM todos t
    WHERE t.done=1 AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.kind='todo' AND c.todo_id=t.id)`).run(now);
  db.prepare("UPDATE meta SET value=? WHERE key='schema_version' AND CAST(value AS INTEGER) < ?").run(String(SCHEMA_VERSION), SCHEMA_VERSION);
  // "Other" project category (kept last in lists).
  db.prepare("INSERT OR IGNORE INTO categories(key,name,color,coding,sort) VALUES('other','Other','ink',1,1000)").run();
  // Planning categories for YouTube and social accounts. Skipped when the key or the same name already exists
  // (e.g. a category the user created or renamed), so nothing is duplicated.
  // Accounts created with the general starter set ('profile' = 'general') don't get them.
  const general = db.prepare("SELECT 1 FROM meta WHERE key='profile' AND value='general'").get();
  for (const [key, name, color, sort] of general ? [] : [['youtube', 'YouTube', 'yellow', 4], ['instagram', 'Instagram', 'pink', 5], ['facebook', 'Facebook', 'sky', 6], ['pinterest', 'Pinterest', 'pink', 7]]) {
    if (db.prepare('SELECT 1 FROM categories WHERE key=? OR lower(name)=lower(?)').get(key, name)) continue;
    db.prepare('INSERT INTO categories(key,name,color,coding,sort) VALUES(?,?,?,1,?)').run(key, name, color, sort);
  }
  // Stable identifier of this dataset, carried through export/import (for a future cloud migration).
  if (!db.prepare("SELECT 1 FROM meta WHERE key='dataset_id'").get()) {
    db.prepare("INSERT INTO meta(key,value) VALUES('dataset_id',?)").run(globalThis.crypto.randomUUID());
  }
}

// The time zone of the device creating the account (browser or server), else UTC.
function deviceTimezone() {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (z) return z; } catch { /* no Intl */ }
  return 'UTC';
}

// A brand-new account: general starter categories that suit any kind of work. Existing accounts keep
// whatever they already have (this only runs when the data is first created).
function seedBase(db) {
  const set = db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)');
  // Tests of the original publishing workflow (sites, Pinterest, WhatsApp) start from the classic set.
  if (typeof process !== 'undefined' && process.env && process.env.DASH_STARTER === 'classic') {
    set.run('timezone', 'Africa/Casablanca');
    const cat = db.prepare('INSERT OR IGNORE INTO categories(key,name,color,coding,sort) VALUES(?,?,?,?,?)');
    cat.run('iptv', 'IPTV sites', 'blue', 1, 1);
    cat.run('digital', 'Digital products', 'pink', 1, 2);
    cat.run('blog', 'Blog sites', 'mint', 1, 3);
    return;
  }
  set.run('timezone', deviceTimezone());
  set.run('profile', 'general');
  const cat = db.prepare('INSERT OR IGNORE INTO categories(key,name,color,coding,sort) VALUES(?,?,?,?,?)');
  cat.run('client', 'Client work', 'blue', 1, 1);
  cat.run('internal', 'Internal projects', 'mint', 1, 2);
  cat.run('growth', 'Marketing & sales', 'pink', 1, 3);
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { init, tx, migrate, TABLES, SCHEMA_VERSION, SCHEMA };
