// TEST-ONLY identity provider, used by the automated browser tests (`npm run build:test` → dist-test/).
// scripts/build.js refuses to put it in a deployable build (dist/ or any build running on Vercel).
const KEY = 'test-auth.user';

export async function createAuth() {
  const id = window.localStorage.getItem(KEY);
  return {
    provider: 'test',
    error: null,
    user: id ? { id: 'test|' + id, email: id + '@test.invalid', name: id } : null,
    login: (who) => { if (!who) return; window.localStorage.setItem(KEY, who); window.location.replace('/' + window.location.hash); },
    logout: () => { window.localStorage.removeItem(KEY); window.location.replace('/'); },
  };
}
