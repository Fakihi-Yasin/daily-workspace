# Local work dashboard

A personal, **local-first, offline** dashboard: daily routines (blog articles, Pinterest, Facebook/Instagram, WhatsApp, custom routines), a coding focus timer with an "Off" pause, projects, YouTube, learning, challenges and stats.

- Single user, `localhost` only (listens on 127.0.0.1).
- No npm packages to install: Node.js + built-in SQLite (`node:sqlite`). Preact, htm and the fonts (Bricolage Grotesque, Inter — SIL Open Font License) are bundled in `public/`.
- The app never publishes anything, sends messages or asks for credentials: it records what **you** check off.

## Two ways to run it

| | Localhost app | Web app (Vercel) |
|---|---|---|
| Start | `npm start` → http://localhost:4321 | deployed from this repo, see **[DEPLOY.md](DEPLOY.md)** |
| Sign-in | none (only you, on 127.0.0.1) | Auth0, invite-only, separate accounts |
| Data | `data/tableau.sqlite` on this computer | per account: synced through Supabase when configured, otherwise this browser's localStorage |

Both run the same dashboard code. Move data between them with **Settings → Backup** (download, then restore with a preview).

## Install (Ubuntu)

You need Node.js **22.13 or newer** (tested with Node 24).

```bash
node -v                      # must print v22.13+ (otherwise: https://nodejs.org or `sudo snap install node --classic`)
cd ~/Desktop/local-work-dashboard
```

The localhost app needs no `npm install`. Building the web version or running the tests does: `npm install` (dev tools: esbuild, sql.js, Auth0 SDK).

## Launch

```bash
cd ~/Desktop/local-work-dashboard
npm start
```

Then open **http://localhost:4321**. Stop with `Ctrl+C`.

Options: `PORT=5000 npm start`; `DATA_DIR=/other/folder npm start` (separate data set).

## Today and focus sessions

- Today puts the routine checklist first. Unfinished routines come first; a routine you complete stays in place for a few seconds (time to undo) and then moves to the collapsible **Completed** section.
- The right column shows the daily score, the next action and **Today's sessions** (every finished focus session with its actual time, "Completed" or "Ended early").
- **Start a session**: pick a project (grouped by category) or type a quick task, then set a duration in minutes, hours or days (presets 25 min → 2 h). Durations are stored in seconds; a session can run up to 30 days and survives closing the app.
- Actual time is counted to the second and excludes paused time; the planned duration is kept separately. Ending a session linked to a project milestone logs the work and asks whether to mark the milestone done — it is never completed automatically.
- Project categories: IPTV sites, Digital products, Blog sites, **Other**, plus any you create (in Settings → Categories or directly from the New project form).

## Data

- Real data: `data/tableau.sqlite` (kept across refreshes and restarts).
- Demo: `data/demo.sqlite`, a **separate** database. Settings → Demo to switch; your real data is never touched.
- Theme: System / Light / Dark, from the buttons at the bottom of the sidebar or Settings → General. "System" follows Ubuntu's light/dark setting; the choice is saved in the browser.
- Default timezone: `Africa/Casablanca` (change it in Settings → General). A day starts at midnight in that timezone.

## Backup and restore

In the app: **Settings → Backup** → "Download a backup". To restore, pick a file: a preview (current vs backup) is shown **before** anything is replaced, and a safety copy is written to `data/backups/` right before.

From the command line:

```bash
npm run backup                                    # → data/backups/backup-<date>.json
npm run backup -- ~/Documents/backups             # any folder
npm run restore -- data/backups/backup-XXXX.json        # preview only
npm run restore -- data/backups/backup-XXXX.json --yes  # replace (stop the app first)
```

Copying the whole `data/` folder (with the app stopped) is also a full backup.

## Tests

```bash
npm test
```

Three suites. `test/cloud-sync.test.js` covers cloud sync: two devices of one account, offline edits kept and sent later, retries that never write twice, conflicts that never overwrite silently, and a backup import with preview, no duplicates and pre-sync browser data left untouched. `test/local-backend.test.js` runs the web version's storage layer: accounts are isolated, data persists, a localhost backup imports with the same ids, and two tabs don't overwrite each other. `test/flows.test.js` starts a real server on a temporary database and checks: no duplicate tasks; focus sessions saved to the second and shared by Today and Stats, 1-day durations, the "Other" category; a 5th Pinterest account (tomorrow 25, today unchanged at 15/20); logging / undoing Pins, articles and a video cross-posted to FB+IG stays in sync across Today, Stats and a challenge; the timer (pause, restart, extend, finish, expiry); a one-week coding Off; an undated project and its milestones; backup then restore into a fresh instance.

## Scoring rules

- Task: `actual/target`, percentage capped at 100% (6 Pins on a target of 5 = 6 published, 100%).
- Category: Σ min(done, target) / Σ targets (e.g. 5+3+5+2 against 4×5 = 15/20 = 75%).
- Daily score: average of the categories scheduled that day (others are excluded). "How?" next to the daily score breaks it down.
- Changes to routines / accounts have an **effective date**; past days keep their targets.
- "Move" only moves what remains to the chosen date; nothing is counted twice.
- Challenges read the same records; their accounts are fixed when the challenge is created.

## Structure

```
server.js            localhost HTTP server (API + static files)
web/                 web (Vercel) version: sign-in gate, in-browser backend (sql.js), per-user storage interface
scripts/build.js     builds the web version into dist/ (requires AUTH0_DOMAIN + AUTH0_CLIENT_ID)
lib/                 db (schema), engine (routines, tasks, scores), timer, stats, challenges, backup, demo
public/              UI (Preact + htm, no build step), styles, fonts
scripts/             command-line backup / restore
test/flows.test.js   automated walkthrough of the 6 required flows
```
