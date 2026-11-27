import { DateField } from './controls.js';
// Challenges: goals computed from what is already checked in "Today".
import { html, useState, useResource, act, toast, Icon, Bar, Ring, Chip, Modal, Empty, fmtDay, fmtShort, addDays, DAYS, DAY_NAMES, pct } from './lib.js';

const PERIOD = { day: 'per day', week: 'per week', total: 'over the whole challenge' };

export function Challenges() {
  const { data } = useResource('/api/challenges');
  const [creating, setCreating] = useState(false);
  if (!data) return html`<p class="muted">Loading…</p>`;
  const active = data.filter(c => !c.archived);
  const archived = data.filter(c => c.archived);
  return html`<div>
    <header class="page-head"><h1>Challenges</h1><span class="spacer"></span>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${16} />Create a challenge</button></header>
    <p class="muted" style="margin:-10px 0 18px">Progress comes from what you already check in Today — nothing to log twice.</p>
    ${!active.length && html`<${Empty} title="No active challenge">Pick activities you already track and set goals over a month.</${Empty}>`}
    <div class="stack">${active.map(c => html`<${ChallengeCard} key=${c.id} c=${c} />`)}</div>
    ${archived.length > 0 && html`<details class="section"><summary style="cursor:pointer;font-weight:650">Archived (${archived.length})</summary>
      <div class="stack" style="margin-top:12px">${archived.map(c => html`<${ChallengeCard} key=${c.id} c=${c} />`)}</div></details>`}
    ${creating && html`<${CreateChallenge} onClose=${() => setCreating(false)} />`}
  </div>`;
}

function ChallengeCard({ c }) {
  const [confirm, setConfirm] = useState(false);
  const state = { upcoming: 'Upcoming', active: `Day ${c.day}/${c.total_days}`, ended: 'Ended' }[c.state];
  return html`<section class="card" aria-label=${c.name}>
    <div class="row wrap" style="gap:16px;align-items:center">
      <${Ring} value=${c.overall} size=${76} stroke=${8}><span style="font-size:19px">${Math.round(c.overall)}%</span></${Ring}>
      <div style="flex:1;min-width:200px">
        <h2>${c.name}</h2>
        <p class="muted small" style="margin-top:4px">${fmtDay(c.start_date, { day: 'numeric', month: 'short' })} → ${fmtDay(c.end_date, { day: 'numeric', month: 'short', year: 'numeric' })} · <${Chip} color=${c.state === 'active' ? 'blue' : 'ink'}>${state}</${Chip}></p>
        <p class="small" style="margin-top:4px">Overall score = average of the ${c.goals.length} goals (each capped at 100%).</p>
      </div>
      <div class="row">
        <button class="btn sm" onClick=${() => act('PUT', `/api/challenges/${c.id}`, { archived: !c.archived })}>${c.archived ? 'Unarchive' : 'Archive'}</button>
        ${confirm ? html`<button class="btn sm danger" onClick=${() => act('DELETE', `/api/challenges/${c.id}`)}>Confirm</button><button class="btn sm" onClick=${() => setConfirm(false)}>Non</button>`
          : html`<button class="btn sm ghost danger" onClick=${() => setConfirm(true)}>Delete</button>`}
      </div>
    </div>
    ${c.off_days > 0 && html`<p class="notice" style="margin-top:12px">Focus prompts were off ${c.off_days} day(s) during this challenge. Focus goals are not adjusted automatically; other goals are not affected.</p>`}
    <div style="margin-top:12px">${c.goals.map(g => html`<div class="goal">
      <div>
        <strong>${g.label}</strong>
        <div class="small muted">${g.target} ${PERIOD[g.period]}${g.per_asset ? ' and per account' : ''}${g.period === 'day' && g.days.length < 7 ? ' (' + DAYS.filter(([d]) => g.days.includes(d)).map(([d]) => DAY_NAMES[d]).join(' ') + ')' : ''}
          ${g.assets.length > 0 && html` · fixed accounts: ${g.assets.map(a => a.name).join(', ')}`}</div>
      </div>
      <div class="num" style="text-align:right"><strong>${pct(g.pct)}</strong><div class="small muted">${g.achieved}/${g.target_total}${g.actual > g.achieved ? ` · ${g.actual} actual` : ''}</div></div>
      <div style="grid-column:1/-1"><${Bar} value=${g.pct} color="blue" label=${g.label} /></div>
      ${g.pace != null && c.state === 'active' && html`<div class="small muted" style="grid-column:1/-1">Pace to date: ${pct(g.pace)} of what was planned so far.</div>`}
      ${g.breakdown.length > 0 && html`<details style="grid-column:1/-1"><summary class="small" style="cursor:pointer">Per-account detail</summary>
        ${g.breakdown.map(b => html`<div class="hbar"><span class="name">${g.assets.find(a => a.id === b.asset_id)?.name || '?'}</span><${Bar} value=${(b.achieved / b.target) * 100} thin /><span class="v">${b.achieved}/${b.target}</span></div>`)}</details>`}
    </div>`)}</div>
  </section>`;
}

function defaultGoal(r) {
  if (r.type === 'counter') {
    const metric = { pin: 'pin', article: 'article', youtube: 'youtube' }[r.unit] || 'unit';
    return { metric, period: 'day', per_asset: r.assets.length > 0, target: r.target || 1, days: r.days };
  }
  if (r.type === 'social') return { metric: 'publication', period: 'day', per_asset: false, target: Math.max(1, r.videosPerDay * Math.max(1, r.assets.length)), days: r.days };
  return { metric: 'routine_done', period: 'day', per_asset: false, target: 1, days: r.days };
}

const EXTRA = [
  { key: 'coding_sessions', label: 'Focus sessions', period: 'week', target: 3 },
  { key: 'coding_minutes', label: 'Focus minutes', period: 'week', target: 600 },
  { key: 'study_minutes', label: 'Study minutes', period: 'week', target: 120 },
  { key: 'milestones', label: 'Project milestones completed', period: 'total', target: 5 },
];

function CreateChallenge({ onClose }) {
  const { data: opts } = useResource('/api/challenges/options');
  const [name, setName] = useState('Monthly challenge');
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState('');
  const [sel, setSel] = useState({}); // key -> goal config
  if (!opts) return html`<${Modal} title="Create a challenge" onClose=${onClose}><p class="muted">Loading…</p></${Modal}>`;
  const s = start || opts.today;
  const defEnd = (() => { const d = new Date(s + 'T12:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return addDays(d.toISOString().slice(0, 10), -1); })();
  const toggle = (key, init) => setSel(x => { const n = { ...x }; if (n[key]) delete n[key]; else n[key] = init; return n; });
  const upd = (key, patch) => setSel(x => ({ ...x, [key]: { ...x[key], ...patch } }));
  const goals = Object.entries(sel).map(([key, g]) => {
    const label = g.label || `${g.target} ${g.name.toLowerCase()} ${PERIOD[g.period]}${g.per_asset ? ' / account' : ''}`;
    return { ...g, label, asset_ids: g.asset_ids && g.asset_ids.length ? g.asset_ids : null };
  });
  const create = async (e) => {
    e.preventDefault();
    if (!goals.length) return toast({ msg: 'Pick at least one activity', kind: 'error' });
    await act('POST', '/api/challenges', { name, start_date: s, end_date: end || undefined, goals });
    toast({ msg: 'Challenge created' }); onClose();
  };
  const routines = opts.routines.filter(r => r.status === 'active');
  return html`<${Modal} title="Create a challenge" onClose=${onClose} wide>
    <form class="stack" onSubmit=${create}>
      <div class="row wrap" style="align-items:flex-end">
        <label class="field" style="flex:1;min-width:220px">Name<input type="text" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <label class="field">Start<${DateField} aria-label="Start" value=${s} onInput=${(e) => setStart(e.target.value)} /></label>
        <label class="field">End<${DateField} aria-label="End" min=${s} value=${end || defEnd} onInput=${(e) => setEnd(e.target.value)} /></label>
      </div>
      <p class="hint">Default: one month. Checked accounts are fixed: an account added later does not change this challenge.</p>
      <h3>Tracked activities</h3>
      ${routines.map(r => {
        const key = 'r' + r.id;
        const g = sel[key];
        return html`<div class="card flat stack" style="padding:14px">
          <label class="checkline"><input type="checkbox" checked=${!!g} onChange=${() => toggle(key, { ...defaultGoal(r), name: r.name, routine_id: r.type === 'counter' && r.unit !== 'unit' ? null : r.id, asset_ids: r.assets.map(a => a.id) })} />
            <strong>${r.name}</strong><span class="muted small">${r.category}</span></label>
          ${g && html`<${GoalFields} g=${g} set=${(p) => upd(key, p)} assets=${r.assets} social=${r.type === 'social'} />`}
        </div>`;
      })}
      ${opts.youtube.length > 0 && html`<div class="card flat stack" style="padding:14px">
        <label class="checkline"><input type="checkbox" checked=${!!sel.yt} onChange=${() => toggle('yt', { metric: 'youtube', name: 'YouTube videos', period: 'week', target: 1, per_asset: false, asset_ids: opts.youtube.map(a => a.id) })} /><strong>YouTube videos published</strong></label>
        ${sel.yt && html`<${GoalFields} g=${sel.yt} set=${(p) => upd('yt', p)} assets=${opts.youtube} />`}
      </div>`}
      ${EXTRA.map(x => html`<div class="card flat stack" style="padding:14px">
        <label class="checkline"><input type="checkbox" checked=${!!sel[x.key]} onChange=${() => toggle(x.key, { metric: x.key, name: x.label, period: x.period, target: x.target, per_asset: false, asset_ids: x.key.startsWith('coding') ? [] : null })} /><strong>${x.label}</strong></label>
        ${sel[x.key] && html`<${GoalFields} g=${sel[x.key]} set=${(p) => upd(x.key, p)} assets=${x.key.startsWith('coding') ? opts.categories.map(c => ({ id: c.id, name: c.name })) : []} categories=${x.key.startsWith('coding')} />`}
      </div>`)}
      ${goals.length > 0 && html`<div class="notice blue"><strong>${goals.length} goal(s)</strong>: ${goals.map(g => g.label).join(' · ')}</div>`}
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Create challenge</button></div>
    </form>
  </${Modal}>`;
}

function GoalFields({ g, set, assets, social, categories }) {
  return html`<div class="stack" style="padding-left:26px">
    ${social && html`<div class="seg"><button type="button" class=${g.metric === 'publication' ? 'on' : ''} onClick=${() => set({ metric: 'publication' })}>Publications</button>
      <button type="button" class=${g.metric === 'video' ? 'on' : ''} onClick=${() => set({ metric: 'video', per_asset: false })}>Videos produced</button></div>`}
    <div class="row wrap" style="align-items:center">
      <input type="number" min="1" value=${g.target} onInput=${(e) => set({ target: +e.target.value })} aria-label="Target" />
      <div class="seg">${Object.entries(PERIOD).map(([k, l]) => html`<button type="button" class=${g.period === k ? 'on' : ''} onClick=${() => set({ period: k })}>${l}</button>`)}</div>
      ${assets.length > 0 && !categories && g.metric !== 'video' && html`<label class="checkline"><input type="checkbox" checked=${!!g.per_asset} onChange=${(e) => set({ per_asset: e.target.checked })} />per account</label>`}
    </div>
    ${g.period === 'day' && html`<div class="daypick" aria-label="Counted days">${DAYS.map(([d, l]) => { const on = (g.days || [0, 1, 2, 3, 4, 5, 6]).includes(d); return html`<button type="button" class=${on ? 'on' : ''} aria-pressed=${on} aria-label=${DAY_NAMES[d]} onClick=${() => { const cur = g.days || [0, 1, 2, 3, 4, 5, 6]; set({ days: on ? cur.filter(x => x !== d) : [...cur, d] }); }}>${l}</button>`; })}</div>`}
    ${assets.length > 0 && g.metric !== 'video' && html`<div class="row wrap">${categories && html`<span class="small muted">Categories (none = all):</span>`}
      ${assets.map(a => html`<label class="checkline small"><input type="checkbox" checked=${(g.asset_ids || []).includes(a.id)} onChange=${(e) => set({ asset_ids: e.target.checked ? [...(g.asset_ids || []), a.id] : (g.asset_ids || []).filter(x => x !== a.id) })} />${a.name}</label>`)}</div>`}
  </div>`;
}
