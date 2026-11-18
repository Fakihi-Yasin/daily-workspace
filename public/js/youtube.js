// YouTube: channels and a simple video pipeline. Only published videos count as publications.
import { html, useState, useResource, act, toast, Icon, Chip, Modal, Empty, fmtShort, addDays } from './lib.js';

const STAGES = [['idea', 'Idea'], ['script', 'Script'], ['recording', 'Recording'], ['editing', 'Editing'], ['published', 'Published']];

export function YouTube() {
  const { data: videos } = useResource('/api/videos');
  const { data: boot } = useResource('/api/bootstrap');
  const [edit, setEdit] = useState(null);
  const [chan, setChan] = useState('');
  if (!videos || !boot) return html`<p class="muted">Loading…</p>`;
  const channels = boot.assets.filter(a => a.kind === 'youtube' && a.status !== 'archived');
  const month = boot.today.slice(0, 7);
  const pubMonth = videos.filter(v => v.stage === 'published' && v.published_date.startsWith(month)).length;
  const move = async (v, dir) => {
    const i = STAGES.findIndex(s => s[0] === v.stage) + dir;
    if (i < 0 || i >= STAGES.length) return;
    if (STAGES[i][0] === 'published') return setEdit({ ...v, stage: 'published', published_date: boot.today });
    await act('PUT', `/api/videos/${v.id}`, { stage: STAGES[i][0] });
  };
  return html`<div>
    <header class="page-head"><h1>YouTube</h1><span class="muted" style="margin-bottom:6px">${pubMonth} video${pubMonth === 1 ? '' : 's'} published this month</span><span class="spacer"></span>
      ${channels.length > 0 && html`<button class="btn primary" onClick=${() => setEdit({ channel_id: channels[0].id, title: '', stage: 'idea', planned_date: '', url: '', notes: '' })}><${Icon} name="plus" size=${16} />New video</button>`}</header>
    <div class="row wrap" style="margin-bottom:16px">
      ${channels.map(c => html`<${Chip} color="pink">${c.name}</${Chip}>`)}
      <form class="row" onSubmit=${async (e) => { e.preventDefault(); if (!chan.trim()) return; await act('POST', '/api/assets', { kind: 'youtube', name: chan, from_date: boot.today }); setChan(''); toast({ msg: 'Channel added' }); }}>
        <input type="text" value=${chan} onInput=${(e) => setChan(e.target.value)} placeholder="New channel" aria-label="New channel name" style="width:200px" /><button class="btn sm">Add</button>
      </form>
    </div>
    ${!channels.length ? html`<${Empty} title="No channel">Add a channel to track your videos. Recurring publishing goals are set in Settings → Routines (Counter type, “YouTube videos”).</${Empty}>`
      : html`<div class="kanban">${STAGES.map(([k, l]) => {
        const list = videos.filter(v => v.stage === k);
        return html`<section class="kcol" aria-label=${l}><h4>${l}<span class="muted small">${list.length}</span></h4>
          ${list.map(v => html`<div class="kcard">
            <span class="t" role="button" tabindex="0" onClick=${() => setEdit(v)} onKeyDown=${(e) => e.key === 'Enter' && setEdit(v)}>${v.title}</span>
            <span class="small muted">${v.channel_name}${v.stage === 'published' ? ' · published ' + fmtShort(v.published_date) : v.planned_date ? ' · planned ' + fmtShort(v.planned_date) : ''}</span>
            ${v.url && html`<a class="small" href=${v.url} target="_blank" rel="noopener noreferrer">Watch video</a>`}
            <div class="row">
              <button class="icon-btn" aria-label="Previous stage" disabled=${k === 'idea'} onClick=${() => move(v, -1)}><${Icon} name="chevL" size=${16} /></button>
              <span class="spacer"></span>
              <button class="icon-btn" aria-label="Next stage" disabled=${k === 'published'} onClick=${() => move(v, 1)}><${Icon} name="chevR" size=${16} /></button>
            </div>
          </div>`)}
        </section>`;
      })}</div>`}
    ${edit && html`<${VideoForm} v=${edit} channels=${channels} today=${boot.today} onClose=${() => setEdit(null)} />`}
  </div>`;
}

function VideoForm({ v, channels, today, onClose }) {
  const [f, setF] = useState({ ...v, published_date: v.published_date || today });
  const set = (p) => setF(x => ({ ...x, ...p }));
  const save = async (e) => {
    e.preventDefault();
    if (v.id) await act('PUT', `/api/videos/${v.id}`, f); else await act('POST', '/api/videos', f);
    toast({ msg: f.stage === 'published' ? 'Video published — counted in stats' : 'Video saved' });
    onClose();
  };
  return html`<${Modal} title=${v.id ? 'Video' : 'New video'} onClose=${onClose}>
    <form class="stack" onSubmit=${save}>
      <label class="field">Title<input type="text" required value=${f.title} onInput=${(e) => set({ title: e.target.value })} /></label>
      <label class="field">Channel<select value=${f.channel_id} onChange=${(e) => set({ channel_id: +e.target.value })}>${channels.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></label>
      <fieldset><legend>Stage</legend><div class="seg">${STAGES.map(([k, l]) => html`<button type="button" class=${f.stage === k ? 'on' : ''} onClick=${() => set({ stage: k })}>${l}</button>`)}</div></fieldset>
      ${f.stage === 'published'
        ? html`<div class="grid2"><label class="field">Publish date<input type="date" max=${addDays(today, 0)} value=${f.published_date} onInput=${(e) => set({ published_date: e.target.value })} required /></label>
            <label class="field">URL<input type="url" value=${f.url} onInput=${(e) => set({ url: e.target.value })} placeholder="https://youtube.com/…" /></label></div>`
        : html`<label class="field">Planned publish date (optional)<input type="date" value=${f.planned_date} onInput=${(e) => set({ planned_date: e.target.value })} /></label>`}
      <label class="field">Notes<textarea value=${f.notes} onInput=${(e) => set({ notes: e.target.value })} /></label>
      <div class="form-actions">
        ${v.id && html`<button type="button" class="btn ghost danger" onClick=${async () => { await act('DELETE', `/api/videos/${v.id}`); onClose(); }}>Delete</button>`}
        <span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Save</button>
      </div>
    </form>
  </${Modal}>`;
}
