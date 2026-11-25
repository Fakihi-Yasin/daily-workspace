// PC Work Time: active time on the user's computers, counted by the local agent (agent/dw-pc-time.py)
// and stored as one total per day in the account. Kept apart from Focus Sessions. Only in the synced
// web build (it needs the account's database); the database checks every call.
import { html, useState, Icon, Chip, Modal, Empty, toast, addDays, fmtShort } from './lib.js';
import { useRpc, change } from './teamwork.js';

export const hasPcTime = () => !!(window.__dash && window.__dash.rpc);
const mondayOf = (d) => addDays(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7));
// Hours and minutes only ("2 h 05 min", "6 min").
const hm = (sec) => {
  if (!sec) return '0 min';
  if (sec < 60) return '< 1 min';
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
};
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtShort(iso.slice(0, 10));
};

// Today page: today and this week (Monday → today), the agent's state, Pause / Resume.
export function PcTimeCard({ today }) {
  const from = mondayOf(today);
  const { data, error } = useRpc(hasPcTime() ? 'pc_time_summary' : null, { p_from: from, p_to: today }, { poll: 60000 });
  if (!hasPcTime()) return null;
  const todaySec = data ? ((data.days.find(d => d.day === today) || {}).seconds || 0) : 0;
  const paused = data && data.settings.paused;
  const setPaused = (p) => change('pc_settings_set', { p_paused: p }, p ? 'PC Work Time paused · your computer stops counting within a minute' : 'PC Work Time resumed').catch(() => {});
  return html`<section class="card side-card pc-card" aria-label="PC Work Time">
    <div class="row"><span class="label" style="flex:1">PC Work Time</span>
      ${data && data.devices > 0 && html`<${Chip} color=${paused ? 'yellow' : 'mint'}>${paused ? 'Paused' : 'On'}<//>`}</div>
    ${error ? html`<p class="small muted">${error}</p>`
      : !data ? html`<p class="small muted">Loading…</p>`
      : data.devices === 0 && !data.total ? html`<p class="small muted">Count the time you actively use your computer, separately from focus sessions.</p>
          <a class="btn sm" href="#/settings?tab=pctime">Connect your PC</a>`
      : html`<div class="pc-nums">
          <div><span class="v num">${hm(todaySec)}</span><span class="k">Today</span></div>
          <div><span class="v num">${hm(data.total)}</span><span class="k">This week</span></div>
        </div>
        <div class="row small muted" style="margin-top:8px"><span style="flex:1">Last update from your PC: ${ago(data.last_seen_at)}</span>
          <button class="btn sm" onClick=${() => setPaused(!paused)}><${Icon} name=${paused ? 'play' : 'pause'} size=${14} />${paused ? 'Resume' : 'Pause'}</button></div>`}
  </section>`;
}

// Stats: total for the selected range, kept apart from Focus.
export function PcTimeTile({ from, to }) {
  const { data } = useRpc(hasPcTime() ? 'pc_time_summary' : null, { p_from: from, p_to: to }, { poll: 0 });
  if (!hasPcTime() || !data || (!data.devices && !data.total)) return null;
  const days = data.days.filter(d => d.seconds > 0).length;
  return html`<div class="tile"><span class="v">${hm(data.total)}</span><span class="k">PC Work Time</span>
    <span class="small muted">${days} day${days === 1 ? '' : 's'} · separate from Focus</span></div>`;
}

// Settings → PC Work Time.
export function PcTimeSettings() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: sum } = useRpc(hasPcTime() ? 'pc_time_summary' : null, { p_from: today, p_to: today }, { poll: 30000 });
  const { data: devices, error } = useRpc(hasPcTime() ? 'pc_device_list' : null, {}, { poll: 30000 });
  const [idle, setIdle] = useState(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState(null); // { name, code, command } — shown once
  const [busy, setBusy] = useState(false);
  if (!hasPcTime()) return html`<${Empty} title="PC Work Time needs cloud sync">It stores one total per day in your account, so it only works in the signed-in web version.<//>`;
  const s = sum && sum.settings;
  const idleVal = idle != null ? idle : s ? String(s.idle_minutes) : '';
  const saveIdle = async (e) => {
    e.preventDefault();
    const m = parseInt(idleVal, 10);
    if (!(m >= 1 && m <= 120)) { toast({ msg: 'Choose between 1 and 120 minutes.', kind: 'error' }); return; }
    try { await change('pc_settings_set', { p_idle_minutes: m }, `Stops counting after ${m} min without keyboard or mouse`); setIdle(null); } catch { /* toast shown */ }
  };
  const connect = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await change('pc_device_create', { p_name: name.trim() });
      const cfg = window.__DASH_CONFIG || {};
      const payload = { o: location.origin, u: cfg.supabase.url, k: cfg.supabase.publishableKey, d: r.key, n: r.name };
      const code = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      setIssued({ name: r.name, code, command: `curl -fsSL ${location.origin}/pc-agent/install.sh | bash -s -- ${code}` });
      setName('');
    } catch { /* toast shown */ } finally { setBusy(false); }
  };
  const revoke = async (d) => {
    if (!confirm(`Disconnect “${d.name}”? Its key stops working at once. Time it already recorded stays in your totals.`)) return;
    try { await change('pc_device_revoke', { p_device_id: d.id }, `${d.name} disconnected`); } catch { /* toast shown */ }
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast({ msg: 'Copied' }); } catch { toast({ msg: 'Select the text and copy it', kind: 'error' }); } };

  return html`<div class="stack pc-settings">
    <section class="card">
      <h3>PC Work Time</h3>
      <p class="muted">A small program on your computer counts the time you actively use it and adds it to your account, separately from Focus Sessions.</p>
      <ul class="small pc-rules">
        <li>Counts while you use the keyboard or mouse. Stops after <strong>${s ? s.idle_minutes : 5} min</strong> without input, while the screen is locked, and while the computer sleeps or is off. Continues by itself when you come back.</li>
        <li>Only <strong>one total per day</strong> is stored. No screenshots, no apps or window titles, nothing you type, no list of when you were active.</li>
        <li>Offline, your computer keeps the totals and sends them when the internet is back.</li>
      </ul>
    </section>

    <section class="card">
      <h3>Settings</h3>
      <form class="row wrap" style="align-items:flex-end;margin-top:10px" onSubmit=${saveIdle}>
        <label class="field">Stop counting after (minutes without keyboard or mouse)
          <input type="number" min="1" max="120" value=${idleVal} onInput=${(e) => setIdle(e.target.value)} style="width:110px" /></label>
        <button class="btn" disabled=${!s || idle == null || idle === String(s.idle_minutes)}>Save</button>
      </form>
      ${s && html`<div class="row" style="margin-top:14px"><span style="flex:1">${s.paused ? html`<${Chip} color="yellow">Paused<//> Your computers are not counting.` : html`<${Chip} color="mint">On<//> Your computers count active time.`}</span>
        <button class="btn" onClick=${() => change('pc_settings_set', { p_paused: !s.paused }, s.paused ? 'PC Work Time resumed' : 'PC Work Time paused').catch(() => {})}>
          <${Icon} name=${s.paused ? 'play' : 'pause'} size=${15} />${s.paused ? 'Resume' : 'Pause'}</button></div>
        <p class="hint">Changes reach your computers within a minute. On the computer itself: right-click “PC Work Time” in the app grid, or run <code>dw-pc-time pause</code> / <code>resume</code>.</p>`}
    </section>

    <section class="card">
      <h3>Your computers</h3>
      ${error ? html`<p class="notice" role="alert">${error}</p>` : !devices ? html`<p class="muted">Loading…</p>`
        : devices.length === 0 ? html`<p class="muted" style="margin-top:6px">No computer connected yet.</p>`
        : html`<ul class="plain" style="margin-top:8px">${devices.map(d => html`<li key=${d.id} class="row">
            <${Icon} name="monitor" size=${16} /><strong style="flex:1">${d.name}</strong>
            <span class="small muted">last update ${ago(d.last_seen_at)}</span>
            <button class="btn sm danger" onClick=${() => revoke(d)}>Disconnect</button></li>`)}</ul>`}
      <form class="row wrap" style="align-items:flex-end;margin-top:14px" onSubmit=${connect}>
        <label class="field" style="flex:1;min-width:220px">Connect a computer (Ubuntu 24.04)
          <input type="text" maxlength="80" placeholder="Name, e.g. Office PC" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <button class="btn primary" disabled=${busy || !name.trim()}><${Icon} name="plus" size=${16} />Connect this PC</button>
      </form>
    </section>

    ${issued && html`<${Modal} title=${'Connect “' + issued.name + '”'} onClose=${() => setIssued(null)} wide>
      <p>On that computer, open a <strong>Terminal</strong> and run this command (no sudo needed):</p>
      <pre class="pc-cmd" tabindex="0">${issued.command}</pre>
      <div class="row"><button class="btn primary" onClick=${() => copy(issued.command)}>Copy command</button><span class="spacer"></span>
        <button class="btn" onClick=${() => copy(issued.code)}>Copy code only</button></div>
      <p class="small muted" style="margin-top:12px">It installs the agent in your home folder and starts it with your session. The code contains this computer’s key: it is shown only now, can only add PC time to your account, and stops working when you disconnect the computer. To remove the agent later: <code>curl -fsSL ${location.origin}/pc-agent/uninstall.sh | bash</code></p>
    <//>`}
  </div>`;
}
