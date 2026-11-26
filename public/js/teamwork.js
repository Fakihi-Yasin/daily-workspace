// Team Work: private teams with shared tasks, future projects and a daily team score.
// Data lives in the shared Supabase tables (never in personal snapshots) and every read and write
// goes through database functions that check role, blocked status and team membership. The
// permission checks below only decide which buttons to show.
import { html, useState, useEffect, useRef, useCallback, useResource, Icon, Chip, Modal, Empty, TaskText, toast, fmtDay, fmtShort, addDays, pct, bus, Avatar, ActionsMenu } from './lib.js';

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

// ---------- unread team tasks (sidebar badge and team cards) ----------
// Tasks someone else created in my teams since I last opened that team's board. The database keeps
// "last seen" per user and per team (team_unread / team_mark_seen), so it survives reloads and
// works across devices. Loaded with the dashboard, refreshed every 20 s, on focus and after changes.
const unread = { data: null, subs: new Set(), started: false, busy: false };
export async function refreshUnread() {
  if (!window.__dash || !window.__dash.rpc || unread.busy) return;
  unread.busy = true;
  try { unread.data = await rpc('team_unread', {}); unread.subs.forEach(f => f(unread.data)); }
  catch { /* offline or signed out: keep the last count */ }
  finally { unread.busy = false; }
}
function startUnread() {
  if (unread.started) return;
  unread.started = true;
  refreshUnread();
  setInterval(() => { if (document.visibilityState === 'visible') refreshUnread(); }, 20000);
  bus.on(refreshUnread);
}
export function useUnread() {
  const [d, set] = useState(unread.data);
  useEffect(() => { unread.subs.add(set); startUnread(); if (unread.data !== d) set(unread.data); return () => unread.subs.delete(set); }, []);
  return d;
}
export const unreadLabel = (n) => (n > 99 ? '+99' : '+' + n);
export function UnreadNavBadge() {
  const d = useUnread();
  const n = d ? d.total : 0;
  const inv = d ? d.invites || 0 : 0;
  return html`${inv > 0 && html`<span class="nav-badge invite" title=${inv + ' team invitation' + (inv === 1 ? '' : 's')} aria-label=${inv + ' team invitation' + (inv === 1 ? '' : 's')}>✉ ${inv}</span>`}
    ${n > 0 && html`<span class="nav-badge" title=${n + ' new team task' + (n === 1 ? '' : 's')} aria-label=${n + ' new team task' + (n === 1 ? '' : 's')}>${unreadLabel(n)}</span>`}`;
}
async function markSeen(teamId, upto) {
  try { await rpc('team_mark_seen', { p_team_id: teamId, p_upto: upto || null }); } catch { return; }
  if (unread.data && unread.data.teams[teamId]) {
    const teams = { ...unread.data.teams }; const n = teams[teamId]; delete teams[teamId];
    unread.data = { total: Math.max(0, unread.data.total - n), teams };
    unread.subs.forEach(f => f(unread.data));
  }
  refreshUnread();
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
  const counts = useUnread();
  const [deleting, setDeleting] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Members are added afterwards, from the team's People tab (Add member).
  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { const r = await change('team_create', { p_name: name.trim() }, 'Team created · add members in People'); setName(''); location.hash = '#/teams/' + r.id + '?tab=people'; }
    catch { /* toast shown */ } finally { setBusy(false); }
  };
  return html`<div>
    <header class="page-head"><h1>Team Work</h1><span class="muted">Private teams: only their members see them.</span></header>
    <${TeamCountTiles} />
    <${MyInvitations} />
    <section class="section">
      <div class="section-head"><h3>${scope === 'all' ? 'All teams' : 'My teams'}</h3>
        ${isSuper() && html`<div class="seg" role="tablist" aria-label="Which teams">
          <button role="tab" aria-selected=${scope === 'mine'} class=${scope === 'mine' ? 'on' : ''} onClick=${() => setScope('mine')}>My teams</button>
          <button role="tab" aria-selected=${scope === 'all'} class=${scope === 'all' ? 'on' : ''} onClick=${() => setScope('all')}>All teams</button></div>`}
      </div>
      ${scope === 'mine' && canCreateTeams() && html`<form class="card flat row wrap team-new" onSubmit=${create}>
        <label class="sr-only" for="team-name">New team name</label>
        <input id="team-name" type="text" maxlength="80" placeholder="New team name, e.g. Content crew" value=${name} onInput=${(e) => setName(e.target.value)} style="flex:1;min-width:200px" />
        <button class="btn primary" disabled=${busy || !name.trim()}><${Icon} name="plus" size=${16} />Create team</button>
      </form>`}
      ${error ? html`<p class="notice" role="alert">${error}</p>`
        : !data ? html`<p class="muted">Loading…</p>`
        : data.length === 0 ? html`<${Empty} title=${scope === 'all' ? 'No teams in the app yet' : 'You’re not in a team yet'}>${scope !== 'mine' ? '' : canCreateTeams() ? 'Create one above, then add people by the email they signed up with.' : 'When a team owner adds you by your email, the team shows up here.'}<//>`
        : html`<div class="cards team-cards">${data.map(t => { const n = (counts && counts.teams[t.id]) || 0; return html`<div class="team-card-wrap" key=${t.id}><a class="card team-card" href=${'#/teams/' + t.id}>
            <div class="row"><strong class="team-name">${t.name}</strong><span class="spacer"></span>
              ${n > 0 && html`<span class="team-badge" title=${n + ' new task' + (n === 1 ? '' : 's') + ' since you last opened the board'}>${unreadLabel(n)}</span>`}
              ${t.my_role ? html`<${Chip} color=${t.my_role === 'owner' ? 'solid' : 'ink'}>${t.my_role === 'owner' ? 'Owner' : 'Member'}<//>` : html`<${Chip} color="yellow">Viewing<//>`}</div>
            <span class="small muted">Owner: ${t.owner.name} · ${t.members} member${t.members === 1 ? '' : 's'}</span>
            <div class="row wrap small">
              <span>${t.open} open</span>
              ${t.blocked > 0 && html`<${Chip} color="pink">${t.blocked} blocked<//>`}
              <span class="muted">${t.done} done</span>
            </div>
          </a>
          ${isSuper() && html`<div class="team-card-menu"><${ActionsMenu} compact label=${t.name} items=${[['Delete team…', () => setDeleting(t), 'danger']]} /></div>`}
          </div>`; })}</div>`}
    </section>
    ${deleting && html`<${DeleteTeamModal} team=${deleting} onClose=${() => setDeleting(null)} />`}
  </div>`;
}

// ---------- one team ----------
const TABS = [['board', 'Board'], ['people', 'People'], ['scores', 'Daily score'], ['future', 'Future projects'], ['activity', 'Activity']];

function TeamPage({ id }) {
  const { data, error } = useRpc('team_get', { p_team_id: id });
  const { data: boot } = useResource('/api/bootstrap');
  // "#/teams/<id>?tab=people" opens a tab directly (used right after creating a team).
  const [tab, setTab] = useState(() => { const t = (/[?&]tab=(\w+)/.exec(location.hash) || [])[1]; return TABS.some(x => x[0] === t) ? t : 'board'; });
  // Opening the board (once its tasks have loaded) clears this team's unread count, and only this one.
  const counts = useUnread();
  const unreadHere = (counts && counts.teams[id]) || 0;
  const seenFor = useRef(null);
  const loadedAt = data && data.loaded_at;
  const isMember = !!data && (data.me.access === 'owner' || data.me.access === 'member');
  useEffect(() => {
    if (tab !== 'board' || !loadedAt || !isMember) return;
    if (seenFor.current === loadedAt && !unreadHere) return;
    seenFor.current = loadedAt;
    markSeen(id, loadedAt);
  }, [tab, loadedAt, unreadHere, isMember]);
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
      ${(ctx.owner || isSuper()) && html`<${TeamMenu} team=${{ ...data.team, categories: data.categories }} owner=${ctx.owner} counts=${{ tasks: t.length, members: data.members.length, projects: data.projects.filter(p => !p.moved_at).length }} />`}
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

function TeamMenu({ team, owner, counts }) {
  const [renaming, setRenaming] = useState(false);
  const [cats, setCats] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(team.name);
  return html`<div class="row">
    ${owner && html`<button class="btn sm" onClick=${() => setCats(true)}>Categories</button>`}
    ${owner && html`<button class="btn sm" onClick=${() => setRenaming(true)}><${Icon} name="edit" size=${14} />Rename</button>`}
    ${cats && html`<${TeamCategories} team=${team} onClose=${() => setCats(false)} />`}
    <button class="btn sm danger" onClick=${() => setDeleting(true)}>Delete team</button>
    ${deleting && html`<${DeleteTeamModal} team=${{ id: team.id, name: team.name, owner: team.owner, ...counts }} onClose=${() => setDeleting(false)} onDeleted=${() => { location.hash = '#/teams'; }} />`}
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
  const [catF, setCatF] = useState('all');
  const [editing, setEditing] = useState(null);
  const members = ctx.team.members;
  const tcats = ctx.team.categories || [];
  const tasks = ctx.team.tasks.filter(k => (who === 'all' || (who === 'none' ? !k.assignee : k.assignee && k.assignee.id === who))
    && (catF === 'all' || (catF === 'none' ? !k.category_id : k.category_id === catF)));
  return html`<div>
    ${ctx.member && html`<${NewTask} ctx=${ctx} />`}
    <div class="row wrap" style="margin:14px 0 10px">
      <label class="row small">Show<select style="width:auto" value=${who} onChange=${(e) => setWho(e.target.value)} aria-label="Filter by assignee">
        <option value="all">Everyone</option>${members.map(m => html`<option value=${m.id}>${m.id === ctx.me.id ? 'Me' : m.name}</option>`)}<option value="none">Unassigned</option></select></label>
      ${tcats.length > 0 && html`<label class="row small">Category<select style="width:auto" value=${catF} onChange=${(e) => setCatF(e.target.value)} aria-label="Filter by team category">
        <option value="all">All</option>${tcats.map(c => html`<option value=${c.id}>${c.name}${c.archived ? ' (archived)' : ''}</option>`)}<option value="none">No category</option></select></label>`}
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
      ${k.category_id && (() => { const c = (ctx.team.categories || []).find(x => x.id === k.category_id); return c && html`<${Chip} color=${c.color}>${c.name}<//>`; })()}
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
  const [f, set] = useState({ title: '', assignee: ctx.me.id, due: '', status: 'todo', category: '' });
  const active = (ctx.team.categories || []).filter(c => !c.archived);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    setBusy(true);
    try {
      await change('team_task_create', { p_team_id: ctx.team.team.id, p_title: f.title.trim(), p_assignee_id: f.assignee || null, p_due_date: f.due || null, p_status: f.status, p_category_id: f.category || null }, 'Task added');
      set({ ...f, title: '' });
    } catch { /* toast shown */ } finally { setBusy(false); }
  };
  return html`<form class="card flat team-new-task" onSubmit=${submit} aria-label="New team task">
    <input type="text" maxlength="500" placeholder="New task title" aria-label="Task title" value=${f.title} onInput=${(e) => set({ ...f, title: e.target.value })} style="flex:2;min-width:220px" />
    <select aria-label="Assignee" value=${f.assignee} onChange=${(e) => set({ ...f, assignee: e.target.value })}>
      <option value="">Unassigned</option>${ctx.team.members.map(m => html`<option value=${m.id}>${m.id === ctx.me.id ? 'Me' : m.name}</option>`)}</select>
    <input type="date" aria-label="Due date" value=${f.due} onInput=${(e) => set({ ...f, due: e.target.value })} />
    <select aria-label="Status" value=${f.status} onChange=${(e) => set({ ...f, status: e.target.value })}>${STATUSES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
    ${active.length > 0 && html`<select aria-label="Team category" value=${f.category} onChange=${(e) => set({ ...f, category: e.target.value })}>
      <option value="">No category</option>${active.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select>`}
    <button class="btn primary" disabled=${busy || !f.title.trim()}><${Icon} name="plus" size=${16} />Add</button>
  </form>`;
}

function TaskModal({ ctx, task, onClose }) {
  const [f, set] = useState({ title: task.title, assignee: task.assignee ? task.assignee.id : '', due: task.due_date || '', status: task.status, category: task.category_id || '' });
  const catOptions = (ctx.team.categories || []).filter(c => !c.archived || c.id === task.category_id);
  const save = async (e) => {
    e.preventDefault();
    try {
      await change('team_task_update', { p_task_id: task.id, p_patch: { title: f.title, assignee_id: f.assignee || null, due_date: f.due || null, status: f.status,
        ...((f.category || null) !== (task.category_id || null) ? { category_id: f.category || null } : {}) } }, 'Saved');
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
      <div class="grid2">
        <label class="field">Status<select value=${f.status} onChange=${(e) => set({ ...f, status: e.target.value })}>${STATUSES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
        <label class="field">Team category<select value=${f.category} onChange=${(e) => set({ ...f, category: e.target.value })}>
          <option value="">No category</option>${catOptions.map(c => html`<option value=${c.id}>${c.name}${c.archived ? ' (archived)' : ''}</option>`)}</select></label>
      </div>
      <p class="small muted">Created by ${task.created_by ? task.created_by.name : 'Unknown'} · last change ${fmtWhen(task.updated_at)}</p>
      <div class="row"><button type="button" class="btn danger" onClick=${del}>Delete</button><span class="spacer"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn primary">Save</button></div>
    </form>
  <//>`;
}

// Add a member by invite: the owner types the full email; the server emails a one-time link.
// The answer is the same whether or not that email has an account (no directory, no lookup).
// "Invite sent" only appears once the email provider accepted the message.
function InviteMember({ teamId }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [note, setNote] = useState(null);
  const { data: invites, reload } = useRpc('team_invite_list', { p_team_id: teamId }, { poll: 0 });
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim());
  const send = async (e) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setProblem(null); setNote(null);
    try {
      // Same answer for every address: whether it has an account is never shown here.
      const r = await window.__dash.sendInvite(teamId, email.trim());
      if (r.emailed) toast({ msg: 'Invite sent' });
      else { toast({ msg: 'Invitation saved · no email sent' }); setNote({ email: email.trim(), text: r.message }); }
      setEmail('');
      reload();
    } catch (err) {
      setProblem(err.message);
    } finally { setBusy(false); }
  };
  const revoke = async (i) => {
    if (!confirm(`Cancel the invite to ${i.email}? The link stops working.`)) return;
    try { await change('team_invite_revoke', { p_invite_id: i.id }, 'Invite cancelled'); reload(); } catch { /* toast shown */ }
  };
  return html`<section class="card flat add-member" aria-labelledby="invite-h">
    <h4 id="invite-h">Add member</h4>
    <form class="invite-form" onSubmit=${send}>
      <label class="sr-only" for="invite-email">Email address</label>
      <input id="invite-email" type="email" inputmode="email" autocomplete="off" spellcheck="false" maxlength="254" placeholder="Their full email, e.g. name@example.com"
        value=${email} onInput=${(e) => { setEmail(e.target.value); setProblem(null); }} />
      <button class="btn primary" disabled=${busy || !valid}><${Icon} name="plus" size=${16} />${busy ? 'Sending…' : 'Send invite'}</button>
    </form>
    ${problem && html`<p class="notice" role="alert">${problem}</p>`}
    ${note && html`<p class="notice" role="status"><strong>No email was sent to ${note.email}.</strong> ${note.text.replace(/^Invitation saved, but no email was sent: /, '').replace(/^./, c => c.toUpperCase())}</p>`}
    <p class="hint">The invitation waits under Team Work → Invitations for whoever has that confirmed email, and is also emailed when email is set up. They join this team only, and only when they click Accept. It works once, for 7 days; their role doesn’t change.</p>
    ${invites && invites.length > 0 && html`<div><p class="small muted" style="margin:4px 0 6px">Waiting for an answer</p>
      <ul class="invite-list">${invites.map(i => html`<li key=${i.id}><span class="em">${i.email}</span>
        <span class="small muted">${i.emailed ? 'emailed ' + fmtWhen(i.sent_at) : 'in the app only (no email) · ' + fmtWhen(i.created_at)} · expires ${fmtWhen(i.expires_at)}</span><span class="spacer"></span>
        <button class="btn sm" onClick=${() => revoke(i)}>Cancel invite</button></li>`)}</ul></div>`}
  </section>`;
}

// Team Work → Invitations: open invitations for this account's confirmed email. Joining needs Accept.
function MyInvitations() {
  const { data, reload } = useRpc('my_invites', {});
  const [busy, setBusy] = useState(null);
  if (!data) return null;
  if (!data.email_verified) {
    return data.waiting > 0 ? html`<section class="section"><div class="section-head"><h3>Invitations</h3></div>
      <p class="notice" role="note">You have ${data.waiting === 1 ? 'a team invitation' : data.waiting + ' team invitations'}. Confirm your email address (open the confirmation email from sign-up), then reload this page to see ${data.waiting === 1 ? 'it' : 'them'}.</p></section>` : null;
  }
  if (!data.invites.length) return null;
  const act = async (i, accept) => {
    setBusy(i.id);
    try {
      if (accept) {
        const r = await rpc('my_invite_accept', { p_invite_id: i.id });
        bus.emit(false); refreshUnread();
        toast({ msg: `You joined “${i.team_name}”` });
        location.hash = '#/teams/' + r.team_id;
      } else {
        await rpc('my_invite_decline', { p_invite_id: i.id });
        toast({ msg: 'Invitation declined' });
        reload(); refreshUnread();
      }
    } catch (e) { toast({ msg: e.message, kind: 'error' }); reload(); }
    finally { setBusy(null); }
  };
  return html`<section class="section" aria-labelledby="inv-h"><div class="section-head"><h3 id="inv-h">Invitations</h3><span class="muted small">${data.invites.length} waiting</span></div>
    <div class="stack">${data.invites.map(i => html`<div class="card flat row wrap invitation" key=${i.id}>
      <${Avatar} p=${i.inviter} size=${36} />
      <div style="flex:1;min-width:200px"><strong>${i.inviter.name}</strong> invited you to join <strong>“${i.team_name}”</strong>
        <div class="small muted">${fmtWhen(i.invited_at)} · expires ${fmtWhen(i.expires_at)} · joining gives you this team only</div></div>
      <button class="btn" disabled=${busy === i.id} onClick=${() => act(i, false)}>Decline</button>
      <button class="btn primary" disabled=${busy === i.id} onClick=${() => act(i, true)}>Accept</button>
    </div>`)}</div></section>`;
}

// Team categories: the team's own (never anyone's personal categories), managed by the team owner.
// Archiving hides one from pickers; tasks that use it keep it.
function TeamCategories({ team, onClose }) {
  const { data, reload } = useRpc('team_get', { p_team_id: team.id }, { poll: 0 });
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const list = (data && data.categories) || team.categories || [];
  const COLORS = ['blue', 'pink', 'mint', 'yellow', 'sky', 'ink'];
  const save = async (c, patch) => { try { await change('team_category_save', { p_team_id: team.id, p_id: c.id, p_name: patch.name ?? c.name, p_color: patch.color ?? c.color }); reload(); } catch { /* toast */ } };
  const archive = async (c, a) => { try { await change('team_category_archive', { p_id: c.id, p_archived: a }, a ? 'Archived · its tasks keep it' : 'Unarchived'); reload(); } catch { /* toast */ } };
  const add = async (e) => { e.preventDefault(); try { await change('team_category_save', { p_team_id: team.id, p_id: null, p_name: name, p_color: color }, 'Category added'); setName(''); reload(); } catch { /* toast */ } };
  return html`<${Modal} title=${'Team categories · ' + team.name} onClose=${onClose}>
    <p class="small muted">Shared by everyone in this team, managed by you as the owner. Members’ personal categories stay in their own dashboards.</p>
    <div class="list">${list.map(c => html`<div class="list-row" key=${c.id}>
      <${Chip} color=${c.color}>●<//>
      <input type="text" maxlength="60" value=${c.name} disabled=${c.archived} aria-label="Category name" onChange=${(e) => e.target.value.trim() && e.target.value !== c.name && save(c, { name: e.target.value })} style="max-width:220px" />
      <select value=${c.color} disabled=${c.archived} onChange=${(e) => save(c, { color: e.target.value })} aria-label="Color" style="width:auto">${COLORS.map(x => html`<option value=${x}>${x}</option>`)}</select>
      <span class="spacer"></span>
      <button class="btn sm" onClick=${() => archive(c, !c.archived)}>${c.archived ? 'Unarchive' : 'Archive'}</button></div>`)}
      ${list.length === 0 && html`<p class="small muted">No categories yet.</p>`}</div>
    <form class="row wrap" style="margin-top:12px" onSubmit=${add}>
      <input type="text" maxlength="60" required placeholder="New category, e.g. Design" value=${name} onInput=${(e) => setName(e.target.value)} style="flex:1;min-width:180px" aria-label="New team category" />
      <select value=${color} onChange=${(e) => setColor(e.target.value)} aria-label="Color" style="width:auto">${COLORS.map(x => html`<option value=${x}>${x}</option>`)}</select>
      <button class="btn primary" disabled=${!name.trim()}>Add</button>
    </form>
  <//>`;
}

// Deleting a team: the owner, or any Super Admin (the database checks it and writes the audit log).
export function DeleteTeamModal({ team, onClose, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed.trim().toLowerCase() === team.name.trim().toLowerCase();
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const del = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      await change('team_delete', { p_team_id: team.id }, `Team “${team.name}” deleted`);
      refreshUnread();
      onClose();
      if (onDeleted) onDeleted();
    } catch { setBusy(false); }
  };
  return html`<${Modal} title="Delete this team?" onClose=${onClose}>
    <form class="stack" onSubmit=${del}>
      <p class="confirm-name">“${team.name}”${team.owner ? html` <span class="muted small" style="font-weight:400">· owner ${team.owner.name}</span>` : ''}</p>
      <ul class="small" style="margin:0;padding-left:18px">
        <li>Its ${team.tasks != null ? plural(team.tasks, 'task') : 'tasks'}${team.projects != null ? `, ${plural(team.projects, 'future project')}` : ', future projects'}, daily scores and activity are deleted for good.</li>
        <li>${team.members != null ? plural(team.members, 'member') : 'Its members'} lose access to it at once; it disappears from their dashboards. Pending invites stop working.</li>
        <li>Their accounts, personal dashboards and personal tasks, and every other team, are not touched.</li>
      </ul>
      <p class="small muted">This can’t be undone. The deletion is recorded in the audit log with your name and the time.</p>
      <label class="field">Type the team name to confirm<input type="text" autocomplete="off" value=${typed} onInput=${(e) => setTyped(e.target.value)} aria-label="Type the team name to confirm" /></label>
      <div class="row"><span class="spacer"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn danger-solid" disabled=${!ok || busy}>${busy ? 'Deleting…' : 'Delete team'}</button></div>
    </form>
  <//>`;
}

// Super Admin only (the database refuses everyone else): pick an existing account directly.
function MemberPicker({ teamId }) {
  const { data, error } = useRpc('team_member_candidates', { p_team_id: teamId }, { poll: 0 });
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const label = (u) => u.email || u.name || 'Account without an email';
  const needle = q.trim().toLowerCase();
  // Search runs over every account's email (not only the rows in view); the list shows 4 at a time and
  // scrolls inside itself.
  const rows = (data || []).filter(u => !needle || (u.email && u.email.toLowerCase().includes(needle)));
  const add = async (u) => {
    setBusy(u.id);
    try { await change('team_add_member_id', { p_team_id: teamId, p_user_id: u.id }, `${label(u)} added to the team`); setQ(''); }
    catch { /* toast shown */ } finally { setBusy(null); }
  };
  return html`<section class="card flat add-member" aria-labelledby="add-member-h">
    <div class="row"><h4 id="add-member-h">Add an existing account <span class="muted small">(Super Admin)</span></h4><span class="spacer"></span>
      ${data && html`<span class="small muted" aria-live="polite">${needle ? `${rows.length} match${rows.length === 1 ? '' : 'es'} · ` : ''}${data.length} account${data.length === 1 ? '' : 's'} not in this team</span>`}</div>
    <label class="search add-member-search"><${Icon} name="search" size=${16} />
      <input type="search" inputmode="email" autocomplete="off" placeholder="Search by email" aria-label="Search accounts by email" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    ${error ? html`<p class="notice" role="alert">${error}</p>`
      : !data ? html`<p class="small muted">Loading accounts…</p>`
      : rows.length === 0 ? html`<p class="small muted">${data.length === 0 ? 'Everyone with an active account is already in this team.' : 'No email matches “' + q.trim() + '”.'}</p>`
      : html`<ul class="member-list member-list-4" role="list" aria-label="Accounts" tabindex="0">${rows.map(u => html`<li key=${u.id}>
          <${Avatar} p=${u} size=${32} />
          <span class="pick-id"><strong>${u.email || html`<span class="muted">no email on file</span>`}</strong>
            <span class="small muted">${u.name || ''}${u.email && !u.email_verified ? html`${u.name ? ' · ' : ''}<span title="This email hasn't been confirmed">unconfirmed</span>` : ''}</span></span>
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
    ${ctx.owner && html`<${InviteMember} teamId=${teamId} />`}
    ${ctx.owner && isSuper() && html`<${MemberPicker} teamId=${teamId} />`}
    <div class="cards">
      ${ctx.team.members.map(m => {
        const mine = ctx.team.tasks.filter(k => k.assignee && k.assignee.id === m.id);
        const by = (s) => mine.filter(k => k.status === s);
        return html`<div class="card flat person" key=${m.id}>
          <div class="row"><div class="person-head"><${Avatar} p=${m} size=${40} /><div class="person-id"><strong>${m.name}${m.id === ctx.me.id ? ' (you)' : ''}</strong><span class="small muted">${m.email || 'no email'}</span></div></div>
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
  member_invited: 'invited', invite_accepted: 'joined by invite:', invite_declined: 'declined the invite for',
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

// ---------- accepting an invite (#/invite/<token>) ----------
export function InvitePage({ sub }) {
  const token = sub;
  const [state, setState] = useState({ data: null, error: null });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setState({ data: await rpc('team_invite_peek', { p_token: token }), error: null }); }
    catch (e) { setState({ data: null, error: e.message }); }
  };
  useEffect(() => { load(); }, [token]);
  const done = () => { window.__dash.clearPendingInvite(); };
  const accept = async () => {
    setBusy(true);
    try {
      const r = await rpc('team_invite_accept', { p_token: token });
      done(); bus.emit(false); refreshUnread();
      toast({ msg: `You joined “${state.data.team_name}”` });
      location.hash = '#/teams/' + r.team_id;
    } catch (e) { toast({ msg: e.message, kind: 'error' }); setBusy(false); load(); }
  };
  const recheck = async () => {
    setBusy(true);
    try { await window.__dash.refreshMe(); await load(); } catch (e) { toast({ msg: e.message, kind: 'error' }); } finally { setBusy(false); }
  };
  const switchAccount = () => window.__dash.logout(); // the invite is kept for the next sign-in
  const d = state.data;
  const head = html`<header class="page-head"><h1>Team invite</h1></header>`;
  if (state.error) return html`<div>${head}<p class="notice" role="alert">${state.error}</p></div>`;
  if (!d) return html`<div>${head}<p class="muted">Loading…</p></div>`;
  if (d.state !== 'ok') {
    const why = { invalid: 'This invite link isn’t valid. Check that you copied the whole link.', used: 'This invite was already used.', revoked: 'This invite was cancelled.', expired: 'This invite has expired.' }[d.state];
    return html`<div>${head}<div class="card invite-card stack">
      <p><strong>${why}</strong>${d.team_name ? ` (team “${d.team_name}”)` : ''}</p>
      ${d.state !== 'used' && html`<p class="muted">Ask the team owner to send you a new invite.</p>`}
      <div class="row"><a class="btn" href="#/teams" onClick=${done}>Go to Team Work</a></div></div></div>`;
  }
  return html`<div>${head}<div class="card invite-card stack">
    <p><strong>${d.inviter_name}</strong> invited you to join the team <strong>“${d.team_name}”</strong>.</p>
    <p class="small muted">The invite is for ${d.invited_email} and works once, until ${fmtWhen(d.expires_at)}. Joining gives you this team only; your role and your own dashboard don’t change.</p>
    ${d.already_member ? html`<p class="notice blue">You’re already a member of this team.</p>
        <div class="row"><a class="btn primary" href=${'#/teams/' + d.team_id} onClick=${done}>Open the team</a></div>`
      : !d.email_matches ? html`<p class="notice" role="alert">You’re signed in as <strong>${d.my_email || 'an account without an email'}</strong>, but this invite is for ${d.invited_email}. Sign out, then sign in or create an account with that email.</p>
        <div class="row"><button class="btn primary" onClick=${switchAccount}>Sign out and switch account</button></div>`
      : !d.my_email_verified ? html`<p class="notice" role="alert">Confirm your email address first: open the confirmation email we sent to <strong>${d.my_email}</strong> when you signed up and click its link. Then come back here.</p>
        <div class="row"><button class="btn primary" disabled=${busy} onClick=${recheck}>${busy ? 'Checking…' : 'I’ve confirmed it — check again'}</button></div>`
      : html`<div class="row"><button class="btn primary" disabled=${busy} onClick=${accept}>${busy ? 'Joining…' : 'Join “' + d.team_name + '”'}</button>
          <a class="btn" href="#/teams" onClick=${done}>Not now</a></div>`}
  </div></div>`;
}
