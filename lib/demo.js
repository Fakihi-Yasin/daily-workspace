// Demo data, written ONLY into the separate demo database (never into real data).
const D = require('./dates');
const E = require('./engine');
const A = require('./api');
const C = require('./challenges');

function seedDemo(db) {
  A.ensureDefaults(db);
  const t = E.today(db);
  const start = D.addDays(t, -20);
  db.prepare('UPDATE routine_versions SET from_date=?').run(start);
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const asset = (kind, name, url = '') => {
    const r = db.prepare('INSERT INTO assets(kind,name,url,notes,created_at) VALUES(?,?,?,?,?)').run(kind, name, url, '', E.nowIso());
    db.prepare('INSERT INTO asset_status(asset_id,from_date,status,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid, start, 'active', E.nowIso());
    return Number(r.lastInsertRowid);
  };
  asset('site_iptv', 'Canada', 'https://example-iptv-canada.test');
  asset('site_iptv', 'France', 'https://example-iptv-france.test');
  asset('site_blog', 'Easy Cooking', 'https://example-cuisine.test');
  asset('site_blog', 'Crochet & Co', 'https://example-crochet.test');
  ['Home Decor', 'Quick Recipes', 'Easy Crochet', 'Tattoo Ideas'].forEach(n => asset('pinterest', n));
  asset('facebook', 'Cooking Page (FB)'); asset('instagram', 'Cooking (IG)');
  asset('facebook', 'Decor Page (FB)'); asset('instagram', 'Decor (IG)');
  const yt = asset('youtube', 'Recipes Channel');

  for (let d = D.addDays(t, -14); d < t; d = D.addDays(d, 1)) {
    E.ensureDay(db, d);
    for (const task of E.tasksFor(db, d)) {
      const level = rand();
      if (task.type === 'counter') {
        const n = Math.round(task.target * Math.min(1.2, level + 0.2));
        const ids = task.meta.asset_ids || [];
        for (let i = 1; i <= n; i++) {
          if (i <= task.target && task.asset_id) E.setMark(db, task.id, { kind: task.unit, idx: i, asset_id: task.asset_id, done: true });
          else E.addExtra(db, task.id, { kind: task.unit, asset_id: task.asset_id || ids[i % Math.max(1, ids.length)] || null });
        }
      } else if (task.type === 'social') {
        for (const dest of task.meta.destinations) if (rand() < 0.75) E.setMark(db, task.id, { kind: 'publication', idx: 1, asset_id: dest, done: true });
      } else if (level > 0.25) E.setMark(db, task.id, { kind: 'check', idx: 0, done: true });
    }
  }
  const cats = Object.fromEntries(db.prepare('SELECT key, id FROM categories').all().map(c => [c.key, c.id]));
  const site = ['Domain', 'Design', 'Development', 'Deployment', 'Indexing'];
  const p1 = A.createProject(db, { name: 'IPTV Belgium', category_id: cats.iptv, topic: 'Belgium', status: 'in_progress', next_action: 'Finish the pricing page', milestones: site }).id;
  db.prepare('UPDATE milestones SET done=1, done_at=? WHERE project_id=? AND sort<2').run(D.addDays(t, -5), p1);
  A.createProject(db, { name: 'IPTV Spain', category_id: cats.iptv, topic: 'Spain', status: 'planned', milestones: site });
  A.createProject(db, { name: 'Tattoo blog', category_id: cats.blog, topic: 'Tattoo', status: 'idea' });
  A.createProject(db, { name: 'PDF planner pack', category_id: cats.digital, topic: 'Organization', status: 'planned_date', planned_for: D.addDays(t, 40).slice(0, 7), milestones: ['Mockups', 'Files', 'Store', 'Launch'] });
  for (let i = 1; i <= 6; i++) {
    const d = D.addDays(t, -i);
    const sec = Math.round(1500 + rand() * 2400);
    db.prepare("INSERT INTO sessions(date,category_id,project_id,task_label,planned_sec,initial_sec,state,accumulated_sec,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?, 'finished',?,?,?,?)")
      .run(d, cats.iptv, p1, 'Pricing page', 3600, 3600, sec, Date.now() - i * 86400000, Date.now() - i * 86400000 + sec * 1000, 'early');
  }
  const course = db.prepare("INSERT INTO courses(name,kind,link,notes,created_at) VALUES('Technical SEO','course','','',?)").run(E.nowIso()).lastInsertRowid;
  ['Crawling & indexing', 'Structured data', 'Core Web Vitals', 'Internal linking'].forEach((m, i) =>
    db.prepare('INSERT INTO modules(course_id,title,done,done_at,sort) VALUES(?,?,?,?,?)').run(course, m, i < 2 ? 1 : 0, i < 2 ? D.addDays(t, -3) : null, i));
  db.prepare('INSERT INTO study_logs(course_id,date,minutes,note,created_at) VALUES(?,?,?,?,?)').run(course, D.addDays(t, -2), 45, '', E.nowIso());
  A.saveVideo(db, { channel_id: yt, title: 'Tagine in 20 minutes', stage: 'published', published_date: D.addDays(t, -4), url: 'https://youtube.test/demo' });
  A.saveVideo(db, { channel_id: yt, title: 'No-knead homemade bread', stage: 'editing', planned_date: D.addDays(t, 3) });
  const opts = C.options(db);
  const pin = opts.routines.find(r => r.unit === 'pin');
  C.create(db, { name: 'All-in November', start_date: D.addDays(t, -10), goals: [
    { metric: 'pin', label: '5 Pins / day / account', period: 'day', per_asset: true, asset_ids: pin.assets.map(a => a.id), target: 5 },
    { metric: 'coding_sessions', label: '3 coding sessions / week', period: 'week', target: 3 },
    { metric: 'article', label: '8 articles over the challenge', period: 'total', target: 8 },
  ] });
  E.setMeta(db, 'is_demo', '1');
}

module.exports = { seedDemo };
