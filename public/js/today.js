// "Today": the routine checklist first, with a compact focus panel and a right column (score, next action, sessions).
import { html, useState, useEffect, useRef, useResource, api, bus, toast, Icon, Bar, Ring, Chip, Empty, fmtDay, fmtShort, addDays, fmtDur, pct } from './lib.js';
import { FocusPanel } from './focus.js';

const CAT_COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky'];
const catColor = (name, all) => CAT_COLORS[Math.max(0, all.indexOf(name)) % CAT_COLORS.length];
const SETTLE_MS = 6000; // a completed row stays in place this long (undo window) before moving to "Completed"
const isClosed = (t) => t.status === 'reported' || (t.progress.scoreTarget > 0 && t.progress.complete) || t.progress.scoreTarget === 0;

export function Today() {
  const [date, setDate] = useState(null);
  const { data, error } = useResource('/api/today' + (date ? `?date=${date}` : ''));
  const [over, setOver] = useState({}); // optimistic marks: key -> bool
  const [settled, setSettled] = useState(null); // { date, ids:Set } — which tasks are laid out as completed
  const [doneOpen, setDoneOpen] = useState(() => { try { return localStorage.getItem('completedOpen') !== '0'; } catch { return true; } });
  useEffect(() => { setOver({}); }, [data]);
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
  const ctx = { data, assets, over, setOver, isToday };
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
      </div>
    </header>
    ${!isToday && html`<p class="notice" style="margin-bottom:14px">${data.date < data.today
      ? 'You are viewing a past day: your checks correct that day without touching today.'
      : 'Upcoming day: only moved tasks and already scheduled routines appear.'}</p>`}

    <div class="today-grid">
      <div class="tg-focus"><${FocusPanel} today=${data.today} tz=${data.tz} /></div>

      <aside class="tg-side" aria-label="Day summary">
        <${ScoreCard} score=${data.score} />
        <${NextAction} ctx=${ctx} />
        <${SessionsCard} sessions=${data.sessions} isToday=${isToday} />
      </aside>

      <div class="tg-tasks">
        ${data.tasks.length === 0
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

function ScoreCard({ score }) {
  const [open, setOpen] = useState(false);
  return html`<section class="card side-card" aria-label="Daily score">
    <div class="row">
      <${Ring} value=${score.overall} size=${48} stroke=${6}><span style="font-size:13px">${score.overall == null ? '—' : Math.round(score.overall)}</span></${Ring}>
      <div style="flex:1">
        <div class="label">Daily score</div>
        <div class="score-num">${score.overall == null ? '—' : pct(score.overall)}</div>
      </div>
      ${score.categories.length > 0 && html`<button class="link-btn small" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'How?'}</button>`}
    </div>
    ${score.categories.length === 0 && html`<p class="small muted" style="margin-top:6px">No routines scheduled, so no score.</p>`}
    ${open && html`<div class="calc">
      ${score.categories.map(c => html`<div class="calc-row"><span>${c.category}</span><span class="num">${c.done}/${c.target}${c.actual > c.done ? html` <span class="muted">(${c.actual})</span>` : ''}</span><strong class="num">${pct(c.pct)}</strong></div>`)}
      <p class="small muted" style="margin-top:6px">Average of ${score.categories.length} scheduled ${score.categories.length === 1 ? 'category' : 'categories'}: (${score.categories.map(c => Math.round(c.pct)).join(' + ')}) ÷ ${score.categories.length} = <strong>${pct(score.overall)}</strong>. Each task counts at most 100%.</p>
    </div>`}
  </section>`;
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
  const steps = order.map(t => ({ t, s: nextStep(ctx, t) })).filter(x => x.s);
  const cur = steps.length ? steps[skip % steps.length] : null;
  const left = data.tasks.filter(t => t.status === 'open' && !t.progress.complete && t.progress.scoreTarget > 0).length;
  if (!data.tasks.length) return null;
  return html`<section class="card side-card next" aria-label="Next action">
    <div class="row"><span class="label" style="flex:1">Next action</span>
      ${steps.length > 1 && html`<button class="btn sm ghost" onClick=${() => setSkip(skip + 1)}>Skip →</button>`}</div>
    ${cur ? html`
      <div class="row wrap" style="gap:6px"><${Chip} color="blue">${cur.t.category}</${Chip}>${cur.t.time_slot && html`<${Chip}>${cur.t.time_slot}</${Chip}>`}</div>
      <div class="what">${cur.s.what}</div>
      <p class="small muted">${cur.s.detail}</p>
      ${cur.s.run
        ? html`<button class="btn primary" onClick=${() => mark(ctx, cur.t, { ...cur.s.run, done: true, label: `${cur.s.what} · ${cur.s.detail}` })}><${Icon} name="check" size=${16} />${cur.s.btn}</button>`
        : html`<button class="btn primary" onClick=${() => document.getElementById('task-' + cur.t.id)?.scrollIntoView({ block: 'center' })}>Choose the site</button>`}
      <p class="small muted">${left} task${left === 1 ? '' : 's'} left</p>`
    : html`<div class="what">Daily routines complete</div><p class="small muted">Every routine scheduled ${ctx.isToday ? 'today' : 'this day'} is done.</p>`}
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
