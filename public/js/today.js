// "Today": the routine checklist first, with a compact focus panel and a right column (score, next action, sessions).
import { html, useState, useEffect, useRef, useResource, api, bus, toast, Icon, Bar, Ring, Chip, Empty, fmtDay, fmtShort, addDays, fmtDur, pct } from './lib.js';
import { FocusPanel, requestStart } from './focus.js';

const CAT_COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky'];
const catColor = (name, all) => CAT_COLORS[Math.max(0, all.indexOf(name)) % CAT_COLORS.length];
const SETTLE_MS = 6000; // a completed row stays in place this long (undo window) before moving to "Completed"
const isClosed = (t) => t.status === 'reported' || (t.progress.scoreTarget > 0 && t.progress.complete) || t.progress.scoreTarget === 0;

export function Today() {
  const [date, setDate] = useState(null);
  const { data, error } = useResource('/api/today' + (date ? `?date=${date}` : ''));
  const [over, setOver] = useState({}); // optimistic marks: key -> bool
  const [todoOver, setTodoOver] = useState({}); // optimistic one-off task changes: id -> { done } | { gone: true }
  const [pending, setPending] = useState([]); // one-off tasks being saved
  const [adding, setAdding] = useState(false);
  const [settled, setSettled] = useState(null); // { date, ids:Set } — which tasks are laid out as completed
  const [doneOpen, setDoneOpen] = useState(() => { try { return localStorage.getItem('completedOpen') !== '0'; } catch { return true; } });
  useEffect(() => { setOver({}); setTodoOver({}); setPending([]); }, [data]);
  // Rows move between "to do" and "completed" only after the undo window, never under the cursor.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.tasks.filter(isClosed).map(t => t.id));
    if (!settled || settled.date !== data.date) { setSettled({ date: data.date, ids }); return; }
    const same = ids.size === settled.ids.size && [...ids].every(i => settled.ids.has(i));
    if (same) return;
    const t = setTimeout(() => setSettled({ date: data.date, ids }), SETTLE_MS);
    return () => clearTimeout(t);
  }, [data]);

  if (error && !data) return html`<${Empty} title="Could not load the day">${error}</${Empty}>`;
  if (!data || !settled) return html`<div class="muted">Loading…</div>`;

  const isToday = data.date === data.today;
  const assets = new Map(data.assets.map(a => [a.id, a]));
  const cats = [...new Set(data.tasks.map(t => t.category))];
  const todos = [...data.todos.filter(t => !(todoOver[t.id] && todoOver[t.id].gone)).map(t => (todoOver[t.id] ? { ...t, ...todoOver[t.id] } : t)), ...pending];
  const ctx = { data, assets, over, setOver, isToday, todos, setTodoOver, setPending };
  const count = liveCount(ctx);
  const doneIds = settled.date === data.date ? settled.ids : new Set();
  const openTasks = data.tasks.filter(t => !doneIds.has(t.id));
  const doneTasks = data.tasks.filter(t => doneIds.has(t.id));
  const countIn = (cat) => data.tasks.filter(t => t.category === cat).length;
  const toggleDone = () => { const v = !doneOpen; setDoneOpen(v); try { localStorage.setItem('completedOpen', v ? '1' : '0'); } catch { /* ignore */ } };

  return html`<div class="today">
    <header class="today-head">
      <h1>${isToday ? 'Today' : fmtDay(data.date, { weekday: 'long' })}</h1>
      <div class="datenav">
        <button class="icon-btn" aria-label="Previous day" onClick=${() => setDate(addDays(data.date, -1))}><${Icon} name="chevL" /></button>
        <strong class="cap">${fmtDay(data.date)}</strong>
        <button class="icon-btn" aria-label="Next day" onClick=${() => setDate(addDays(data.date, 1))}><${Icon} name="chevR" /></button>
        ${!isToday && html`<button class="btn sm" onClick=${() => setDate(null)}>Back to today</button>`}
        <button class="btn sm add-task-btn" aria-expanded=${adding} onClick=${() => { setAdding(true); setTimeout(() => document.getElementById('add-task-input')?.focus(), 30); }}>
          <${Icon} name="plus" size=${15} />Add task</button>
      </div>
    </header>
    ${!isToday && html`<p class="notice" style="margin-bottom:14px">${data.date < data.today
      ? 'You are viewing a past day: your checks correct that day without touching today.'
      : 'Upcoming day: only moved tasks and already scheduled routines appear.'}</p>`}

    <div class="today-grid">
      <div class="tg-focus"><${FocusPanel} today=${data.today} tz=${data.tz} /></div>

      <aside class="tg-side" aria-label="Day summary">
        <${ScoreCard} count=${count} />
        <${NextAction} ctx=${ctx} />
        <${SessionsCard} sessions=${data.sessions} isToday=${isToday} />
      </aside>

      <div class="tg-tasks">
        ${(todos.length > 0 || adding) && html`<${MyTasks} ctx=${ctx} adding=${adding} setAdding=${setAdding} />`}
        ${data.tasks.length === 0 && (todos.length > 0 || adding) ? html`<p class="small muted">No recurring routines scheduled ${isToday ? 'today' : 'this day'} · <a href="#/settings?tab=routines">Set up routines</a></p>`
        : data.tasks.length === 0
          ? html`<div class="card empty-routines">
              <h3>No routines scheduled ${isToday ? 'today' : 'this day'}</h3>
              <p class="muted">Add your sites and accounts, then choose which days each routine runs.</p>
              <div class="row wrap"><a class="btn primary sm" href="#/settings?tab=routines">Set up routines</a><a class="btn sm" href="#/settings?tab=assets">Add accounts & sites</a></div>
            </div>`
          : html`
            ${openTasks.length === 0 && html`<div class="card all-done" role="status"><${Icon} name="check" size=${18} /><div><strong>Daily routines complete</strong>
              <span class="muted small"> · extras are still possible below.</span></div></div>`}
            ${cats.filter(c => openTasks.some(t => t.category === c)).map(cat => html`<${CategorySection} key=${'o-' + cat} cat=${cat} color=${catColor(cat, cats)}
              tasks=${openTasks.filter(t => t.category === cat)} all=${data.tasks.filter(t => t.category === cat)} showTotal=${countIn(cat) > 1} ctx=${ctx} />`)}
            ${doneTasks.length > 0 && html`<section class="section done-group">
              <button class="done-toggle" aria-expanded=${doneOpen} onClick=${toggleDone}>
                <${Icon} name=${doneOpen ? 'down' : 'chevR'} size=${16} /><span>Completed</span><span class="muted">${doneTasks.length}</span></button>
              ${doneOpen && cats.filter(c => doneTasks.some(t => t.category === c)).map(cat => html`<${CategorySection} key=${'d-' + cat} cat=${cat} color=${catColor(cat, cats)} compact
                tasks=${doneTasks.filter(t => t.category === cat)} all=${data.tasks.filter(t => t.category === cat)} showTotal=${false} ctx=${ctx} />`)}
            </section>`}`}
      </div>
    </div>
  </div>`;
}

// Live task count: the same numbers drive the Daily score card and "tasks left".
function liveCount(ctx) {
  const due = ctx.data.tasks.filter(t => t.progress.scoreTarget > 0);
  const isDone = (t) => liveDone(ctx, t).scoreDone >= t.progress.scoreTarget;
  const rDone = due.filter(isDone).length;
  const cDone = ctx.todos.filter(t => t.done).length;
  const done = rDone + cDone, total = due.length + ctx.todos.length;
  const cats = new Map();
  for (const t of due) { const c = cats.get(t.category) || { category: t.category, done: 0, total: 0 }; c.total++; if (isDone(t)) c.done++; cats.set(t.category, c); }
  return { done, total, left: total - done, pct: total ? Math.round((done / total) * 100) : null,
    recurring: { done: rDone, total: due.length }, custom: { done: cDone, total: ctx.todos.length }, categories: [...cats.values()] };
}

function ScoreCard({ count }) {
  const [open, setOpen] = useState(false);
  return html`<section class="card side-card" aria-label="Daily score">
    <div class="row">
      <${Ring} value=${count.pct} size=${48} stroke=${6}><span style="font-size:13px">${count.pct == null ? '—' : count.pct}</span></${Ring}>
      <div style="flex:1;min-width:0">
        <div class="label">Daily score</div>
        ${count.total
          ? html`<div class="score-line" aria-live="polite"><span class="score-num">${count.done} / ${count.total}</span> <span>tasks done · <strong>${count.pct}%</strong></span></div>`
          : html`<div class="score-line">No tasks scheduled.</div>`}
      </div>
      ${count.total > 0 && html`<button class="link-btn small" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'How?'}</button>`}
    </div>
    ${open && html`<div class="calc">
      ${count.categories.map(c => html`<div class="calc-row"><span>${c.category}</span><span class="num">${c.done}/${c.total}</span><strong class="num">${c.done === c.total ? '✓' : ''}</strong></div>`)}
      ${count.custom.total > 0 && html`<div class="calc-row"><span>My tasks</span><span class="num">${count.custom.done}/${count.custom.total}</span><strong class="num">${count.custom.done === count.custom.total ? '✓' : ''}</strong></div>`}
      <p class="small muted" style="margin-top:6px">${count.done} done ÷ ${count.total} tasks = <strong>${count.pct}%</strong>. A routine item with a quota counts once, when its target is reached; extras don’t add. Focus sessions don’t count.</p>
    </div>`}
  </section>`;
}

// ---------- My tasks (one-off, for this date only) ----------
async function setTodoDone(ctx, t, done) {
  ctx.setTodoOver(o => ({ ...o, [t.id]: { done: done ? 1 : 0 } }));
  try {
    await api('PUT', `/api/todos/${t.id}`, { done });
    bus.emit();
    toast({ msg: `${t.title} · ${done ? 'done' : 'reopened'}`, undo: async () => { await api('PUT', `/api/todos/${t.id}`, { done: !done }); bus.emit(); } });
  } catch (e) { ctx.setTodoOver(o => { const n = { ...o }; delete n[t.id]; return n; }); toast({ msg: e.message, kind: 'error' }); }
}
async function deleteTodo(ctx, t) {
  ctx.setTodoOver(o => ({ ...o, [t.id]: { gone: true } }));
  try {
    await api('DELETE', `/api/todos/${t.id}`);
    bus.emit();
    toast({ msg: `Deleted “${t.title}”`, undo: async () => { await api('POST', '/api/todos', { date: t.date, title: t.title, done: !!t.done, sort: t.sort }); bus.emit(); } });
  } catch (e) { ctx.setTodoOver(o => { const n = { ...o }; delete n[t.id]; return n; }); toast({ msg: e.message, kind: 'error' }); }
}

function MyTasks({ ctx, adding, setAdding }) {
  const [title, setTitle] = useState('');
  const todos = ctx.todos;
  const done = todos.filter(t => t.done).length;
  const add = async (e) => {
    e.preventDefault();
    const v = title.trim();
    if (!v) return;
    const temp = { id: 'tmp-' + Date.now(), date: ctx.data.date, title: v, done: 0, temp: true };
    ctx.setPending(p => [...p, temp]);
    setTitle('');
    try { await api('POST', '/api/todos', { date: ctx.data.date, title: v }); bus.emit(); }
    catch (err) { ctx.setPending(p => p.filter(x => x.id !== temp.id)); toast({ msg: err.message, kind: 'error' }); }
  };
  return html`<section class="section routine my-tasks" id="my-tasks" aria-label="My tasks">
    <div class="routine-head">
      <h3>My tasks</h3>
      ${todos.length > 0 && html`<span class="num rh-num">${done}/${todos.length} done</span>`}
    </div>
    ${adding && html`<form class="card add-task" onSubmit=${add} onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); setAdding(false); } }}>
      <input id="add-task-input" type="text" value=${title} onInput=${(e) => setTitle(e.target.value)} maxlength="200"
        placeholder=${'Task for ' + (ctx.isToday ? 'today' : fmtShort(ctx.data.date)) + ', e.g. Fix DMCA'} aria-label="New task title" autofocus />
      <button class="btn primary" disabled=${!title.trim()}>Add</button>
      <button type="button" class="btn ghost" onClick=${() => setAdding(false)}>Close</button>
    </form>`}
    ${todos.length > 0 && html`<div class="task-list">${todos.map(t => html`<${TodoRow} key=${t.id} t=${t} ctx=${ctx} />`)}</div>`}
  </section>`;
}

function TodoRow({ t, ctx }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [menu, setMenu] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!menu) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenu(false); };
    const k = (e) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', f); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k); };
  }, [menu]);
  const saveTitle = async (e) => {
    e.preventDefault();
    if (!title.trim() || title.trim() === t.title) return setEditing(false);
    try { await api('PUT', `/api/todos/${t.id}`, { title }); bus.emit(); setEditing(false); } catch (err) { toast({ msg: err.message, kind: 'error' }); }
  };
  const doneAt = t.done && t.done_at ? new Date(t.done_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  return html`<div class=${'task todo-row' + (t.done ? ' done' : '')} id=${'todo-' + t.id}>
    <div class="tname">
      ${editing
        ? html`<form class="row" onSubmit=${saveTitle}><input type="text" value=${title} onInput=${(e) => setTitle(e.target.value)} aria-label="Task title" autofocus
            onKeyDown=${(e) => { if (e.key === 'Escape') { setTitle(t.title); setEditing(false); } }} /><button class="btn sm primary">Save</button></form>`
        : html`<span class="todo-title">${t.title}</span>
          <small>${t.temp ? 'Saving…' : t.done ? `Done${doneAt ? ' at ' + doneAt : ''}` : 'One-off task'}</small>`}
    </div>
    <div class="todo-actions">
      <button class="btn sm" disabled=${t.temp || !!t.done} onClick=${() => requestStart({ task_label: t.title })} aria-label=${'Start a session: ' + t.title}>
        <${Icon} name="play" size=${13} />Start</button>
      ${t.done
        ? html`<button class="btn sm" disabled=${t.temp} onClick=${() => setTodoDone(ctx, t, false)} aria-label=${'Reopen: ' + t.title}><${Icon} name="undo" size=${14} />Reopen</button>`
        : html`<button class="btn sm primary" disabled=${t.temp} onClick=${() => setTodoDone(ctx, t, true)} aria-label=${'Mark done: ' + t.title}><${Icon} name="check" size=${14} />Done</button>`}
      <div class="menu" ref=${ref}>
        <button class="icon-btn" disabled=${t.temp} aria-label=${'Options — ' + t.title} aria-expanded=${menu} onClick=${() => setMenu(!menu)}><${Icon} name="more" /></button>
        ${menu && html`<div class="menu-pop">
          <button class="item" onClick=${() => { setMenu(false); setTitle(t.title); setEditing(true); }}><${Icon} name="note" size=${16} />Edit title</button>
          <button class="item danger" onClick=${() => { setMenu(false); deleteTodo(ctx, t); }}><${Icon} name="x" size=${16} />Delete</button>
        </div>`}
      </div>
    </div>
  </div>`;
}

function SessionsCard({ sessions, isToday }) {
  const total = sessions.reduce((s, x) => s + x.actual_sec, 0);
  return html`<section class="card side-card" aria-label=${isToday ? 'Today’s sessions' : 'Sessions'}>
    <div class="row"><span class="label" style="flex:1">${isToday ? 'Today’s sessions' : 'Sessions'}</span>${sessions.length > 0 && html`<span class="small num"><strong>${fmtDur(total)}</strong></span>`}</div>
    ${sessions.length === 0 ? html`<p class="small muted" style="margin-top:6px">No finished sessions yet.</p>`
      : html`<ul class="sess-list">${sessions.map(s => html`<li key=${s.id}>
        <div class="sess-main">
          <strong>${s.task_label || s.milestone_title || s.project_name || 'Quick task'}</strong>
          <span class="small muted">${s.project_name || 'Quick task'}${s.category_name && s.category_name !== s.project_name ? ' · ' + s.category_name : ''}</span>
          ${s.milestone_id && !s.milestone_done && html`<button class="link-btn small" style="align-self:flex-start" onClick=${async () => {
            try { await api('PUT', `/api/milestones/${s.milestone_id}`, { done: true }); bus.emit(); toast({ msg: `“${s.milestone_title}” marked done` }); } catch (e) { toast({ msg: e.message, kind: 'error' }); }
          }}>Mark “${s.milestone_title}” done</button>`}
        </div>
        <div class="sess-meta"><strong class="num">${fmtDur(s.actual_sec)}</strong>
          <span class=${'chip ' + (s.end_reason === 'completed' ? 'mint' : 'ink')}>${s.end_reason === 'completed' ? 'Completed' : 'Ended early'}</span></div>
      </li>`)}</ul>`}
  </section>`;
}

// ---------- marks ----------
const keyOf = (t, kind, idx, asset) => `${t.id}|${kind}|${asset || 0}|${idx}`;
function isOn(ctx, t, kind, idx, asset = null) {
  const k = keyOf(t, kind, idx, asset);
  if (k in ctx.over) return ctx.over[k];
  return t.records.some(r => r.kind === kind && r.idx === idx && (r.asset_id || 0) === (asset || 0));
}

async function mark(ctx, t, { kind, idx, asset = null, done, label }) {
  const k = keyOf(t, kind, idx, asset);
  ctx.setOver(o => ({ ...o, [k]: done }));
  try {
    const r = await api('POST', `/api/tasks/${t.id}/mark`, { kind, idx, asset_id: asset, done });
    bus.emit();
    toast({
      msg: done ? `${label} · logged` : `${label} · removed`,
      undo: async () => {
        await api('POST', `/api/tasks/${t.id}/mark`, { kind, idx, asset_id: asset, done: !done });
        if (done && r.autoVideo) await api('POST', `/api/tasks/${t.id}/mark`, { kind: 'video', idx, asset_id: null, done: false });
        bus.emit();
      },
    });
  } catch (e) {
    ctx.setOver(o => { const n = { ...o }; delete n[k]; return n; });
    toast({ msg: e.message, kind: 'error' });
  }
}

async function addExtra(t, kind, asset, label) {
  try {
    const r = await api('POST', `/api/tasks/${t.id}/extra`, { kind, asset_id: asset });
    bus.emit();
    toast({ msg: `${label} · logged`, undo: async () => { await api('DELETE', `/api/records/${r.id}`); bus.emit(); } });
  } catch (e) { toast({ msg: e.message, kind: 'error' }); }
}

async function removeRec(rec, label, t) {
  try {
    await api('DELETE', `/api/records/${rec.id}`);
    bus.emit();
    toast({ msg: `${label} · removed`, undo: async () => { await api('POST', `/api/tasks/${t.id}/extra`, { kind: rec.kind, asset_id: rec.asset_id }); bus.emit(); } });
  } catch (e) { toast({ msg: e.message, kind: 'error' }); }
}

// ---------- next action ----------
function liveDone(ctx, t) {
  // Progress with optimistic marks applied, for instant feedback.
  const p = t.progress;
  let delta = 0;
  for (const [k, v] of Object.entries(ctx.over)) {
    if (!k.startsWith(t.id + '|')) continue;
    const [, kind, asset, idx] = k.split('|');
    const had = t.records.some(r => r.kind === kind && r.idx === +idx && (r.asset_id || 0) === +asset);
    if (kind === (t.type === 'social' ? 'publication' : t.type === 'check' ? 'check' : t.unit) && had !== v) delta += v ? 1 : -1;
  }
  return { actual: p.actual + delta, scoreDone: Math.max(0, Math.min(p.scoreTarget, p.scoreDone + delta)) };
}

function nextStep(ctx, t) {
  const a = ctx.assets;
  if (t.status !== 'open' || t.unit === 'youtube') return null;
  if (t.type === 'counter') {
    if (!t.asset_id) {
      const done = t.records.filter(r => r.kind === t.unit).length;
      if (done >= t.target) return null;
      return { what: `${t.label}`, detail: `${t.meta.unit_label || 'Unit'} ${done + 1}/${t.target} — choose the site`, shared: true };
    }
    for (let i = 1; i <= t.target; i++) {
      if (!isOn(ctx, t, t.unit, i, t.asset_id)) return { what: t.label, detail: `${unitWord(t)} ${i}/${t.target}`, run: { kind: t.unit, idx: i, asset: t.asset_id }, btn: `Check ${unitWord(t).toLowerCase()} ${i}` };
    }
    return null;
  }
  if (t.type === 'social') {
    for (let i = 1; i <= t.target; i++) for (const d of t.meta.destinations) {
      if (!isOn(ctx, t, 'publication', i, d)) return { what: `${t.meta.slot_label || t.label} · video ${i}`, detail: `Publish to ${a.get(d)?.name || '?'}`, run: { kind: 'publication', idx: i, asset: d }, btn: 'Published' };
    }
    return null;
  }
  const list = t.meta.checklist || [];
  if (!list.length) return isOn(ctx, t, 'check', 0) ? null : { what: t.label, detail: 'One-click task', run: { kind: 'check', idx: 0 }, btn: 'Done' };
  for (let i = 0; i < list.length; i++) if (!isOn(ctx, t, 'check', i)) return { what: t.label, detail: list[i], run: { kind: 'check', idx: i }, btn: 'Done' };
  return null;
}
const unitWord = (t) => ({ pin: 'Pin', article: 'Article', youtube: 'Video' }[t.unit] || 'Unit');

function NextAction({ ctx }) {
  const [skip, setSkip] = useState(0);
  const { data } = ctx;
  const order = [...data.tasks].sort((x, y) => (x.time_slot || '99') < (y.time_slot || '99') ? -1 : (x.time_slot || '99') > (y.time_slot || '99') ? 1 : x.sort - y.sort);
  const steps = [...order.map(t => ({ t, s: nextStep(ctx, t) })).filter(x => x.s),
    ...ctx.todos.filter(t => !t.done && !t.temp).map(t => ({ todo: t, t: { category: 'My tasks', time_slot: '' }, s: { what: t.title, detail: 'One-off task', btn: 'Done' } }))];
  const cur = steps.length ? steps[skip % steps.length] : null;
  const { left, total } = liveCount(ctx);
  if (!total) return null;
  return html`<section class="card side-card next" aria-label="Next action">
    <div class="row"><span class="label" style="flex:1">Next action</span>
      ${steps.length > 1 && html`<button class="btn sm ghost" onClick=${() => setSkip(skip + 1)}>Skip →</button>`}</div>
    ${cur ? html`
      <div class="row wrap" style="gap:6px"><${Chip} color="blue">${cur.t.category}</${Chip}>${cur.t.time_slot && html`<${Chip}>${cur.t.time_slot}</${Chip}>`}</div>
      <div class="what">${cur.s.what}</div>
      <p class="small muted">${cur.s.detail}</p>
      ${cur.todo
        ? html`<button class="btn primary" onClick=${() => setTodoDone(ctx, cur.todo, true)}><${Icon} name="check" size=${16} />Done</button>`
        : cur.s.run
        ? html`<button class="btn primary" onClick=${() => mark(ctx, cur.t, { ...cur.s.run, done: true, label: `${cur.s.what} · ${cur.s.detail}` })}><${Icon} name="check" size=${16} />${cur.s.btn}</button>`
        : html`<button class="btn primary" onClick=${() => document.getElementById('task-' + cur.t.id)?.scrollIntoView({ block: 'center' })}>Choose the site</button>`}
      <p class="small muted">${left} task${left === 1 ? '' : 's'} left</p>`
    : html`<div class="what">All tasks done</div><p class="small muted">Every task ${ctx.isToday ? 'for today' : 'for this day'} is done.</p>`}
  </section>`;
}

// ---------- sections ----------
// Progress is shown once: in the header when a category has several tasks, otherwise on the task row.
function CategorySection({ cat, color, tasks, all, showTotal, ctx, compact }) {
  const s = all.reduce((a, t) => ({ done: a.done + t.progress.scoreDone, target: a.target + t.progress.scoreTarget }), { done: 0, target: 0 });
  return html`<section class=${'section routine' + (compact ? ' compact' : '')} id=${compact ? undefined : 'cat-' + cat} aria-label=${cat}>
    <div class="routine-head">
      <h3>${cat}</h3>
      ${showTotal && html`<div class="rh-bar"><${Bar} value=${s.target ? (s.done / s.target) * 100 : 0} color=${color} thin label=${cat + ' progress'} /></div>
        <span class="num rh-num">${s.done}/${s.target} · ${s.target ? Math.round((s.done / s.target) * 100) : 0}%</span>`}
    </div>
    <div class="task-list">${tasks.map(t => html`<${TaskRow} key=${t.id} t=${t} ctx=${ctx} />`)}</div>
  </section>`;
}

function TaskRow({ t, ctx }) {
  const live = liveDone(ctx, t);
  const target = t.progress.scoreTarget;
  const done = target > 0 && live.scoreDone >= target;
  const reported = t.status === 'reported';
  const Body = t.type === 'counter' ? (t.asset_id ? CounterBoxes : SharedCounter) : t.type === 'social' ? SocialSlot : CheckItems;
  const a = t.asset_id ? ctx.assets.get(t.asset_id) : null;
  const pctv = target ? Math.round((live.scoreDone / target) * 100) : 0;
  return html`<div class=${'task' + (done ? ' done' : '') + (reported ? ' reported' : '')} id=${'task-' + t.id}>
    <div class="tname">
      ${a && a.url ? html`<a href=${a.url} target="_blank" rel="noopener noreferrer" title=${a.url}>${t.label}</a>` : t.label}
      <small>
        ${t.time_slot && html`${t.time_slot} · `}
        ${t.meta.reported_from && !reported && html`Moved from ${fmtShort(t.meta.reported_from)} · `}
        ${reported ? html`Moved → ${fmtShort(t.reported_to)}${t.target ? ` (${t.target} kept here)` : ''}` : sub(t, ctx)}
      </small>
    </div>
    <div>${reported ? html`<span class="small muted">What remains counts on ${fmtShort(t.reported_to)}, not here.</span>` : html`<${Body} t=${t} ctx=${ctx} />`}</div>
    <div class="tcount">
      ${target > 0 && html`<span class="frac">${t.type === 'social' ? `${live.scoreDone}/${target}` : `${live.actual}/${target}`} · ${pctv}%</span>`}
      <${TaskMenu} t=${t} ctx=${ctx} />
    </div>
    ${t.note && html`<div class="note-line">${t.note}</div>`}
  </div>`;
}

function sub(t, ctx) {
  if (t.unit === 'youtube') return 'Completed by publishing a video in YouTube';
  if (t.type === 'counter' && !t.asset_id) return `Shared goal · ${(t.meta.asset_ids || []).length} site${(t.meta.asset_ids || []).length > 1 ? 's' : ''}`;
  if (t.type === 'counter') return t.meta.unit_label || (t.unit === 'article' ? 'articles published' : '');
  if (t.type === 'social') {
    const v = t.progress.videos;
    return `${v} video${v === 1 ? '' : 's'} produced · ${t.meta.destinations.map(d => ctx.assets.get(d)?.name || '?').join(' + ')}`;
  }
  return (t.meta.checklist || []).length ? `${t.meta.checklist.length} steps` : 'One click';
}

function CounterBoxes({ t, ctx }) {
  if (t.unit === 'youtube') return html`<span class="small muted">${t.records.length} published · <a href="#/youtube">Open YouTube</a></span>`;
  const word = unitWord(t);
  const extras = t.records.filter(r => r.kind === t.unit && r.idx > t.target).sort((a, b) => a.idx - b.idx);
  const boxes = [];
  for (let i = 1; i <= t.target; i++) {
    const on = isOn(ctx, t, t.unit, i, t.asset_id);
    boxes.push(html`<button class=${'box' + (on ? ' on' : '')} aria-pressed=${on} aria-label=${`${word} ${i} — ${t.label}`}
      onClick=${() => mark(ctx, t, { kind: t.unit, idx: i, asset: t.asset_id, done: !on, label: `${word} ${i} · ${t.label}` })}>${on ? html`<${Icon} name="check" size=${16} />` : i}</button>`);
  }
  return html`<div class="boxes">
    ${boxes}
    ${extras.map(r => html`<button class="box on extra" title="Extra — click to remove" aria-label=${`${word} extra ${r.idx} — remove`} onClick=${() => removeRec(r, `${word} extra`, t)}>+${r.idx - t.target}</button>`)}
    <button class="box extra" title=${`Extra ${word.toLowerCase()} (does not exceed 100%)`} aria-label=${`Add an extra ${word.toLowerCase()} — ${t.label}`} onClick=${() => addExtra(t, t.unit, t.asset_id, `${word} extra · ${t.label}`)}><${Icon} name="plus" size=${15} /></button>
  </div>`;
}

function SharedCounter({ t, ctx }) {
  const word = unitWord(t);
  const recs = t.records.filter(r => r.kind === t.unit).sort((a, b) => a.idx - b.idx);
  const ids = t.meta.asset_ids || [];
  const by = {};
  for (const r of recs) by[r.asset_id] = (by[r.asset_id] || 0) + 1;
  return html`<div class="boxes">
    ${recs.map(r => html`<span class="logged">${ctx.assets.get(r.asset_id)?.name || word}<button aria-label=${`Remove ${word.toLowerCase()} ${ctx.assets.get(r.asset_id)?.name || ''}`} onClick=${() => removeRec(r, `${word} · ${ctx.assets.get(r.asset_id)?.name || ''}`, t)}><${Icon} name="x" size=${13} /></button></span>`)}
    ${ids.map(id => html`<button class="site-btn" onClick=${() => addExtra(t, t.unit, id, `${word} · ${ctx.assets.get(id)?.name}`)}>+ ${ctx.assets.get(id)?.name || '?'}${by[id] ? html` <span class="muted">(${by[id]})</span>` : ''}</button>`)}
    ${!ids.length && html`<button class="site-btn" onClick=${() => addExtra(t, t.unit, null, word)}>+ ${word}</button>`}
  </div>`;
}

function SocialSlot({ t, ctx }) {
  const maxIdx = Math.max(t.target, ...t.records.map(r => r.idx));
  const rows = [];
  for (let i = 1; i <= maxIdx; i++) {
    const produced = isOn(ctx, t, 'video', i);
    rows.push(html`<div class="video-row">
      <span class="vlabel">${i > t.target ? 'Extra' : 'Video ' + i}</span>
      <button class=${'dest produced' + (produced ? ' on' : '')} aria-pressed=${produced} onClick=${() => mark(ctx, t, { kind: 'video', idx: i, done: !produced, label: `Video ${i} produced` })}>
        <span class="tick">${produced && html`<${Icon} name="check" size=${14} />`}</span>Produced</button>
      ${t.meta.destinations.map(d => {
        const on = isOn(ctx, t, 'publication', i, d);
        const n = ctx.assets.get(d)?.name || '?';
        return html`<button class=${'dest' + (on ? ' on' : '')} aria-pressed=${on} aria-label=${`Video ${i} published on ${n}`}
          onClick=${() => mark(ctx, t, { kind: 'publication', idx: i, asset: d, done: !on, label: `Published · ${n}` })}>
          <span class="tick">${on && html`<${Icon} name="check" size=${14} />`}</span>${n}</button>`;
      })}
    </div>`);
  }
  return html`<div>${rows}
    <button class="btn sm ghost" style="margin-top:4px" onClick=${() => mark(ctx, t, { kind: 'video', idx: maxIdx + 1, done: true, label: 'Extra video produced' })}><${Icon} name="plus" size=${14} />Extra video</button>
  </div>`;
}

function CheckItems({ t, ctx }) {
  const list = t.meta.checklist || [];
  if (!list.length) {
    const on = isOn(ctx, t, 'check', 0);
    return html`<button class=${'check-big' + (on ? ' on' : '')} aria-pressed=${on} onClick=${() => mark(ctx, t, { kind: 'check', idx: 0, done: !on, label: t.label })}>
      <span class="tick">${on && html`<${Icon} name="check" size=${16} />`}</span>${on ? 'Done' : 'Mark as done'}</button>`;
  }
  const all = list.every((_, i) => isOn(ctx, t, 'check', i));
  return html`<div class="boxes">
    ${list.map((item, i) => { const on = isOn(ctx, t, 'check', i); return html`<button class=${'check-big' + (on ? ' on' : '')} style="padding:5px 11px 5px 5px" aria-pressed=${on}
      onClick=${() => mark(ctx, t, { kind: 'check', idx: i, done: !on, label: item })}><span class="tick" style="width:22px;height:22px">${on && html`<${Icon} name="check" size=${14} />`}</span>${item}</button>`; })}
    ${!all && html`<button class="btn sm" onClick=${async () => {
      for (let i = 0; i < list.length; i++) if (!isOn(ctx, t, 'check', i)) await api('POST', `/api/tasks/${t.id}/mark`, { kind: 'check', idx: i, done: true });
      bus.emit(); toast({ msg: `${t.label} · all checked` });
    }}>Check all</button>`}
  </div>`;
}

function TaskMenu({ t, ctx }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(null);
  const [to, setTo] = useState(addDays(t.date, 1));
  const [note, setNote] = useState(t.note || '');
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', f); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k); };
  }, [open]);
  const report = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', `/api/tasks/${t.id}/report`, { to });
      bus.emit(); setOpen(false);
      toast({ msg: `${t.label} moved to ${fmtShort(to)} (${r.moved} left)`, undo: async () => { await api('POST', `/api/tasks/${t.id}/unreport`); bus.emit(); } });
    } catch (err) { toast({ msg: err.message, kind: 'error' }); }
  };
  return html`<div class="menu" ref=${ref}>
    <button class="icon-btn" aria-label=${'Options — ' + t.label} aria-expanded=${open} onClick=${() => { setOpen(!open); setMode(null); setNote(t.note || ''); }}><${Icon} name="more" /></button>
    ${open && html`<div class="menu-pop">
      ${t.status === 'reported'
        ? html`<button class="item" onClick=${async () => { try { await api('POST', `/api/tasks/${t.id}/unreport`); bus.emit(); setOpen(false); toast({ msg: 'Move undone' }); } catch (e) { toast({ msg: e.message, kind: 'error' }); } }}><${Icon} name="undo" size=${16} />Undo move</button>`
        : mode === 'report'
          ? html`<form class="inner stack" onSubmit=${report}>
              <label class="field">Move to<input type="date" min=${addDays(t.date, 1)} value=${to} onInput=${(e) => setTo(e.target.value)} /></label>
              <p class="hint">Only what remains is moved. What is already checked stays counted here, once.</p>
              <button class="btn primary sm">Move</button>
            </form>`
          : mode === 'note'
            ? html`<form class="inner stack" onSubmit=${async (e) => { e.preventDefault(); await api('PUT', `/api/tasks/${t.id}/note`, { note }); bus.emit(); setOpen(false); }}>
                <label class="field">Note for the day<textarea value=${note} onInput=${(e) => setNote(e.target.value)} /></label>
                <button class="btn primary sm">Save</button>
              </form>`
            : html`
              ${!t.progress.complete && t.unit !== 'youtube' && html`<button class="item" onClick=${() => setMode('report')}><${Icon} name="calendar" size=${16} />Move…</button>`}
              <button class="item" onClick=${() => setMode('note')}><${Icon} name="note" size=${16} />${t.note ? 'Edit note' : 'Add a note'}</button>
              <a class="item btn ghost sm" style="justify-content:flex-start;width:100%" href="#/settings">Configure the routine</a>`}
    </div>`}
  </div>`;
}
