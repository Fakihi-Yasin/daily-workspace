import { html, render, useState, useEffect, useResource, Icon, Toasts, ThemeToggle, api, Avatar } from './lib.js';
import { Today } from './today.js';
import { Settings } from './settings.js';
import { Projects } from './projects.js';
import { YouTube } from './youtube.js';
import { Formation } from './formation.js';
import { Challenges } from './challenges.js';
import { Stats } from './stats.js';
import { MiniTimer } from './focus.js';
import { TeamWork, InvitePage, UnreadNavBadge, RemarkNotifications } from './teamwork.js';
import { Profile } from './profile.js';
import { useWorkspace, navItems, Onboarding, QuickAdd, Views } from './workspace.js';
import { Users } from './users.js';

// Team Work and Users exist only in the synced web build: the database enforces who may use them
// (window.__dash.rpc); these checks only decide what the sidebar shows.
const hasTeams = () => !!(window.__dash && window.__dash.rpc);
const isSuperAdmin = () => !!(window.__dash && window.__dash.rpc && window.__dash.role === 'super_admin');

const ROUTES = [
  ['today', 'Today', 'today', Today],
  ['projects', 'Projects', 'projects', Projects],
  ['youtube', 'YouTube', 'youtube', YouTube, { hidden: true }], // page and data kept; reachable at #/youtube, not in the sidebar
  ['learning', 'Learning', 'formation', Formation],
  ['challenges', 'Challenges', 'challenges', Challenges],
  ['teams', 'Team Work', 'team', TeamWork, { when: hasTeams }],
  ['views', 'Saved views', 'list', Views],
  ['stats', 'Stats', 'stats', Stats],
  ['users', 'Users', 'users', Users, { when: isSuperAdmin }],
  ['settings', 'Settings', 'settings', Settings],
  ['invite', 'Team invite', 'team', InvitePage, { when: hasTeams, hidden: true }],
  ['profile', 'Profile', 'users', Profile, { when: hasTeams }],
];
const allowed = (r) => !(r[4] && r[4].when) || r[4].when();

function NotAvailable({ superOnly }) {
  return html`<div><header class="page-head"><h1>Not available</h1></header>
    <p class="muted">${superOnly ? 'This page is only available to Super Admins.' : 'This page isn’t available in this version of the dashboard.'}</p>
    <p><a class="btn" href="#/today">Back to Today</a></p></div>`;
}

function useHash() {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'today'); // e.g. "teams/<id>"
  const [h, set] = useState(read());
  useEffect(() => { const f = () => { set(read()); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

function App() {
  const path = useHash();
  const [route, ...rest] = path.split('/');
  const { data: modeData } = useResource('/api/mode');
  const known = ROUTES.find(x => x[0] === route);
  const r = known || ROUTES[0];
  const blocked = known && !allowed(known); // typed URL to a page this account can't use
  const Page = blocked ? NotAvailable : r[3];
  // Sidebar: Today first, Settings last; the rest in this account's own order (Customize on Today).
  const w = useWorkspace();
  const order = navItems(w && w.layout) || ['projects', 'learning', 'challenges', 'teams', 'stats'];
  const byKey = (k) => ROUTES.find(x => x[0] === k);
  const navRoutes = [byKey('today'), ...order.map(byKey).filter(Boolean), byKey('users'), byKey('profile'), byKey('settings')]
    .filter(x => !(x[4] && x[4].hidden) && allowed(x));
  // The page you're on stays visible in the sidebar while you're on it, even if hidden there.
  if (known && !blocked && !(r[4] && r[4].hidden) && !navRoutes.includes(r)) navRoutes.splice(navRoutes.length - 1, 0, r);
  useEffect(() => { if (route !== 'today') document.title = `${r[1]} · Dashboard`; }, [route]);
  return html`<div class="shell">
    <nav class="side" aria-label="Main navigation">
      <div class="brand"><i>✓</i><span>Dashboard</span></div>
      ${navRoutes.map(([key, label, icon]) => html`<a class=${'nav-link' + (key === r[0] ? ' on' : '')} href=${'#/' + key} aria-current=${key === r[0] ? 'page' : undefined} title=${label}>
        <${Icon} name=${icon} /><span>${label}</span>${key === 'teams' && html`<${UnreadNavBadge} />`}</a>`)}
      ${hasTeams() && !(route === 'teams' && rest.length) && html`<${RemarkNotifications} />`}
      <div class="side-foot">
        <${MiniTimer} />
        <${ThemeToggle} />
        ${modeData && modeData.mode === 'demo' && html`<a class="demo-flag" href="#/settings" title="Demo mode">D<span>EMO — sample data</span></a>`}
        ${window.__dash && window.__dash.sync && html`<${SyncBadge} />`}
        ${window.__dash && html`<${Account} />`}
      </div>
    </nav>
    <main id="main">${window.__dash && window.__dash.sync && html`<${SyncBanner} />`}<${Page} key=${r[0]} sub=${rest.join('/')} superOnly=${r[0] === 'users'} /></main>
    <${Toasts} />
    <${QuickAdd} />
    <${Onboarding} />
  </div>`;
}

function Account() {
  const u = window.__dash.user;
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(x => x + 1); addEventListener('dash-profile', f); return () => removeEventListener('dash-profile', f); }, []);
  const profile = window.__dash.profile;
  const name = [profile?.display_name, profile?.name, u.name]
    .find(value => value?.trim() && !value.includes('@'))?.trim() || 'My profile';
  const identity = html`<${Avatar} p=${{ ...profile, id: u.id, name }} size=${30} />
    <span class="account-text"><span class="account-id">${name}</span></span>`;
  return html`<div class="account">
    ${hasTeams() ? html`<a class="account-link" href="#/profile" title="Your profile (name and photo)">${identity}</a>`
      : html`<div class="account-link">${identity}</div>`}
    <button class="account-out" onClick=${() => window.__dash.logout()} title="Sign out" aria-label="Sign out"><${Icon} name="logout" size=${16} /><span>Sign out</span></button>
  </div>`;
}

// ---------- cloud sync status (browser build with Supabase) ----------
export function useSync() {
  const sync = window.__dash && window.__dash.sync;
  const [s, set] = useState(sync ? sync.status() : null);
  useEffect(() => (sync ? sync.subscribe(() => set(sync.status())) : undefined), []);
  return [s, sync];
}
const SYNC_LABEL = { idle: 'Saving…', saving: 'Saving…', synced: 'Synced', offline: 'Offline', error: 'Sync failed', signin: 'Sign in to sync', conflict: 'Sync conflict', denied: 'No access' };

function SyncBadge() {
  const [s] = useSync();
  if (!s) return null;
  const bad = ['offline', 'error', 'conflict'].includes(s.state);
  const label = s.state === 'synced' && s.pending ? 'Saving…' : SYNC_LABEL[s.state] || s.state;
  return html`<a class=${'sync-badge' + (bad ? ' bad' : '')} href="#/settings?tab=backup" role="status" aria-live="polite"
    title=${s.error || (s.lastSync ? 'Last synced ' + new Date(s.lastSync).toLocaleTimeString() : label)}>
    <i aria-hidden="true"></i><span>${label}${bad && s.pending ? ' · changes kept here' : ''}</span></a>`;
}

function SyncBanner() {
  const [s, sync] = useSync();
  const [busy, setBusy] = useState(false);
  if (!s || !['offline', 'error', 'conflict'].includes(s.state)) return null;
  const run = (fn) => async () => { setBusy(true); try { await fn(); } catch (e) { alert(e.message || e); } finally { setBusy(false); } };
  if (s.state === 'conflict') {
    return html`<div class="sync-banner conflict" role="alert">
      <p><strong>Sync paused: this dashboard changed on another device while this one had unsynced changes.</strong>
        Nothing has been overwritten. Choose which version to keep — the other one is downloaded as a backup file first, so you can restore it from Settings → Backup.</p>
      <div class="row wrap">
        <button class="btn sm dark" disabled=${busy} onClick=${run(sync.keepCloud)}>Use the cloud version</button>
        <button class="btn sm" disabled=${busy} onClick=${run(() => { if (confirm('Replace the cloud version with this device’s version? The cloud version is downloaded as a file first.')) return sync.keepDevice(); })}>Keep this device’s version</button>
      </div></div>`;
  }
  return html`<div class=${'sync-banner ' + s.state} role="alert">
    <p><strong>${s.state === 'offline' ? 'Offline.' : 'Sync failed.'}</strong>
      ${' '}${s.state === 'error' ? s.error + '. ' : ''}${s.pending ? 'Your latest changes are saved in this browser and will be sent when sync works again — don’t clear this browser’s data.' : 'Your data is up to date on this device.'}</p>
    <div class="row wrap">
      <button class="btn sm" disabled=${busy} onClick=${run(sync.retry)}>Retry now</button>
    </div></div>`;
}

export function mount(el) {
  api('GET', '/api/mode').catch(() => {}); // warm up (ensures today's checklist exists)
  render(html`<${App} />`, el);
}
// The localhost server build mounts right away; the browser build mounts after sign-in (web/entry.js).
if (!window.__DASH_DEFER_MOUNT) mount(document.getElementById('app'));
