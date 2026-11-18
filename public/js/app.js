import { html, render, useState, useEffect, useResource, Icon, Toasts, ThemeToggle, api } from './lib.js';
import { Today } from './today.js';
import { Settings } from './settings.js';
import { Projects } from './projects.js';
import { YouTube } from './youtube.js';
import { Formation } from './formation.js';
import { Challenges } from './challenges.js';
import { Stats } from './stats.js';
import { MiniTimer } from './focus.js';

const ROUTES = [
  ['today', 'Today', 'today', Today],
  ['projects', 'Projects', 'projects', Projects],
  ['youtube', 'YouTube', 'youtube', YouTube],
  ['learning', 'Learning', 'formation', Formation],
  ['challenges', 'Challenges', 'challenges', Challenges],
  ['stats', 'Stats', 'stats', Stats],
  ['settings', 'Settings', 'settings', Settings],
];

function useHash() {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'today');
  const [h, set] = useState(read());
  useEffect(() => { const f = () => { set(read()); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

function App() {
  const route = useHash();
  const { data: modeData } = useResource('/api/mode');
  const r = ROUTES.find(x => x[0] === route) || ROUTES[0];
  const Page = r[3];
  useEffect(() => { if (route !== 'today') document.title = `${r[1]} · Dashboard`; }, [route]);
  return html`<div class="shell">
    <nav class="side" aria-label="Main navigation">
      <div class="brand"><i>✓</i><span>Dashboard</span></div>
      ${ROUTES.map(([key, label, icon]) => html`<a class=${'nav-link' + (key === r[0] ? ' on' : '')} href=${'#/' + key} aria-current=${key === r[0] ? 'page' : undefined} title=${label}>
        <${Icon} name=${icon} /><span>${label}</span></a>`)}
      <div class="side-foot">
        <${MiniTimer} />
        <${ThemeToggle} />
        ${modeData && modeData.mode === 'demo' && html`<a class="demo-flag" href="#/settings" title="Demo mode">D<span>EMO — sample data</span></a>`}
        ${window.__dash && html`<${Account} />`}
      </div>
    </nav>
    <main id="main"><${Page} key=${r[0]} /></main>
    <${Toasts} />
  </div>`;
}

function Account() {
  const u = window.__dash.user;
  return html`<div class="account">
    <span class="account-id" title=${u.email}>${u.email || u.name}</span>
    <button class="account-out" onClick=${() => window.__dash.logout()} title="Sign out" aria-label="Sign out"><${Icon} name="logout" size=${16} /><span>Sign out</span></button>
  </div>`;
}

export function mount(el) {
  api('GET', '/api/mode').catch(() => {}); // warm up (ensures today's checklist exists)
  render(html`<${App} />`, el);
}
// The localhost server build mounts right away; the browser build mounts after sign-in (web/entry.js).
if (!window.__DASH_DEFER_MOUNT) mount(document.getElementById('app'));
