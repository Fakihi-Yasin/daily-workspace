// Focus session panel: compact start form, running timer, end-of-session choice, coding "Off".
import { html, useState, useEffect, useRef, useResource, api, act, bus, toast, Icon, Bar, Chip, clock, fmtDur, fmtDateTime, addDays,
  UNITS, toSec, fromSec, useNow } from './lib.js';

// ---------- one shared session store (sidebar mini-timer + main panel read the same object) ----------
let store = { session: null, off: null, loaded: false };
const subs = new Set();
let inflight = null;
export async function refreshSession() {
  if (inflight) return inflight;
  inflight = api('GET', '/api/session').then(d => { store = { ...d, loaded: true }; subs.forEach(fn => fn(store)); })
    .catch(() => {}).finally(() => { inflight = null; });
  return inflight;
}
function setStore(patch) { store = { ...store, ...patch, loaded: true }; subs.forEach(fn => fn(store)); }
bus.on(() => refreshSession());
export function useSession() {
  const [s, set] = useState(store);
  useEffect(() => { subs.add(set); if (!store.loaded) refreshSession(); else set(store); return () => subs.delete(set); }, []);
  return s;
}

export function liveActual(s, now = Date.now()) {
  let a = s.accumulated_sec;
  if (s.state === 'running' && s.run_started_at) a += Math.max(0, now - s.run_started_at) / 1000;
  return Math.max(0, Math.min(a, s.planned_sec));
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.08, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.6);
  } catch { /* audio unavailable */ }
}

const sessionTitle = (s) => s.task_label || (s.milestone && s.milestone.title) || (s.project && s.project.name) || 'Quick task';
const sessionSub = (s) => [s.project ? s.project.name : 'Quick task', s.category && s.category.name].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ');

// Session actions update the shared store immediately, then every view refreshes.
async function sessionAct(method, url, body) {
  const r = await act(method, url, body);
  if (r && r.id && r.state) setStore({ session: r.state === 'finished' ? null : r });
  return r;
}

// Other parts of Today (e.g. a "My tasks" row) can open the Start form with a prefilled task.
const startRequests = new Set();
export function requestStart(prefill) {
  if (store.session) { toast({ msg: 'A session is already running — end it first', kind: 'error' }); return false; }
  startRequests.forEach(fn => fn(prefill));
  return true;
}

export function FocusPanel({ today, tz }) {
  const { session, off, loaded } = useSession();
  const [mode, setMode] = useState(null); // 'start' | 'off' | 'stop'
  const [ended, setEnded] = useState(null); // last finished session, for the result + milestone question
  const [prefill, setPrefill] = useState(null);
  const ref = useRef();
  useEffect(() => {
    const fn = (p) => {
      setPrefill({ ...p, key: Date.now() }); setMode('start');
      setTimeout(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, 30);
    };
    startRequests.add(fn); return () => startRequests.delete(fn);
  }, []);

  // Refresh exactly when the coding pause ends so the prompt comes back.
  useEffect(() => {
    if (!off) return;
    const ms = off.until - Date.now();
    if (ms > 0 && ms < 2 ** 31) { const t = setTimeout(() => bus.emit(false), ms + 500); return () => clearTimeout(t); }
  }, [off && off.until]);

  if (!loaded) return html`<section class="card fp" aria-label="Focus session"><span class="muted small">Loading…</span></section>`;

  const finish = async () => {
    const r = await sessionAct('POST', `/api/session/${session.id}/finish`);
    setEnded(r);
    toast({ msg: `Session saved · ${fmtDur(r.accumulated_sec)} on ${sessionTitle(r)}` });
    return r;
  };

  if (session) {
    return session.state === 'expired'
      ? html`<${Expired} s=${session} onFinish=${finish} onOther=${async () => { await finish(); setMode('start'); }} onStop=${async () => { await finish(); setMode('stop'); }} />`
      : html`<${Running} s=${session} onFinish=${finish} />`;
  }

  const result = ended && html`<${EndedResult} s=${ended} onClose=${() => setEnded(null)} />`;
  if (mode === 'start') return html`<div class="stack" ref=${ref}>${result}<${StartForm} key=${prefill ? prefill.key : 'new'} prefill=${prefill}
    onCancel=${() => { setMode(null); setPrefill(null); }} onStarted=${() => { setMode(null); setEnded(null); setPrefill(null); }} /></div>`;
  if (mode === 'off' || mode === 'stop') {
    return html`<div class="stack">${result}<section class="card fp" aria-label="Pause focus prompts">
      <div class="fp-head"><span class="label">${mode === 'stop' ? 'Stop for today' : 'Off'}</span><span class="spacer"></span>
        <button class="btn sm ghost" onClick=${() => setMode(null)}>${mode === 'stop' ? 'No, just end the session' : 'Cancel'}</button></div>
      <p class="small muted">Pauses only the focus prompt. Your routines stay available.</p>
      <${OffChooser} today=${today} onDone=${() => setMode(null)} />
    </section></div>`;
  }
  if (off) {
    return html`<div class="stack">${result}<section class="card fp fp-off" aria-label="Focus prompts paused">
      <div class="fp-row">
        <div class="fp-main"><span class="label"><${Icon} name="moon" size=${13} /> Focus off</span>
          <div class="fp-title">Paused until ${fmtDateTime(off.until, tz)}</div></div>
        <div class="fp-actions">
          <button class="btn sm" onClick=${() => act('POST', '/api/off/extend', { days: 1 })}>+1 day</button>
          <button class="btn sm" onClick=${() => act('POST', '/api/off/extend', { days: 7 })}>+1 week</button>
          <button class="btn sm" onClick=${async () => { await act('DELETE', '/api/off'); toast({ msg: 'Pause cancelled' }); }}>Cancel pause</button>
          <button class="btn sm primary" onClick=${() => setMode('start')}>Start a session</button>
        </div>
      </div>
    </section></div>`;
  }
  return html`<div class="stack">${result}<section class="card fp" aria-label="Focus session">
    <div class="fp-row">
      <div class="fp-main"><span class="label">Focus session</span><div class="fp-title muted-title">No session running</div></div>
      <div class="fp-actions">
        <button class="btn ghost sm" onClick=${() => setMode('off')}><${Icon} name="moon" size=${15} />Off</button>
        <button class="btn primary" onClick=${() => setMode('start')}><${Icon} name="play" size=${15} />Start a session</button>
      </div>
    </div>
  </section></div>`;
}

function EndedResult({ s, onClose }) {
  const [busy, setBusy] = useState(false);
  const m = s.milestone;
  return html`<section class="card fp fp-result" role="status" aria-label="Session saved">
    <div class="fp-row">
      <div class="fp-main">
        <span class="label">Session saved</span>
        <div class="fp-title">${sessionTitle(s)}</div>
        <div class="small muted">${sessionSub(s)} · <strong class="num">${fmtDur(s.accumulated_sec)}</strong> actual · ${s.end_reason === 'completed' ? 'Completed' : 'Ended early'}</div>
      </div>
      <div class="fp-actions">
        ${m && !m.done ? html`<span class="small">Mark “${m.title}” done?</span>
          <button class="btn sm primary" disabled=${busy} onClick=${async () => { setBusy(true); await act('PUT', `/api/milestones/${m.id}`, { done: true }); toast({ msg: `“${m.title}” marked done` }); onClose(); }}>Mark done</button>
          <button class="btn sm" onClick=${onClose}>Keep for later</button>`
        : html`<button class="icon-btn" aria-label="Dismiss" onClick=${onClose}><${Icon} name="x" size=${16} /></button>`}
      </div>
    </div>
  </section>`;
}

function Running({ s, onFinish }) {
  const now = useNow();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [extOpen, setExtOpen] = useState(false);
  const fired = useRef(false);
  const actual = liveActual(s, now);
  const left = s.planned_sec - actual;
  const paused = s.state === 'paused';
  useEffect(() => {
    if (s.state === 'running' && left <= 0 && !fired.current) { fired.current = true; beep(); refreshSession(); bus.emit(false); }
    document.title = `${paused ? '⏸ ' : ''}${clock(left)} · ${sessionTitle(s)}`;
  });
  useEffect(() => () => { document.title = 'Today · Dashboard'; }, []);
  const ext = async (sec) => { setExtOpen(false); await sessionAct('POST', `/api/session/${s.id}/extend`, { duration_sec: sec }); toast({ msg: `+${fmtDur(sec)} added` }); };
  return html`<section class=${'card fp fp-live' + (paused ? ' is-paused' : '')} aria-label="Current focus session">
    <div class="fp-row">
      <div class="fp-main">
        <span class="label">${paused ? 'Paused' : 'Focus session'}</span>
        <div class="fp-title">${sessionTitle(s)}</div>
        <div class="small muted">${sessionSub(s)}</div>
      </div>
      <div class="fp-clock" role="timer" aria-label=${'Time remaining ' + clock(left)}>${clock(left)}</div>
      <div class="fp-actions">
        ${paused
          ? html`<button class="btn primary sm" onClick=${() => sessionAct('POST', `/api/session/${s.id}/resume`)}><${Icon} name="play" size=${14} />Resume</button>`
          : html`<button class="btn sm" onClick=${() => sessionAct('POST', `/api/session/${s.id}/pause`)}><${Icon} name="pause" size=${14} />Pause</button>`}
        <div class="menu">
          <button class="btn sm" aria-expanded=${extOpen} onClick=${() => setExtOpen(!extOpen)}><${Icon} name="plus" size=${14} />Extend</button>
          ${extOpen && html`<div class="menu-pop">
            ${[[300, '+5 min'], [900, '+15 min'], [1800, '+30 min'], [3600, '+1 h']].map(([sec, l]) => html`<button class="item" onClick=${() => ext(sec)}>${l}</button>`)}
            <${DurationForm} label="Add" onSubmit=${ext} />
          </div>`}
        </div>
        ${confirmEnd
          ? html`<span class="small">End now?</span>
              <button class="btn sm dark" onClick=${async () => { setConfirmEnd(false); await onFinish(); }}>Yes, end it</button>
              <button class="btn sm" onClick=${() => setConfirmEnd(false)}>No</button>`
          : html`<button class="btn sm" onClick=${() => setConfirmEnd(true)}><${Icon} name="stop" size=${13} />End</button>`}
      </div>
    </div>
    <div class="fp-progress">
      <${Bar} value=${(actual / s.planned_sec) * 100} thin label="Session progress" />
      <span class="small muted num">Actual ${fmtDur(actual)} · planned ${fmtDur(s.planned_sec)}${paused ? ' · paused time not counted' : ''}</span>
    </div>
  </section>`;
}

function DurationForm({ label = 'OK', onSubmit }) {
  const [v, setV] = useState('');
  const [u, setU] = useState('min');
  return html`<form class="inner row" onSubmit=${(e) => { e.preventDefault(); const sec = toSec(v, u); if (sec >= 60) onSubmit(sec); }}>
    <input type="number" min="1" step="any" value=${v} onInput=${(e) => setV(e.target.value)} placeholder="0" aria-label="Amount" style="width:70px" />
    <select value=${u} onChange=${(e) => setU(e.target.value)} aria-label="Unit" style="width:auto">${UNITS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
    <button class="btn sm">${label}</button>
  </form>`;
}

function Expired({ s, onFinish, onOther, onStop }) {
  useEffect(() => { document.title = '⏰ Time’s up · Dashboard'; return () => { document.title = 'Today · Dashboard'; }; }, []);
  const ext = (sec) => sessionAct('POST', `/api/session/${s.id}/extend`, { duration_sec: sec });
  return html`<section class="card fp fp-live is-expired" role="alert" aria-label="Time’s up">
    <div class="fp-row">
      <div class="fp-main">
        <span class="label">Time’s up</span>
        <div class="fp-title">${sessionTitle(s)}</div>
        <div class="small muted">${sessionSub(s)} · actual ${fmtDur(s.actual_sec)}. Nothing changes until you choose.</div>
      </div>
      <div class="fp-actions">
        <span class="small muted">Continue</span>
        ${[[600, '+10 min'], [1500, '+25 min'], [3600, '+1 h']].map(([sec, l]) => html`<button class="btn sm primary" onClick=${() => ext(sec)}>${l}</button>`)}
      </div>
    </div>
    <div class="fp-row" style="margin-top:10px">
      <${DurationForm} label="Continue" onSubmit=${ext} />
      <span class="spacer"></span>
      <button class="btn sm" onClick=${onOther}>Pick another project</button>
      <button class="btn sm" onClick=${onStop}>Stop for today</button>
      <button class="btn sm ghost" onClick=${onFinish}>Just end it</button>
    </div>
  </section>`;
}

function OffChooser({ today, onDone }) {
  const [custom, setCustom] = useState(false);
  const [d, setD] = useState(addDays(today, 3));
  const [t, setT] = useState('08:00');
  const go = async (body) => { await act('POST', '/api/off', body); toast({ msg: 'Focus prompts paused' }); onDone && onDone(); };
  return html`<div style="margin-top:10px">
    <div class="row wrap">
      <button class="btn sm" onClick=${() => go({ preset: 'tomorrow' })}>Until tomorrow</button>
      <button class="btn sm" onClick=${() => go({ preset: 'week' })}>1 week</button>
      <button class="btn sm" aria-expanded=${custom} onClick=${() => setCustom(!custom)}>Custom date</button>
    </div>
    ${custom && html`<form class="row wrap" style="margin-top:10px" onSubmit=${(e) => { e.preventDefault(); go({ preset: 'custom', until_date: d, until_time: t }); }}>
      <input type="date" min=${today} value=${d} onInput=${(e) => setD(e.target.value)} aria-label="Pause end (date)" style="width:auto" />
      <input type="time" value=${t} onInput=${(e) => setT(e.target.value)} aria-label="Pause end (time)" style="width:auto" />
      <button class="btn sm primary">Pause focus prompts</button>
    </form>`}
  </div>`;
}

const PRESETS = [[1500, '25 min'], [2700, '45 min'], [3600, '1 h'], [5400, '1 h 30'], [7200, '2 h']];

function StartForm({ onCancel, onStarted, prefill }) {
  const { data: projects } = useResource('/api/projects');
  const { data: cats } = useResource('/api/categories');
  const [proj, setProj] = useState('');
  const [task, setTask] = useState(prefill && prefill.task_label ? prefill.task_label : '');
  const [milestone, setMilestone] = useState(null);
  const [cat, setCat] = useState('');
  const saved = (() => { try { return +localStorage.getItem('lastDurationSec') || 2700; } catch { return 2700; } })();
  const [[amount, unit], setDur] = useState(fromSec(saved));
  const [busy, setBusy] = useState(false);
  const sec = toSec(amount, unit);
  const valid = sec >= 60 && sec <= 30 * 86400;
  const p = (projects || []).find(x => x.id === +proj);
  const open = (projects || []).filter(x => x.status !== 'done');
  const groups = (cats || []).map(c => [c, open.filter(x => x.category_id === c.id)]).filter(([, l]) => l.length);
  const uncategorised = open.filter(x => !x.category_id || !(cats || []).some(c => c.id === x.category_id));
  const suggestions = p ? [...p.milestones.filter(m => !m.done).map(m => ({ label: m.title, milestone: m.id })), ...(p.next_action ? [{ label: p.next_action, milestone: null }] : [])].slice(0, 8) : [];
  const start = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    if (!p && !task.trim()) return toast({ msg: 'Type a task or choose a project', kind: 'error' });
    setBusy(true);
    try {
      try { localStorage.setItem('lastDurationSec', String(sec)); } catch { /* ignore */ }
      const r = await sessionAct('POST', '/api/session/start', { project_id: p ? p.id : null, milestone_id: milestone, task_label: task, category_id: p ? null : (+cat || null), duration_sec: sec });
      setStore({ session: r, off: null });
      onStarted();
    } catch { setBusy(false); }
  };
  return html`<form class="card fp fp-form" onSubmit=${start} aria-label="Start a focus session">
    <div class="fp-head"><span class="label">Start a session</span><span class="spacer"></span><button type="button" class="btn sm ghost" onClick=${onCancel}>Cancel</button></div>
    <div class="fp-grid">
      <label class="field">Project
        <select value=${proj} onChange=${(e) => { setProj(e.target.value); setMilestone(null); const np = (projects || []).find(x => x.id === +e.target.value); setTask(np && np.next_action ? np.next_action : ''); }}>
          <option value="">Quick task (no project)</option>
          ${groups.map(([c, l]) => html`<optgroup label=${c.name}>${l.map(x => html`<option value=${x.id}>${x.name}${x.topic ? ' — ' + x.topic : ''}</option>`)}</optgroup>`)}
          ${uncategorised.length > 0 && html`<optgroup label="No category">${uncategorised.map(x => html`<option value=${x.id}>${x.name}</option>`)}</optgroup>`}
        </select>
      </label>
      ${!p && html`<label class="field"><span>Category <span class="hint">(optional)</span></span>
        <select value=${cat} onChange=${(e) => setCat(e.target.value)}><option value="">None</option>${(cats || []).filter(c => c.coding).map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></label>`}
      <label class="field fp-task">${p ? 'Task' : 'Quick task'}
        <input type="text" value=${task} onInput=${(e) => { setTask(e.target.value); const m = suggestions.find(s => s.label === e.target.value); setMilestone(m ? m.milestone : null); }}
          placeholder=${p ? 'What part of the project?' : 'e.g. fix the pricing page'} required=${!p} />
      </label>
    </div>
    ${suggestions.length > 0 && html`<div class="chips-row" aria-label="Project tasks">${suggestions.map(s => html`<button type="button" class=${'chip-btn' + (s.label === task ? ' on' : '')}
      aria-pressed=${s.label === task} onClick=${() => { setTask(s.label); setMilestone(s.milestone); }}>${s.milestone ? '◇ ' : ''}${s.label}</button>`)}</div>`}
    <div class="fp-dur">
      <div class="field"><span>Duration</span>
        <div class="row">
          <input type="number" min="1" step="any" value=${amount} onInput=${(e) => setDur([e.target.value, unit])} aria-label="Duration amount" style="width:88px" />
          <select value=${unit} onChange=${(e) => setDur([amount, e.target.value])} aria-label="Duration unit" style="width:auto">${UNITS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
          <span class="small muted num" aria-live="polite">${valid ? '= ' + fmtDur(sec) : 'Between 1 minute and 30 days'}</span>
        </div>
      </div>
      <div class="chips-row">${PRESETS.map(([v, l]) => html`<button type="button" class=${'chip-btn' + (sec === v ? ' on' : '')} aria-pressed=${sec === v} onClick=${() => setDur(fromSec(v))}>${l}</button>`)}</div>
      <span class="spacer"></span>
      <button class="btn primary" disabled=${!valid || busy}><${Icon} name="play" size=${15} />Start</button>
    </div>
    ${p && html`<p class="hint">The timer logs time on ${p.name}; it never marks a milestone done by itself.</p>`}
  </form>`;
}

export function MiniTimer() {
  const { session: s } = useSession();
  const now = useNow(!!s);
  if (!s) return null;
  const left = s.planned_sec - liveActual(s, now);
  const label = s.state === 'paused' ? 'Paused' : s.state === 'expired' ? 'Time’s up' : sessionTitle(s);
  return html`<a class=${'mini-timer ' + s.state} href="#/today" aria-label=${'Timer: ' + label}>
    <small>${label}</small><b>${s.state === 'expired' ? '0:00' : clock(left)}</b>
  </a>`;
}
