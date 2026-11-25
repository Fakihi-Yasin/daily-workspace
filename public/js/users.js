// Users (Super Admin only): everyone who signed up through Auth0, their role and status.
// The database refuses every call here from anyone but an active Super Admin; the sidebar link and
// the route guard in app.js only keep the page out of other people's way.
import { html, useState, Icon, Chip, Modal, Empty, ActionsMenu } from './lib.js';
import { useRpc, change } from './teamwork.js';

export const ROLES = [['user', 'User'], ['admin', 'Admin'], ['super_admin', 'Super Admin']];
const roleLabel = (r) => (ROLES.find(x => x[0] === r) || [r, r])[1];
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Users() {
  const { data, error } = useRpc('admin_list_users', {});
  const [q, setQ] = useState('');
  const [role, setRole] = useState('all');
  const [status, setStatus] = useState('all');
  const [confirmBox, setConfirm] = useState(null); // { title, text, action, danger }
  const [editing, setEditing] = useState(null); // the account being edited
  const meId = window.__dash && window.__dash.user && window.__dash.user.id;

  if (error) return html`<div><header class="page-head"><h1>Users</h1></header><p class="notice" role="alert">${error}</p></div>`;
  if (!data) return html`<div><header class="page-head"><h1>Users</h1></header><p class="muted">Loading…</p></div>`;

  const needle = q.trim().toLowerCase();
  const rows = data.filter(u => (role === 'all' || u.role === role) && (status === 'all' || u.status === status)
    && (!needle || [u.name, u.email, u.user_id].some(v => v && v.toLowerCase().includes(needle))));
  const activeSupers = data.filter(u => u.role === 'super_admin' && u.status === 'active').length;
  const label = (u) => u.name || u.email || u.user_id;

  const setRoleFor = (u, next) => {
    if (next === u.role) return;
    const run = () => change('admin_set_role', { p_user_id: u.user_id, p_role: next }, `${label(u)} is now ${roleLabel(next)}`).catch(() => {});
    if (next === 'super_admin') {
      setConfirm({ title: 'Make Super Admin?', action: run, confirmLabel: 'Make Super Admin',
        text: html`<p><strong>${label(u)}</strong>${u.email ? ` (${u.email})` : ''} will be able to see every team, manage all users, change roles and block accounts — including yours.</p>` });
    } else run();
  };
  const setStatusFor = (u, next) => {
    const run = () => change('admin_set_status', { p_user_id: u.user_id, p_status: next }, next === 'blocked' ? `${label(u)} is blocked` : `${label(u)} is unblocked`).catch(() => {});
    if (next === 'blocked') {
      setConfirm({ title: 'Block this account?', action: run, confirmLabel: 'Block account', danger: true,
        text: html`<p><strong>${label(u)}</strong>${u.email ? ` (${u.email})` : ''} loses access to the workspace and Team Work on their next request, even in a browser where they are already signed in. Their data is kept, and you can unblock them later.</p>` });
    } else run();
  };

  const deleteFor = (u) => {
    const run = () => change('admin_delete_user', { p_user_id: u.user_id }, `${label(u)} was deleted`).catch(() => {});
    setConfirm({ title: 'Delete this account?', action: run, confirmLabel: 'Delete account', danger: true,
      text: html`<p><strong>${label(u)}</strong>${u.email ? ` (${u.email})` : ''} is removed from the app and from every team they’re in. Tasks they created pass to each team’s owner; tasks assigned to them become unassigned.</p>
        <p class="muted">Their personal dashboard is kept in a private recovery copy, not shown anywhere. Their sign-in still works: if they sign in again they start over as a new account with an empty dashboard. To keep them out, use <strong>Block</strong> instead.</p>
        <p class="muted small">An account that owns a team can’t be deleted until its teams are deleted.</p>` });
  };

  return html`<div>
    <header class="page-head"><h1>Users</h1><span class="muted">Everyone who signed up. New accounts start as Admin: their own dashboard, and they can create teams.</span></header>
    <div class="tiles" style="margin-bottom:16px">
      <div class="tile"><span class="v">${data.length}</span><span class="k">Accounts</span></div>
      <div class="tile"><span class="v">${data.filter(u => u.role === 'admin').length}</span><span class="k">Admins</span></div>
      <div class="tile"><span class="v">${data.filter(u => u.status === 'blocked').length}</span><span class="k">Blocked</span></div>
      <div class="tile"><span class="v">${activeSupers}</span><span class="k">Active Super Admins</span></div>
    </div>
    <div class="row wrap users-filters">
      <label class="search"><${Icon} name="search" size=${16} /><input type="search" placeholder="Search name or email" aria-label="Search users" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
      <div class="seg" role="group" aria-label="Filter by role">${[['all', 'All roles'], ...ROLES].map(([k, l]) => html`<button aria-pressed=${role === k} class=${role === k ? 'on' : ''} onClick=${() => setRole(k)}>${l}</button>`)}</div>
      <div class="seg" role="group" aria-label="Filter by status">${[['all', 'Any status'], ['active', 'Active'], ['blocked', 'Blocked']].map(([k, l]) => html`<button aria-pressed=${status === k} class=${status === k ? 'on' : ''} onClick=${() => setStatus(k)}>${l}</button>`)}</div>
    </div>
    ${rows.length === 0 ? html`<${Empty} title="No users match" />` : html`<div class="table-wrap"><table class="data users-table">
      <thead><tr><th>Name</th><th>Email</th><th>Signup date</th><th>Role</th><th>Status</th><th class="r">Actions</th></tr></thead>
      <tbody>${rows.map(u => {
        const self = u.user_id === meId;
        const lastSuper = u.role === 'super_admin' && u.status === 'active' && activeSupers <= 1;
        return html`<tr key=${u.user_id} class=${u.status === 'blocked' ? 'is-blocked' : ''}>
          <td><strong>${u.name || html`<span class="muted">—</span>`}</strong>${self && html` <${Chip}>You<//>`}</td>
          <td>${u.email || html`<span class="muted">not yet known</span>`}${u.email && !u.email_verified ? html` <${Chip} color="yellow" title="Email not confirmed: can't be added to teams by email">unconfirmed<//>` : ''}</td>
          <td title=${u.last_seen_at ? 'Last seen ' + fmtWhen(u.last_seen_at) : 'Never signed in to this app'}>${fmtDate(u.signed_up_at)}</td>
          <td>
            <select class="sm-select" aria-label=${'Role of ' + label(u)} value=${u.role} disabled=${self || lastSuper}
              title=${self ? 'You can’t change your own role' : lastSuper ? 'The last active Super Admin can’t be demoted' : u.role_changed_by ? `Changed by ${u.role_changed_by.name}, ${fmtWhen(u.role_changed_at)}` : ''}
              onChange=${(e) => { const v = e.target.value; e.target.value = u.role; setRoleFor(u, v); }}>
              ${ROLES.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
          </td>
          <td><${Chip} color=${u.status === 'blocked' ? 'pink' : 'mint'} title=${u.status_changed_by ? `Changed by ${u.status_changed_by.name}, ${fmtWhen(u.status_changed_at)}` : undefined}>${u.status === 'blocked' ? 'Blocked' : 'Active'}<//></td>
          <td class="r"><${ActionsMenu} label=${label(u)} items=${[
            ['Edit name and email', () => setEditing(u)],
            ...(self || lastSuper ? [] : [u.status === 'blocked' ? ['Unblock', () => setStatusFor(u, 'active')] : ['Block', () => setStatusFor(u, 'blocked')]]),
            ...(self || lastSuper ? [] : [['Delete account…', () => deleteFor(u), 'danger']]),
          ]} /></td>
        </tr>`;
      })}</tbody>
    </table></div>`}
    <${AuditLog} />
    ${editing && html`<${EditUser} u=${editing} onClose=${() => setEditing(null)} />`}
    ${confirmBox && html`<${Modal} title=${confirmBox.title} onClose=${() => setConfirm(null)}>
      ${confirmBox.text}
      <div class="row" style="margin-top:14px"><span class="spacer"></span>
        <button class="btn" onClick=${() => setConfirm(null)}>Cancel</button>
        <button class=${'btn ' + (confirmBox.danger ? 'danger-solid' : 'primary')} onClick=${() => { const a = confirmBox.action; setConfirm(null); a(); }}>${confirmBox.confirmLabel}</button>
      </div>
    <//>`}
  </div>`;
}

// Edit the name and email shown in the app. An email set here counts as confirmed, so the account
// can be added to teams with it. A later sign-in whose token carries a name or email replaces them.
function EditUser({ u, onClose }) {
  const [name, setName] = useState(u.name || '');
  const [email, setEmail] = useState(u.email || '');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dirty = name.trim() !== (u.name || '') || email.trim().toLowerCase() !== (u.email || '').toLowerCase();
  const save = async () => {
    setBusy(true);
    try { await change('admin_update_user', { p_user_id: u.user_id, p_name: name.trim() || null, p_email: email.trim() || null }, 'Account updated'); onClose(); }
    catch { setConfirming(false); } finally { setBusy(false); }
  };
  return html`<${Modal} title="Edit account" onClose=${onClose}>
    ${confirming ? html`
      <p>Save these changes to <strong>${u.name || u.email || u.user_id}</strong>?</p>
      <dl class="edit-diff">
        <dt>Name</dt><dd><span class="muted">${u.name || '—'}</span> → <strong>${name.trim() || '—'}</strong></dd>
        <dt>Email</dt><dd><span class="muted">${u.email || '—'}</span> → <strong>${email.trim().toLowerCase() || '—'}</strong></dd>
      </dl>
      ${email.trim() && email.trim().toLowerCase() !== (u.email || '').toLowerCase() && html`<p class="small muted">You’re confirming this email belongs to them: team owners can then add them by it.</p>`}
      <div class="row" style="margin-top:14px"><span class="spacer"></span>
        <button class="btn" onClick=${() => setConfirming(false)}>Back</button>
        <button class="btn primary" disabled=${busy} onClick=${save}>Save changes</button></div>`
    : html`<form class="edit-user" onSubmit=${(e) => { e.preventDefault(); if (dirty) setConfirming(true); }}>
      <label class="field">Name<input type="text" maxlength="200" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Display name" /></label>
      <label class="field">Email<input type="email" maxlength="320" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        <span class="hint">Shown on the Users page and in teams. If their sign-in later sends a name or email, that one is used.</span></label>
      <p class="small muted">Account id: <code>${u.user_id}</code>. Role and status are changed in the table.</p>
      <div class="row"><span class="spacer"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn primary" disabled=${!dirty}>Review changes</button></div>
    </form>`}
  <//>`;
}

function AuditLog() {
  const { data } = useRpc('admin_audit', { p_limit: 30 });
  if (!data || !data.length) return null;
  const describe = (a) => a.action === 'role' ? `role ${roleLabel(a.old)} → ${roleLabel(a.new)}`
    : a.action === 'status' ? (a.new === 'blocked' ? 'blocked' : 'unblocked')
    : a.action === 'bootstrap' ? 'made first Super Admin (SQL editor)'
    : a.action === 'backfill' ? 'kept workspace access as Admin (rollout)'
    : a.action === 'profile' ? `details changed: ${a.old} → ${a.new}`
    : a.action === 'delete' ? 'account deleted' : a.action;
  return html`<section class="section"><div class="section-head"><h3>Recent changes</h3><span class="muted small">who changed a role or blocked an account, and when</span></div>
    <ul class="activity">${data.map((a, i) => html`<li key=${i}><span class="muted small">${fmtWhen(a.at)}</span>
      <span><strong>${a.actor.id === 'migration' ? 'Rollout' : a.actor.id === 'sql-editor' ? 'SQL editor' : a.actor.name}</strong>: ${a.target.name} — ${describe(a)}</span></li>`)}</ul></section>`;
}
