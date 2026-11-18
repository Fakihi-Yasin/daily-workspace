// Database schema, seeding and migrations — shared by the Node server and the browser (Vercel) build.
const SCHEMA_VERSION = 1;

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
  'study_logs', 'challenges', 'challenge_goals'];

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
  // "Other" project category (kept last in lists).
  db.prepare("INSERT OR IGNORE INTO categories(key,name,color,coding,sort) VALUES('other','Other','ink',1,1000)").run();
  // Stable identifier of this dataset, carried through export/import (for a future cloud migration).
  if (!db.prepare("SELECT 1 FROM meta WHERE key='dataset_id'").get()) {
    db.prepare("INSERT INTO meta(key,value) VALUES('dataset_id',?)").run(globalThis.crypto.randomUUID());
  }
}

function seedBase(db) {
  const now = new Date().toISOString();
  const set = db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)');
  set.run('timezone', 'Africa/Casablanca');
  const cat = db.prepare('INSERT OR IGNORE INTO categories(key,name,color,coding,sort) VALUES(?,?,?,?,?)');
  cat.run('iptv', 'IPTV sites', 'blue', 1, 1);
  cat.run('digital', 'Digital products', 'pink', 1, 2);
  cat.run('blog', 'Blog sites', 'mint', 1, 3);
  void now;
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
