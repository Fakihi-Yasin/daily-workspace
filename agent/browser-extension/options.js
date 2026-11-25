const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
api.storage.local.get(['token', 'port']).then(({ token, port }) => { $('token').value = token || ''; $('port').value = port || 47613; });
$('save').addEventListener('click', async () => {
  const token = $('token').value.trim(), port = +$('port').value || 47613;
  await api.storage.local.set({ token, port });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ext/active`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DW-Token': token }, body: JSON.stringify({ domain: null, focused: false }) });
    $('msg').textContent = r.ok ? 'Connected to the agent.' : 'The agent refused this token.';
  } catch { $('msg').textContent = 'Saved. The agent is not running right now.'; }
});
