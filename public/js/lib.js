// Shared helpers and UI primitives.
import { h, render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export { render, useState, useEffect, useRef, useCallback };

// ---------- event bus + cross-tab sync ----------
const listeners = new Set();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tableau-sync') : null;
export const bus = {
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(local = true) { listeners.forEach(fn => fn()); if (local && channel) channel.postMessage('changed'); },
};
if (channel) channel.onmessage = () => bus.emit(false);
window.addEventListener('focus', () => bus.emit(false));

// ---------- API ----------
// In the browser (Vercel) build, requests go to the signed-in user's local backend instead of a server.
export async function api(method, url, body) {
  if (window.__dash && window.__dash.backend) return window.__dash.backend.request(method, url, body);
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `Error ${res.status}`); err.status = res.status; err.conflict = data.conflict; throw err; }
  return data;
}
// Mutation helper: run, notify every view, surface errors.
export async function act(method, url, body, { quiet = false } = {}) {
  try {
    const r = await api(method, url, body);
    bus.emit();
    return r;
  } catch (e) {
    if (!quiet) toast({ msg: e.message, kind: 'error' });
    throw e;
  }
}

// Fetch + silent refresh on any change (keeps the DOM in place: no loading flash).
export function useResource(url) {
  const [state, set] = useState({ data: null, error: null });
  const urlRef = useRef(url);
  urlRef.current = url;
  const load = useCallback(async () => {
    const u = urlRef.current;
    if (!u) return;
    try { const data = await api('GET', u); if (u === urlRef.current) set({ data, error: null }); }
    catch (e) { set(s => ({ ...s, error: e.message })); }
  }, []);
  useEffect(() => { load(); }, [url]);
  useEffect(() => bus.on(load), []);
  return { ...state, reload: load };
}

export function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Where data lives, for user-facing notes.
export const isBrowserStorage = () => !!(window.__dash && window.__dash.storageKind === 'browser');
export const isCloudStorage = () => !!(window.__dash && window.__dash.storageKind === 'cloud');
export const CLOUD_NOTE = 'Data is saved to your account in the cloud and synced across the devices where you sign in. This browser keeps a copy for offline use.';
export const BROWSER_NOTE = 'Data is stored in this browser. Export a backup before changing browsers or clearing site data.';

// ---------- toasts ----------
let toastSet = null;
let toastId = 0;
export function toast(t) {
  const id = ++toastId;
  const item = { id, kind: 'ok', ...t };
  toastSet && toastSet(list => [...list.slice(-2), item]);
  setTimeout(() => toastSet && toastSet(list => list.filter(x => x.id !== id)), t.undo ? 7000 : 3500);
}
export function Toasts() {
  const [list, set] = useState([]);
  toastSet = set;
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map(t => html`<div key=${t.id} class=${'toast ' + t.kind}>
      <span>${t.msg}</span>
      ${t.undo && html`<button class="link-btn" onClick=${async () => { set(l => l.filter(x => x.id !== t.id)); await t.undo(); }}>Undo</button>`}
    </div>`)}
  </div>`;
}

// ---------- dates (fr) ----------
const asDate = (d) => new Date(d + 'T12:00:00Z');
export const fmtDay = (d, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(asDate(d));
export const fmtShort = (d) => fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtMonth = (m) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(m + '-15T12:00:00Z'));
export const addDays = (d, n) => { const x = asDate(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const fmtDateTime = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
// Readable duration from seconds: "18 sec", "4 min 05 sec", "25 min", "1 h 30 min", "2 days", "1 day 3 h".
export const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} sec`;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d} day${d > 1 ? 's' : ''}${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m < 10 && s) return `${m} min ${String(s).padStart(2, '0')} sec`;
  return `${m} min`;
};
// Countdown clock: "4:05", "1:30:00", "1d 03:00:00".
export const clock = (sec) => {
  sec = Math.max(0, Math.ceil(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${p(h)}:${p(m)}:${p(s)}`;
  return (h ? h + ':' + p(m) : String(m)) + ':' + p(s);
};
// Duration units for inputs; the stored format is always seconds.
export const UNITS = [['min', 'Minutes', 60], ['h', 'Hours', 3600], ['d', 'Days', 86400]];
export const toSec = (value, unit) => Math.round(+value * (UNITS.find(u => u[0] === unit) || UNITS[0])[2]);
export function fromSec(sec) {
  if (sec % 86400 === 0) return [sec / 86400, 'd'];
  if (sec % 3600 === 0) return [sec / 3600, 'h'];
  return [Math.round(sec / 60), 'min'];
}

// One shared ticker so every timer on screen shows the same second.
const nowSubs = new Set();
let nowTimer = null;
let lastTick = Date.now();
export function useNow(active = true) {
  const [now, set] = useState(lastTick);
  useEffect(() => {
    if (!active) return;
    nowSubs.add(set);
    lastTick = Date.now(); nowSubs.forEach(fn => fn(lastTick)); // every timer jumps to the same "now" when one appears
    if (!nowTimer) {
      const tick = () => { const t = Date.now(); lastTick = t; nowSubs.forEach(fn => fn(t)); nowTimer = setTimeout(tick, 1000 - (t % 1000) + 5); };
      nowTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    }
    return () => { nowSubs.delete(set); if (!nowSubs.size && nowTimer) { clearTimeout(nowTimer); nowTimer = null; } };
  }, [active]);
  return now;
}
export const DAYS = [[1, 'M'], [2, 'T'], [3, 'W'], [4, 'T'], [5, 'F'], [6, 'S'], [0, 'S']];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const pct = (n) => (n == null ? '—' : `${Math.round(n)}%`);

export const KIND_LABELS = {
  site_iptv: 'IPTV site', site_blog: 'Blog site', site_other: 'Other site', pinterest: 'Pinterest', facebook: 'Facebook',
  instagram: 'Instagram', youtube: 'YouTube', other: 'Other',
};
export const KIND_PLURAL = {
  site_iptv: 'IPTV sites', site_blog: 'Blog sites', site_other: 'Other sites', pinterest: 'Pinterest accounts', facebook: 'Facebook pages',
  instagram: 'Instagram accounts', youtube: 'YouTube channels', other: 'Others',
};
export const KIND_COLOR = { site_iptv: 'blue', site_blog: 'mint', site_other: 'sky', pinterest: 'pink', facebook: 'sky', instagram: 'yellow', youtube: 'pink', other: 'ink' };

// ---------- primitives ----------
const ICONS = {
  today: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4',
  projects: 'M3 7h7l2 2h9v10H3zM3 7V5h6',
  youtube: 'M3 7c0-1.5 1-2.5 2.5-2.5h13C20 4.5 21 5.5 21 7v10c0 1.5-1 2.5-2.5 2.5h-13C4 19.5 3 18.5 3 17zM10 9l5 3-5 3z',
  formation: 'M2 8l10-4 10 4-10 4zM6 10v5c3 2 9 2 12 0v-5',
  challenges: 'M7 4h10v4a5 5 0 01-10 0zM7 6H4c0 3 1 4 3 4M17 6h3c0 3-1 4-3 4M12 13v4M8 20h8',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a7.5 7.5 0 000-2l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1L15 3.5h-4l-.4 2.5a7 7 0 00-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.4 2.5h4l.4-2.5a7 7 0 001.7-1l2.4 1 2-3.4z',
  play: 'M7 4l13 8-13 8z', pause: 'M7 4h4v16H7zM14 4h4v16h-4z', stop: 'M6 6h12v12H6z', plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5 9-10', chevL: 'M15 5l-7 7 7 7', chevR: 'M9 5l7 7-7 7', chevD: 'M6 9l6 6 6-6', alert: 'M12 3l10 18H2zM12 10v5M12 18h.01', more: 'M5 12h.01M12 12h.01M19 12h.01',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3', moon: 'M20 14A8 8 0 0110 4a8 8 0 1010 10z', x: 'M6 6l12 12M18 6L6 18',
  link: 'M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1', up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M5 12l7 7 7-7',
  calendar: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01', ban: 'M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8',
  history: 'M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 2',
  logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  team: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-1a6 6 0 0112 0v1M16 3.5a4 4 0 010 7.5M22 21v-1a6 6 0 00-4-5.6',
  users: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8 16.5c1-1.5 2.4-2 4-2s3 .5 4 2',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5', edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2', note: 'M5 4h14v16H5zM9 9h6M9 13h6',
};
export const Icon = ({ name, size = 18 }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${ICONS[name] || ''} /></svg>`;

export function Bar({ value, color = 'blue', label, thin }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return html`<div class=${'bar ' + (thin ? 'thin ' : '') + color} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(v)} aria-label=${label || 'Progress'}><span style=${{ width: v + '%' }}></span></div>`;
}

export function Ring({ value, size = 64, stroke = 7, color = 'var(--accent)', children }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return html`<div class="ring" style=${{ width: size + 'px', height: size + 'px' }}>
    <svg width=${size} height=${size} aria-hidden="true">
      <circle cx=${size / 2} cy=${size / 2} r=${r} stroke="var(--line)" stroke-width=${stroke} fill="none" />
      <circle cx=${size / 2} cy=${size / 2} r=${r} stroke=${color} stroke-width=${stroke} fill="none" stroke-linecap="round"
        stroke-dasharray=${c} stroke-dashoffset=${c * (1 - v / 100)} transform=${`rotate(-90 ${size / 2} ${size / 2})`} class="ring-arc" />
    </svg>
    <div class="ring-label">${children}</div>
  </div>`;
}

export function Chip({ color = 'ink', children, title }) { return html`<span class=${'chip ' + color} title=${title}>${children}</span>`; }

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const first = el && el.querySelector('input, select, textarea, button:not(.modal-x)');
    first && first.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev && prev.focus && prev.focus(); };
  }, []);
  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${'modal ' + (wide ? 'wide' : '')} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <header><h2>${title}</h2><button class="icon-btn modal-x" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

// A textarea that grows with its content (long and multiline titles stay fully readable while editing).
// Enter saves, Shift+Enter inserts a new line, Escape cancels. With `bullets`, typing "- " at the start
// of a line turns it into a "• " bullet. Line breaks and bullets are formatting inside ONE text.
export const BULLET = '• ';
const toBullets = (v) => v.replace(/(^|\n)- /g, '$1' + BULLET);
export function AutoGrow({ value, onInput, onSave, onCancel, label, autofocus = true, placeholder, maxlength = 1000, bullets = true, id, enterkeyhint }) {
  const ref = useRef();
  const fit = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; } };
  useEffect(() => { fit(); if (autofocus && ref.current) { ref.current.focus(); const n = ref.current.value.length; ref.current.setSelectionRange(n, n); } }, []);
  useEffect(fit, [value]);
  const input = (e) => {
    const el = e.target;
    let v = el.value;
    if (bullets) {
      const b = toBullets(v);
      if (b !== v) { const a = el.selectionStart, z = el.selectionEnd; el.value = b; el.setSelectionRange(a, z); v = b; } // same length: caret stays put
    }
    onInput(v); fit();
  };
  return html`<textarea ref=${ref} id=${id} class="autogrow" rows="1" value=${value} aria-label=${label} placeholder=${placeholder} maxlength=${maxlength} enterkeyhint=${enterkeyhint}
    onInput=${input}
    onKeyDown=${(e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && onSave) { e.preventDefault(); onSave(); }
      if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
    }} />`;
}

// A task's text: line breaks kept; lines starting with "• " (or "- ") shown as a bulleted list.
export const firstLine = (s) => { const l = String(s || '').split('\n')[0].replace(/^(• |- )/, ''); return String(s || '').includes('\n') ? l + ' …' : l; };
export function TaskText({ text }) {
  const lines = String(text || '').split('\n');
  if (lines.length === 1 && !/^(• |- )/.test(lines[0])) return text;
  const out = [];
  for (const line of lines) {
    const m = /^(• |- )(.*)$/.exec(line);
    if (m) { const last = out[out.length - 1]; if (last && last.list) last.items.push(m[2]); else out.push({ list: true, items: [m[2]] }); }
    else out.push({ line });
  }
  return html`<span class="task-text">${out.map(b => b.list
    ? html`<ul class="task-bullets">${b.items.map(i => html`<li>${i}</li>`)}</ul>`
    : html`<span class="task-line">${b.line || '\u00a0'}</span>`)}</span>`;
}

// Choose when an edit takes effect.
export function EffectPicker({ value, onChange, today, allowToday = true, hint }) {
  const tomorrow = addDays(today, 1);
  const mode = value === today ? 'today' : value === tomorrow ? 'tomorrow' : 'date';
  return html`<fieldset class="effect">
    <legend>Takes effect from</legend>
    <div class="effect-row">
      <div class="seg">
        ${allowToday && html`<button type="button" aria-pressed=${mode === 'today'} class=${mode === 'today' ? 'on' : ''} onClick=${() => onChange(today)}>Today</button>`}
        <button type="button" aria-pressed=${mode === 'tomorrow'} class=${mode === 'tomorrow' ? 'on' : ''} onClick=${() => onChange(tomorrow)}>Tomorrow</button>
      </div>
      <span class="muted small">or pick a date</span>
      <input type="date" class=${'effect-date' + (mode === 'date' ? ' on' : '')} aria-label="Other date" min=${allowToday ? today : tomorrow} value=${value} onInput=${(e) => e.target.value && onChange(e.target.value)} />
    </div>
    <p class="hint">${hint || 'Past days keep their targets and scores.'} Effective: <strong>${fmtDay(value)}</strong>.</p>
  </fieldset>`;
}

// ---------- theme (per device: stored in this browser) ----------
const themeListeners = new Set();
export function getTheme() { try { const t = localStorage.getItem('theme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } }
export function setTheme(t) {
  try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch { /* storage unavailable */ }
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  themeListeners.forEach(fn => fn(t));
}
window.addEventListener('storage', (e) => { if (e.key === 'theme') setTheme(getTheme()); });
export function useTheme() {
  const [t, set] = useState(getTheme());
  useEffect(() => { themeListeners.add(set); return () => themeListeners.delete(set); }, []);
  return [t, setTheme];
}
export const THEMES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];
export function ThemeToggle() {
  const [t, set] = useTheme();
  return html`<div class="theme-toggle" role="radiogroup" aria-label="Theme">
    ${THEMES.map(([k, l, icon]) => html`<button role="radio" aria-checked=${t === k} class=${t === k ? 'on' : ''} title=${l + ' theme'} aria-label=${l + ' theme'} onClick=${() => set(k)}><${Icon} name=${icon} size=${16} /></button>`)}
  </div>`;
}

export function Empty({ title, children }) {
  return html`<div class="empty"><strong>${title}</strong>${children && html`<div>${children}</div>`}</div>`;
}
