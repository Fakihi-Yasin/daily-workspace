// Sends only the HOSTNAME of the active tab (and whether the browser window has focus) to the PC Work
// Time agent on this computer (http://127.0.0.1). Nothing is sent anywhere else. Never the page title,
// the full address (path, query), page contents, form fields or keystrokes. Private windows are ignored.
const api = globalThis.browser || globalThis.chrome;
let last = '';

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch { return null; }
}

async function current() {
  const win = await api.windows.getLastFocused({ populate: false }).catch(() => null);
  if (!win || !win.focused || win.incognito) return { domain: null, focused: false };
  const [tab] = await api.tabs.query({ active: true, windowId: win.id });
  return { domain: tab && !tab.incognito ? hostOf(tab.url) : null, focused: true };
}

async function report(force) {
  const { token, port } = await api.storage.local.get(['token', 'port']);
  if (!token) return;
  const state = await current();
  const key = JSON.stringify(state);
  if (!force && key === last) return;
  last = key;
  try {
    await fetch(`http://127.0.0.1:${port || 47613}/ext/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DW-Token': token }, body: key,
    });
  } catch { /* the agent isn't running: nothing to do */ }
}

api.tabs.onActivated.addListener(() => report());
api.tabs.onUpdated.addListener((_id, info) => { if (info.url) report(); });
api.windows.onFocusChanged.addListener(() => report());
api.alarms.create('dw-heartbeat', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener((a) => { if (a.name === 'dw-heartbeat') report(true); });
api.runtime.onStartup.addListener(() => report(true));
api.runtime.onInstalled.addListener(() => report(true));
