import { Select, DateField, SuggestField } from './controls.js';
// Personal workspace UI: the account's own layout (home sections and sidebar), first-login starter
// setups, the Customize dialog, a category field you can type a new category into, the Calendar and
// Projects sections, Quick Add (any page) and Saved views. Everything is stored in the account's own
// dashboard (private, synced across its devices, never shared with teams). See lib/workspace.js.
import { html, useState, useEffect, useRef, useResource, api, bus, toast, Icon, Chip, Modal, Empty, fmtDay, fmtShort, addDays, firstLine, SubtaskDraft, subtaskTitles } from './lib.js';

// ---------- the account's layout ----------
export const HOME_LABELS = {
  tasks: ['Tasks', 'Your one-off tasks for the day, overdue ones first'],
  calendar: ['Calendar', 'Tasks and planned projects for the next two weeks'],
  projects: ['Projects', 'Projects in progress and their next action'],
  focus: ['Focus session', 'Start a timed work session'],
  routines: ['Daily routines', 'Recurring checklists and counters'],
  score: ['Daily score', 'Tasks done today'],
  next: ['Next action', 'The next routine step to do'],
  sessions: ['Today’s sessions', 'Focus sessions finished today'],
  pctime: ['PC Work Time', 'Active time on your computer'],
};
export const NAV_LABELS = { projects: 'Projects', learning: 'Learning', challenges: 'Challenges', teams: 'Team Work', views: 'Saved views', stats: 'Stats' };

let ws = { data: null, subs: new Set(), loading: null };
export async function loadWorkspace() {
  if (ws.loading) return ws.loading;
  ws.loading = api('GET', '/api/workspace').then(d => { ws.data = d; ws.subs.forEach(f => f(d)); return d; }).catch(() => ws.data).finally(() => { ws.loading = null; });
  return ws.loading;
}
export function useWorkspace() {
  const [d, set] = useState(ws.data);
  useEffect(() => { ws.subs.add(set); if (!ws.data) loadWorkspace(); else if (ws.data !== d) set(ws.data); return () => ws.subs.delete(set); }, []);
  return d;
}
bus.on(() => { if (ws.data) loadWorkspace(); });
export async function saveLayout(patch) {
  const layout = await api('PUT', '/api/workspace/layout', patch);
  ws.data = { ...ws.data, layout }; ws.subs.forEach(f => f(ws.data));
  return layout;
}
const shownKeys = (part) => part.order.filter(k => !part.hidden.includes(k));
export const hasPcFeature = () => !!(window.__dash && window.__dash.rpc && (window.__dash.features || []).includes('pc_time'));
// Sections this account can have at all (PC Work Time only where it's granted; localhost has none).
const availableHome = (k) => k !== 'pctime' || hasPcFeature();
const availableNav = (k) => k !== 'teams' || !!(window.__dash && window.__dash.rpc);
export function homeSections(layout) { return layout ? shownKeys(layout.home).filter(availableHome) : null; }
export function navItems(layout) { return layout ? shownKeys(layout.nav).filter(availableNav) : null; }

// ---------- category field: pick one, or type a new one (created when saved) ----------
export function CategoryInput({ value, onInput, cats, label = 'Category', placeholder = 'No category', id, compact }) {
  const suggested = (ws.data && ws.data.suggested) || ['Work', 'Study', 'Personal'];
  const active = (cats || []).filter(c => !c.archived && c.key !== 'other');
  const names = [...active.map(c => c.name), ...suggested.filter(s => !active.some(c => c.name.toLowerCase() === s.toLowerCase()))];
  const input = html`<${SuggestField} id=${id} maxlength="60" value=${value} placeholder=${placeholder}
    label=${label} choices=${names} onInput=${onInput} />`;
  return compact ? html`<span class="cat-input">${input}</span>` : html`<label class="field cat-input">${label}${input}
    <span class="hint">Pick one or type a new name: it’s created for you.</span></label>`;
}
export const catName = (cats, id) => { const c = (cats || []).find(x => x.id === id); return c ? c.name : ''; };
export function CatChip({ cats, id }) {
  const c = (cats || []).find(x => x.id === id);
  return c ? html`<${Chip} color=${c.color} title=${c.archived ? 'Archived category' : 'Category'}>${c.name}<//>` : null;
}

// ---------- first login: optional starter setups ----------
const SETUPS = [
  ['study', 'Study', 'Courses, Assignments and Exams categories, plus “Exams” and “Due this week” views.'],
  ['work', 'Work', 'Projects and Clients categories, plus a “Due this week” view.'],
  ['personal', 'Personal', 'Personal, Home and Health categories.'],
  ['blank', 'Start blank', 'Nothing added. Create categories as you go.'],
];
export function Onboarding() {
  const w = useWorkspace();
  const [busy, setBusy] = useState(null);
  const [closed, setClosed] = useState(false);
  if (!w || !w.onboarding.pending || closed) return null;
  const pick = async (setup) => {
    setBusy(setup);
    try { await api('POST', '/api/workspace/setup', { setup }); await loadWorkspace(); bus.emit(); setClosed(true); toast({ msg: setup === 'blank' ? 'Starting blank' : 'Set up · change anything later in Customize and Settings' }); }
    catch (e) { toast({ msg: e.message, kind: 'error' }); } finally { setBusy(null); }
  };
  return html`<${Modal} title="Welcome! How will you use this workspace?" onClose=${() => pick('blank')}>
    <p class="muted">Optional: a setup only adds a few categories and saved views. No sample tasks. You can change or remove everything later.</p>
    <div class="setup-grid">${SETUPS.map(([k, l, d]) => html`<button class=${'card setup-card' + (k === 'blank' ? ' blank' : '')} disabled=${!!busy} onClick=${() => pick(k)}>
      <strong>${l}</strong><span class="small muted">${d}</span>${busy === k && html`<span class="small">Setting up…</span>`}</button>`)}</div>
    <p class="small muted" style="margin-top:10px">Skip = Start blank.</p>
  <//>`;
}

// ---------- Customize: show, hide and reorder home sections and sidebar items ----------
function OrderList({ items, labels, hidden, onChange, available }) {
  const move = (i, d) => { const o = [...items]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; onChange(o, hidden); };
  const toggle = (k) => onChange(items, hidden.includes(k) ? hidden.filter(x => x !== k) : [...hidden, k]);
  return html`<ul class="order-list">${items.filter(available).map((k) => { const i = items.indexOf(k); const lab = labels[k]; const [name, hint] = Array.isArray(lab) ? lab : [lab, '']; return html`<li key=${k}>
    <label class="checkline"><input type="checkbox" checked=${!hidden.includes(k)} onChange=${() => toggle(k)} /><span><strong>${name}</strong>${hint && html`<span class="small muted"> · ${hint}</span>`}</span></label>
    <span class="spacer"></span>
    <button class="icon-btn" type="button" aria-label=${'Move ' + name + ' up'} disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
    <button class="icon-btn" type="button" aria-label=${'Move ' + name + ' down'} disabled=${i === items.length - 1} onClick=${() => move(i, 1)}>↓</button>
  </li>`; })}</ul>`;
}
export function CustomizeModal({ onClose }) {
  const w = useWorkspace();
  const [l, setL] = useState(w && w.layout);
  const [busy, setBusy] = useState(false);
  if (!l) return null;
  const save = async () => {
    setBusy(true);
    try { await saveLayout({ home: l.home, nav: l.nav, sites: l.sites }); bus.emit(); toast({ msg: 'Layout saved' }); onClose(); }
    catch (e) { toast({ msg: e.message, kind: 'error' }); setBusy(false); }
  };
  const reset = async () => {
    if (!confirm('Go back to the default layout? Your saved views are kept.')) return;
    const layout = await api('POST', '/api/workspace/layout/reset');
    ws.data = { ...ws.data, layout }; ws.subs.forEach(f => f(ws.data)); bus.emit(); toast({ msg: 'Default layout restored' }); onClose();
  };
  return html`<${Modal} title="Customize your dashboard" onClose=${onClose} wide>
    <p class="small muted">Only for you: your layout is saved with your dashboard and follows you to your other devices. Teammates never see it.</p>
    <div class="customize-grid">
      <section><h4>Today page</h4>
        <${OrderList} items=${l.home.order} hidden=${l.home.hidden} labels=${HOME_LABELS} available=${availableHome}
          onChange=${(order, hidden) => setL({ ...l, home: { order, hidden } })} /></section>
      <section><h4>Sidebar</h4>
        <p class="small muted" style="margin:0 0 6px">Today and Settings are always there.</p>
        <${OrderList} items=${l.nav.order} hidden=${l.nav.hidden} labels=${NAV_LABELS} available=${availableNav}
          onChange=${(order, hidden) => setL({ ...l, nav: { order, hidden } })} />
        <h4 style="margin-top:14px">Sites & social accounts</h4>
        <label class="checkline"><input type="checkbox" checked=${l.sites} onChange=${(e) => setL({ ...l, sites: e.target.checked })} />
          <span>Blogging, IPTV, Facebook, Instagram and Pinterest: the Accounts & sites settings and their routine types</span></label>
      </section>
    </div>
    <div class="row" style="margin-top:14px"><button class="btn sm" type="button" onClick=${reset}>Reset to default</button><span class="spacer"></span>
      <button class="btn" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy} onClick=${save}>Save layout</button></div>
  <//>`;
}

// ---------- Calendar (next two weeks) ----------
export function CalendarSection() {
  const { data } = useResource('/api/agenda?days=14');
  if (!data) return html`<section class="section card cal-section" aria-label="Calendar"><h3>Calendar</h3><p class="muted small">Loading…</p></section>`;
  return html`<section class="section card cal-section" aria-labelledby="cal-h">
    <div class="row"><h3 id="cal-h">Calendar</h3><span class="muted small">next 2 weeks</span><span class="spacer"></span>
      ${data.overdue > 0 && html`<${Chip} color="pink">${data.overdue} overdue<//>`}</div>
    ${data.days.length === 0 && data.months.length === 0 ? html`<p class="small muted">Nothing scheduled. Give a task a date (Quick Add, or plan a project) and it shows here.</p>`
      : html`<ul class="cal-list">${data.days.map(d => html`<li key=${d.date}>
          <span class=${'cal-day' + (d.date === data.today ? ' today' : '')}>${d.date === data.today ? 'Today' : d.date === addDays(data.today, 1) ? 'Tomorrow' : fmtShort(d.date)}</span>
          <div class="cal-items">${d.tasks.map(t => html`<a class="cal-item" key=${'t' + t.id} href=${'#/today?date=' + d.date}>${t.category_color && html`<i class=${'dot-c ' + t.category_color}></i>`}${firstLine(t.title)}${t.repeat && html` <span class="muted" title=${'Repeats ' + t.repeat}>↻</span>`}</a>`)}
            ${d.projects.map(p => html`<a class="cal-item proj" key=${'p' + p.id} href="#/projects"><${Icon} name="projects" size=${13} />${p.name}</a>`)}</div></li>`)}
          ${data.months.map(p => html`<li key=${'m' + p.id}><span class="cal-day">${p.planned_for}</span><div class="cal-items"><a class="cal-item proj" href="#/projects"><${Icon} name="projects" size=${13} />${p.name} <span class="muted">(this month)</span></a></div></li>`)}</ul>`}
  </section>`;
}

// ---------- Projects (in progress and next actions) ----------
export function ProjectsSection() {
  const { data } = useResource('/api/projects');
  const { data: boot } = useResource('/api/bootstrap');
  if (!data) return null;
  const active = data.filter(p => p.status === 'in_progress' || p.status === 'planned_date').slice(0, 5);
  return html`<section class="section card proj-section" aria-labelledby="proj-h">
    <div class="row"><h3 id="proj-h">Projects</h3><span class="spacer"></span><a class="link-btn small" href="#/projects">All projects →</a></div>
    ${active.length === 0 ? html`<p class="small muted">No project in progress. <a href="#/projects">Start one</a>.</p>`
      : html`<ul class="proj-mini">${active.map(p => html`<li key=${p.id}>
          <div><strong>${p.name}</strong> ${boot && html`<${CatChip} cats=${boot.categories} id=${p.category_id} />`}
            ${p.next_action && html`<div class="small muted">Next: ${p.next_action}</div>`}</div>
          ${p.progress.total > 0 && html`<span class="small muted">${p.progress.done}/${p.progress.total}</span>`}</li>`)}</ul>`}
  </section>`;
}

// ---------- Quick Add (from any page: the + button or the “q” key) ----------
export const REPEAT_LABELS = [['', 'Doesn’t repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week'], ['monthly', 'Every month']];
export function QuickAdd() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e) => {
      if (e.key !== 'q' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.modal-back, [role=dialog]:not([popover]), [popover]:popover-open')) return;
      e.preventDefault(); setOpen(true);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  return open ? html`<${QuickAddModal} onClose=${() => setOpen(false)} />` : null;
}
function QuickAddModal({ onClose }) {
  const { data: boot } = useResource('/api/bootstrap');
  const [f, set] = useState({ title: '', date: '', cat: '', repeat: '', subtasks: '' });
  const [busy, setBusy] = useState(false);
  const ref = useRef();
  useEffect(() => { setTimeout(() => ref.current && ref.current.focus(), 30); }, []);
  const today = boot && boot.today;
  const submit = async (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    setBusy(true);
    try {
      await api('POST', '/api/todos', { title: f.title.trim(), date: f.date || today, category_name: f.cat.trim(), repeat: f.repeat, subtasks: subtaskTitles(f.subtasks) });
      bus.emit();
      toast({ msg: `Added${f.date && f.date !== today ? ' for ' + fmtShort(f.date) : ''}: ${firstLine(f.title).slice(0, 50)}` });
      onClose();
    } catch (err) { toast({ msg: err.message, kind: 'error' }); setBusy(false); }
  };
  return html`<${Modal} title="Quick add a task" onClose=${onClose}>
    <form class="stack" onSubmit=${submit}>
      <label class="field">Task<input ref=${ref} type="text" maxlength="1000" required value=${f.title} onInput=${(e) => set({ ...f, title: e.target.value })} placeholder="e.g. Hand in the essay" /></label>
      <div class="grid2">
        <label class="field">Date<${DateField} value=${f.date || today || ''} onInput=${(e) => set({ ...f, date: e.target.value })} /></label>
        <label class="field">Repeat<${Select} value=${f.repeat} onChange=${(e) => set({ ...f, repeat: e.target.value })}>${REPEAT_LABELS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}<//></label>
      </div>
      <${CategoryInput} value=${f.cat} onInput=${(v) => set({ ...f, cat: v })} cats=${boot && boot.categories} />
      <${SubtaskDraft} value=${f.subtasks} onInput=${subtasks => set({ ...f, subtasks })} />
      ${f.repeat && html`<p class="small muted">When you mark it done, the next one is scheduled automatically.</p>`}
      <div class="row"><span class="small muted">Tip: press <kbd>q</kbd> on any page.</span><span class="spacer"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy || !f.title.trim()}>Add task</button></div>
    </form>
  <//>`;
}

// ---------- Saved views ----------
const RANGES = [['week', 'Due this week'], ['today', 'Due today (incl. overdue)'], ['overdue', 'Overdue'], ['later', 'Later'], ['all', 'All open tasks']];
export function Views() {
  const w = useWorkspace();
  const { data: boot } = useResource('/api/bootstrap');
  const builtIn = [{ id: 'b-week', name: 'Due this week', range: 'week' }, { id: 'b-overdue', name: 'Overdue', range: 'overdue' },
    ...(window.__dash && window.__dash.rpc ? [{ id: 'b-team', name: 'My team tasks', team: true }] : [])];
  const custom = (w && w.layout.views) || [];
  const all = [...builtIn, ...custom];
  const [sel, setSel] = useState(() => (/[?&]v=([\w-]+)/.exec(location.hash) || [])[1] || 'b-week');
  const [adding, setAdding] = useState(false);
  const view = all.find(v => v.id === sel) || all[0];
  const remove = async (v) => { if (!confirm(`Remove the view “${v.name}”?`)) return; await saveLayout({ views: custom.filter(x => x.id !== v.id) }); setSel('b-week'); };
  return html`<div>
    <header class="page-head"><h1>Saved views</h1><span class="muted">Your tasks, filtered. Only you see these.</span></header>
    <div class="row wrap views-tabs" role="tablist">${all.map(v => html`<button role="tab" aria-selected=${v.id === view.id} class=${'btn sm' + (v.id === view.id ? ' primary' : '')} onClick=${() => setSel(v.id)}>${v.name}</button>`)}
      <button class="btn sm" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} />New view</button></div>
    ${view.team ? html`<${TeamTasksView} />` : html`<${TaskView} v=${view} cats=${boot && boot.categories} onRemove=${custom.includes(view) ? () => remove(view) : null} />`}
    ${adding && html`<${NewView} cats=${boot && boot.categories} custom=${custom} onClose=${(id) => { setAdding(false); if (id) setSel(id); }} />`}
  </div>`;
}
function TaskView({ v, cats, onRemove }) {
  const { data } = useResource(`/api/views/tasks?range=${v.range}${v.category_id ? '&category_id=' + v.category_id : ''}`);
  return html`<section class="section">
    <div class="row"><p class="small muted" style="margin:0">${(RANGES.find(r => r[0] === v.range) || [, ''])[1]}${v.category_id ? ' · ' + (catName(cats, v.category_id) || 'a deleted category') : ''}</p>
      <span class="spacer"></span>${onRemove && html`<button class="btn sm" onClick=${onRemove}>Remove view</button>`}</div>
    ${!data ? html`<p class="muted">Loading…</p>` : data.length === 0 ? html`<${Empty} title="Nothing here" />`
      : html`<ul class="view-list">${data.map(t => html`<li key=${t.id}><a href=${'#/today?date=' + t.date}>${firstLine(t.title)}</a>
          <span class="spacer"></span>${t.category_name && html`<${Chip} color=${t.category_color}>${t.category_name}<//>`}
          ${t.repeat && html`<span class="muted small" title=${'Repeats ' + t.repeat}>↻</span>`}<span class="small muted">${fmtShort(t.date)}</span></li>`)}</ul>`}
  </section>`;
}
function TeamTasksView() {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => { window.__dash.rpc('my_team_tasks', {}).then(d => setState({ data: d }), e => setState({ error: e.message })); }, []);
  const { data, error } = state;
  return html`<section class="section"><p class="small muted">Open tasks assigned to you in your teams.</p>
    ${error ? html`<p class="notice">${error}</p>` : !data ? html`<p class="muted">Loading…</p>` : data.length === 0 ? html`<${Empty} title="No team tasks assigned to you" />`
      : html`<ul class="view-list">${data.map(k => html`<li key=${k.id}><a href=${'#/teams/' + k.team_id}>${firstLine(k.title)}</a><span class="spacer"></span>
          ${k.category && html`<${Chip} color=${k.category.color}>${k.category.name}<//>`}<span class="small muted">${k.team_name}${k.due_date ? ' · ' + fmtShort(k.due_date) : ''}</span></li>`)}</ul>`}
  </section>`;
}
function NewView({ cats, custom, onClose }) {
  const [f, set] = useState({ name: '', range: 'week', category_id: '' });
  const save = async (e) => {
    e.preventDefault();
    const id = 'v-' + Date.now().toString(36);
    try { await saveLayout({ views: [...custom, { id, name: f.name.trim(), range: f.range, category_id: f.category_id ? +f.category_id : null }] }); onClose(id); }
    catch (err) { toast({ msg: err.message, kind: 'error' }); }
  };
  return html`<${Modal} title="New saved view" onClose=${() => onClose(null)}>
    <form class="stack" onSubmit=${save}>
      <label class="field">Name<input type="text" maxlength="60" required value=${f.name} onInput=${(e) => set({ ...f, name: e.target.value })} placeholder="e.g. Exams" /></label>
      <div class="grid2">
        <label class="field">When<${Select} value=${f.range} onChange=${(e) => set({ ...f, range: e.target.value })}>${RANGES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}<//></label>
        <label class="field">Category<${Select} value=${f.category_id} onChange=${(e) => set({ ...f, category_id: e.target.value })}><option value="">Any</option>
          ${(cats || []).filter(c => !c.archived).map(c => html`<option value=${c.id}>${c.name}</option>`)}<//></label>
      </div>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${() => onClose(null)}>Cancel</button><button class="btn primary" disabled=${!f.name.trim()}>Save view</button></div>
    </form>
  <//>`;
}
