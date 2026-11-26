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

## Roles, User Management and Team Work (V3, needs Supabase sync)

Roles and teams exist only in builds with Supabase sync. The browser-only build (V1) and the localhost
app have no server to enforce them, so they keep working as before, without Team Work or Users.

### What it does
- **Roles** (`public.app_users`, keyed by the Auth0 user id `sub`, never by name or email):
  - **Admin**: every new signup (the default role, migration `20261125220000_new_accounts_admin_team_member_picker.sql`).
    Their own private dashboard plus Team Work: creates teams (picking members by email from the
    list of active accounts) and manages the ones they own.
  - **User**: given by a Super Admin. Their own dashboard plus the teams someone adds them to; can't
    create teams.
  - **Super Admin**: Admin features, plus the **Users** page and a read-only **All teams** view.
    Personal dashboards stay private. Nobody, a Super Admin included, can read another account's snapshot.
- **Blocking** applies on the account's next request to the database, including from a browser that is
  already signed in. Open browsers also re-check access every 20 seconds and on focus, then switch to a
  "This account is blocked" screen. The data stays where it is, and unblocking restores it.
- **Enforcement is in the database.** New tables have RLS enabled with no policies and no API grants.
  All reads and writes go through `SECURITY DEFINER` functions that check the caller's role, status
  and team membership on every call. Snapshot reads and writes now also require an active Admin or
  Super Admin. The sidebar only hides links: typing `#/users` as an Admin shows "Not available", and
  calling the functions directly is refused (HTTP 403).
- **Team data** (`teams`, `team_members`, `team_tasks`, `team_future_projects`, `team_events`) is stored
  apart from personal snapshots. Backups and restores of a personal dashboard never include it.
- **Who changed what:** every role change and block or unblock is recorded in `public.user_audit`, with
  the actor, the target, the old and new values, and the time. The Users page shows the latest changes.

### Rollout (Preview first)
1. **Auth0 Action:** replace the code of the `supabase-role` post-login Action with the code below, then
   **Deploy**. Name, email and the signup date come from this signed token. A user can't edit them, and
   they are only shown to people, never used for permissions. Only a **verified** email can be used to
   add someone to a team, so nobody can claim a friend's address by signing up with it.
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.accessToken.setCustomClaim('role', 'authenticated'); // Supabase Third-Party Auth (unchanged)
     const ns = 'https://daily-workspace/';
     api.accessToken.setCustomClaim(ns + 'email', event.user.email || null);
     api.accessToken.setCustomClaim(ns + 'email_verified', !!event.user.email_verified);
     api.accessToken.setCustomClaim(ns + 'name', event.user.name || event.user.nickname || null);
     api.accessToken.setCustomClaim(ns + 'created_at', event.user.created_at || null);
   };
   ```
2. **Database:** in the Preview project's SQL Editor, run
   `supabase/migrations/20261124000000_roles_and_teams.sql`. **Do this before deploying the new
   build**, or the new build can't check access and shows "Can't open the workspace".
   - Every account that already has a synced dashboard becomes **Admin**, so existing users keep their
     workspace. This is logged in the audit as "rollout". Nobody is made Super Admin automatically.
3. **First Super Admin:** in Auth0 → **User Management → Users**, open your own user and copy its
   **user_id** (for example `auth0|64f…`). In the SQL Editor, run:
   ```sql
   select app_private.bootstrap_super_admin('auth0|64f…');
   ```
   It only works from the SQL Editor (not through the API), and it refuses to run once an active Super
   Admin exists. Promote everyone else from the **Users** page.
4. Deploy the Preview build. Sign in, check **Users** and **Team Work**, then run `npm run check:rls`
   with `TOKEN_A` and `TOKEN_B` of two **test** Admin accounts.
   - Preview needs its **own** Supabase project (never the Production one) and its own variables:
     Vercel → Settings → Environment Variables, environment **Preview** only: `AUTH0_DOMAIN`,
     `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE` (same values as Production), and `SUPABASE_URL` +
     `SUPABASE_PUBLISHABLE_KEY` of the **test** project. Without the Auth0 variables, or with Supabase
     but no `AUTH0_AUDIENCE`, the build stops on purpose ("Build stopped: …" in the Vercel log).
   - In the test project: Authentication → Sign In / Providers → Third-Party Auth → add the same Auth0
     tenant, then run both migrations in order (`20261123000000_cloud_snapshots.sql`, then this one).
   - In Auth0 → Applications → your SPA, add the branch URL
     `https://daily-workspace-git-daily-workspace-v3-<team>.vercel.app` to Allowed Callback URLs,
     Allowed Logout URLs and Allowed Web Origins.
5. **Sign-ups:** every new signup gets their own empty dashboard at once (role Admin). Leave
   **Disable Sign Ups** on unless you want anyone to be able to register. If you use the optional `ALLOWED_EMAILS` Action,
   unknown emails are still refused before they can register.
6. Production: only after Preview works. Do it in this order, all in the **Production** project's SQL
   Editor, and keep the previous working Vercel deployment so you can roll back (Deployments → ⋯ →
   Instant Rollback; that changes only the app, never the database).

   `snapshots` has **forced** row level security, so in the SQL Editor a plain
   `select … from public.snapshots` may show 0 rows although the data is there. The scripts below lift
   it inside their own transaction only.

   a. **Review (read-only, ends with `rollback`).** Confirms the migration isn't applied yet and
      lists every account the migration will keep as **Admin**. Find your own `user_id` in that list
      and check it against Auth0 → User Management → Users → you → `user_id`, character for character.
      ```sql
      begin;
      select to_regprocedure('public.register_me()') as register_me,
             to_regclass('public.app_users')        as app_users,
             to_regnamespace('app_private')         as app_private;
      alter table public.snapshots no force row level security;  -- undone by the rollback
      select user_id, slot, version, created_at, updated_at, pg_column_size(snapshot) as bytes
        from public.snapshots order by created_at;
      rollback;
      ```
   b. **Backup.** In the app: Settings → Backup (your own dashboard as a file). Then this server-side
      copy of every snapshot, in a schema the Data API doesn't expose. It must say `identical = true`:
      ```sql
      begin;
      alter table public.snapshots no force row level security;
      create schema if not exists backup;
      revoke all on schema backup from public, anon, authenticated;
      create table backup.snapshots_20261125 as table public.snapshots;
      revoke all on table backup.snapshots_20261125 from public, anon, authenticated;
      select (select count(*) from public.snapshots) as live_rows,
             (select count(*) from backup.snapshots_20261125) as backup_rows,
             (select md5(string_agg(user_id || rev || snapshot::text, ',' order by user_id, slot)) from public.snapshots)
           = (select md5(string_agg(user_id || rev || snapshot::text, ',' order by user_id, slot)) from backup.snapshots_20261125) as identical;
      alter table public.snapshots force row level security;
      commit;
      ```
   c. **Migration:** run `20261124000000_roles_and_teams.sql`. It ends with the notice
      `Rollout: N existing account(s) kept workspace access as Admin`. N must equal the number of
      accounts in (a). If they don't match, it stops and changes nothing. Then run
      `notify pgrst, 'reload schema';`.
   d. **Super Admin:** `select app_private.bootstrap_super_admin('<your user_id from a>');`
   e. **Check:** `select user_id, role, status from public.app_users order by role;` shows you as
      `super_admin` and the others as `admin`. In the app: sign in, open **Users**, and check your
      tasks are there.

A new signup appears in **Users** the first time the app loads after their Auth0 sign-in. That's
the redirect straight after signup, even if they never reach the workspace.

### Rules in short
Members can be Users or Admins; the same rules apply. Only Admins and Super Admins can create a team.
A team name is unique per owner (case ignored); different owners may use the same name. To add a
member, the owner **invites their full email** (People → Add member); see *Invites, profiles, unread
badges* below. Only a Super Admin can list accounts and emails (Users page, and the "Add an existing
account" picker on teams they own); for everyone else the database refuses it (HTTP 403).

**Users page actions (Super Admin):** change role, Block / Unblock, **Edit** name and email (an email
set here counts as confirmed), and **Delete**. Delete removes the account from the app and its teams
(tasks it created pass to the team owner; tasks assigned to it become unassigned). Its dashboard goes
to `app_private.deleted_snapshots` for recovery from the SQL editor. Team owners can't be deleted until
their teams are deleted, and the Auth0 login is untouched: Block is the way to keep someone out.

| | Owner of the team | Member | Super Admin (not a member) | Everyone else |
|---|---|---|---|---|
| See the team, members (name, email), tasks, scores | ✔ | ✔ | ✔ read-only | ✖ not even its name |
| Add / remove members, rename, delete the team | ✔ | ✖ | ✖ | ✖ |
| Create tasks | ✔ | ✔ | ✖ | ✖ |
| Edit, reassign, delete a task | ✔ any task | tasks they created | ✖ | ✖ |
| Change a task's status | ✔ | tasks they created or that are assigned to them | ✖ | ✖ |
| Future projects (add, edit, move into active work) | ✔ | ✖ | ✖ | ✖ |

Only current members can be assignees. Removing a member unassigns their tasks in that team.
**Daily team score** for a selected day: the tasks assigned to the member and due that day that were
done by the end of that day, divided by the tasks due that day. Days use the workspace timezone.
"Completed that day" lists every task the member finished that day, whatever its due date. Team scores
are separate from the personal Daily Score.

### Local test setup
`node scripts/fake-sync-server.js 54321` runs the real migrations in PGlite (in-memory Postgres,
TEST ONLY). Build with `SUPABASE_URL=http://localhost:54321 SUPABASE_PUBLISHABLE_KEY=sb_publishable_test npm run build:test`,
then serve it with `node scripts/preview.js dist-test 4323`. Open
`http://localhost:54321/__bootstrap?user=<name>` to make the test account `test|<name>` the first
Super Admin. `npm test` includes `test/roles-teams.test.js`, which runs the same SQL.

## Invites, profiles, unread badges, Super Admin team delete (migration 20261126120000)

### What it does
- **Private directory:** `team_member_directory`, `team_member_candidates`, `team_add_member` (by email)
  and `team_add_member_id` require an active **Super Admin**; `team_create_with_members` takes members
  from a Super Admin only. A regular Admin's People → Add member is a single email field: no list,
  no search, no account count.
- **Invites by email:** the owner types the full email → `POST /api/invite` (Vercel Function,
  `api/invite.mjs`). The function has no database power: it calls the database with the owner's own
  token. `team_invite_create` (owner only) never looks at accounts, so the answer is identical for a
  registered and an unregistered email. It stores only a SHA-256 hash of a random 64-character token.
  The email is sent; **only after the provider accepts it** is the invite marked `sent` and the owner
  sees "Invite sent". If sending fails, it is marked `failed` and can never be used. An invite works
  **once**, for **7 days**, and only for a signed-in active account whose **verified** email equals the
  invited one; it adds that account to that team only and never changes its role. A new invite to the
  same email replaces the old one; the owner can cancel pending invites. At most 50 invites per owner
  per 24 hours.
- **Invite link:** `https://<app>/#/invite/<token>`. The token stays in the URL hash (never sent to
  the server) and survives sign-in, sign-up ("Create an account" on the sign-in screen) and switching
  accounts. Someone who just signed up and hasn't confirmed their email sees "Confirm your email", then
  "check again" (a fresh token re-reads `email_verified`).
- **Profiles** (sidebar → your name, `#/profile`): display name, upload or remove a photo (resized to
  256 px JPEG in the browser), or **Use my Google photo** for Google sign-ins. Without a photo, two
  initials from the display name (OSM BEN → OB, Bianco Verde → BV). Photos are only returned to the
  user, people who share a team with them, and Super Admins. Same avatar in team member cards and on
  the Users page. A Super Admin's name edit sets the display name.
- **Unread team tasks:** `team_task_seen` stores, per user and team, when the board was last opened.
  The red **+N** on Team Work (sidebar, loaded with the dashboard) and on each team card counts tasks
  **created by someone else** after that, in teams the user is a member of. Opening a team's board
  clears only that team, once its tasks have loaded; opening the Team Work list clears nothing. Own
  tasks, edits and status changes never count. Existing memberships started at "seen" on rollout.
- **Team delete:** the owner (unchanged) or **any Super Admin**, also from Team Work → All teams → ⋯ →
  Delete team. The dialog names the team and what is deleted (tasks, future projects, scores,
  activity, pending invites) and needs the team name typed. Accounts, personal dashboards and other
  teams are untouched. Every team deletion is in the audit log (who, team name, when, counts).

### Email provider (required for invites)
Without it the app refuses to invite ("Invites can't be emailed yet… No invite was sent") and creates
nothing. Set these in Vercel → Settings → Environment Variables (Production), then redeploy:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | from [Resend](https://resend.com) (Vercel Marketplace: `resend/resend-email`), secret |
| `INVITE_FROM_EMAIL` | e.g. `Dashboard <invites@your-domain.com>`: an address on a domain verified in Resend |
| `APP_URL` | optional; the link's origin. Defaults to `https://<VERCEL_PROJECT_PRODUCTION_URL>` |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | already set (also used by the function) |

Auth0: the existing post-login Action already puts `email_verified` in the token; nothing to change.
For "Create an account" to work, sign-ups must be enabled on the Auth0 database connection.

### Local test
`INVITE_TEST_OUTBOX=/tmp/outbox.jsonl APP_URL=http://localhost:4323 SUPABASE_URL=http://localhost:54321 SUPABASE_PUBLISHABLE_KEY=sb_publishable_test node scripts/preview.js dist-test 4323`
writes emails to that file instead of sending them (refused on Vercel). The fake server's
`/__verify?user=<name>&v=0|1` toggles a test account's `email_verified`.

## PC Work Time & Activity Details (desktop agent)

Counts active computer time even when the dashboard is closed, and stores **daily totals only** in the
account (active seconds; Work and Personal seconds when Activity Details are on), separately from Focus
Sessions. Migrations: `20261126000000_pc_work_time.sql`, `20261126010000_pc_work_split_and_delete.sql`.
Agent source: `agent/` (served at `/pc-agent/`). One Python file (`dw-pc-time.py`, standard library only)
shares the counting and sync logic; small adapters handle each system.

### Privacy rules (all systems)
- Never: screenshots or screen recording; keystrokes, typed text, passwords, messages, clipboard; window
  or page titles; full URLs. Idle time comes only from the OS idle timer (time since last input).
- Activity Details are **off by default** (`dw-pc-time details on`). When on, the computer keeps only the
  foreground app's name, the active tab's domain (optional browser extension) and the time — in a local
  SQLite file (30 days) — shown at `http://127.0.0.1:47613` (`dw-pc-time open`): daily timeline,
  Work / Personal / Uncategorized, exclusion list, Delete history. Only the daily Work / Personal totals
  are synced. Settings → PC Work Time → **Delete synced history** removes the account's totals.
- The local page and the extension endpoint listen on 127.0.0.1 only, check the Host header, and need a
  token (one-time link from `dw-pc-time open`; extension token from `dw-pc-time extension-token`).

### Install (Settings → PC Work Time → Connect this PC shows the command with your code)
| System | Command | Starts at login via | Needs |
|---|---|---|---|
| Ubuntu / Linux | `curl -fsSL <dashboard>/pc-agent/install.sh \| bash -s -- CODE` | systemd user service | python3, gdbus |
| macOS | `curl -fsSL <dashboard>/pc-agent/install-macos.sh \| bash -s -- CODE` | LaunchAgent | python3 (Command Line Tools) |
| Windows 10/11 | PowerShell: `$env:DW_CODE='CODE'; irm <dashboard>/pc-agent/install-windows.ps1 \| iex` | HKCU `Run` key (pythonw) | Python 3.9+ |

Commands: `dw-pc-time status | pause | resume | idle N | details on|off | domains on|off | open |
autostart on|off | browser-extension | gnome-extension | sync`. Linux removal: `<dashboard>/pc-agent/uninstall.sh`;
macOS / Windows: `dw-pc-time autostart off`, then delete the agent folder.

### How each system is read
| | Idle (OS idle timer) | Screen locked | Foreground app (Activity Details) |
|---|---|---|---|
| Linux GNOME | Mutter IdleMonitor (D-Bus) | GNOME ScreenSaver / logind LockedHint | Wayland: only with the bundled GNOME Shell extension (`dw-pc-time gnome-extension`, then log out/in); X11: `xprop` WM_CLASS |
| Linux KDE / other | freedesktop ScreenSaver, `xprintidle` | freedesktop ScreenSaver | X11 only |
| Windows | `GetLastInputInfo` | input desktop can't be switched to | `GetForegroundWindow` → process name |
| macOS | IOHIDSystem `HIDIdleTime` | `CGSSessionScreenIsLocked` (ioreg) | `lsappinfo front` |
Sleep / hibernate on every system: a gap longer than 30 s between checks is never counted.

### Tested (25–26 Nov 2026)
- **Ubuntu 24.04, GNOME 46, Wayland — tested on a real machine:** install command from the dashboard,
  systemd service enabled for the graphical session, counting, idle setting from the dashboard, Pause
  (computer → server 47 s) and Resume (dashboard → computer), **screen lock stops counting** (seen twice,
  the screen locked by itself), offline totals kept and uploaded when the server returned, disconnect
  refuses the key, uninstall. Local Activity Details page, token and Host checks. The browser
  extension's code was run against the live agent with a stand-in for the browser API (Chrome 157 no
  longer loads unpacked extensions from the command line), so it is **not tested inside a browser**.
- **Sleep / suspend:** covered by unit tests only (not suspended for real).
- **GNOME Shell extension (Wayland foreground app):** written for GNOME 45–48, **not loaded or tested**
  (needs a logout). Without it, apps show as "Unknown app" on Wayland.
- **Windows and macOS: not tested** on a real machine (no such machine available). The adapters use
  documented system APIs, but treat them as untested until run once.
