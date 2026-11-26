// Auth0 (managed Universal Login). The app never sees or stores passwords: Auth0 hosts the sign-in
// page and returns an ID token; we only read the stable user id (`sub`) and email from it.
// Invite-only access is enforced in Auth0 (sign-ups disabled on the database connection).
import { createAuth0Client } from '@auth0/auth0-spa-js';

// With cloud sync, `audience` is the Auth0 API whose access tokens Supabase accepts (Third-Party Auth);
// the user id stays the same Auth0 `sub`, so existing accounts keep their identity.
export async function createAuth({ domain, clientId, audience }) {
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

  const authed = await client.isAuthenticated();
  const u = authed ? await client.getUser() : null;
  return {
    provider: 'auth0',
    error,
    // picture: only a Google sign-in's photo is offered as a profile photo (the user chooses it).
    user: u && u.sub ? { id: u.sub, email: u.email || '', name: u.name || u.email || '', picture: u.sub.startsWith('google-oauth2|') && typeof u.picture === 'string' ? u.picture : '' } : null,
    login: (opts = {}) => client.loginWithRedirect({ appState: { hash: window.location.hash }, ...(opts.signup ? { authorizationParams: { screen_hint: 'signup' } } : {}) }),
    // Access token for the sync API. Errors (expired session, missing consent…) are tagged `auth`.
    // { fresh: true } skips the cached token, so claims such as email_verified are re-read.
    getToken: async ({ fresh = false } = {}) => {
      try {
        return await client.getTokenSilently({ ...(audience ? { authorizationParams: { audience } } : {}), ...(fresh ? { cacheMode: 'off' } : {}) });
      } catch (e) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw Object.assign(new Error('Offline'), { offline: true });
        throw Object.assign(new Error(e.error_description || e.message || 'Sign-in expired'), { auth: true });
      }
    },
    logout: () => client.logout({ logoutParams: { returnTo: window.location.origin + '/' } }),
  };
}
