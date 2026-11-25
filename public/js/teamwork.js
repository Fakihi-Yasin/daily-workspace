// Team Work: private teams with shared tasks, future projects and a daily team score.
// Data lives in the shared Supabase tables (never in personal snapshots) and every read and write
// goes through database functions that check role, blocked status and team membership. The
// permission checks below only decide which buttons to show.
import { html, useState, useEffect, useRef, useCallback, useResource, Icon, Chip, Modal, Empty, TaskText, toast, fmtDay, fmtShort, addDays, pct, bus } from './lib.js';

export const rpc = (name, args) => window.__dash.rpc(name, args);

// Load from a database function; refresh on app changes, on focus, and every 20 s while visible
// (teammates' updates show up without a reload).
export function useRpc(name, args, { poll = 20000 } = {}) {
  const key = name && JSON.stringify([name, args]);
  const [state, set] = useState({ data: null, error: null, key: null });
  const keyRef = useRef(key);
  keyRef.current = key;
  const load = useCallback(async () => {
    const k = keyRef.current;
    if (!k) return;
    const [n, a] = JSON.parse(k);
    try { const data = await rpc(n, a); if (k === keyRef.current) set({ data, error: null, key: k }); }
    catch (e) { if (k === keyRef.current) set(s => ({ ...s, error: e.message, key: k })); }
  }, []);
  useEffect(() => { load(); }, [key]);
  useEffect(() => bus.on(load), []);
  useEffect(() => {
    if (!poll) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, poll);
    return () => clearInterval(t);
  }, [poll]);
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, reload: load };
}

// Run a change, refresh every view, show errors.
export async function change(name, args, okMsg) {
  try {
    const r = await rpc(name, args);
    bus.emit(false);
    if (okMsg) toast({ msg: okMsg });
    return r;
  } catch (e) {
    toast({ msg: e.message, kind: 'error' });
    throw e;
  }
}

export const STATUSES = [['todo', 'To do', 'ink'], ['in_progress', 'In progress', 'blue'], ['blocked', 'Blocked', 'pink'], ['done', 'Done', 'mint']];
const statusLabel = (s) => (STATUSES.find(x => x[0] === s) || [s, s])[1];
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const isSuper = () => window.__dash && window.__dash.role === 'super_admin';
// Creating teams is for Admins and Super Admins; a User works in the teams they're added to.
const canCreateTeams = () => window.__dash && (window.__dash.role === 'admin' || window.__dash.role === 'super_admin');

// ---------- counts shown on Team Work and Stats ----------
export function TeamCountTiles() {
  const { data } = useRpc('team_stats', {}, { poll: 0 });
  if (!data) return null;
  return html`<div class="tiles">
    <div class="tile"><span class="v">${data.my_teams}</span><span class="k">Teams I belong to</span></div>
    ${data.total_teams != null && html`<div class="tile"><span class="v">${data.total_teams}</span><span class="k">Total teams in the app</span><span class="small muted">Super Admin only</span></div>`}
  </div>`;
}

export function TeamWork({ sub }) {
  if (sub) return html`<${TeamPage} id=${sub} key=${sub} />`;
  return html`<${TeamLanding} />`;
}

// ---------- landing: my teams (and all teams for a Super Admin) ----------
function TeamLanding() {
  const [scope, setScope] = useState('mine');
  const { data, error } = useRpc('team_list', { p_scope: scope });
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]); // accounts chosen as members of the new team
  const [busy, setBusy] = useState(false);
  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await change('team_create_with_members', { p_name: name.trim(), p_member_ids: picked.map(u => u.id) },
        picked.length ? `Team created with ${picked.length} member${picked.length === 1 ? '' : 's'}` : 'Team created');
      setName(''); setPicked([]); location.hash = '#/teams/' + r.id;
    } catch { /* toast shown */ } finally { setBusy(false); }
  };
  return html`<div>
    <header class="page-head"><h1>Team Work</h1><span class="muted">Private teams: only their members see them.</span></header>
    <${TeamCountTiles} />
    <section class="section">
      <div class="section-head"><h3>${scope === 'all' ? 'All teams' : 'My teams'}</h3>
        ${isSuper() && html`<div class="seg" role="tablist" aria-label="Which teams">
          <button role="tab" aria-selected=${scope === 'mine'} class=${scope === 'mine' ? 'on' : ''} onClick=${() => setScope('mine')}>My teams</button>
          <button role="tab" aria-selected=${scope === 'all'} class=${scope === 'all' ? 'on' : ''} onClick=${() => setScope('all')}>All teams</button></div>`}
      </div>
      ${scope === 'mine' && canCreateTeams() && html`<form class="card flat team-new create-team" onSubmit=${create}>
        <h4>Create a team</h4>
        <label class="field" for="team-name">Team name
          <input id="team-name" type="text" maxlength="80" placeholder="e.g. Content crew" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <${DirectoryPicker} picked=${picked} setPicked=${setPicked} />
        <div class="row"><span class="small muted">${picked.length ? `You + ${picked.length} member${picked.length === 1 ? '' : 's'}` : 'Just you for now: you can add members later too.'}</span><span class="spacer"></span>
          <button class="btn primary" disabled=${busy || !name.trim()}><${Icon} name="plus" size=${16} />Create team</button></div>
      </form>`}
      ${error ? html`<p class="notice" role="alert">${error}</p>`
        : !data ? html`<p class="muted">Loading…</p>`
        : data.length === 0 ? html`<${Empty} title=${scope === 'all' ? 'No teams in the app yet' : 'You’re not in a team yet'}>${scope !== 'mine' ? '' : canCreateTeams() ? 'Create one above, then add people by the email they signed up with.' : 'When a team owner adds you by your email, the team shows up here.'}<//>`
        : html`<div class="cards team-cards">${data.map(t => html`<a class="card team-card" href=${'#/teams/' + t.id} key=${t.id}>
            <div class="row"><strong class="team-name">${t.name}</strong><span class="spacer"></span>
              ${t.my_role ? html`<${Chip} color=${t.my_role === 'owner' ? 'solid' : 'ink'}>${t.my_role === 'owner' ? 'Owner' : 'Member'}<//>` : html`<${Chip} color="yellow">Viewing<//>`}</div>
            <span class="small muted">Owner: ${t.owner.name} · ${t.members} member${t.members === 1 ? '' : 's'}</span>
            <div class="row wrap small">
              <span>${t.open} open</span>
              ${t.blocked > 0 && html`<${Chip} color="pink">${t.blocked} blocked<//>`}
              <span class="muted">${t.done} done</span>
            </div>
          </a>`)}</div>`}
    </section>
  </div>`;
}

// Members for a new team: search the accounts by email (or name) and select them. The list comes from
// team_member_directory(), which only answers active Admins and Super Admins (the people who can
// create teams) and never includes blocked accounts.
function DirectoryPicker({ picked, setPicked }) {
  const { data, error } = useRpc('team_member_directory', {}, { poll: 0 });
  const [q, setQ] = useState('');
  const label = (u) => u.email || u.name || 'Account without an email';
  const needle = q.trim().toLowerCase();
  const chosen = new Set(picked.map(u => u.id));
  const rows = (data || []).filter(u => !needle || [u.email, u.name].some(v => v && v.toLowerCase().includes(needle))).slice(0, 50);
  const toggle = (u) => setPicked(chosen.has(u.id) ? picked.filter(x => x.id !== u.id) : [...picked, u]);
  return html`<div class="field dir-picker">
    <span id="dir-label">Members</span>
    ${picked.length > 0 && html`<div class="row wrap picked">${picked.map(u => html`<span class="logged" key=${u.id}>${label(u)}
      <button type="button" aria-label=${'Remove ' + label(u)} onClick=${() => toggle(u)}><${Icon} name="x" size=${13} /></button></span>`)}</div>`}
    <label class="search"><${Icon} name="search" size=${16} />
      <input type="search" placeholder="Search by email" aria-label="Search accounts by email" aria-describedby="dir-label" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    ${error ? html`<p class="notice" role="alert">${error}</p>`
      : !data ? html`<p class="small muted">Loading accounts…</p>`
      : rows.length === 0 ? html`<p class="small muted">${data.length ? 'No account matches “' + q.trim() + '”.' : 'No other accounts yet.'}</p>`
      : html`<ul class="member-list" role="list" aria-label="Accounts">${rows.map(u => html`<li key=${u.id}>
          <label class="pick-row"><input type="checkbox" checked=${chosen.has(u.id)} onChange=${() => toggle(u)} />
            <span class="pick-avatar" aria-hidden="true">${label(u).slice(0, 1).toUpperCase()}</span>
            <span class="pick-id"><strong>${u.email || html`<span class="muted">no email on file</span>`}</strong>
              <span class="small muted">${u.name || ''}${u.email && !u.email_verified ? (u.name ? ' · ' : '') + 'unconfirmed email' : ''}</span></span></label>
        </li>`)}</ul>`}
    ${data && data.length > 50 && !needle && html`<p class="hint">Showing 50 of ${data.length}. Type to search.</p>`}
  </div>`;
}

// ---------- one team ----------
const TABS = [['board', 'Board'], ['people', 'People'], ['scores', 'Daily score'], ['future', 'Future projects'], ['activity', 'Activity']];

function TeamPage({ id }) {
  const { data, error } = useRpc('team_get', { p_team_id: id });
  const { data: boot } = useResource('/api/bootstrap');
  const [tab, setTab] = useState('board');
  if (error) return html`<div><p><a href="#/teams" class="link-btn">← Team Work</a></p>
    <${Empty} title=${/not found/i.test(error) ? 'Team not found' : 'Can’t open this team'}>${/not found/i.test(error) ? 'It was deleted, or you’re not a member of it.' : error}<//></div>`;
  if (!data || !boot) return html`<p class="muted">Loading…</p>`;
  const today = boot.today;
  const me = data.me;
  const ctx = { team: data, me, today, tz: boot.tz, owner: me.access === 'owner', member: me.access === 'owner' || me.access === 'member' };
  const t = data.tasks;
  const overdue = t.filter(k => k.status !== 'done' && k.due_date && k.due_date < today).length;
  return html`<div class="team-page">
    <p><a href="#/teams" class="link-btn">← Team Work</a></p>
    <header class="page-head">
      <h1>${data.team.name}</h1>
      ${me.access === 'owner' ? html`<${Chip} color="solid">Owner<//>` : me.access === 'member' ? html`<${Chip}>Member<//>` : html`<${Chip} color="yellow">Viewing as Super Admin (read-only)<//>`}
      <span class="spacer"></span>
      ${ctx.owner && html`<${TeamMenu} team=${data.team} />`}
    </header>
    <div class="tiles team-summary">
      <div class="tile"><span class="v">${t.filter(k => k.status === 'todo').length}</span><span class="k">To do</span></div>
      <div class="tile"><span class="v">${t.filter(k => k.status === 'in_progress').length}</span><span class="k">In progress</span></div>
      <div class=${'tile' + (t.some(k => k.status === 'blocked') ? ' warn' : '')}><span class="v">${t.filter(k => k.status === 'blocked').length}</span><span class="k">Blocked (stuck)</span></div>
      <div class=${'tile' + (overdue ? ' warn' : '')}><span class="v">${overdue}</span><span class="k">Overdue</span></div>
      <div class="tile"><span class="v">${t.filter(k => k.status === 'done').length}</span><span class="k">Done</span></div>
    </div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}
      ${k === 'people' ? html`<span class="count">${data.members.length}</span>` : k === 'future' ? html`<span class="count">${data.projects.filter(p => !p.moved_at).length}</span>` : ''}</button>`)}</div>
    ${tab === 'board' && html`<${Board} ctx=${ctx} />`}
    ${tab === 'people' && html`<${People} ctx=${ctx} />`}
    ${tab === 'scores' && html`<${Scores} ctx=${ctx} />`}
    ${tab === 'future' && html`<${Future} ctx=${ctx} />`}
    ${tab === 'activity' && html`<${Activity} ctx=${ctx} />`}
  </div>`;
}

function TeamMenu({ team }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  const del = async () => {
    if (!confirm(`Delete the team “${team.name}” with all its tasks and future projects? This can’t be undone.`)) return;
    try { await change('team_delete', { p_team_id: team.id }, 'Team deleted'); location.hash = '#/teams'; } catch { /* toast shown */ }
  };
  return html`<div class="row">
    <button class="btn sm" onClick=${() => setRenaming(true)}><${Icon} name="edit" size=${14} />Rename</button>
    <button class="btn sm danger" onClick=${del}>Delete team</button>
    ${renaming && html`<${Modal} title="Rename team" onClose=${() => setRenaming(false)}>
      <form class="stack" onSubmit=${async (e) => { e.preventDefault(); try { await change('team_rename', { p_team_id: team.id, p_name: name }, 'Renamed'); setRenaming(false); } catch { /* toast */ } }}>
        <label class="field">Name<input type="text" maxlength="80" value=${name} onInput=${(e) => setName(e.target.value)} required /></label>
        <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${() => setRenaming(false)}>Cancel</button><button class="btn primary">Save</button></div>
      </form><//>`}
  </div>`;
}

// What the signed-in user may do with a task (the database enforces the same rules).
const canEdit = (ctx, k) => ctx.owner || (ctx.member && k.created_by && k.created_by.id === ctx.me.id);
const canStatus = (ctx, k) => canEdit(ctx, k) || (ctx.member && k.assignee && k.assignee.id === ctx.me.id);

function Board({ ctx }) {
  const [who, setWho] = useState('all');
  const [editing, setEditing] = useState(null);
  const members = ctx.team.members;
  const tasks = ctx.team.tasks.filter(k => who === 'all' || (who === 'none' ? !k.assignee : k.assignee && k.assignee.id === who));
  return html`<div>
    ${ctx.member && html`<${NewTask} ctx=${ctx} />`}
    <div class="row wrap" style="margin:14px 0 10px">
      <label class="row small">Show<select style="width:auto" value=${who} onChange=${(e) => setWho(e.target.value)} aria-label="Filter by assignee">
        <option value="all">Everyone</option>${members.map(m => html`<option value=${m.id}>${m.id === ctx.me.id ? 'Me' : m.name}</option>`)}<option value="none">Unassigned</option></select></label>
    </div>
    <div class="board">
      ${STATUSES.map(([s, label, color]) => {
        const col = tasks.filter(k => k.status === s);
        return html`<section class=${'board-col ' + s} aria-label=${label}>
          <h4><${Chip} color=${color}>${label}<//><span class="muted small">${col.length}</span></h4>
          ${col.length === 0 ? html`<p class="small muted board-empty">Nothing here.</p>` : col.map(k => html`<${TaskCard} key=${k.id} k=${k} ctx=${ctx} onEdit=${() => setEditing(k)} />`)}
        </section>`;
      })}
    </div>
    ${editing && html`<${TaskModal} ctx=${ctx} task=${editing} onClose=${() => setEditing(null)} />`}
  </div>`;
}

function TaskCard({ k, ctx, onEdit }) {
  const late = k.status !== 'done' && k.due_date && k.due_date < ctx.today;
  return html`<article class=${'card flat team-task' + (k.status === 'blocked' ? ' stuck' : '')}>
    <div class="team-task-title"><${TaskText} text=${k.title} /></div>
    <div class="row wrap small">
      <span class=${k.assignee ? '' : 'muted'}>${k.assignee ? (k.assignee.id === ctx.me.id ? 'Me' : k.assignee.name) : 'Unassigned'}</span>
      ${k.due_date && html`<${Chip} color=${late ? 'pink' : k.due_date === ctx.today ? 'yellow' : 'ink'} title=${late ? 'Overdue' : 'Due date'}>${late ? 'Overdue · ' : ''}${fmtShort(k.due_date)}<//>`}
    </div>
    <div class="row">
      ${canStatus(ctx, k)
        ? html`<select class="sm-select" aria-label=${'Status of ' + k.title} value=${k.status}
            onChange=${(e) => change('team_task_update', { p_task_id: k.id, p_patch: { status: e.target.value } }).catch(() => {})}>
            ${STATUSES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>`
        : html`<span class="small muted">${statusLabel(k.status)}</span>`}
      <span class="spacer"></span>
      ${canEdit(ctx, k) && html`<button class="icon-btn" title="Edit" aria-label=${'Edit ' + k.title} onClick=${onEdit}><${Icon} name="edit" size=${16} /></button>`}
    </div>
  </article>`;
}

function NewTask({ ctx }) {
  const [f, set] = useState({ title: '', assignee: ctx.me.id, due: '', status: 'todo' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    setBusy(true);
    try {
      await change('team_task_create', { p_team_id: ctx.team.team.id, p_title: f.title.trim(), p_assignee_id: f.assignee || null, p_due_date: f.due || null, p_status: f.status }, 'Task added');
      set({ ...f, title: '' });
    } catch { /* toast shown */ } finally { setBusy(false); }
  };
  return html`<form class="card flat team-new-task" onSubmit=${submit} aria-label="New team task">
    <input type="text" maxlength="500" placeholder="New task title" aria-label="Task title" value=${f.title} onInput=${(e) => set({ ...f, title: e.target.value })} style="flex:2;min-width:220px" />
    <select aria-label="Assignee" value=${f.assignee} onChange=${(e) => set({ ...f, assignee: e.target.value })}>
      <option value="">Unassigned</option>${ctx.team.members.map(m => html`<option value=${m.id}>${m.id === ctx.me.id ? 'Me' : m.name}</option>`)}</select>
    <input type="date" aria-label="Due date" value=${f.due} onInput=${(e) => set({ ...f, due: e.target.value })} />
    <select aria-label="Status" value=${f.status} onChange=${(e) => set({ ...f, status: e.target.value })}>${STATUSES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
    <button class="btn primary" disabled=${busy || !f.title.trim()}><${Icon} name="plus" size=${16} />Add</button>
  </form>`;
}

function TaskModal({ ctx, task, onClose }) {
  const [f, set] = useState({ title: task.title, assignee: task.assignee ? task.assignee.id : '', due: task.due_date || '', status: task.status });
  const save = async (e) => {
    e.preventDefault();
    try {
      await change('team_task_update', { p_task_id: task.id, p_patch: { title: f.title, assignee_id: f.assignee || null, due_date: f.due || null, status: f.status } }, 'Saved');
      onClose();
    } catch { /* toast shown */ }
  };
  const del = async () => {
    if (!confirm('Delete this task?')) return;
    try { await change('team_task_delete', { p_task_id: task.id }, 'Task deleted'); onClose(); } catch { /* toast shown */ }
  };
  return html`<${Modal} title="Edit task" onClose=${onClose}>
    <form class="stack" onSubmit=${save}>
      <label class="field">Title<textarea rows="2" maxlength="500" value=${f.title} onInput=${(e) => set({ ...f, title: e.target.value })} required></textarea></label>
      <div class="grid2">
        <label class="field">Assignee<select value=${f.assignee} onChange=${(e) => set({ ...f, assignee: e.target.value })}>
          <option value="">Unassigned</option>${ctx.team.members.map(m => html`<option value=${m.id}>${m.name}</option>`)}</select></label>
        <label class="field">Due date<input type="date" value=${f.due} onInput=${(e) => set({ ...f, due: e.target.value })} /></label>
      </div>
      <label class="field">Status<select value=${f.status} onChange=${(e) => set({ ...f, status: e.target.value })}>${STATUSES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
      <p class="small muted">Created by ${task.created_by ? task.created_by.name : 'Unknown'} · last change ${fmtWhen(task.updated_at)}</p>
      <div class="row"><button type="button" class="btn danger" onClick=${del}>Delete</button><span class="spacer"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Save</button></div>
    </form>
  <//>`;
}

// Add a member: search the accounts that aren't in the team yet and pick one (team owner only;
// the database refuses everyone else and never lists blocked accounts).
function MemberPicker({ teamId }) {
  const { data, error } = useRpc('team_member_candidates', { p_team_id: teamId }, { poll: 0 });
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const label = (u) => u.name || u.email || 'Account without a name';
  const needle = q.trim().toLowerCase();
  const rows = (data || []).filter(u => !needle || [u.name, u.email].some(v => v && v.toLowerCase().includes(needle)));
  const add = async (u) => {
    setBusy(u.id);
    try { await change('team_add_member_id', { p_team_id: teamId, p_user_id: u.id }, `${label(u)} added to the team`); setQ(''); }
    catch { /* toast shown */ } finally { setBusy(null); }
  };
  return html`<section class="card flat add-member" aria-labelledby="add-member-h">
    <div class="row"><h4 id="add-member-h">Add a member</h4><span class="spacer"></span>
      ${data && html`<span class="small muted">${data.length} account${data.length === 1 ? '' : 's'} not in this team</span>`}</div>
    <label class="search add-member-search"><${Icon} name="search" size=${16} />
      <input type="search" placeholder="Search by name or email" aria-label="Search accounts to add" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    ${error ? html`<p class="notice" role="alert">${error}</p>`
      : !data ? html`<p class="small muted">Loading accounts…</p>`
      : rows.length === 0 ? html`<p class="small muted">${data.length === 0 ? 'Everyone with an active account is already in this team.' : 'No account matches “' + q.trim() + '”.'}</p>`
      : html`<ul class="member-list" role="list">${rows.map(u => html`<li key=${u.id}>
          <span class="pick-avatar" aria-hidden="true">${label(u).slice(0, 1).toUpperCase()}</span>
          <span class="pick-id"><strong>${label(u)}</strong>
            <span class="small muted">${u.email ? u.email : 'no email on file'}${u.email && !u.email_verified ? html` · <span title="This email hasn't been confirmed">unconfirmed</span>` : ''}</span></span>
          <button class="btn sm primary" disabled=${busy === u.id} onClick=${() => add(u)} aria-label=${'Add ' + label(u)}><${Icon} name="plus" size=${14} />Add</button>
        </li>`)}</ul>`}
    <p class="hint">Adding someone gives them this team only. It doesn’t change their role.</p>
  </section>`;
}

// ---------- people: membership and who is doing what ----------
function People({ ctx }) {
  const teamId = ctx.team.team.id;
  const remove = async (m) => {
    if (!confirm(`Remove ${m.name} from this team? They lose access to it at once; their tasks here become unassigned.`)) return;
    try { await change('team_remove_member', { p_team_id: teamId, p_user_id: m.id }, 'Removed'); } catch { /* toast shown */ }
  };
  return html`<div>
    ${ctx.owner && html`<${MemberPicker} teamId=${teamId} />`}
    <div class="cards">
      ${ctx.team.members.map(m => {
        const mine = ctx.team.tasks.filter(k => k.assignee && k.assignee.id === m.id);
        const by = (s) => mine.filter(k => k.status === s);
        return html`<div class="card flat person" key=${m.id}>
          <div class="row"><div class="person-id"><strong>${m.name}${m.id === ctx.me.id ? ' (you)' : ''}</strong><span class="small muted">${m.email || 'no email'}</span></div>
            <span class="spacer"></span>${m.owner ? html`<${Chip} color="solid">Owner<//>` : ctx.owner && html`<button class="btn sm danger" onClick=${() => remove(m)}>Remove</button>`}</div>
          <div class="row wrap small" style="margin-top:8px">
            <${Chip}>${by('todo').length} to do<//><${Chip} color="blue">${by('in_progress').length} in progress<//>
            <${Chip} color=${by('blocked').length ? 'pink' : 'ink'}>${by('blocked').length} blocked<//><${Chip} color="mint">${by('done').length} done<//></div>
          ${[...by('in_progress'), ...by('blocked')].length > 0 && html`<ul class="person-now small">${[...by('in_progress'), ...by('blocked')].map(k => html`<li key=${k.id}><span class=${'dot ' + k.status}></span>${k.title.split('\n')[0]}</li>`)}</ul>`}
        </div>`;
      })}
    </div>
  </div>`;
}

// ---------- daily team score ----------
function Scores({ ctx }) {
  const [date, setDate] = useState(ctx.today);
  const { data, error } = useRpc('team_scores', { p_team_id: ctx.team.team.id, p_date: date, p_tz: ctx.tz || 'UTC' });
  return html`<div>
    <div class="row wrap" style="margin-bottom:12px">
      <button class="icon-btn" aria-label="Previous day" onClick=${() => setDate(addDays(date, -1))}><${Icon} name="chevL" /></button>
      <input type="date" value=${date} max=${addDays(ctx.today, 365)} onInput=${(e) => e.target.value && setDate(e.target.value)} aria-label="Day" style="width:auto" />
      <button class="icon-btn" aria-label="Next day" onClick=${() => setDate(addDays(date, 1))}><${Icon} name="chevR" /></button>
      ${date !== ctx.today && html`<button class="btn sm" onClick=${() => setDate(ctx.today)}>Today</button>`}
      <strong>${fmtDay(date)}</strong>
    </div>
    <p class="small muted">Score = tasks assigned to the member and due that day that were done by the end of that day ÷ tasks due that day.
      “Completed that day” counts every task they finished that day, whatever its due date. Team scores are separate from your personal Daily Score.</p>
    ${error ? html`<p class="notice" role="alert">${error}</p>` : !data ? html`<p class="muted">Loading…</p>` : html`
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Member</th><th class="r">Due that day</th><th class="r">Done on time</th><th class="r">Score</th><th>Completed that day</th></tr></thead>
      <tbody>${data.members.map(m => html`<tr key=${m.id}>
        <td><strong>${m.name}</strong></td>
        <td class="r">${m.due}</td><td class="r">${m.on_time}</td>
        <td class="r"><strong>${m.score == null ? '—' : pct(m.score)}</strong></td>
        <td>${m.completed.length === 0 ? html`<span class="muted">—</span>` : html`<span class="small">${m.completed.length}: ${m.completed.map(c => c.title.split('\n')[0]).join(' · ')}</span>`}</td>
      </tr>`)}</tbody>
    </table></div>`}
  </div>`;
}

// ---------- future projects ----------
function Future({ ctx }) {
  const [f, set] = useState({ title: '', notes: '' });
  const [editing, setEditing] = useState(null);
  const [starting, setStarting] = useState(null);
  const teamId = ctx.team.team.id;
  const planned = ctx.team.projects.filter(p => !p.moved_at);
  const started = ctx.team.projects.filter(p => p.moved_at);
  const add = async (e) => {
    e.preventDefault();
    try { await change('team_project_save', { p_team_id: teamId, p_project_id: null, p_title: f.title, p_notes: f.notes }, 'Project added'); set({ title: '', notes: '' }); } catch { /* toast */ }
  };
  return html`<div>
    ${ctx.owner ? html`<form class="card flat stack" onSubmit=${add} style="margin-bottom:14px" aria-label="New future project">
      <div class="row wrap"><input type="text" maxlength="200" required placeholder="Planned project" aria-label="Project title" value=${f.title} onInput=${(e) => set({ ...f, title: e.target.value })} style="flex:1;min-width:220px" />
        <button class="btn primary" disabled=${!f.title.trim()}><${Icon} name="plus" size=${16} />Add</button></div>
      <textarea rows="2" maxlength="2000" placeholder="Notes (optional)" aria-label="Notes" value=${f.notes} onInput=${(e) => set({ ...f, notes: e.target.value })}></textarea>
    </form>` : html`<p class="small muted">The team owner plans future projects and moves them into active work.</p>`}
    ${planned.length === 0 ? html`<${Empty} title="No planned projects" />` : html`<div class="stack">${planned.map(p => html`<div class="card flat row wrap" key=${p.id}>
      <div style="flex:1;min-width:200px"><strong>${p.title}</strong>${p.notes && html`<p class="small muted" style="white-space:pre-wrap;margin-top:4px">${p.notes}</p>`}</div>
      ${ctx.owner && html`<button class="btn sm primary" onClick=${() => setStarting(p)}>Move to active work</button>
        <button class="icon-btn" aria-label=${'Edit ' + p.title} onClick=${() => setEditing(p)}><${Icon} name="edit" size=${16} /></button>
        <button class="btn sm danger" onClick=${async () => { if (confirm(`Delete “${p.title}”?`)) await change('team_project_delete', { p_project_id: p.id }, 'Deleted').catch(() => {}); }}>Delete</button>`}
    </div>`)}</div>`}
    ${started.length > 0 && html`<section class="section"><div class="section-head"><h3>Moved to active work</h3></div>
      <ul class="plain small">${started.map(p => html`<li key=${p.id}><strong>${p.title}</strong> <span class="muted">· ${fmtWhen(p.moved_at)}</span></li>`)}</ul></section>`}
    ${editing && html`<${ProjectModal} p=${editing} teamId=${teamId} onClose=${() => setEditing(null)} />`}
    ${starting && html`<${StartModal} p=${starting} ctx=${ctx} onClose=${() => setStarting(null)} />`}
  </div>`;
}

function ProjectModal({ p, teamId, onClose }) {
  const [f, set] = useState({ title: p.title, notes: p.notes || '' });
  return html`<${Modal} title="Edit future project" onClose=${onClose}>
    <form class="stack" onSubmit=${async (e) => { e.preventDefault(); try { await change('team_project_save', { p_team_id: teamId, p_project_id: p.id, p_title: f.title, p_notes: f.notes }, 'Saved'); onClose(); } catch { /* toast */ } }}>
      <label class="field">Title<input type="text" maxlength="200" required value=${f.title} onInput=${(e) => set({ ...f, title: e.target.value })} /></label>
      <label class="field">Notes<textarea rows="3" maxlength="2000" value=${f.notes} onInput=${(e) => set({ ...f, notes: e.target.value })}></textarea></label>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Save</button></div>
    </form><//>`;
}

function StartModal({ p, ctx, onClose }) {
  const [f, set] = useState({ assignee: '', due: '' });
  return html`<${Modal} title="Move to active work" onClose=${onClose}>
    <form class="stack" onSubmit=${async (e) => { e.preventDefault(); try { await change('team_project_activate', { p_project_id: p.id, p_assignee_id: f.assignee || null, p_due_date: f.due || null }, 'Added to the board as a task'); onClose(); } catch { /* toast */ } }}>
      <p><strong>${p.title}</strong> becomes a “To do” task on the board.</p>
      <div class="grid2">
        <label class="field">Assignee<select value=${f.assignee} onChange=${(e) => set({ ...f, assignee: e.target.value })}>
          <option value="">Unassigned</option>${ctx.team.members.map(m => html`<option value=${m.id}>${m.name}</option>`)}</select></label>
        <label class="field">Due date<input type="date" value=${f.due} onInput=${(e) => set({ ...f, due: e.target.value })} /></label>
      </div>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Move to active work</button></div>
    </form><//>`;
}

// ---------- activity ----------
const EVENT_TEXT = {
  team_created: 'created the team', team_renamed: 'renamed the team to', member_added: 'added', member_removed: 'removed',
  task_created: 'added the task', task_status: 'changed a status →', task_assigned: 'assigned', task_edited: 'edited', task_deleted: 'deleted the task',
  project_added: 'planned', project_started: 'moved to active work:',
};
function Activity({ ctx }) {
  const ev = ctx.team.events;
  if (!ev.length) return html`<${Empty} title="No activity yet" />`;
  return html`<ul class="activity">${ev.map((e, i) => html`<li key=${i}>
    <span class="muted small">${fmtWhen(e.at)}</span>
    <span><strong>${e.actor.name}</strong> ${EVENT_TEXT[e.action] || e.action} ${e.action === 'task_status' ? html`<em>${statusLabel((e.detail || '').split(':')[0])}</em>: ${(e.detail || '').split(': ').slice(1).join(': ')}` : e.detail}</span>
  </li>`)}</ul>`;
}
