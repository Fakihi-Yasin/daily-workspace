// Settings: accounts & sites, routines (versioned with effective dates), categories, timezone, backup, demo.
import { html, useState, useEffect, useRef, useResource, api, act, bus, toast, Icon, useTheme, THEMES, downloadJson, isBrowserStorage, isCloudStorage, BROWSER_NOTE, CLOUD_NOTE, Chip, Modal, EffectPicker, Empty, fmtDay, fmtShort, addDays,
  KIND_LABELS, KIND_PLURAL, KIND_COLOR, DAYS, DAY_NAMES } from './lib.js';

const TABS = [['assets', 'Accounts & sites'], ['routines', 'Routines'], ['categories', 'Categories'], ['general', 'General'], ['backup', 'Backup'], ['demo', 'Demo']];

export function Settings() {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
    if (q && TABS.some(t => t[0] === q)) return q;
    try { return sessionStorage.getItem('settingsTab') || 'assets'; } catch { return 'assets'; }
  });
  const { data } = useResource('/api/bootstrap');
  const pick = (k) => { setTab(k); sessionStorage.setItem('settingsTab', k); };
  return html`<div>
    <header class="page-head"><h1>Settings</h1></header>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => pick(k)}>${l}</button>`)}</div>
    ${!data ? html`<p class="muted">Loading…</p>`
      : tab === 'assets' ? html`<${Assets} data=${data} />`
      : tab === 'routines' ? html`<${Routines} data=${data} />`
      : tab === 'categories' ? html`<${Categories} data=${data} />`
      : tab === 'general' ? html`<${General} data=${data} />`
      : tab === 'backup' ? html`<${Backup} />`
      : html`<${Demo} />`}
  </div>`;
}

// ---------- Assets ----------
const STATUS_LABEL = { active: 'Active', paused: 'Paused', archived: 'Archived', pending: 'Upcoming' };
const STATUS_COLOR = { active: 'mint', paused: 'yellow', archived: 'ink', pending: 'sky' };

function Assets({ data }) {
  const [kind, setKind] = useState('pinterest');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [from, setFrom] = useState(addDays(data.today, 1));
  const [edit, setEdit] = useState(null);
  const [statusFor, setStatusFor] = useState(null);
  const [del, setDel] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    const r = await act('POST', '/api/assets', { kind, name, url, from_date: from });
    toast({ msg: `${name} added · active ${r.from_date === data.today ? 'from today' : 'from ' + fmtShort(r.from_date)}` });
    setName(''); setUrl('');
  };
  const kinds = Object.keys(KIND_LABELS);
  const grouped = kinds.map(k => [k, data.assets.filter(a => a.kind === k)]).filter(([, l]) => l.length);
  return html`<div class="stack">
    <form class="card" onSubmit=${add}>
      <h3 style="margin-bottom:12px">Add a site, account or page</h3>
      <div class="row wrap" style="align-items:flex-end">
        <label class="field" style="width:190px">Type<select value=${kind} onChange=${(e) => setKind(e.target.value)}>${kinds.map(k => html`<option value=${k}>${KIND_LABELS[k]}</option>`)}</select></label>
        <label class="field" style="flex:1;min-width:180px">Name<input type="text" required value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. Canada, Home Decor…" /></label>
        <label class="field" style="flex:1;min-width:200px">Link (optional)<input type="url" value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="https://" /></label>
      </div>
      <div style="margin-top:12px"><${EffectPicker} value=${from} onChange=${setFrom} today=${data.today}
        hint="Routines covering this type will include it from this date." /></div>
      <div class="form-actions"><button class="btn primary"><${Icon} name="plus" size=${16} />Add</button></div>
    </form>
    ${grouped.length === 0 && html`<${Empty} title="No sites or accounts yet">Start with your 4 sites, your Pinterest accounts and your Facebook / Instagram pages.</${Empty}>`}
    ${grouped.map(([k, list]) => html`<section>
      <div class="section-head"><h3>${KIND_PLURAL[k]}</h3><span class="muted small">${list.filter(a => a.status === 'active').length} active · ${list.length} total</span></div>
      <div class="list">${list.map(a => html`<div class="list-row" key=${a.id}>
        <div class="grow">
          <strong>${a.name}</strong> ${a.url && html`<a class="small" href=${a.url} target="_blank" rel="noopener noreferrer">${a.url.replace(/^https?:\/\//, '')}</a>`}
          ${a.upcoming.map(u => html`<div class="small muted">→ ${STATUS_LABEL[u.status]} from ${fmtShort(u.from_date)}</div>`)}
        </div>
        <div class="row-end">
          <${Chip} color=${STATUS_COLOR[a.status]}>${STATUS_LABEL[a.status]}</${Chip}>
          <${ActionsMenu} label=${`${a.name} — ${KIND_LABELS[a.kind]}`} items=${[
            ['Edit', () => setEdit(a)],
            [a.status === 'active' ? 'Pause / archive' : 'Reactivate…', () => setStatusFor(a)],
            ['Delete', () => setDel(a), 'danger'],
          ]} />
        </div>
      </div>`)}</div>
    </section>`)}
    ${edit && html`<${EditAsset} a=${edit} onClose=${() => setEdit(null)} onPause=${() => { const a = edit; setEdit(null); setStatusFor(a); }} />`}
    ${statusFor && html`<${AssetStatus} a=${statusFor} today=${data.today} onClose=${() => setStatusFor(null)} />`}
    ${del && html`<${DeleteAsset} a=${del} onClose=${() => setDel(null)} />`}
  </div>`;
}

// One "Actions" dropdown per row (keyboard: Enter/Space opens, ↑/↓ move, Esc closes).
function ActionsMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef();
  const toggle = () => {
    if (!open) { const r = ref.current.getBoundingClientRect(); setUp(window.innerHeight - r.bottom < 40 * items.length + 30 && r.top > 40 * items.length + 30); }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    el.querySelector('[role=menuitem]')?.focus();
    const away = (e) => { if (!el.contains(e.target)) setOpen(false); };
    const keys = (e) => {
      const btns = [...el.querySelectorAll('[role=menuitem]')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { setOpen(false); el.querySelector('.actions-btn').focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    };
    document.addEventListener('mousedown', away); el.addEventListener('keydown', keys);
    return () => { document.removeEventListener('mousedown', away); el.removeEventListener('keydown', keys); };
  }, [open]);
  return html`<div class="menu" ref=${ref}>
    <button class="btn sm actions-btn" aria-haspopup="menu" aria-expanded=${open} aria-label=${'Actions for ' + label} onClick=${toggle}>
      Actions <${Icon} name="chevD" size=${14} /></button>
    ${open && html`<div class=${'menu-pop actions-pop' + (up ? ' up' : '')} role="menu" aria-label=${'Actions for ' + label}>
      ${items.map(([text, fn, tone]) => html`<button role="menuitem" class=${'item' + (tone === 'danger' ? ' danger' : '')} onClick=${() => { setOpen(false); fn(); }}>${text}</button>`)}
    </div>`}
  </div>`;
}

function DeleteAsset({ a, onClose }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await api('DELETE', `/api/assets/${a.id}`);
      bus.emit();
      onClose();
      toast({ msg: `Deleted “${a.name}” (${KIND_LABELS[a.kind]})`, undo: async () => { await api('POST', `/api/assets/${a.id}/restore`); bus.emit(); } });
    } catch (e) { toast({ msg: e.message, kind: 'error' }); setBusy(false); }
  };
  return html`<${Modal} title="Delete this entry?" onClose=${onClose}>
    <div class="stack">
      <dl class="kv">
        <dt>Name</dt><dd><strong>${a.name}</strong></dd>
        <dt>Type</dt><dd>${KIND_LABELS[a.kind]}</dd>
        <dt>Link</dt><dd>${a.url ? html`<span class="num">${a.url}</span>` : html`<span class="muted">none</span>`}</dd>
        <dt>Status</dt><dd>${STATUS_LABEL[a.status]}</dd>
      </dl>
      <p>Only this entry is deleted. It leaves your lists, the counts and every routine from today.</p>
      <p class="hint">Past activity and scores stay in your history. Entries with the same name or link are not affected.</p>
      <div class="form-actions"><button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn danger-solid" disabled=${busy} onClick=${confirm}>Delete “${a.name}” (${KIND_LABELS[a.kind]})</button></div>
    </div>
  </${Modal}>`;
}

function EditAsset({ a, onClose, onPause }) {
  const [name, setName] = useState(a.name);
  const [kind, setKind] = useState(a.kind);
  const [url, setUrl] = useState(a.url || '');
  const [notes, setNotes] = useState(a.notes || '');
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const moving = kind !== a.kind;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setConflict(null);
    try {
      const r = await api('PUT', `/api/assets/${a.id}`, { name, kind, url, notes });
      bus.emit();
      toast({ msg: r.moved ? `Saved · moved to ${KIND_PLURAL[r.kind]}` : 'Saved' });
      onClose();
    } catch (err) {
      if (err.conflict) setConflict({ message: err.message, ...err.conflict });
      else toast({ msg: err.message, kind: 'error' });
    } finally { setBusy(false); }
  };
  return html`<${Modal} title=${'Edit · ' + a.name} onClose=${onClose}>
    <form class="stack" onSubmit=${save}>
      <label class="field">Name<input type="text" required value=${name} onInput=${(e) => setName(e.target.value)} /></label>
      <label class="field">Type<select value=${kind} onChange=${(e) => { setKind(e.target.value); setConflict(null); }}>
        ${Object.keys(KIND_LABELS).map(k => html`<option value=${k}>${KIND_LABELS[k]}</option>`)}</select></label>
      <label class="field">Link<input type="url" value=${url} onInput=${(e) => { setUrl(e.target.value); setConflict(null); }} placeholder="https://" /></label>
      <label class="field">Notes<textarea value=${notes} onInput=${(e) => setNotes(e.target.value)} /></label>
      ${moving
        ? html`<p class="notice blue">Moves this entry from <strong>${KIND_PLURAL[a.kind]}</strong> to <strong>${KIND_PLURAL[kind]}</strong>. Its history stays with it; from today, routines treat it as “${KIND_LABELS[kind]}” (today’s untouched ${KIND_LABELS[a.kind]} tasks for it are replaced).</p>`
        : html`<p class="hint">Changes show from today. History keeps its scores as they were.</p>`}
      ${conflict && html`<div class="notice conflict" role="alert">
        <strong>Possible duplicate — nothing was saved.</strong>
        <p style="margin-top:4px">${KIND_PLURAL[conflict.kind]} already has <strong>${conflict.name}</strong>${conflict.url ? html` (<span class="num">${conflict.url}</span>)` : ''}, ${conflict.status === 'active' ? 'active' : conflict.status}. Moving this entry there would create a second copy.</p>
        <p style="margin-top:4px">Keep the existing one and pause or archive this mistaken entry instead.</p>
        <div class="row wrap" style="margin-top:8px">
          <button type="button" class="btn sm" onClick=${onClose}>Cancel edit</button>
          <button type="button" class="btn sm dark" onClick=${onPause}>Pause / archive “${a.name}” (${KIND_LABELS[a.kind]})</button>
        </div>
      </div>`}
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy}>Save</button></div>
    </form>
  </${Modal}>`;
}

function AssetStatus({ a, today, onClose }) {
  const [status, setStatus] = useState(a.status === 'active' ? 'paused' : 'active');
  const [from, setFrom] = useState(addDays(today, 1));
  return html`<${Modal} title=${a.name} onClose=${onClose}>
    <form class="stack" onSubmit=${async (e) => { e.preventDefault(); const r = await act('POST', `/api/assets/${a.id}/status`, { status, from_date: from }); toast({ msg: `${a.name}: ${STATUS_LABEL[status].toLowerCase()} from ${fmtShort(r.from_date)}` }); onClose(); }}>
      <div class="seg">${['active', 'paused', 'archived'].map(s => html`<button type="button" class=${status === s ? 'on' : ''} onClick=${() => setStatus(s)}>${{ active: 'Reactivate', paused: 'Pause', archived: 'Archive' }[s]}</button>`)}</div>
      <p class="hint">${status === 'paused' ? 'No more tasks for this account, but it stays in your lists and stats.' : status === 'archived' ? 'Hidden from tasks; history and stats stay intact. Can be reactivated anytime.' : 'Routines covering it resume on the chosen date.'}</p>
      <${EffectPicker} value=${from} onChange=${setFrom} today=${today} hint="A task already started today is never removed." />
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Confirm</button></div>
    </form>
  </${Modal}>`;
}

// ---------- Routines ----------
const UNIT_LABEL = { pin: 'Pins', article: 'Articles', unit: 'Units', youtube: 'YouTube videos' };
const TYPE_LABEL = { counter: 'Counter', social: 'Video slots', check: 'Checkbox' };
const daysText = (days) => days.length === 7 ? 'Every day' : DAYS.filter(([d]) => days.includes(d)).map(([d]) => DAY_NAMES[d]).join(' ');

function summary(r, assets) {
  const c = r.config;
  if (!c) return '';
  const parts = [daysText(c.days || [])];
  if (c.status && c.status !== 'active') parts.unshift(c.status === 'paused' ? 'Paused' : 'Archived');
  if (r.type === 'counter') {
    const scope = c.asset_scope === 'kinds' ? `all ${(c.asset_kinds || []).map(k => KIND_PLURAL[k].toLowerCase()).join(' + ')}`
      : c.asset_scope === 'list' ? (c.asset_ids || []).map(id => assets.find(a => a.id === id)?.name || '?').join(', ') : 'no account';
    parts.push(`${c.target} ${UNIT_LABEL[c.unit] || ''} ${c.target_mode === 'shared' ? 'shared' : 'per account'}`, scope);
  } else if (r.type === 'social') {
    parts.push((c.slots || []).map(s => `${s.label} ${s.time || ''} (${s.videos} video${s.videos === 1 ? '' : 's'}, ${s.mode === 'shared' ? 'multi-destination' : 'per page'})`).join(' · '));
  } else parts.push((c.checklist || []).length ? `${c.checklist.length} steps` : 'one click');
  if (c.time_slot) parts.push(c.time_slot);
  return parts.join(' · ');
}

function Routines({ data }) {
  const [edit, setEdit] = useState(null);
  return html`<div class="stack">
    <div class="row"><p class="muted" style="flex:1">Each change creates a new version with an effective date. Past days keep their targets.</p>
      <button class="btn primary" onClick=${() => setEdit({ isNew: true })}><${Icon} name="plus" size=${16} />New routine</button></div>
    <div class="list">${data.routines.map(r => html`<div class="list-row">
      <div class="grow">
        <div class="row"><strong>${r.name}</strong><${Chip} color="blue">${r.category}</${Chip}><${Chip}>${TYPE_LABEL[r.type]}</${Chip}></div>
        <div class="small muted" style="margin-top:3px">${r.current ? summary({ ...r, config: r.current.config }, data.assets) : 'Starts later'}</div>
        ${r.upcoming.map(v => html`<div class="small" style="margin-top:4px">
          <${Chip} color="yellow">From ${fmtShort(v.from_date)}</${Chip}> ${summary({ ...r, config: v.config }, data.assets)}
          <button class="link-btn small" style="margin-left:6px" onClick=${async () => { await act('DELETE', `/api/routine-versions/${v.id}`); toast({ msg: 'Scheduled change cancelled' }); }}>Cancel this change</button>
        </div>`)}
      </div>
      <button class="btn sm" onClick=${() => setEdit(r)}>Edit</button>
    </div>`)}</div>
    ${edit && html`<${RoutineEditor} r=${edit} data=${data} onClose=${() => setEdit(null)} />`}
  </div>`;
}

function defaultConfig(type) {
  const base = { status: 'active', days: [1, 2, 3, 4, 5, 6, 0], time_slot: '' };
  if (type === 'counter') return { ...base, unit: 'unit', unit_label: '', asset_scope: 'none', asset_kinds: [], asset_ids: [], target_mode: 'per_asset', target: 1, overrides: {} };
  if (type === 'social') return { ...base, slots: [{ key: 'matin', label: 'Morning', time: '09:00', videos: 1, mode: 'shared', dest_scope: 'kinds', dest_kinds: ['facebook', 'instagram'], destinations: [] }] };
  return { ...base, checklist: [] };
}

function RoutineEditor({ r, data, onClose }) {
  const isNew = !!r.isNew;
  const latest = !isNew && (r.upcoming.length ? r.upcoming[r.upcoming.length - 1] : r.current);
  const [type, setType] = useState(isNew ? 'counter' : r.type);
  const [name, setName] = useState(isNew ? '' : r.name);
  const [category, setCategory] = useState(isNew ? '' : r.category);
  const [cfg, setCfg] = useState(() => JSON.parse(JSON.stringify(latest ? latest.config : defaultConfig('counter'))));
  const [from, setFrom] = useState(isNew ? data.today : addDays(data.today, 1));
  const set = (patch) => setCfg(c => ({ ...c, ...patch }));
  const cats = [...new Set(data.routines.map(x => x.category))];
  const save = async (e) => {
    e.preventDefault();
    const body = { name, category, config: cfg, from_date: from };
    const res = isNew ? await act('POST', '/api/routines', { ...body, type }) : await act('PUT', `/api/routines/${r.id}`, body);
    toast({ msg: `Routine saved · effective ${res.from_date === data.today ? 'today' : fmtShort(res.from_date)}` });
    onClose();
  };
  return html`<${Modal} title=${isNew ? 'New routine' : 'Edit · ' + r.name} onClose=${onClose} wide>
    <form class="stack" onSubmit=${save}>
      ${isNew && html`<fieldset><legend>Type</legend><div class="seg">${Object.entries(TYPE_LABEL).map(([k, l]) => html`<button type="button" class=${type === k ? 'on' : ''} onClick=${() => { setType(k); setCfg(defaultConfig(k)); }}>${l}</button>`)}</div>
        <p class="hint" style="margin-top:6px">${type === 'counter' ? 'A numeric target (per account or shared) with numbered boxes.' : type === 'social' ? 'Slots (Morning, Evening…): video produced + one publication per destination.' : 'A one-click task, optionally split into small steps.'}</p></fieldset>`}
      <div class="grid2">
        <label class="field">Name<input type="text" required value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <label class="field">Score category<input type="text" list="cat-list" value=${category} onInput=${(e) => setCategory(e.target.value)} placeholder="e.g. Pinterest" />
          <span class="hint">Tasks in the same category form a single score.</span>
          <datalist id="cat-list">${cats.map(c => html`<option value=${c} />`)}</datalist></label>
      </div>
      <div class="row wrap" style="gap:18px;align-items:flex-end">
        <fieldset><legend>Active days</legend><div class="daypick">${DAYS.map(([d, l]) => { const on = (cfg.days || []).includes(d); return html`<button type="button" class=${on ? 'on' : ''} aria-pressed=${on} aria-label=${DAY_NAMES[d]} onClick=${() => set({ days: on ? cfg.days.filter(x => x !== d) : [...(cfg.days || []), d] })}>${l}</button>`; })}</div></fieldset>
        ${type !== 'social' && html`<label class="field">Time slot (optional)<input type="text" value=${cfg.time_slot || ''} onInput=${(e) => set({ time_slot: e.target.value })} placeholder="09:00–11:00" style="width:150px" /></label>`}
        <fieldset><legend>Status</legend><div class="seg">${[['active', 'Active'], ['paused', 'Paused'], ['archived', 'Archived']].map(([k, l]) => html`<button type="button" class=${(cfg.status || 'active') === k ? 'on' : ''} onClick=${() => set({ status: k })}>${l}</button>`)}</div></fieldset>
      </div>
      ${type === 'counter' && html`<${CounterFields} cfg=${cfg} set=${set} assets=${data.assets} />`}
      ${type === 'social' && html`<${SocialFields} cfg=${cfg} set=${set} assets=${data.assets} />`}
      ${type === 'check' && html`<${CheckFields} cfg=${cfg} set=${set} />`}
      <${EffectPicker} value=${from} onChange=${setFrom} today=${data.today}
        hint=${from === data.today ? 'Today will be recalculated; tasks already checked are kept.' : 'Today does not change.'} />
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Save</button></div>
    </form>
  </${Modal}>`;
}

const pickKinds = (selected, onChange, kinds) => html`<div class="row wrap">${kinds.map(k => html`<label class="checkline"><input type="checkbox" checked=${selected.includes(k)}
  onChange=${(e) => onChange(e.target.checked ? [...selected, k] : selected.filter(x => x !== k))} />${KIND_PLURAL[k]}</label>`)}</div>`;
const pickAssets = (selected, onChange, assets) => html`<div class="row wrap">${assets.filter(a => a.status !== 'archived').map(a => html`<label class="checkline"><input type="checkbox" checked=${selected.includes(a.id)}
  onChange=${(e) => onChange(e.target.checked ? [...selected, a.id] : selected.filter(x => x !== a.id))} />${a.name} <span class="muted small">${KIND_LABELS[a.kind]}</span></label>`)}</div>`;

function CounterFields({ cfg, set, assets }) {
  const scoped = cfg.asset_scope === 'kinds' ? assets.filter(a => (cfg.asset_kinds || []).includes(a.kind) && a.status !== 'archived')
    : cfg.asset_scope === 'list' ? assets.filter(a => (cfg.asset_ids || []).includes(a.id)) : [];
  return html`<div class="card flat stack">
    <div class="row wrap" style="align-items:flex-end">
      <label class="field">What is counted<select value=${cfg.unit} onChange=${(e) => set({ unit: e.target.value })}>${Object.entries(UNIT_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
      <label class="field" style="flex:1">Display label<input type="text" value=${cfg.unit_label || ''} onInput=${(e) => set({ unit_label: e.target.value })} placeholder="articles published, Pins…" /></label>
    </div>
    <fieldset><legend>Applies to</legend>
      <div class="seg">${[['kinds', 'All accounts of a type'], ['list', 'A selection'], ['none', 'No account']].map(([k, l]) => html`<button type="button" class=${cfg.asset_scope === k ? 'on' : ''} onClick=${() => set({ asset_scope: k })}>${l}</button>`)}</div>
      <div style="margin-top:8px">
        ${cfg.asset_scope === 'kinds' && html`${pickKinds(cfg.asset_kinds || [], (v) => set({ asset_kinds: v }), Object.keys(KIND_LABELS))}<p class="hint" style="margin-top:6px">A new account of this type will be included from its activation date.</p>`}
        ${cfg.asset_scope === 'list' && pickAssets(cfg.asset_ids || [], (v) => set({ asset_ids: v }), assets)}
      </div>
    </fieldset>
    <div class="row wrap" style="align-items:flex-end">
      ${cfg.asset_scope !== 'none' && html`<fieldset><legend>Target</legend><div class="seg">
        <button type="button" class=${cfg.target_mode !== 'shared' ? 'on' : ''} onClick=${() => set({ target_mode: 'per_asset' })}>Per account / site</button>
        <button type="button" class=${cfg.target_mode === 'shared' ? 'on' : ''} onClick=${() => set({ target_mode: 'shared' })}>Shared</button></div></fieldset>`}
      <label class="field">${cfg.target_mode === 'shared' ? 'Total per day' : 'Per day'}<input type="number" min="1" max="200" value=${cfg.target} onInput=${(e) => set({ target: +e.target.value })} /></label>
    </div>
    ${cfg.target_mode === 'shared' && cfg.asset_scope !== 'none' && html`<p class="hint">Shared target: you choose the site each time you log, to keep per-site detail.</p>`}
    ${cfg.target_mode !== 'shared' && scoped.length > 0 && html`<details><summary class="small" style="cursor:pointer;font-weight:600">Different target for some accounts</summary>
      <div class="stack" style="margin-top:8px">${scoped.map(a => html`<label class="row small"><span style="width:180px">${a.name}</span>
        <input type="number" min="0" max="200" placeholder=${String(cfg.target)} value=${(cfg.overrides || {})[a.id] ?? ''} onInput=${(e) => set({ overrides: { ...(cfg.overrides || {}), [a.id]: e.target.value } })} />
        <span class="muted">empty = ${cfg.target}, 0 = no task</span></label>`)}</div></details>`}
  </div>`;
}

function SocialFields({ cfg, set, assets }) {
  const slots = cfg.slots || [];
  const upd = (i, patch) => set({ slots: slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const social = assets.filter(a => ['facebook', 'instagram'].includes(a.kind));
  return html`<div class="stack">
    ${slots.map((s, i) => html`<div class="card flat stack">
      <div class="row wrap" style="align-items:flex-end">
        <label class="field">Slot<input type="text" value=${s.label} onInput=${(e) => upd(i, { label: e.target.value })} style="width:140px" /></label>
        <label class="field">Time<input type="time" value=${s.time} onInput=${(e) => upd(i, { time: e.target.value })} style="width:120px" /></label>
        <label class="field">Videos<input type="number" min="0" max="20" value=${s.videos} onInput=${(e) => upd(i, { videos: +e.target.value })} /></label>
        <span class="spacer"></span>
        <button type="button" class="btn sm danger" onClick=${() => set({ slots: slots.filter((_, j) => j !== i) })}>Remove</button>
      </div>
      <fieldset><legend>Mode</legend><div class="seg">
        <button type="button" class=${s.mode !== 'per_page' ? 'on' : ''} onClick=${() => upd(i, { mode: 'shared' })}>One video → several destinations</button>
        <button type="button" class=${s.mode === 'per_page' ? 'on' : ''} onClick=${() => upd(i, { mode: 'per_page' })}>Target per page</button></div>
        <p class="hint" style="margin-top:6px">${s.mode === 'per_page' ? 'Each page has its own task and its own video.' : '1 video produced, 1 publication tracked per destination (e.g. Facebook + Instagram = 2 publications).'}</p></fieldset>
      <fieldset><legend>Destinations</legend>
        <div class="seg"><button type="button" class=${s.dest_scope !== 'list' ? 'on' : ''} onClick=${() => upd(i, { dest_scope: 'kinds' })}>By type</button>
          <button type="button" class=${s.dest_scope === 'list' ? 'on' : ''} onClick=${() => upd(i, { dest_scope: 'list' })}>Selection</button></div>
        <div style="margin-top:8px">${s.dest_scope === 'list' ? pickAssets(s.destinations || [], (v) => upd(i, { destinations: v }), social) : pickKinds(s.dest_kinds || [], (v) => upd(i, { dest_kinds: v }), ['facebook', 'instagram'])}</div>
      </fieldset>
    </div>`)}
    <button type="button" class="btn" onClick=${() => set({ slots: [...slots, { key: 'c' + Date.now().toString(36), label: 'New', time: '', videos: 1, mode: 'shared', dest_scope: 'kinds', dest_kinds: ['facebook', 'instagram'], destinations: [] }] })}><${Icon} name="plus" size=${16} />Add a slot</button>
  </div>`;
}

function CheckFields({ cfg, set }) {
  const list = cfg.checklist || [];
  const [v, setV] = useState('');
  return html`<div class="card flat stack">
    <p class="hint">No steps: a single checkbox. With steps: a small checklist (the score follows the checked steps).</p>
    ${list.map((x, i) => html`<div class="row"><input type="text" value=${x} onInput=${(e) => set({ checklist: list.map((y, j) => (j === i ? e.target.value : y)) })} />
      <button type="button" class="icon-btn" aria-label="Remove step" onClick=${() => set({ checklist: list.filter((_, j) => j !== i) })}><${Icon} name="x" /></button></div>`)}
    <div class="row"><input type="text" value=${v} onInput=${(e) => setV(e.target.value)} placeholder="New step" onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (v.trim()) { set({ checklist: [...list, v.trim()] }); setV(''); } } }} />
      <button type="button" class="btn" onClick=${() => { if (v.trim()) { set({ checklist: [...list, v.trim()] }); setV(''); } }}>Add</button></div>
  </div>`;
}

// ---------- Categories ----------
const COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky', 'ink'];
function Categories({ data }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('sky');
  return html`<div class="stack">
    <p class="muted">Project categories. Those marked “coding” appear in the “What are you working on?” prompt.</p>
    <div class="list">${data.categories.map(c => html`<${CatRow} key=${c.id} c=${c} />`)}</div>
    <form class="card row wrap" style="align-items:flex-end" onSubmit=${async (e) => { e.preventDefault(); await act('POST', '/api/categories', { name, color, coding: true }); setName(''); toast({ msg: 'Category added' }); }}>
      <label class="field" style="flex:1;min-width:200px">New category<input type="text" required value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. Mobile apps" /></label>
      <label class="field">Color<select value=${color} onChange=${(e) => setColor(e.target.value)}>${COLORS.map(c => html`<option value=${c}>${c}</option>`)}</select></label>
      <button class="btn primary">Add</button>
    </form>
  </div>`;
}
function CatRow({ c }) {
  const [name, setName] = useState(c.name);
  const save = (patch) => act('PUT', `/api/categories/${c.id}`, { name, color: c.color, coding: !!c.coding, ...patch });
  return html`<div class="list-row">
    <${Chip} color=${c.color}>●</${Chip}>
    <input type="text" value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${() => name !== c.name && save({ name })} aria-label="Category name" style="max-width:280px" />
    <select value=${c.color} onChange=${(e) => save({ color: e.target.value })} aria-label="Color" style="width:auto">${COLORS.map(x => html`<option value=${x}>${x}</option>`)}</select>
    <label class="checkline"><input type="checkbox" checked=${!!c.coding} onChange=${(e) => save({ coding: e.target.checked })} />Coding</label>
  </div>`;
}

// ---------- General ----------
function General({ data }) {
  const [theme, setTheme] = useTheme();
  const [tz, setTz] = useState(data.tz);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return html`<div class="stack" style="max-width:560px">
  <${AccountCard} />
  <section class="card stack" aria-label="Appearance">
    <h3>Appearance</h3>
    <div class="seg" role="radiogroup" aria-label="Theme">${THEMES.map(([k, l, icon]) => html`<button type="button" role="radio" aria-checked=${theme === k} class=${theme === k ? 'on' : ''} onClick=${() => setTheme(k)}><span class="row" style="gap:6px"><${Icon} name=${icon} size=${15} />${l}</span></button>`)}</div>
    <p class="hint">System follows your Ubuntu light/dark setting. Saved in this browser.</p>
  </section>
  <form class="card stack" onSubmit=${async (e) => { e.preventDefault(); await act('PUT', '/api/settings', { timezone: tz }); toast({ msg: 'Timezone saved' }); }}>
    <h3>Timezone</h3>
    <label class="field">Days start at midnight in this timezone<input type="text" list="tz-list" value=${tz} onInput=${(e) => setTz(e.target.value)} />
      <datalist id="tz-list">${zones.map(z => html`<option value=${z} />`)}</datalist></label>
    <p class="hint">Default: Africa/Casablanca. Today in the app: ${fmtDay(data.today)}.</p>
    <div class="form-actions"><button class="btn primary">Save</button></div>
  </form>
  </div>`;
}

// ---------- Backup ----------
function StorageNote() {
  if (isCloudStorage()) return html`<p class="notice blue" role="note">${CLOUD_NOTE}</p>`;
  return isBrowserStorage()
    ? html`<p class="notice" role="note"><strong>${BROWSER_NOTE}</strong></p>`
    : html`<p class="notice blue" role="note">Data is stored on this computer in <code>data/tableau.sqlite</code>.</p>`;
}

function AccountCard() {
  if (isCloudStorage()) return html`<${CloudAccountCard} />`;
  if (!isBrowserStorage()) return null;
  const d = window.__dash;
  const kb = Math.round(d.bytesUsed() / 1024);
  return html`<section class="card stack" aria-label="Account and storage">
    <h3>Account & storage</h3>
    <p>Signed in as <strong>${d.user.email || d.user.name}</strong>.</p>
    <p class="notice"><strong>${BROWSER_NOTE}</strong></p>
    <p class="hint">No cross-device sync yet. This browser holds about ${kb} KB of dashboard data for this account (browsers allow roughly 5 MB per site).
      Other accounts' data in this browser is never shown here, but anyone using this browser profile can read site storage — don't keep passwords or other sensitive information in the dashboard.</p>
    <div><button class="btn" onClick=${() => d.logout()}>Sign out</button></div>
  </section>`;
}

function CloudAccountCard() {
  const d = window.__dash;
  const [s, set] = useState(d.sync.status());
  useEffect(() => d.sync.subscribe(() => set(d.sync.status())), []);
  const label = { synced: s.pending ? 'Saving…' : 'Synced', saving: 'Saving…', idle: 'Saving…', offline: 'Offline', error: 'Sync failed', signin: 'Sign in again to sync', conflict: 'Conflict — choose a version (banner at the top)' }[s.state] || s.state;
  return html`<section class="card stack" aria-label="Account and sync">
    <h3>Account & sync</h3>
    <p>Signed in as <strong>${d.user.email || d.user.name}</strong>.</p>
    <p class="notice blue">${CLOUD_NOTE}</p>
    <p>Sync: <${Chip} color=${['offline', 'error', 'signin', 'conflict'].includes(s.state) ? 'pink' : 'mint'}>${label}</${Chip}>
      ${s.lastSync && html` <span class="hint">last synced ${new Date(s.lastSync).toLocaleString('en-GB')}</span>`}</p>
    ${s.error && html`<p class="notice" role="alert">${s.error}</p>`}
    ${s.pending && html`<p class="hint">Changes not yet in the cloud are kept in this browser until they are sent.</p>`}
    <div class="row wrap"><button class="btn" onClick=${() => d.sync.retry()}>Sync now</button><button class="btn" onClick=${() => d.logout()}>Sign out</button></div>
  </section>`;
}

function Backup() {
  const download = async () => {
    try {
      const data = await api('GET', '/api/backup');
      downloadJson(data, `dashboard-backup-${data.exported_from || 'export'}-${new Date().toISOString().slice(0, 10)}.json`);
      toast({ msg: 'Backup downloaded' });
    } catch (e) { toast({ msg: e.message, kind: 'error' }); }
  };
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      setPreview({ ...(await api('POST', '/api/restore/preview', json)), file: f.name });
    } catch (err) { toast({ msg: err.message.includes('JSON') ? 'Unreadable file (invalid JSON)' : err.message, kind: 'error' }); }
    e.target.value = '';
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await act('POST', '/api/restore/apply', { token: preview.token });
      toast({ msg: 'Data restored. Previous data saved as ' + String(r.safety_backup || '').split('/').pop() });
      if (isCloudStorage()) {
        await window.__dash.sync.retry();
        const st = window.__dash.sync.status();
        if (st.pending || st.error) toast({ msg: 'Restored on this device, but not synced yet: ' + (st.error || 'will retry') + '. Keep this tab open until it shows “Synced”.', kind: 'error' });
        else toast({ msg: 'Restored and synced to your account' });
      }
      setPreview(null);
    } finally { setBusy(false); }
  };
  const rows = [['assets', 'Sites & accounts'], ['routines', 'Routines'], ['tasks', 'Tasks'], ['records', 'Records'], ['projects', 'Projects'],
    ['milestones', 'Milestones'], ['sessions', 'Coding sessions'], ['videos', 'Videos'], ['courses', 'Courses'], ['challenges', 'Challenges']];
  return html`<div class="stack" style="max-width:760px">
    <${StorageNote} />
    <div class="card stack">
      <h3>Back up</h3>
      <p class="muted">A single JSON file with all your data (accounts, routines, history, projects, sessions…).</p>
      <div><button class="btn primary" onClick=${download}>Download a backup</button></div>
      ${isCloudStorage()
        ? html`<p class="hint">Restoring a file (from the localhost app or this browser before sync) brings your data into your signed-in account, on all your devices.</p>`
        : isBrowserStorage()
        ? html`<p class="hint">Restoring a file exported from the localhost app (or another browser) brings your data here, into this account only.</p>`
        : html`<p class="hint">From the command line: <code>npm run backup</code> (writes to <code>data/backups/</code>).</p>`}
    </div>
    ${isCloudStorage() && window.__dash.legacyBackup() && html`<${LegacyImport} onPreview=${setPreview} />`}
    <div class="card stack">
      <h3>Restore</h3>
      <p class="muted">Choose a file: you will see a preview before anything is replaced.</p>
      <input type="file" accept="application/json,.json" onChange=${onFile} aria-label="Backup file" />
      ${preview && html`<div class="stack">
        <p class="notice"><strong>Preview of ${preview.file}</strong> — exported ${new Date(preview.exported_at).toLocaleString('en-GB')}. Restoring <strong>replaces all current data${isCloudStorage() ? ' in your account, on every device' : ''}</strong>. A safety copy is ${isCloudStorage() ? 'downloaded' : 'made'} just before.</p>
        <table class="data"><thead><tr><th></th><th class="r">Current</th><th class="r">Backup</th></tr></thead><tbody>
          ${rows.map(([k, l]) => html`<tr><td>${l}</td><td class="r">${preview.current[k]}</td><td class="r"><strong>${preview.incoming[k]}</strong></td></tr>`)}
          <tr><td>Period</td><td class="r">${preview.current.first_date || '—'} → ${preview.current.last_date || '—'}</td><td class="r">${preview.incoming.first_date || '—'} → ${preview.incoming.last_date || '—'}</td></tr>
        </tbody></table>
        ${preview.already_imported && html`<p class="notice blue">This exact data was already imported on ${new Date(preview.already_imported).toLocaleString('en-GB')}. Importing it again creates no duplicates: it replaces your data with the same records (unless you changed things since).</p>`}
        ${preview.incoming.asset_names.length > 0 && html`<p class="small muted">Accounts in the backup: ${preview.incoming.asset_names.join(', ')}</p>`}
        <div class="form-actions"><button class="btn" onClick=${() => setPreview(null)}>Cancel</button><button class="btn dark" disabled=${busy} onClick=${apply}>${isCloudStorage() ? 'Replace my account data' : 'Replace my data'}</button></div>
      </div>`}
    </div>
  </div>`;
}

// Dashboard data this browser stored before cloud sync existed: importable with the same preview.
function LegacyImport({ onPreview }) {
  const data = window.__dash.legacyBackup();
  const [busy, setBusy] = useState(false);
  const n = (t) => (data.tables[t] || []).length;
  const open = async () => {
    setBusy(true);
    try { onPreview({ ...(await api('POST', '/api/restore/preview', data)), file: 'data saved in this browser before sync' }); }
    catch (e) { toast({ msg: e.message, kind: 'error' }); }
    finally { setBusy(false); }
  };
  return html`<div class="card stack">
    <h3>Data from this browser (before sync)</h3>
    <p class="muted">This browser still holds dashboard data saved for your account before cloud sync: ${n('projects')} projects, ${n('tasks')} tasks, ${n('sessions')} sessions${data.exported_at ? `, last saved ${new Date(data.exported_at).toLocaleString('en-GB')}` : ''}.
      It is kept untouched. You can import it into your account — you'll see a preview first.</p>
    <div><button class="btn" disabled=${busy} onClick=${open}>Preview import</button>
      <button class="btn ghost" onClick=${() => downloadJson(data, `dashboard-browser-before-sync-${new Date().toISOString().slice(0, 10)}.json`)}>Download it as a file</button></div>
  </div>`;
}

// ---------- Demo ----------
function Demo() {
  const { data } = useResource('/api/mode');
  if (!data) return null;
  const demo = data.mode === 'demo';
  const switchTo = async (mode) => { await api('POST', '/api/mode', { mode }); bus.emit(); toast({ msg: mode === 'demo' ? 'Demo mode on' : 'Back to your data' }); };
  return html`<div class="card stack" style="max-width:640px">
    <h3>Demo data</h3>
    <p class="muted">The demo uses a <strong>separate ${isBrowserStorage() || isCloudStorage() ? 'storage slot for your account in this browser' : html`database (<code>data/demo.sqlite</code>)`}</strong>. Your real data is never mixed or modified.</p>
    <p>Current mode: <${Chip} color=${demo ? 'yellow' : 'mint'}>${demo ? 'Demo' : 'My data'}</${Chip}></p>
    <div class="row wrap">
      ${demo ? html`<button class="btn primary" onClick=${() => switchTo('real')}>Back to my data</button>
          <button class="btn" onClick=${async () => { await api('POST', '/api/demo/reset'); bus.emit(); toast({ msg: 'Demo reset' }); }}>Reset demo</button>`
        : html`<button class="btn" onClick=${() => switchTo('demo')}>Explore with demo data</button>`}
    </div>
  </div>`;
}
