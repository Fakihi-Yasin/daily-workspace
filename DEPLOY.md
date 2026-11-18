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

## Later: moving to Supabase

- **Engine:** the dashboard talks to storage only through `web/storage.js` (`load`, `save`, `revision`, `remove`, prefs).
- **Supabase adapter:** a Supabase version would implement the same methods against a `snapshots` table (`user_id`, `slot`, `snapshot jsonb`, `rev`), protected by row-level security (`user_id = auth.uid()`).
- **Fine-grained alternative:** import the per-table rows using the versioned backup format.
- **IDs:** record ids, and the `dataset_id` of every dataset, are preserved through export/import, so links between records survive the move.
