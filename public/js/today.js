// "Today": the routine checklist first, with a compact focus panel and a right column (score, next action, sessions).
import { html, useState, useEffect, useRef, useResource, api, bus, toast, Icon, Bar, Ring, Chip, Empty, Modal, AutoGrow, TaskText, firstLine, fmtDay, fmtShort, addDays, fmtDur, pct, useFiveRows, SubtaskDraft, subtaskTitles, ConfirmDeleteTask } from './lib.js';
import { PcTimeCard } from './pctime.js';
import { FocusPanel, requestStart } from './focus.js';
import { CompletedModal } from './history.js';
import { useWorkspace, homeSections, HOME_LABELS, CustomizeModal, CalendarSection, ProjectsSection, CategoryInput, CatChip, REPEAT_LABELS } from './workspace.js';

const CAT_COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky'];
const catColor = (name, all) => CAT_COLORS[Math.max(0, all.indexOf(name)) % CAT_COLORS.length];

// The viewed date lives in the URL (#/today?date=YYYY-MM-DD), so Stats can open a specific day.
const dateFromHash = () => { const d = new URLSearchParams(location.hash.split('?')[1] || '').get('date'); return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null; };

export function Today() {
  const [date, setDateState] = useState(dateFromHash);
  const setDate = (d) => { setDateState(d); history.replaceState(null, '', '#/today' + (d ? '?date=' + d : '')); };
  useEffect(() => { const f = () => setDateState(dateFromHash()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const [askDone, setAskDone] = useState(null); // task waiting for "Complete all subtasks" / "parent only"
  const [showDone, setShowDone] = useState(false); // "View completed tasks" popup
  const { data, error } = useResource('/api/today' + (date ? `?date=${date}` : ''));
  const { data: boot } = useResource('/api/bootstrap');
  const w = useWorkspace();
  const [customizing, setCustomizing] = useState(false);
  const [over, setOver] = useState({}); // optimistic marks: key -> bool
  const [todoOver, setTodoOver] = useState({}); // optimistic one-off task changes: id -> { done } | { gone: true }
  const [pending, setPending] = useState([]); // one-off tasks being saved
  const [doneOpen, setDoneOpen] = useState(() => { try { return localStorage.getItem('completedOpen') !== '0'; } catch { return true; } });
  useEffect(() => { setOver({}); setTodoOver({}); setPending([]); }, [data]);
  if (error && !data) return html`<${Empty} title="Could not load the day">${error}</${Empty}>`;
  if (!data) return html`<div class="muted">Loading…</div>`;

  const isToday = data.date === data.today;
  const assets = new Map(data.assets.map(a => [a.id, a]));
  const cats = [...new Set(data.tasks.map(t => t.category))];
  const todos = [...data.todos.filter(t => !(todoOver[t.id] && todoOver[t.id].gone)).map(t => (todoOver[t.id] ? { ...t, ...todoOver[t.id] } : t)), ...pending];
  const cancelled = (data.cancelled || []).filter(t => !(todoOver[t.id] && todoOver[t.id].gone));
  const ctx = { data, assets, over, setOver, isToday, todos, setTodoOver, setPending, cancelled, askDone: setAskDone, openHistory: () => setShowDone(true), cats: (boot && boot.categories) || [], sites: !w || w.layout.sites };
  const count = liveCount(ctx);
  const closed = t => t.status === 'reported' || liveDone(ctx, t).scoreDone >= t.progress.scoreTarget;
  const openTasks = data.tasks.filter(t => !closed(t));
  const doneTasks = data.tasks.filter(closed);
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
      </div>
      <span class="spacer"></span>
      ${w && html`<button class="btn sm customize-btn" onClick=${() => setCustomizing(true)} title="Show, hide and reorder sections and sidebar items"><${Icon} name="edit" size=${14} />Customize</button>`}
    </header>
    ${!isToday && html`<p class="notice" style="margin-bottom:14px">${data.date < data.today
      ? 'You are viewing a past day: your checks correct that day without touching today.'
      : 'Upcoming day: only moved tasks and already scheduled routines appear.'}</p>`}

    ${(() => {
      // Sections in this account's own order (Customize). Accounts from before customization see
      // exactly the layout they had.
      const keys = homeSections(w && w.layout) || ['focus', 'tasks', 'routines', 'score', 'next', 'sessions', 'pctime'];
      const SIDE = ['score', 'next', 'sessions', 'pctime'];
      const main = keys.filter(k => !SIDE.includes(k));
      const side = keys.filter(k => SIDE.includes(k) && (k !== 'pctime' || isToday));
      const focusTop = main[0] === 'focus';
      const part = (k) => k === 'focus' ? html`<${FocusPanel} key="focus" today=${data.today} tz=${data.tz} />`
        : k === 'tasks' ? html`<${MyTasks} key="tasks" ctx=${ctx} />`
        : k === 'calendar' ? html`<${CalendarSection} key="calendar" />`
        : k === 'projects' ? html`<${ProjectsSection} key="projects" />`
        : k === 'routines' ? html`<div key="routines" class="routines-block">        ${data.tasks.length === 0 && todos.length > 0 ? html`<p class="small muted">No recurring routines scheduled ${isToday ? 'today' : 'this day'} · <a href="#/settings?tab=routines">Set up routines</a></p>`
        : data.tasks.length === 0
          ? html`<div class="card empty-routines">
              <h3>No routines scheduled ${isToday ? 'today' : 'this day'}</h3>
              <p class="muted">${ctx.sites ? 'Add your sites and accounts, then choose which days each routine runs.' : 'Routines are checklists that come back on the days you choose. For one-off deadlines that repeat, use a repeating task (Quick add).'}</p>
              <div class="row wrap"><a class="btn primary sm" href="#/settings?tab=routines">Set up routines</a>${ctx.sites && html`<a class="btn sm" href="#/settings?tab=assets">Add accounts & sites</a>`}</div>
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
            </section>`}`}</div>`
        : k === 'score' ? html`<${ScoreCard} key="score" count=${count} data=${data} onHistory=${() => setShowDone(true)} />`
        : k === 'next' ? html`<${NextAction} key="next" ctx=${ctx} />`
        : k === 'sessions' ? html`<${SessionsCard} key="sessions" sessions=${data.sessions} isToday=${isToday} />`
        : k === 'pctime' ? html`<${PcTimeCard} key="pctime" today=${data.today} />` : null;
      return html`<div class=${'today-grid' + (focusTop ? '' : ' no-focus') + (side.length ? '' : ' no-side')}>
        ${focusTop && html`<div class="tg-focus">${part('focus')}</div>`}
        ${side.length > 0 && html`<aside class="tg-side" aria-label="Day summary">${side.map(part)}</aside>`}
        <div class="tg-tasks">${(focusTop ? main.slice(1) : main).map(part)}
          ${main.length === 0 && html`<${Empty} title="Nothing on this page">Use <strong>Customize</strong> to choose what Today shows.<//>`}</div>
      </div>`;
    })()}
    ${askDone && html`<${DoneChoice} t=${askDone} ctx=${ctx} onClose=${() => setAskDone(null)} />`}
    ${showDone && html`<${CompletedModal} date=${data.date} onClose=${() => setShowDone(false)} />`}
    ${customizing && html`<${CustomizeModal} onClose=${() => setCustomizing(false)} />`}
  </div>`;
}

// Live task count: the same numbers drive the Daily score card and "tasks left".
function liveCount(ctx) {
  const due = ctx.data.tasks.filter(t => t.progress.scoreTarget > 0);
  const isDone = (t) => liveDone(ctx, t).scoreDone >= t.progress.scoreTarget;
  const rDone = due.filter(isDone).length;
  const cDone = ctx.todos.filter(t => t.done_for_day).length;
  const done = rDone + cDone, total = due.length + ctx.todos.length;
  const cats = new Map();
  for (const t of due) { const c = cats.get(t.category) || { category: t.category, done: 0, total: 0 }; c.total++; if (isDone(t)) c.done++; cats.set(t.category, c); }
  return { done, total, left: total - done, pct: total ? Math.round((done / total) * 100) : null,
    recurring: { done: rDone, total: due.length }, custom: { done: cDone, total: ctx.todos.length }, categories: [...cats.values()] };
}

// Today and upcoming days: the live count. A past day: its score as recorded that day (later deletions,
// cancellations or moves don't rewrite it), or "No score recorded" when the day has no record.
function ScoreCard({ count: live, data, onHistory }) {
  const [open, setOpen] = useState(false);
  const past = data.date < data.today;
  const rec = data.dayScore || {};
  const none = past && rec.pct == null;
  const count = past && !none ? { done: rec.done, total: rec.total, pct: rec.pct, categories: rec.categories || [], custom: rec.custom || { done: 0, total: 0 } } : live;
  const label = data.date === data.today ? 'Daily score' : `Daily score · ${fmtShort(data.date)}`;
  return html`<section class="card side-card" aria-label=${label}>
    <div class="row">
      <${Ring} value=${none ? null : count.pct} size=${48} stroke=${6}><span style="font-size:13px">${none || count.pct == null ? '—' : count.pct}</span></${Ring}>
      <div style="flex:1;min-width:0">
        <div class="label">${label}</div>
        ${none
          ? html`<div class="score-line">No score recorded</div>`
          : count.total
          ? html`<div class="score-line" aria-live="polite"><span class="score-num">${count.done} / ${count.total}</span> <span>tasks done · <strong>${count.pct}%</strong></span></div>`
          : html`<div class="score-line">No tasks scheduled.</div>`}
      </div>
      ${!none && count.total > 0 && html`<button class="link-btn small" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'How?'}</button>`}
    </div>
    ${none && html`<p class="small muted" style="margin-top:6px">${data.unrecorded ? 'The dashboard wasn’t used this day, so there’s nothing to score.' : 'Nothing was recorded for this day.'}</p>`}
    ${past && !none && rec.source === 'backfill' && html`<p class="small muted" style="margin-top:6px">Calculated from the records saved for that day.</p>`}
    <button class="btn sm history-btn" onClick=${onHistory}><${Icon} name="history" size=${14} />View completed tasks</button>
    ${open && html`<div class="calc">
      ${count.categories.map(c => html`<div class="calc-row"><span>${c.category}</span><span class="num">${c.done}/${c.total}</span><strong class="num">${c.done === c.total ? '✓' : ''}</strong></div>`)}
      ${count.custom.total > 0 && html`<div class="calc-row"><span>My tasks</span><span class="num">${count.custom.done}/${count.custom.total}</span><strong class="num">${count.custom.done === count.custom.total ? '✓' : ''}</strong></div>`}
      <p class="small muted" style="margin-top:6px">${count.done} done ÷ ${count.total} tasks = <strong>${count.pct}%</strong>. A routine item with a quota counts once, when its target is reached; extras don’t add. Focus sessions don’t count.</p>
    </div>`}
  </section>`;
}

// ---------- My tasks (one-off, for this date only) ----------
// Done credits the day being viewed (normally today) — never rewrites an earlier day.
async function setTodoDone(ctx, t, done, subtasks) {
  const on = ctx.data.date;
  ctx.setTodoOver(o => ({ ...o, [t.id]: { done: done ? 1 : 0, done_for_day: done ? 1 : 0, done_on: done ? on : null } }));
  try {
    await api('PUT', `/api/todos/${t.id}`, { done, on, ...(subtasks ? { subtasks } : {}) });
    bus.emit();
    toast({ msg: `${firstLine(t.title)} · ${done ? 'done' : 'reopened'}`, undo: async () => { await api('PUT', `/api/todos/${t.id}`, { done: !done, on }); bus.emit(); } });
  } catch (e) { ctx.setTodoOver(o => { const n = { ...o }; delete n[t.id]; return n; }); toast({ msg: e.message, kind: 'error' }); }
}
async function deleteTodo(ctx, t) {
  ctx.setTodoOver(o => ({ ...o, [t.id]: { gone: true } }));
  try {
    const r = await api('DELETE', `/api/todos/${t.id}`);
    bus.emit();
    toast({ msg: `Deleted “${firstLine(t.title).slice(0, 60)}”`, undo: async () => { await api('POST', '/api/todos/undelete', { deleted: r.deleted, subtasks: r.subtasks }); bus.emit(); } });
  } catch (e) { ctx.setTodoOver(o => { const n = { ...o }; delete n[t.id]; return n; }); toast({ msg: e.message, kind: 'error' }); }
}

function MyTasks({ ctx }) {
  const [title, setTitle] = useState('');
  const [cat, setCat] = useState('');
  const [subtasks, setSubtasks] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [showCancelled, setShowCancelled] = useState(false);
  const overdue = ctx.todos.filter(t => t.overdue && !t.done).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const overdueList = useFiveRows();
  const rest = ctx.todos.filter(t => !t.overdue && !t.done);
  const completed = ctx.todos.filter(t => t.done && t.done_on === ctx.data.date);
  const done = ctx.todos.filter(t => t.done_for_day).length;
  // One entry = ONE task: new lines and bullets are formatting inside its title.
  const add = async (e) => {
    if (e) e.preventDefault();
    const v = title.replace(/\r\n?/g, '\n').replace(/\s+$/, '').replace(/^\s*\n/, '');
    if (!v) return;
    const temp = { id: 'tmp-' + Date.now(), date: ctx.data.date, title: v, done: 0, done_for_day: 0, temp: true };
    ctx.setPending(p => [...p, temp]);
    const drafts = subtaskTitles(subtasks);
    setSubtasks('');
    setTitle(''); // ready for the next one (the category stays picked)
    try { await api('POST', '/api/todos', { date: ctx.data.date, title: v, category_name: cat.trim(), subtasks: drafts }); bus.emit(); }
    catch (err) { setTitle(current => current || v); setSubtasks(current => current || drafts.join('\n')); ctx.setPending(p => p.filter(x => x.id !== temp.id)); toast({ msg: err.message, kind: 'error' }); }
  };
  return html`<section class="section routine my-tasks" id="my-tasks" aria-label="My tasks">
    <div class="routine-head">
      <h3>My tasks</h3>
      ${ctx.todos.length > 0 && html`<span class="num rh-num">${done}/${ctx.todos.length} done</span>`}
    </div>
    <form class="add-task-card" onSubmit=${add}>
      <label for="add-task-input" class="add-task-label">Add a task${ctx.isToday ? '' : ` for ${fmtShort(ctx.data.date)}`}</label>
      <div class="add-task-row">
        <${AutoGrow} id="add-task-input" value=${title} onInput=${setTitle} onSave=${() => add()} autofocus=${false} enterkeyhint="done"
          label=${'Add a task' + (ctx.isToday ? '' : ` for ${fmtShort(ctx.data.date)}`)} placeholder=${ctx.isToday ? 'Task title, e.g. Send the weekly report' : 'Task title'} />
        <${CategoryInput} compact value=${cat} onInput=${setCat} cats=${ctx.cats} label="Category for the new task" placeholder="Category (optional)" />
        <button class="btn primary" disabled=${!title.trim()}><${Icon} name="plus" size=${15} />Add task</button>
      </div>
      <${SubtaskDraft} value=${subtasks} onInput=${setSubtasks} />
    </form>
    ${overdue.length > 0 && html`<div class="overdue-block" role="region" aria-label=${'Overdue, ' + overdue.length + ' task' + (overdue.length === 1 ? '' : 's')}>
      <div class="overdue-head"><${Icon} name="alert" size=${15} /><span>Overdue</span><span class="overdue-count">${overdue.length}</span></div>
      <div class="task-list five-row-list" ref=${overdueList} tabindex="0" aria-label="Overdue tasks">${overdue.map(t => html`<${TodoRow} key=${t.id} t=${t} ctx=${ctx} />`)}</div>
    </div>`}
    ${rest.length > 0 && html`<div class="task-list">${rest.map(t => html`<${TodoRow} key=${t.id} t=${t} ctx=${ctx} />`)}</div>`}
    ${completed.length > 0 && html`<section class="done-group" aria-label="Completed tasks">
      <button class="done-toggle" aria-expanded=${showCompleted} onClick=${() => setShowCompleted(!showCompleted)}>
        <${Icon} name=${showCompleted ? 'chevD' : 'chevR'} size=${16} />Completed <span class="muted">${completed.length}</span></button>
      ${showCompleted && html`<div class="task-list">${completed.map(t => html`<${TodoRow} key=${t.id} t=${t} ctx=${ctx} />`)}</div>`}
    </section>`}
    <button class="link-btn small" onClick=${ctx.openHistory}>View task history</button>
    ${ctx.cancelled.length > 0 && html`<div class="cancelled-group">
      <button class="done-toggle" aria-expanded=${showCancelled} onClick=${() => setShowCancelled(!showCancelled)}>
        <${Icon} name=${showCancelled ? 'down' : 'chevR'} size=${16} /><span>Cancelled</span><span class="muted">${ctx.cancelled.length}</span></button>
      ${showCancelled && html`<div class="task-list">${ctx.cancelled.map(t => html`<${TodoRow} key=${'c' + t.id} t=${t} ctx=${ctx} />`)}</div>`}
    </div>`}
  </section>`;
}

const overdueLabel = (from, day) => {
  const n = Math.round((new Date(day + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000);
  return n === 1 ? 'Overdue · from yesterday' : `Overdue · from ${fmtShort(from)} (${n} days)`;
};

// Done with unfinished subtasks asks first: complete them all, or only the parent.
async function requestDone(ctx, t) {
  const open = (t.subtasks || []).filter(x => !x.done).length;
  if (open > 0) return ctx.askDone(t);
  return setTodoDone(ctx, t, true);
}
async function cancelTodo(ctx, t, cancel) {
  ctx.setTodoOver(o => ({ ...o, [t.id]: { gone: true } }));
  try {
    await api('POST', `/api/todos/${t.id}/${cancel ? 'cancel' : 'reopen'}`);
    bus.emit();
    toast({ msg: `${firstLine(t.title).slice(0, 60)} · ${cancel ? 'cancelled' : 'reopened'}`,
      undo: async () => { await api('POST', `/api/todos/${t.id}/${cancel ? 'reopen' : 'cancel'}`); bus.emit(); } });
  } catch (e) { ctx.setTodoOver(o => { const n = { ...o }; delete n[t.id]; return n; }); toast({ msg: e.message, kind: 'error' }); }
}

function useOutside(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', f); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k); };
  }, [open]);
}

// Title editor: a textarea that grows with the text, with visible Save and Cancel.
function TitleEditor({ value, onSave, onCancel, label }) {
  const [v, setV] = useState(value);
  const save = () => { const x = v.trim(); if (!x) return; if (x === value) return onCancel(); onSave(x); };
  return html`<form class="title-edit" onSubmit=${(e) => { e.preventDefault(); save(); }}>
    <${AutoGrow} value=${v} onInput=${setV} onSave=${save} onCancel=${onCancel} label=${label} />
    <div class="title-edit-actions">
      <button class="btn sm primary" disabled=${!v.trim()}>Save</button>
      <button type="button" class="btn sm" onClick=${onCancel}>Cancel</button>
    </div>
  </form>`;
}

function TodoRow({ t, ctx }) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [details, setDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef();
  useOutside(menu, setMenu, ref);
  const cancelled = !!t.cancelled;
  const saveTitle = async (title) => {
    try { await api('PUT', `/api/todos/${t.id}`, { title }); bus.emit(); setEditing(false); } catch (err) { toast({ msg: err.message, kind: 'error' }); }
  };
  const subs = t.subtasks || [];
  const showSubs = subsOpen || adding;
  const doneAt = t.done && t.done_at ? new Date(t.done_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const late = t.overdue && !t.done_for_day && !cancelled;
  const status = t.temp ? 'Saving…'
    : cancelled ? `Cancelled${t.cancelled_on ? ' · ' + fmtShort(t.cancelled_on) : ''}`
    : t.done_for_day ? `Done${doneAt && t.done_on === ctx.data.today ? ' at ' + doneAt : ''}${t.overdue ? ' · was ' + overdueLabel(t.date, ctx.data.date).toLowerCase() : ''}`
    : t.done ? `Done later · ${fmtShort(t.done_on)}`
    : late ? overdueLabel(t.date, ctx.data.date) : 'One-off task';
  return html`<div class=${'task todo-row' + (t.done_for_day ? ' done' : '') + (late ? ' overdue' : '') + (cancelled ? ' cancelled' : '')} id=${'todo-' + t.id}>
    <div class="tname">
      ${editing
        ? html`<${TitleEditor} value=${t.title} label="Task title" onSave=${saveTitle} onCancel=${() => setEditing(false)} />`
        : html`<span class="todo-title">${late && html`<span class="od-dot" aria-hidden="true"></span>`}<${TaskText} text=${t.title} /></span>
          <small class=${late ? 'od-label' : ''}>${late && html`<${Icon} name="alert" size=${13} /> `}${status}
            ${t.category_id && html` <${CatChip} cats=${ctx.cats} id=${t.category_id} />`}${t.repeat && html` <span class="repeat-mark" title=${'Repeats: ' + (REPEAT_LABELS.find(x => x[0] === t.repeat) || ['', t.repeat])[1]}>↻ ${(REPEAT_LABELS.find(x => x[0] === t.repeat) || ['', t.repeat])[1].toLowerCase()}</span>`}</small>
          ${subs.length > 0 && html`<button class="sub-progress" aria-expanded=${showSubs} onClick=${() => setSubsOpen(!subsOpen)}>
            <${Icon} name=${showSubs ? 'chevD' : 'chevR'} size=${14} />${t.sub_done}/${subs.length} subtasks done</button>`}`}
    </div>
    ${!editing && html`<div class="todo-actions">
      ${cancelled
        ? html`<button class="btn sm" onClick=${() => cancelTodo(ctx, t, false)} aria-label=${'Reopen task: ' + firstLine(t.title)}><${Icon} name="undo" size=${14} />Reopen task</button>`
        : html`
          <button class="btn sm" disabled=${t.temp || !!t.done} onClick=${() => requestStart({ task_label: firstLine(t.title) })} aria-label=${'Start a session: ' + firstLine(t.title)}>
            <${Icon} name="play" size=${13} />Start</button>
          ${t.done
            ? html`<button class="btn sm" disabled=${t.temp} onClick=${() => setTodoDone(ctx, t, false)} aria-label=${'Reopen: ' + firstLine(t.title)}><${Icon} name="undo" size=${14} />Reopen</button>`
            : html`<button class="btn sm primary" disabled=${t.temp} onClick=${() => requestDone(ctx, t)} aria-label=${'Mark done: ' + firstLine(t.title)}><${Icon} name="check" size=${14} />Done</button>`}`}
      <div class="menu" ref=${ref}>
        <button class="icon-btn" disabled=${t.temp} aria-label=${'Options — ' + firstLine(t.title)} aria-expanded=${menu} onClick=${() => setMenu(!menu)}><${Icon} name="more" /></button>
        ${menu && html`<div class="menu-pop">
          <button class="item" onClick=${() => { setMenu(false); setEditing(true); }}><${Icon} name="note" size=${16} />Edit title</button>
          <button class="item" onClick=${() => { setMenu(false); setDetails(true); }}><${Icon} name="edit" size=${16} />Category & repeat…</button>
          ${!cancelled && html`<button class="item" onClick=${() => { setMenu(false); setSubsOpen(true); setAdding(true); }}><${Icon} name="list" size=${16} />Add subtask</button>`}
          ${cancelled
            ? html`<button class="item" onClick=${() => { setMenu(false); cancelTodo(ctx, t, false); }}><${Icon} name="undo" size=${16} />Reopen task</button>`
            : !t.done && html`<button class="item" onClick=${() => { setMenu(false); cancelTodo(ctx, t, true); }}><${Icon} name="ban" size=${16} />Cancel task</button>`}
          <button class="item danger" onClick=${() => { setMenu(false); setConfirmDelete(true); }}><${Icon} name="x" size=${16} />Delete</button>
        </div>`}
      </div>
    </div>`}
    ${showSubs && !t.temp && html`<${Subtasks} t=${t} ctx=${ctx} adding=${adding} setAdding=${setAdding} readOnly=${cancelled} />`}
    ${confirmDelete && html`<${ConfirmDeleteTask} title=${t.title} onCancel=${() => setConfirmDelete(false)}
      onDelete=${async () => { setConfirmDelete(false); await deleteTodo(ctx,t); }} />`}
    ${details && html`<${TodoDetails} t=${t} ctx=${ctx} onClose=${() => setDetails(false)} />`}
  </div>`;
}

// A task's category (pick or type a new one) and repeat rule.
function TodoDetails({ t, ctx, onClose }) {
  const cur = (ctx.cats.find(c => c.id === t.category_id) || {}).name || '';
  const [cat, setCat] = useState(cur);
  const [repeat, setRepeat] = useState(t.repeat || '');
  const save = async (e) => {
    e.preventDefault();
    try { await api('PUT', `/api/todos/${t.id}`, { category_name: cat.trim(), repeat }); bus.emit(); onClose(); }
    catch (err) { toast({ msg: err.message, kind: 'error' }); }
  };
  return html`<${Modal} title="Category & repeat" onClose=${onClose}>
    <form class="stack" onSubmit=${save}>
      <p class="small"><strong>${firstLine(t.title)}</strong></p>
      <${CategoryInput} value=${cat} onInput=${setCat} cats=${ctx.cats} />
      <label class="field">Repeat<select value=${repeat} onChange=${(e) => setRepeat(e.target.value)}>${REPEAT_LABELS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
        <span class="hint">A repeating task schedules its next one when you mark it done.</span></label>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Save</button></div>
    </form>
  <//>`;
}

function Subtasks({ t, ctx, adding, setAdding, readOnly }) {
  const [title, setTitle] = useState('');
  const [editId, setEditId] = useState(null);
  const subs = t.subtasks || [];
  const call = async (m, u, b) => { try { await api(m, u, b); bus.emit(); } catch (e) { toast({ msg: e.message, kind: 'error' }); } };
  const add = async (e) => {
    e && e.preventDefault();
    const v = title.trim(); if (!v) return;
    setTitle('');
    await call('POST', `/api/todos/${t.id}/subtasks`, { title: v });
  };
  return html`<div class="subtasks" aria-label=${'Subtasks of ' + firstLine(t.title)}>
    ${subs.length > 0 && html`<ul class="sub-list">${subs.map(st => html`<li key=${st.id} class=${st.done ? 'done' : ''}>
      ${editId === st.id
        ? html`<${TitleEditor} value=${st.title} label="Subtask title" onCancel=${() => setEditId(null)}
            onSave=${async (v) => { await call('PUT', `/api/subtasks/${st.id}`, { title: v }); setEditId(null); }} />`
        : html`<label class="sub-check">
            <input type="checkbox" checked=${!!st.done} disabled=${readOnly} onChange=${(e) => call('PUT', `/api/subtasks/${st.id}`, { done: e.target.checked, on: ctx.data.date })} />
            <span class="sub-title"><${TaskText} text=${st.title} /></span></label>
          ${!readOnly && html`<span class="sub-actions">
            <button class="icon-btn sm" aria-label=${'Edit subtask: ' + firstLine(st.title)} onClick=${() => setEditId(st.id)}><${Icon} name="note" size=${15} /></button>
            <button class="icon-btn sm" aria-label=${'Remove subtask: ' + firstLine(st.title)} onClick=${() => call('DELETE', `/api/subtasks/${st.id}`)}><${Icon} name="x" size=${15} /></button>
          </span>`}`}
    </li>`)}</ul>`}
    ${!readOnly && (adding
      ? html`<form class="sub-add" onSubmit=${add}>
          <${AutoGrow} value=${title} onInput=${setTitle} onSave=${add} onCancel=${() => { setTitle(''); setAdding(false); }} label="New subtask" placeholder="Subtask" />
          <div class="title-edit-actions"><button class="btn sm primary" disabled=${!title.trim()}>Add</button><button type="button" class="btn sm" onClick=${() => { setTitle(''); setAdding(false); }}>Done adding</button></div>
        </form>`
      : html`<button class="link-btn small" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${13} /> Add subtask</button>`)}
  </div>`;
}

// Parent marked Done while subtasks are open: complete them all, or only the parent.
function DoneChoice({ t, ctx, onClose }) {
  const open = (t.subtasks || []).filter(x => !x.done).length;
  const go = async (mode) => { onClose(); await setTodoDone(ctx, t, true, mode); };
  return html`<${Modal} title="Mark task done" onClose=${onClose}>
    <div class="stack">
      <p><strong class="wrap-anywhere"><${TaskText} text=${t.title} /></strong></p>
      <p class="muted">${open} subtask${open === 1 ? ' is' : 's are'} not done yet.</p>
      <div class="row wrap">
        <button class="btn primary" onClick=${() => go('all')}><${Icon} name="check" size=${15} />Complete all subtasks</button>
        <button class="btn" onClick=${() => go('parent')}>Complete parent only</button>
        <button class="btn ghost" onClick=${onClose}>Cancel</button>
      </div>
    </div>
  </${Modal}>`;
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
    if (!t.asset_id && (t.meta.asset_ids || []).length) {
      const done = t.records.filter(r => r.kind === t.unit).length;
      if (done >= t.target) return null;
      return { what: `${t.label}`, detail: `${t.meta.unit_label || 'Unit'} ${done + 1}/${t.target} — choose the site`, shared: true };
    }
    for (let i = 1; i <= t.target; i++) {
      if (!isOn(ctx, t, t.unit, i, t.asset_id || null)) return { what: t.label, detail: `${unitWord(t)} ${i}/${t.target}`, run: { kind: t.unit, idx: i, asset: t.asset_id }, btn: `Check ${unitWord(t).toLowerCase()} ${i}` };
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
const unitWord = (t) => ({ pin: 'Pin', article: 'Article', youtube: 'Video' }[t.unit] || 'Item');
// A counter not tied to sites or accounts (e.g. "calls made"): numbered boxes, like a per-site counter.
const plainCounter = (t) => !t.asset_id && !(t.meta.asset_ids || []).length;

function NextAction({ ctx }) {
  const [skip, setSkip] = useState(0);
  const { data } = ctx;
  const order = [...data.tasks].sort((x, y) => (x.time_slot || '99') < (y.time_slot || '99') ? -1 : (x.time_slot || '99') > (y.time_slot || '99') ? 1 : x.sort - y.sort);
  const todoStep = (t) => ({ todo: t, t: { category: t.overdue ? 'Overdue' : 'My tasks', time_slot: '' }, s: { what: html`<${TaskText} text=${t.title} />`, detail: t.overdue ? overdueLabel(t.date, ctx.data.date) : 'One-off task', btn: 'Done' } });
  const open = (t) => !t.done_for_day && !t.done && !t.temp;
  // Overdue first, then routines, then today's own tasks.
  const steps = [...ctx.todos.filter(t => t.overdue && open(t)).map(todoStep),
    ...order.map(t => ({ t, s: nextStep(ctx, t) })).filter(x => x.s),
    ...ctx.todos.filter(t => !t.overdue && open(t)).map(todoStep)];
  const cur = steps.length ? steps[skip % steps.length] : null;
  const { left, total } = liveCount(ctx);
  if (!total) return null;
  return html`<section class="card side-card next" aria-label="Next action">
    <div class="row"><span class="label" style="flex:1">Next action</span>
      ${steps.length > 1 && html`<button class="btn sm ghost" onClick=${() => setSkip(skip + 1)}>Skip →</button>`}</div>
    ${cur ? html`
      <div class="row wrap" style="gap:6px"><${Chip} color=${cur.t.category === 'Overdue' ? 'pink' : 'blue'}>${cur.t.category}</${Chip}>${cur.t.time_slot && html`<${Chip}>${cur.t.time_slot}</${Chip}>`}</div>
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
function CategorySection(props) {
  // Social routines (e.g. Facebook & Instagram) get their own session-card layout.
  if (props.all.length && props.all.every(t => t.type === 'social')) return html`<${SocialSection} ...${props} />`;
  return html`<${PlainSection} ...${props} />`;
}

function PlainSection({ cat, color, tasks, all, showTotal, ctx, compact }) {
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
  const Body = t.type === 'counter' ? (t.asset_id || plainCounter(t) ? CounterBoxes : SharedCounter) : t.type === 'social' ? SocialSlot : CheckItems;
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
  if (t.type === 'counter' && plainCounter(t)) return t.meta.unit_label || '';
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

// ---------- Social routines: one card per session (Morning, Evening…), one block per video ----------
function SocialSection({ cat, tasks, all, ctx, compact }) {
  const sum = all.filter(t => t.status !== 'reported').reduce((a, t) => ({ done: a.done + liveDone(ctx, t).scoreDone, target: a.target + t.progress.scoreTarget }), { done: 0, target: 0 });
  return html`<section class=${'section routine social-section' + (compact ? ' compact' : '')} id=${compact ? undefined : 'cat-' + cat} aria-label=${cat}>
    <div class="social-head">
      <h3>${cat}</h3>
      ${!compact && sum.target > 0 && html`<span class=${'social-total' + (sum.done >= sum.target ? ' complete' : '')} aria-live="polite">${sum.done} of ${sum.target} posts published</span>`}
    </div>
    <div class="social-cards">${tasks.map(t => html`<${SocialCard} key=${t.id} t=${t} ctx=${ctx} />`)}</div>
  </section>`;
}

function SocialCard({ t, ctx }) {
  // Videos shown: the scheduled ones, any with saved checks, and new blocks added here (a new block is
  // saved as soon as something in it is checked).
  const [shown, setShown] = useState(0);
  const live = liveDone(ctx, t);
  const target = t.progress.scoreTarget;
  const reported = t.status === 'reported';
  const recorded = Math.max(t.target, 0, ...t.records.map(r => r.idx));
  const n = Math.max(recorded, shown);
  const title = [t.label, t.time_slot].filter(Boolean).join(' · ');
  const dests = t.meta.destinations || [];
  const blocks = [];
  for (let i = 1; i <= n; i++) {
    const produced = isOn(ctx, t, 'video', i);
    const isExtra = i > t.target;
    blocks.push(html`<div class="video-block" key=${i}>
      <div class="vb-head">
        <strong>Video ${i}</strong>${isExtra && html`<span class="vb-extra">extra</span>`}
        <label class="cb"><input type="checkbox" checked=${produced} disabled=${reported}
          onChange=${() => mark(ctx, t, { kind: 'video', idx: i, done: !produced, label: `Video ${i} produced` })} /><span>Produced</span></label>
      </div>
      <fieldset class="publish-to"><legend>Publish to</legend>
        <div class="pt-list">${dests.map(d => {
          const on = isOn(ctx, t, 'publication', i, d);
          const name = ctx.assets.get(d)?.name || '?';
          return html`<label class="cb"><input type="checkbox" checked=${on} disabled=${reported} aria-label=${`Video ${i} published on ${name}`}
            onChange=${() => mark(ctx, t, { kind: 'publication', idx: i, asset: d, done: !on, label: `Published · ${name}` })} /><span>${name}</span></label>`;
        })}</div>
      </fieldset>
    </div>`);
  }
  return html`<article class=${'social-card' + (target > 0 && live.scoreDone >= target ? ' complete' : '') + (reported ? ' reported' : '')} id=${'task-' + t.id} aria-label=${title}>
    <header class="sc-head">
      <h4>${title}</h4>
      ${target > 0 && !reported && html`<span class="sc-progress num">${live.scoreDone}/${target} posted</span>`}
      <${TaskMenu} t=${t} ctx=${ctx} />
    </header>
    ${t.meta.reported_from && !reported && html`<p class="small muted">Moved from ${fmtShort(t.meta.reported_from)}</p>`}
    ${reported
      ? html`<p class="small muted">Moved → ${fmtShort(t.reported_to)}. What remains counts on ${fmtShort(t.reported_to)}, not here.</p>`
      : html`<div class="video-blocks">${blocks}</div>
        <button class="btn sm ghost add-video" onClick=${() => setShown(n + 1)}><${Icon} name="plus" size=${14} />Add video</button>`}
    ${t.note && html`<div class="note-line">${t.note}</div>`}
  </article>`;
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
