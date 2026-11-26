// Calls the database functions in supabase/migrations through Supabase's REST API (PostgREST),
// with the publishable key and the signed-in user's Auth0 access token. No privileged key is ever
// used: every permission (role, blocked status, team membership) is checked by the database.
//
// Errors carry flags for the UI:
//   offline  no connection          auth    the sign-in expired (401 / token errors)
//   denied   the account is blocked (workspace_access_denied)
//   status, code                    HTTP status and Postgres error code
export function createRpc({ url, publishableKey, getToken, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const base = url.replace(/\/+$/, '') + '/rest/v1/rpc/';
  async function request(name, args, fresh) {
    let token;
    try { token = await getToken(fresh ? { fresh: true } : undefined); }
    catch (e) { throw Object.assign(new Error(e.message || 'Sign-in expired'), { auth: !!e.auth, offline: !!e.offline }); }
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
      const msg = denied ? 'This account is blocked.'
        : raw === 'super_admin_required' ? 'Only a Super Admin can do that.'
        : raw;
      throw Object.assign(new Error(msg), {
        status: res.status, code: body && body.code, denied,
        auth: res.status === 401 && (['PGRST301', 'PGRST302', 'PGRST303'].includes(body && body.code)
          || /^(?:jwt expired|invalid jwt|jwt malformed|invalid token)(?:\b|$)/i.test(raw)),
      });
    }
    return body;
  }
  return async function rpc(name, args = {}) {
    try {
      return await request(name, args, false);
    } catch (e) {
      if (e.status !== 401 || !e.auth) throw e;
    }
    return request(name, args, true);
  };
}
