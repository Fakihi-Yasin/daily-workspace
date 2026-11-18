// Formation: courses / skills, modules, optional study time (separate from coding time).
import { html, useState, useResource, act, toast, Icon, Bar, Chip, Modal, Empty, fmtDur, fmtShort } from './lib.js';

export function Formation() {
  const { data } = useResource('/api/courses');
  const [creating, setCreating] = useState(false);
  if (!data) return html`<p class="muted">Loading…</p>`;
  const total = data.reduce((s, c) => s + c.study_minutes, 0);
  return html`<div>
    <header class="page-head"><h1>Learning</h1><span class="muted" style="margin-bottom:6px">${fmtDur(total * 60)} of study in total</span><span class="spacer"></span>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${16} />New course</button></header>
    ${!data.length ? html`<${Empty} title="No courses or skills">Add a course and split it into modules to track your progress.</${Empty}>`
      : html`<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">${data.map(c => html`<${Course} key=${c.id} c=${c} />`)}</div>`}
    ${creating && html`<${CourseForm} onClose=${() => setCreating(false)} />`}
  </div>`;
}

function Course({ c }) {
  const [m, setM] = useState('');
  const [min, setMin] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  return html`<section class="card stack" aria-label=${c.name}>
    <div class="row"><h3 style="flex:1">${c.name}</h3><${Chip} color=${c.kind === 'skill' ? 'mint' : 'sky'}>${c.kind === 'skill' ? 'Skill' : 'Course'}</${Chip}>
      <select value=${c.status} aria-label="Status" style="width:auto;min-height:30px;padding:2px 6px" onChange=${(e) => act('PUT', `/api/courses/${c.id}`, { status: e.target.value })}>
        <option value="active">In progress</option><option value="paused">Paused</option><option value="done">Done</option></select></div>
    ${c.link && html`<a class="small" href=${c.link} target="_blank" rel="noopener noreferrer">${c.link.replace(/^https?:\/\//, '').slice(0, 50)}</a>`}
    <div><div class="row small"><span class="muted">${c.progress.done}/${c.progress.total} modules completed</span><span class="spacer"></span><strong class="num">${c.progress.total ? c.progress.pct + '%' : '—'}</strong></div>
      <div style="margin-top:6px"><${Bar} value=${c.progress.pct || 0} color="mint" label=${'Progress ' + c.name} /></div></div>
    <div class="mlist">${c.modules.map(x => html`<label key=${x.id} class=${'mrow checkline' + (x.done ? ' done' : '')}>
      <input type="checkbox" checked=${!!x.done} onChange=${(e) => act('PUT', `/api/modules/${x.id}`, { done: e.target.checked })} />
      <span style=${{ flex: 1, textDecoration: x.done ? 'line-through' : 'none', color: x.done ? 'var(--muted)' : 'inherit' }}>${x.title}</span>
      <button class="icon-btn" aria-label=${'Delete ' + x.title} onClick=${(e) => { e.preventDefault(); act('DELETE', `/api/modules/${x.id}`); }}><${Icon} name="x" size=${14} /></button>
    </label>`)}</div>
    <form class="row" onSubmit=${async (e) => { e.preventDefault(); if (!m.trim()) return; await act('POST', `/api/courses/${c.id}/modules`, { title: m }); setM(''); }}>
      <input type="text" value=${m} onInput=${(e) => setM(e.target.value)} placeholder="New module" aria-label="New module" /><button class="btn sm">Add</button></form>
    <div class="card flat" style="padding:12px;background:var(--surface)">
      <div class="row"><strong>Study time</strong><span class="spacer"></span><span class="num">${fmtDur(c.study_minutes * 60)}</span></div>
      <form class="row" style="margin-top:8px" onSubmit=${async (e) => { e.preventDefault(); if (!(+min > 0)) return; await act('POST', `/api/courses/${c.id}/study`, { minutes: +min }); setMin(''); toast({ msg: `${min} min of study logged` }); }}>
        <input type="number" min="1" max="1440" value=${min} onInput=${(e) => setMin(e.target.value)} placeholder="min" aria-label="Minutes studied today" />
        <button class="btn sm">Add today</button>
        ${c.logs.length > 0 && html`<button type="button" class="link-btn small" onClick=${() => setShowLogs(!showLogs)}>${showLogs ? 'Hide' : 'History'}</button>`}
      </form>
      ${showLogs && html`<div class="stack small" style="margin-top:8px">${c.logs.map(l => html`<div class="row"><span>${fmtShort(l.date)}</span><span class="num">${l.minutes} min</span><span class="spacer"></span>
        <button class="icon-btn" aria-label="Delete this entry" onClick=${() => act('DELETE', `/api/study/${l.id}`)}><${Icon} name="x" size=${14} /></button></div>`)}</div>`}
    </div>
  </section>`;
}

function CourseForm({ onClose }) {
  const [f, setF] = useState({ name: '', kind: 'course', link: '', modules: '' });
  const set = (p) => setF(x => ({ ...x, ...p }));
  return html`<${Modal} title="New course or skill" onClose=${onClose}>
    <form class="stack" onSubmit=${async (e) => { e.preventDefault(); await act('POST', '/api/courses', { ...f, modules: f.modules.split('\n') }); toast({ msg: 'Added' }); onClose(); }}>
      <label class="field">Name<input type="text" required value=${f.name} onInput=${(e) => set({ name: e.target.value })} /></label>
      <div class="seg"><button type="button" class=${f.kind === 'course' ? 'on' : ''} onClick=${() => set({ kind: 'course' })}>Course</button><button type="button" class=${f.kind === 'skill' ? 'on' : ''} onClick=${() => set({ kind: 'skill' })}>Skill</button></div>
      <label class="field">Link (optional)<input type="url" value=${f.link} onInput=${(e) => set({ link: e.target.value })} /></label>
      <label class="field">Modules or steps (one per line)<textarea value=${f.modules} onInput=${(e) => set({ modules: e.target.value })} /></label>
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Create</button></div>
    </form>
  </${Modal}>`;
}
