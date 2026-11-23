# Deploying to Vercel (V1: Auth0 sign-in, data in the browser)

## How V1 works

- **Hosting:** Vercel serves a static build (`dist/`). There is no server and no database on Vercel.
- **Sign-in:** [Auth0](https://auth0.com) Universal Login, a hosted sign-in page. The app never sees or stores passwords. It only reads the stable user id (`sub`) and email from Auth0.
- **Invite-only:** public sign-ups are disabled in Auth0. Only users you create can sign in.
- **Data:** each signed-in user gets their own storage slot in the browser's localStorage (`dash.v1.u.<user id>.*`). A new account starts with an empty dashboard.
- **Engine:** the dashboard runs the same code as the localhost app, against an in-browser SQLite (sql.js).
- **No sync:** there is no cross-device sync. Data stays in the browser and profile where it was created. Use **Settings → Backup** to move it.
- **Shared browsers:** localStorage is **not a security boundary**. Anyone using the same browser profile can read site storage with developer tools. The app never shows another account's data, but don't keep passwords or other sensitive information in the dashboard.
- **Without sign-in settings:** the build refuses to run without the Auth0 settings, so an unprotected dashboard can't be deployed. Every route shows the sign-in screen until Auth0 confirms a session.

## 1. Auth0 (about 10 minutes)

1. Create a free Auth0 account and tenant (choose the EU region if you prefer). Your tenant domain looks like `your-tenant.eu.auth0.com`.
2. **Applications → Applications → Create Application** → name it `Dashboard` → type **Single Page Web Applications** → Create.
3. In the application's **Settings** tab, fill these in (replace `your-project` with your Vercel project name):
   - **Allowed Callback URLs:** `https://your-project.vercel.app/, http://localhost:4322/`
   - **Allowed Logout URLs:** `https://your-project.vercel.app/, http://localhost:4322/`
   - **Allowed Web Origins:** `https://your-project.vercel.app, http://localhost:4322`
   - **Refresh Token Rotation:** turn **Rotation** on.
   - Click **Save**.
4. **Make it invite-only:**
   - **Authentication → Database → Username-Password-Authentication** → turn **Disable Sign Ups** on.
   - **Applications → Dashboard → Connections:** keep **only** `Username-Password-Authentication` enabled. Turn **off** `google-oauth2` and any other social login. A social login would let anyone with that kind of account in.
5. **Create your own user:** **User Management → Users → Create User** → your email and a strong password → connection `Username-Password-Authentication`.
6. **Invite a friend later:** create a user for their email in the same way. Tell them to open the app, click **Sign in**, then **Forgot password?** to set their own password. They get their own empty dashboard and never see yours.
7. *(Optional safety net)* If sign-ups are ever re-enabled by mistake, an email allowlist still blocks unknown accounts. Go to **Actions → Library → Build Custom → Login / Post Login**, paste the code below, then add a secret `ALLOWED_EMAILS` (comma-separated). Deploy it and drag it into **Actions → Triggers → post-login**.
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     const allowed = (event.secrets.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
     if (!allowed.includes((event.user.email || '').toLowerCase())) api.access.deny('This dashboard is invitation-only.');
   };
   ```

## 2. Vercel

1. Push this folder to your GitHub repository. `data/`, `dist/`, `node_modules/` and `.env*` are ignored, so your local data is never committed.
2. On vercel.com: **Add New → Project → Import** the repository.
   - **Framework Preset:** Other. The build and output settings come from `vercel.json`: `npm ci`, `npm run build`, output `dist`.
3. **Environment Variables** (Project → Settings → Environment Variables), for **Production** and **Preview**:

   | Name | Value |
   |---|---|
   | `AUTH0_DOMAIN` | your tenant domain, e.g. `your-tenant.eu.auth0.com` |
   | `AUTH0_CLIENT_ID` | the Dashboard application's **Client ID** |

   Both are public identifiers: an Auth0 single-page app has no client secret, and none is used. Nothing secret goes in the repository.
4. Deploy. If the variables are missing, the build stops with `Refusing to build a dashboard without sign-in`.
5. Copy the production URL into the three Auth0 URL fields above, if it differs from what you entered.
6. **Preview deployments:** keep **Settings → Deployment Protection → Vercel Authentication** on. Preview URLs aren't in the Auth0 allow-lists, so sign-in only works on the production URL and `localhost:4322`. Avoid adding a `*.vercel.app` wildcard to Auth0.

The CLI works too: `npx vercel link`, then `npx vercel env add AUTH0_DOMAIN` and `npx vercel env add AUTH0_CLIENT_ID`, then `npx vercel --prod`.

## 3. Move your data from localhost

1. On the localhost app (`npm start` → http://localhost:4321): **Settings → Backup → Download a backup**. This saves a JSON file, `format_version: 1`.
2. On the deployed app, sign in with **your** account → **Settings → Backup → Restore** → choose the file.
3. Check the preview, which shows current vs. backup counts. Then click **Replace my data**. Your current browser data (empty, the first time) is downloaded as a safety file first.

The import only ever goes into the account you are signed in with. Nothing is attached to an account automatically.

## Check the production build locally

```bash
AUTH0_DOMAIN=your-tenant.eu.auth0.com AUTH0_CLIENT_ID=xxxx npm run build
npm run preview          # → http://localhost:4322 (this URL is in the Auth0 allow-lists above)
```

## Cloud sync with Supabase (V2)

With three extra environment variables, the same build syncs each account's dashboard across devices
through Supabase. Without them it stays browser-only (V1), so the switch is per Vercel environment.

### How it works
- **Sign-in is unchanged:** Auth0 stays the login. Supabase **Third-Party Auth** trusts the Auth0
  tenant, and the database identifies you by the Auth0 user id (`sub`), the same id that V1 already
  used. No passwords are moved and no accounts are migrated.
- **Data:** one row per account in `public.snapshots` (migration in `supabase/migrations/`). Grants and
  row-level security mean signed-out visitors have no access, and a signed-in user can only read and
  write the row whose `user_id` is their own token's `sub`.
- **Sync:** every change is written to this browser first and marked pending, then sent to Supabase.
  The write is a compare-and-swap, so a device never overwrites a newer cloud version. Retries reuse
  the same revision id, so a retry never writes twice. If two devices both edited while one was
  offline, a banner asks which version to keep, and the other version is downloaded as a file first.
  Pending changes survive reloads, closed tabs and expired sessions.
- **No server:** the browser talks to Supabase's REST API with the **publishable** key and the
  user's Auth0 access token. The build refuses a secret or service_role key.
- **Existing browser data** (V1, `dash.v1.*` in localStorage) is never moved, changed or deleted. Import
  it, or any JSON backup, from **Settings → Backup**. You get a preview and must confirm with **Replace my
  account data**. Your current account data is downloaded first. An import replaces data with the
  same record ids, so importing the same file twice never creates duplicates, and the preview tells
  you when that exact file was already imported.

### Environment variables (Vercel → Settings → Environment Variables)

| Name | Value | Environments |
|---|---|---|
| `AUTH0_DOMAIN` | unchanged | Production, Preview |
| `AUTH0_CLIENT_ID` | unchanged | Production, Preview |
| `AUTH0_AUDIENCE` | the Auth0 API identifier, e.g. `https://daily-workspace-sync` | Preview first; Production when you go live |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Preview first; Production when you go live |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (Supabase → Project Settings → API Keys) | Preview first; Production when you go live |

The database password and the `sb_secret_…` / service_role key are not used anywhere. Don't add them.

### Setup
1. **Auth0 → Applications → APIs → Create API:** name `Daily Workspace sync`, identifier
   `https://daily-workspace-sync` (this is `AUTH0_AUDIENCE`), signing algorithm **RS256**. Under its
   **Application Access**, allow the Dashboard SPA (user access).
2. **Auth0 → Actions → Library → Create Action → Login / Post Login**, named `supabase-role`:
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     // Supabase Third-Party Auth maps this claim to the Postgres role used by row-level security.
     api.accessToken.setCustomClaim('role', 'authenticated');
   };
   ```
   Deploy it and drag it into **Actions → Triggers → post-login**. It only adds a claim to access
   tokens. Logins, users and user ids don't change.
3. **Supabase → Authentication → Sign In / Providers → Third-Party Auth → Add provider → Auth0**:
   enter the tenant ID and region (from `AUTH0_DOMAIN`: `my-tenant.eu.auth0.com` means tenant
   `my-tenant`, region `eu`).
4. **Supabase → SQL Editor:** run `supabase/migrations/20261123000000_cloud_snapshots.sql`, or use
   `supabase db push` with the Supabase CLI. Check that **Database → Tables → snapshots** shows RLS enabled.
5. **Supabase → Integrations → Data API:** keep it enabled, with `public` among the exposed schemas.
6. **Preview sign-in:** add the preview's fixed branch URL to the Auth0 application's Allowed Callback
   URLs, Allowed Logout URLs (with a trailing `/`) and Allowed Web Origins (without the `/`). Remove it after the review.
7. **Check access:** run `npm run check:rls` with `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, plus
   `TOKEN_A` / `TOKEN_B` (access tokens of two **test** accounts) for the cross-account checks.

### Storage interface
The engine only talks to storage through `web/storage.js` (browser-only) or `web/cloud-store.js`
(sync), which share the same methods: `load`, `save`, `revision`, `remove`, prefs.
