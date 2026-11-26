// Auth0 (managed Universal Login). The app never sees or stores passwords: Auth0 hosts the sign-in
// page and returns an ID token; we only read the stable user id (`sub`) and email from it.
// Invite-only access is enforced in Auth0 (sign-ups disabled on the database connection).
import { createAuth0Client } from '@auth0/auth0-spa-js';

// With cloud sync, `audience` is the Auth0 API whose access tokens Supabase accepts (Third-Party Auth);
// the user id stays the same Auth0 `sub`, so existing accounts keep their identity.
const interactionErrors = new Set(['login_required', 'interaction_required', 'consent_required',
  'missing_refresh_token', 'invalid_grant', 'invalid_refresh_token']);

export async function createAuth({ domain, clientId, audience, resume }) {
  const client = await createAuth0Client({
    domain,
    clientId,
    authorizationParams: { redirect_uri: window.location.origin + '/', ...(audience ? { audience } : {}) },
    // Keeps the session across reloads without third-party cookies. Holds tokens only — no dashboard data.
    cacheLocation: 'localstorage',
    useRefreshTokens: true,
    useRefreshTokensFallback: false,
  });

  let error = null;
  const q = new URLSearchParams(window.location.search);
  if (q.has('error')) error = q.get('error_description') || q.get('error');
  if (q.has('code') && q.has('state')) {
    try {
      const { appState } = await client.handleRedirectCallback();
      const hash = appState && typeof appState.hash === 'string' && appState.hash.startsWith('#/') ? appState.hash : '';
      window.history.replaceState({}, '', '/' + hash);
    } catch (e) {
      error = e.message || 'Sign-in failed';
      window.history.replaceState({}, '', '/');
    }
  } else if (q.has('error')) {
    window.history.replaceState({}, '', '/');
  }

  const getToken = async ({ fresh = false } = {}) => {
    try {
      return await client.getTokenSilently({ ...(audience ? { authorizationParams: { audience } } : {}), ...(fresh ? { cacheMode: 'off' } : {}) });
    } catch (e) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw Object.assign(new Error('Offline'), { offline: true });
      throw Object.assign(new Error(e.error_description || e.message || 'Sign-in unavailable'), { auth: interactionErrors.has(e.error) });
    }
  };

  let user = await client.getUser();
  let sessionExpired = false;
  if (!user && resume && !error && navigator.onLine !== false) {
    try { await getToken(); user = await client.getUser(); }
    catch (e) { sessionExpired = !!e.auth; }
  }
  return {
    provider: 'auth0',
    error,
    sessionExpired,
    // Offer Google’s photo as an option. Profile settings control whether teammates see it.
    user: user && user.sub ? { id: user.sub, email: user.email || '', name: user.name || user.email || '', picture: user.sub.startsWith('google-oauth2|') && typeof user.picture === 'string' ? user.picture : '' } : null,
    login: (opts = {}) => client.loginWithRedirect({ appState: { hash: window.location.hash }, ...(opts.signup ? { authorizationParams: { screen_hint: 'signup' } } : {}) }),
    getToken,
    logout: () => client.logout({ logoutParams: { returnTo: window.location.origin + '/' } }),
  };
}
