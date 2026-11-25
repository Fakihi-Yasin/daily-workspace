// Calls the database functions in supabase/migrations through Supabase's REST API (PostgREST),
// with the publishable key and the signed-in user's Auth0 access token. No privileged key is ever
// used: every permission (role, blocked status, team membership) is checked by the database.
//
// Errors carry flags for the UI:
//   offline  no connection          auth    the sign-in expired (401 / token errors)
//   denied   the account is blocked or waiting for access (workspace_access_denied)
//   status, code                    HTTP status and Postgres error code
export function createRpc({ url, publishableKey, getToken, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const base = url.replace(/\/+$/, '') + '/rest/v1/rpc/';
  return async function rpc(name, args = {}) {
    let token;
    try { token = await getToken(); }
    catch (e) { throw Object.assign(new Error(e.message || 'Sign-in expired'), { auth: !e.offline, offline: !!e.offline }); }
    let res;
    try {
      res = await fetchImpl(base + name, {
        method: 'POST',
        headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch {
      throw Object.assign(new Error('No connection to the server'), { offline: true });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      const raw = (body && (body.message || body.msg || body.error)) || `HTTP ${res.status}`;
      const denied = /workspace_access_denied/.test(raw);
      const msg = denied ? 'This account is blocked or waiting for access.'
        : raw === 'super_admin_required' ? 'Only a Super Admin can do that.'
        : raw;
      throw Object.assign(new Error(msg), {
        status: res.status, code: body && body.code, denied,
        auth: res.status === 401 || /jwt|token/i.test(raw),
      });
    }
    return body;
  };
}
