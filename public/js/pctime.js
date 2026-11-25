// PC Work Time: active time on the user's computers, counted by the local agent (agent/dw-pc-time.py)
// and stored as one total per day in the account. Kept apart from Focus Sessions. Only in the synced
// web build (it needs the account's database); the database checks every call.
import { html, useState, Icon, Chip, Modal, Empty, toast, addDays, fmtShort } from './lib.js';
import { useRpc, change } from './teamwork.js';

const guessOs = () => { const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''; return /win/i.test(p) ? 'windows' : /mac/i.test(p) ? 'mac' : 'linux'; };
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
        <${SplitBar} total=${data.total} work=${data.work} personal=${data.personal} label="This week" />
        <div class="row small muted" style="margin-top:8px"><span style="flex:1">Last update from your PC: ${ago(data.last_seen_at)}</span>
          <button class="btn sm" onClick=${() => setPaused(!paused)}><${Icon} name=${paused ? 'play' : 'pause'} size=${14} />${paused ? 'Resume' : 'Pause'}</button></div>`}
  </section>`;
}

// Work vs Personal (from Activity Details, classified on the computer; only these totals are synced).
function SplitBar({ total, work, personal, label }) {
  if (!total) return null;
  if (!work && !personal) return html`<p class="small muted" style="margin-top:8px">Work vs Personal: turn on Activity Details on your computer (Settings → PC Work Time).</p>`;
  const other = Math.max(0, total - work - personal);
  const pc = (v) => `${(100 * v / total).toFixed(1)}%`;
  return html`<div class="pc-split" style="margin-top:10px" aria-label=${label + ': Work ' + hm(work) + ', Personal ' + hm(personal) + ', Uncategorized ' + hm(other)}>
    <div class="pc-split-bar"><i class="w" style=${{ width: pc(work) }}></i><i class="p" style=${{ width: pc(personal) }}></i><i class="u" style=${{ width: pc(other) }}></i></div>
    <div class="row small"><span><b class="dot w"></b>Work ${hm(work)}</span><span><b class="dot p"></b>Personal ${hm(personal)}</span><span class="muted"><b class="dot u"></b>Other ${hm(other)}</span></div>
  </div>`;
}

// Stats: total for the selected range, kept apart from Focus.
export function PcTimeTile({ from, to }) {
  const { data } = useRpc(hasPcTime() ? 'pc_time_summary' : null, { p_from: from, p_to: to }, { poll: 0 });
  if (!hasPcTime() || !data || (!data.devices && !data.total)) return null;
  const days = data.days.filter(d => d.seconds > 0).length;
  return html`<div class="tile"><span class="v">${hm(data.total)}</span><span class="k">PC Work Time</span>
    <span class="small muted">${days} day${days === 1 ? '' : 's'}${data.work || data.personal ? ` · Work ${hm(data.work)} · Personal ${hm(data.personal)}` : ''} · separate from Focus</span></div>`;
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
      setIssued({ name: r.name, code, os: guessOs(), commands: {
        linux: `curl -fsSL ${location.origin}/pc-agent/install.sh | bash -s -- ${code}`,
        mac: `curl -fsSL ${location.origin}/pc-agent/install-macos.sh | bash -s -- ${code}`,
        windows: `$env:DW_CODE='${code}'; irm ${location.origin}/pc-agent/install-windows.ps1 | iex`,
      } });
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
        <li>Your account stores only <strong>daily totals</strong>: active time and, if you turn on Activity Details, how much of it was Work or Personal.</li>
        <li>Never, on any system: screenshots or screen recording, what you type (keys, passwords, messages, clipboard), window or page titles, full web addresses. Idle time comes only from the system’s own idle timer.</li>
        <li>Offline, your computer keeps counting and sends the totals when the internet is back.</li>
      </ul>
    </section>

    <section class="card">
      <h3>Activity Details <span class="small muted">(optional, off by default)</span></h3>
      <p class="muted">See where your time went: time per app and, with the browser extension, per website domain, a daily timeline, and Work / Personal / Uncategorized. These details <strong>stay on the computer</strong>; only the daily Work and Personal totals reach your account.</p>
      <ol class="small pc-rules">
        <li>On the computer, run <code>dw-pc-time details on</code>, then <code>dw-pc-time open</code> to see the timeline, classify apps and sites, exclude some, or delete history (Linux: also “PC Work Time → Activity Details” in the app menu).</li>
        <li>Website domains (optional): run <code>dw-pc-time browser-extension</code> and follow the steps (Chrome, Edge, Brave; Firefox as a temporary add-on). It sends only the domain of the active tab — e.g. github.com — to the agent on the same computer.</li>
        <li>Ubuntu on Wayland (the default): GNOME doesn’t let programs see the app in front. Run <code>dw-pc-time gnome-extension</code>, then log out and back in. Without it, Linux records websites (with the browser extension) but shows other apps as “Unknown app”.</li>
      </ol>
      <div class="row" style="margin-top:12px"><span class="small muted" style="flex:1">Delete history: on the computer, use the local page. Here you can delete the synced daily totals.</span>
        <button class="btn sm danger" onClick=${() => confirm('Delete all synced PC Work Time totals (active, Work, Personal) from your account? Your computers keep their local copies and send totals again from now on.') && change('pc_history_delete', { p_before: null }, 'Synced PC Work Time history deleted').catch(() => {})}>Delete synced history</button></div>
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
        <label class="field" style="flex:1;min-width:220px">Connect a computer (Ubuntu / Linux, macOS or Windows)
          <input type="text" maxlength="80" placeholder="Name, e.g. Office PC" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <button class="btn primary" disabled=${busy || !name.trim()}><${Icon} name="plus" size=${16} />Connect this PC</button>
      </form>
    </section>

    ${issued && html`<${Modal} title=${'Connect “' + issued.name + '”'} onClose=${() => setIssued(null)} wide>
      <div class="seg" role="tablist" aria-label="Operating system">${[['linux', 'Ubuntu / Linux'], ['mac', 'macOS'], ['windows', 'Windows']].map(([k, l]) => html`<button role="tab" aria-selected=${issued.os === k} class=${issued.os === k ? 'on' : ''} onClick=${() => setIssued({ ...issued, os: k })}>${l}</button>`)}</div>
      <p style="margin-top:12px">${issued.os === 'windows' ? html`On that computer, open <strong>PowerShell</strong> (no admin needed) and run:` : html`On that computer, open <strong>Terminal</strong> and run (no sudo needed):`}</p>
      <pre class="pc-cmd" tabindex="0">${issued.commands[issued.os]}</pre>
      <div class="row"><button class="btn primary" onClick=${() => copy(issued.commands[issued.os])}>Copy command</button><span class="spacer"></span>
        <button class="btn" onClick=${() => copy(issued.code)}>Copy code only</button></div>
      <p class="small muted" style="margin-top:12px">${issued.os === 'linux' ? 'Needs python3 and gdbus (both come with Ubuntu). Starts with your desktop session (systemd user service).'
        : issued.os === 'mac' ? 'Needs python3 (macOS offers to install the Command Line Tools the first time). Starts at login (LaunchAgent).'
        : 'Needs Python 3.9+ (winget install Python.Python.3.12). Starts at login (your user’s Run key), with no window.'}
        The code contains this computer’s key: it is shown only now, can only add PC time to your account, and stops working when you disconnect the computer.
        ${issued.os === 'linux' && html` Remove later: <code>curl -fsSL ${location.origin}/pc-agent/uninstall.sh | bash</code>`}</p>
    <//>`}
  </div>`;
}
