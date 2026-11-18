// Projects and future plans, with milestone-based progress (separate from the daily score).
import { html, useState, useResource, act, toast, Icon, Bar, Chip, Modal, Empty, fmtDay, fmtMonth, fmtDur } from './lib.js';

export const STATUS = { idea: 'Idea', planned: 'Planned, no date', planned_date: 'Planned with date', in_progress: 'In progress', done: 'Done' };
const STATUS_COLOR = { idea: 'pink', planned: 'sky', planned_date: 'yellow', in_progress: 'blue', done: 'mint' };
const TEMPLATES = {
  'Website': ['Domain', 'Design', 'Development', 'Deployment', 'Indexing'],
  'Digital product': ['Idea validated', 'Creation', 'Sales page', 'Launch'],
};
const VIEWS = [['in_progress', 'In progress'], ['later', 'Later'], ['planned_date', 'Scheduled'], ['done', 'Done'], ['all', 'All']];
const inView = (p, v) => v === 'all' || (v === 'later' ? ['idea', 'planned'].includes(p.status) : p.status === v);
// Card badge, named like the status tabs (Later keeps the detail: idea or undated plan).
const statusLabel = (s) => ({ idea: 'Later · Idea', planned: 'Later · No date', planned_date: 'Scheduled', in_progress: 'In progress', done: 'Done' })[s] || s;
const when = (p) => p.planned_for ? (p.planned_for.length === 7 ? 'around ' + fmtMonth(p.planned_for) : fmtDay(p.planned_for, { day: 'numeric', month: 'short', year: 'numeric' })) : '';

export function Projects() {
  const { data: projects } = useResource('/api/projects');
  const { data: cats } = useResource('/api/categories');
  // Two browsing modes: a status tab shows that status across every category (grouped by category);
  // a category button shows every project in that category, whatever its status. Picking one resets the other.
  const [view, setView] = useState('in_progress');
  const [cat, setCat] = useState(null);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  if (!projects || !cats) return html`<p class="muted">Loading…</p>`;
  const catOf = (id) => cats.find(c => c.id === id);
  const pickView = (k) => { setView(k); setCat(null); };
  const pickCat = (id) => { setCat(id); setView('all'); };
  const list = projects.filter(p => inView(p, view) && (!cat || p.category_id === cat));
  const cur = open && projects.find(p => p.id === open);
  const card = (p) => html`<button key=${p.id} class="card pcard" onClick=${() => setOpen(p.id)}>
        <div class="row wrap">${catOf(p.category_id) && html`<${Chip} color=${catOf(p.category_id).color}>${catOf(p.category_id).name}</${Chip}>`}<${Chip} color=${STATUS_COLOR[p.status]} title=${STATUS[p.status]}>${statusLabel(p.status)}</${Chip}></div>
        <h3>${p.name}</h3>
        ${p.topic && html`<p class="muted small" style="margin-top:-6px">${p.topic}${when(p) && ' · ' + when(p)}</p>`}
        ${!p.topic && when(p) && html`<p class="muted small" style="margin-top:-6px">${when(p)}</p>`}
        ${p.milestones.length > 0 && html`<div><div class="steps" aria-hidden="true">${p.milestones.map(m => html`<i class=${m.done ? 'on' : ''}></i>`)}</div>
          <p class="small muted num" style="margin-top:5px">${p.progress.done}/${p.progress.total} milestones · ${p.progress.pct}%</p></div>`}
        ${p.next_action && html`<p class="small"><strong>Next action:</strong> ${p.next_action}</p>`}
      </button>`;
  // Without a category filter, results are grouped under category headings (empty groups hidden).
  const groups = cat ? null : [...cats, { id: null, name: 'No category' }]
    .map(c => ({ c, items: list.filter(p => (p.category_id ?? null) === c.id || (c.id === null && !catOf(p.category_id))) }))
    .filter(g => g.items.length);
  const selCat = cat && catOf(cat);
  return html`<div>
    <header class="page-head"><h1>Projects</h1><span class="spacer"></span>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${16} />New project</button></header>
    <div class="tabs" role="tablist" aria-label="Status">${VIEWS.map(([k, l]) => html`<button role="tab" aria-selected=${view === k} class=${view === k ? 'on' : ''} onClick=${() => pickView(k)}>${l}<span class="count">${projects.filter(p => inView(p, k)).length}</span></button>`)}</div>
    ${view === 'later' && html`<p class="notice blue" style="margin-bottom:14px">Ideas and undated plans: they stay visible here, without fake deadlines.</p>`}
    <div class="row wrap cat-filter" role="group" aria-label="Category" style="margin-bottom:14px">
      <button class=${'btn sm' + (!cat ? ' dark' : '')} aria-pressed=${!cat} onClick=${() => setCat(null)}>All</button>
      ${cats.map(c => html`<button class=${'btn sm' + (cat === c.id ? ' dark' : '')} aria-pressed=${cat === c.id} onClick=${() => pickCat(c.id)}>${c.name}</button>`)}
    </div>
    ${list.length === 0 ? html`<${Empty} title=${selCat ? `No ${selCat.name} projects yet` : 'Nothing here yet'}>${selCat ? 'Use “New project” to plan one.' : 'Add an IPTV country, a blog topic or a digital product.'}</${Empty}>`
      : groups ? groups.map(g => html`<section key=${g.c.id ?? 'none'} class="pgroup" aria-label=${g.c.name}>
          <div class="section-head"><h2 class="pgroup-title">${g.c.name}</h2><span class="muted small num">${g.items.length}</span></div>
          <div class="cards">${g.items.map(card)}</div></section>`)
      : html`<div class="cards">${list.map(card)}</div>`}
    ${creating && html`<${ProjectForm} cats=${cats} onClose=${() => setCreating(false)} />`}
    ${cur && html`<${ProjectDetail} p=${cur} cats=${cats} onClose=${() => setOpen(null)} />`}
  </div>`;
}

// Category picker with "Other" and inline "Create category…" (same categories as Settings → Categories).
const COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky', 'ink'];
function CategoryField({ value, onChange, cats }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('sky');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await act('POST', '/api/categories', { name: name.trim(), color, coding: true });
      onChange(r.id); setCreating(false); setName('');
      toast({ msg: r.existing ? `“${name.trim()}” already exists — selected it` : `Category “${name.trim()}” created` });
    } catch { /* toast shown by act */ } finally { setBusy(false); }
  };
  return html`<div class="field">
    <label for="proj-cat">Category</label>
    ${creating
      ? html`<div class="row wrap">
          <input type="text" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="New category name" aria-label="New category name" style="flex:1;min-width:140px"
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } if (e.key === 'Escape') { e.preventDefault(); setCreating(false); } }} autofocus />
          <select value=${color} onChange=${(e) => setColor(e.target.value)} aria-label="Color" style="width:auto">${COLORS.map(c => html`<option value=${c}>${c}</option>`)}</select>
          <button type="button" class="btn sm primary" disabled=${!name.trim() || busy} onClick=${create}>Create</button>
          <button type="button" class="btn sm" onClick=${() => setCreating(false)}>Cancel</button>
        </div>`
      : html`<select id="proj-cat" value=${value || ''} onChange=${(e) => { if (e.target.value === '__new') { e.target.value = value || ''; setCreating(true); } else onChange(+e.target.value || null); }}>
          <option value="">No category</option>
          ${cats.map(c => html`<option value=${c.id}>${c.name}</option>`)}
          <option value="__new">+ Create category…</option>
        </select>`}
  </div>`;
}

function Fields({ f, set, cats }) {
  return html`<div class="stack">
    <label class="field">Name<input type="text" required value=${f.name} onInput=${(e) => set({ name: e.target.value })} placeholder="e.g. IPTV Belgium" /></label>
    <div class="grid2">
      <${CategoryField} value=${f.category_id} onChange=${(id) => set({ category_id: id })} cats=${cats} />
      <label class="field">Country or topic<input type="text" value=${f.topic} onInput=${(e) => set({ topic: e.target.value })} placeholder="Belgium, recipes, crochet…" /></label>
    </div>
    <fieldset><legend>Status</legend><div class="seg">${Object.entries(STATUS).map(([k, l]) => html`<button type="button" class=${f.status === k ? 'on' : ''} onClick=${() => set({ status: k })}>${l}</button>`)}</div></fieldset>
    ${(f.status === 'planned_date' || f.status === 'in_progress' || f.status === 'done') && html`<div class="row wrap" style="align-items:flex-end">
      <fieldset><legend>Due</legend><div class="seg">
        <button type="button" class=${f.approx ? 'on' : ''} onClick=${() => set({ approx: true, planned_for: (f.planned_for || '').slice(0, 7) })}>Approximate month</button>
        <button type="button" class=${!f.approx ? 'on' : ''} onClick=${() => set({ approx: false })}>Exact date</button></div></fieldset>
      ${f.approx ? html`<input type="month" value=${f.planned_for.slice(0, 7)} onInput=${(e) => set({ planned_for: e.target.value })} aria-label="Month" style="width:auto" />`
        : html`<input type="date" value=${f.planned_for.length === 10 ? f.planned_for : ''} onInput=${(e) => set({ planned_for: e.target.value })} aria-label="Date" style="width:auto" />`}
      ${f.status !== 'planned_date' && html`<span class="hint">optional</span>`}
    </div>`}
    <label class="field">Next action<input type="text" value=${f.next_action} onInput=${(e) => set({ next_action: e.target.value })} /></label>
    <label class="field">Links (one per line)<textarea value=${f.links} onInput=${(e) => set({ links: e.target.value })} style="min-height:60px" /></label>
    <label class="field">Notes<textarea value=${f.notes} onInput=${(e) => set({ notes: e.target.value })} /></label>
  </div>`;
}

const toForm = (p) => ({ name: p.name || '', category_id: p.category_id || null, topic: p.topic || '', status: p.status || 'idea', planned_for: p.planned_for || '',
  approx: p.planned_for ? p.planned_for.length === 7 : true, next_action: p.next_action || '', links: (p.links || []).join('\n'), notes: p.notes || '' });
const toBody = (f) => ({ ...f, links: f.links.split('\n').map(s => s.trim()).filter(Boolean), planned_for: f.planned_for });

function ProjectForm({ cats, onClose }) {
  const [f, setF] = useState(toForm({ category_id: cats[0] && cats[0].id }));
  const [tpl, setTpl] = useState('Website');
  const set = (p) => setF(x => ({ ...x, ...p }));
  return html`<${Modal} title="New project" onClose=${onClose} wide>
    <form onSubmit=${async (e) => { e.preventDefault(); await act('POST', '/api/projects', { ...toBody(f), milestones: TEMPLATES[tpl] || [] }); toast({ msg: 'Project created' }); onClose(); }}>
      <${Fields} f=${f} set=${set} cats=${cats} />
      <fieldset style="margin-top:12px"><legend>Starting milestones</legend><div class="seg">
        ${[...Object.keys(TEMPLATES), 'None'].map(k => html`<button type="button" class=${tpl === k ? 'on' : ''} onClick=${() => setTpl(k)}>${k}</button>`)}</div>
        <p class="hint" style="margin-top:6px">${TEMPLATES[tpl] ? TEMPLATES[tpl].join(' → ') : 'You can add milestones later.'} — editable anytime.</p></fieldset>
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Create</button></div>
    </form>
  </${Modal}>`;
}

function ProjectDetail({ p, cats, onClose }) {
  const [f, setF] = useState(toForm(p));
  const [newM, setNewM] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (x) => setF(y => ({ ...y, ...x }));
  const ms = p.milestones;
  const move = async (i, d) => {
    const a = ms[i], b = ms[i + d];
    if (!b) return;
    await act('PUT', `/api/milestones/${a.id}`, { sort: b.sort === a.sort ? b.sort + d : b.sort });
    await act('PUT', `/api/milestones/${b.id}`, { sort: a.sort });
  };
  return html`<${Modal} title=${p.name} onClose=${onClose} wide>
    <div class="stack">
      <div class="card flat">
        <div class="row"><h3 style="flex:1">Project progress</h3><strong class="num">${p.progress.total ? p.progress.pct + '%' : '—'}</strong></div>
        <div style="margin:8px 0 12px"><${Bar} value=${p.progress.pct || 0} color="mint" label="Project progress" /></div>
        <div class="mlist">${ms.map((m, i) => html`<div key=${m.id} class=${'mrow' + (m.done ? ' done' : '')}>
          <input type="checkbox" class="checkline" style="width:18px;height:18px;accent-color:var(--blue)" checked=${!!m.done} aria-label=${'Milestone done: ' + m.title}
            onChange=${(e) => act('PUT', `/api/milestones/${m.id}`, { done: e.target.checked })} />
          <input type="text" value=${m.title} aria-label="Milestone name" onBlur=${(e) => e.target.value !== m.title && act('PUT', `/api/milestones/${m.id}`, { title: e.target.value })} />
          ${m.done_at && html`<span class="small muted" style="white-space:nowrap">${fmtDay(m.done_at, { day: 'numeric', month: 'short' })}</span>`}
          <button class="icon-btn" aria-label="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}><${Icon} name="up" size=${15} /></button>
          <button class="icon-btn" aria-label="Move down" disabled=${i === ms.length - 1} onClick=${() => move(i, 1)}><${Icon} name="down" size=${15} /></button>
          <button class="icon-btn" aria-label="Delete milestone" onClick=${() => act('DELETE', `/api/milestones/${m.id}`)}><${Icon} name="x" size=${15} /></button>
        </div>`)}</div>
        <form class="row" style="margin-top:8px" onSubmit=${async (e) => { e.preventDefault(); if (!newM.trim()) return; await act('POST', `/api/projects/${p.id}/milestones`, { title: newM }); setNewM(''); }}>
          <input type="text" value=${newM} onInput=${(e) => setNewM(e.target.value)} placeholder="New milestone" aria-label="New milestone" /><button class="btn">Add</button>
        </form>
        ${p.coding_sec > 0 && html`<p class="small muted" style="margin-top:10px">Coding time on this project: ${fmtDur(p.coding_sec)}</p>`}
      </div>
      <form onSubmit=${async (e) => { e.preventDefault(); await act('PUT', `/api/projects/${p.id}`, toBody(f)); toast({ msg: 'Project saved' }); }}>
        <${Fields} f=${f} set=${set} cats=${cats} />
        ${p.links.length > 0 && html`<div class="row wrap" style="margin-top:8px">${p.links.map(l => html`<a class="btn sm" href=${l} target="_blank" rel="noopener noreferrer"><${Icon} name="link" size=${14} />${l.replace(/^https?:\/\//, '').slice(0, 40)}</a>`)}</div>`}
        <div class="form-actions">
          ${confirmDel ? html`<span class="small">Delete permanently?</span><button type="button" class="btn danger" onClick=${async () => { await act('DELETE', `/api/projects/${p.id}`); onClose(); }}>Yes, delete</button><button type="button" class="btn" onClick=${() => setConfirmDel(false)}>No</button>`
            : html`<button type="button" class="btn ghost danger" onClick=${() => setConfirmDel(true)}>Delete</button>`}
          <span class="spacer"></span>
          <button class="btn primary">Save</button>
        </div>
      </form>
    </div>
  </${Modal}>`;
}
