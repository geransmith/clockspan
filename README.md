# Clockspan

*Vibe coded — built almost entirely with AI ([Claude Code](https://claude.com/claude-code)), with light human review.*

[![Release](https://img.shields.io/github/v/release/geransmith/clockspan)](https://github.com/geransmith/clockspan/releases)
[![CI](https://github.com/geransmith/clockspan/actions/workflows/ci.yml/badge.svg)](https://github.com/geransmith/clockspan/actions/workflows/ci.yml)

**Clockspan** is a self-hosted, single-day focus sheet for getting through a workday with ADHD. One page: a punch-style timeclock that works out when lunch is due and when the day ends, a short list of the day's priorities, a focus timer that logs what you did, and a retrospective that puts the plan next to what happened. Every day is saved, alarms fire as deadlines approach, and History rolls the days up into a week, month or quarter review. A board holds the tasks that aren't for today. Runs as one Docker container with a SQLite file; works on phones and installs to the Home Screen.

<p align="center">
  <img src="docs/screenshots/sheet-phone-dark.png" width="300" alt="The sheet on a phone, dark mode: running timer bar, timeclock with the lunch-by, worked, clock-out and focused tiles, and today's priorities">
</p>

## Features

**Timeclock.** Tap *Now* on *Clock in* and the sheet works out when lunch must start (default: within 5 hours) and when your day ends (default: 8 hours worked plus a 30-minute lunch), and re-plans if lunch runs long, or leaves it out once the deadline passes without one. A day with no more work than the lunch window (5 hours by default) needs no lunch, so none is planned or alarmed. The *Now* for the next punch is the highlighted one. Forgot to punch? Type the time. Extra out/in pairs cover appointments before or after lunch. The day ends at the *Clock out* once the clock reaches it, early or not, with a small celebration.

**Priorities.** New days start with three rows (adjustable). You can add more; past three one-off rows (or your Rows per day, if higher), the sheet asks first: the nudge changes once some rows are ticked, and again once they all are. Rows can only be ticked once they have text. A task has one name, one category and a plain-text note that stays hidden until you open it: change any of them on any day, or on the board, and it changes on every day it is on. A new day's empty list offers whatever the last day left unticked and the top of the board's *Next*, in one tap, as the same tasks. With the sheet open on a laptop and a phone at once, the two merge their edits row by row.

**Focus timer.** 15, 25 or 50-minute sessions (or three lengths of your own) you can stretch, shorten or pause (paused time isn't logged). When one runs out it chimes and waits for you to add time or finish. Link a session to one of your open priorities, or type a new task and it goes on today's list as the session starts. **Done** finishes the session and ticks its priority. The running timer stays at the top of every view, and since its start time lives on the server it survives reloads and phone sleep. Between sessions, **Break** counts down a short break (5 minutes by default), says when it's over, and logs it in the day log. A break lives on the server like a timer, so it counts down on every device and survives a reload; starting a session ends it. One ended within its first minute (Break pressed by mistake) isn't logged. Turn on *Suggest a break after each session* and finishing a session offers a break sized to it, Pomodoro style: a fifth of the session (25 minutes earn 5), and after four sessions in a row a long break of a fifth of all four, up to 30 minutes.

**Day log.** Every session with its actual duration, which priority it was for, under that priority's current name (editable after the fact), and the day's total focused time. The breaks you took sit between the sessions, with the day's total time on breaks.

<p align="center">
  <img src="docs/screenshots/retro.png" width="360" alt="The retrospective card: the planned priorities with the time logged against each, a routine among them, a row added mid-day, a session that was not on the plan, and the note">
</p>

**Retrospective.** The plan next to what actually happened: time logged against each priority, the sessions that weren't on the plan, rows that were added mid-day, and a note on why. A reminder fires 30 minutes before clock-out (adjustable) so you write it while you still remember. Until you clock out, today's card is one line of totals.

<p align="center">
  <img src="docs/screenshots/history.png" width="300" alt="History → Days with the sticker chart on: a month calendar with each day's stickers and their counts, and the picked day's worked, focused and priorities under it with Open day and Review this week">
  &nbsp;&nbsp;
  <img src="docs/screenshots/review.png" width="300" alt="History → Review → Month: days and hours worked against the target, focused time with the number of sessions and how much was on plan, rows added mid-day, breaks and a typical day, what went off the plan, each routine with the days it was ticked, what never got done, and the days' notes">
</p>

**History.** A month calendar with each day's hours on it and a thin bar for how much of the work day that was, green once the target was met (or its stickers instead); step back as far as your data goes. Tap a day for its worked, focused and priorities numbers, a tick once reviewed, and its note, then **Open day** or **Review this week**.

**Sticker chart.** Off by default. With it on, every day on the History calendar wears a little creature for each thing it did: clocked out, lunch taken, all priorities done, a focus session logged, retrospective reviewed. A legend counts them for the month.

**Week / month / quarter review.** History → **Review** rolls the days up: hours worked against a target, focused time and how much of it was on plan, breaks, rows added mid-day, where the off-plan time went, which priorities never got done, and every day's note. Repeated rows are merged, so a chore that came back on five days is one row with its total, and long lists fold after eight rows. Tap a row to open that day (the latest one, for a merged row).

<p align="center">
  <img src="docs/screenshots/board-desktop.png" width="720" alt="The Board page on a desktop, dark mode: the running timer's bar across the top, a row of today's clock times, then Later, with two recurring priorities and their days under Repeats at its end, Next with the tasks left open on earlier days, In progress (today's priorities) and Done side by side, a + on each column but Done, cards marked with their category, the one the timer runs on marked running, and a note mark on the two cards that have a note">
</p>

**Board, categories and recurring priorities.** The Board page is for tasks that come up but aren't for today, in four columns: *Later*, *Next*, *In progress* and *Done*. *In progress* is today's priorities list itself, so a row written on the sheet shows up there and a card moved there lands on today's list. A task left open on an earlier day waits in *Next* for two weeks. *Done* holds this week. A card can start the focus timer; one in *Later* or *Next* goes onto today's list first. Categories go on tasks and sessions, and the review adds up the time under each; change a task's category and its past time moves with it. Any card can repeat on the weekdays you pick, which makes it a recurring priority: on those days the sheet offers it for today's list, and the review counts how often it got done.

<p align="center">
  <img src="docs/screenshots/settings-alarms.png" width="300" alt="Settings → Alarms: per-alarm warn-before chips, when reached, repeat while over">
  &nbsp;&nbsp;
  <img src="docs/screenshots/settings-data.png" width="300" alt="Settings → Data: delete old days automatically after N days, or delete everything before a date">
</p>

**Alarms.** Sound, browser notification and in-app banner as lunch, clock-out and (on long days) the second meal period approach, each with its own warn-before, when-reached and repeat rules, and a sound per kind of event. An *Overtime approved* switch silences that day's clock-out alarm only; meal alarms stay on.

**Sign-in and data.** Per-user sheets, history, boards, settings and layout. Sign-in is optional: run it open on your LAN, create local accounts, or sign in through Authentik (OIDC). Old days can be deleted by hand or pruned automatically after a number of days you choose, with an optional server-wide ceiling (`RETENTION_DAYS`).

**Layout.** Each user can reorder or hide the sheet's cards. A window 1100 px wide or more shows them in two columns, and any card can move to the other one.

**Keyboard.** Single keys for a new priority or card, the pages and the timer; `?` lists them, and one switch turns them off.

**Phones.** Mobile layout, 44 px touch targets, installable (Android *Install app*, iOS *Add to Home Screen*), a *keep screen awake* option so the countdown and chime stay live, and a light or dark theme that follows the device unless you pick one in Settings.

---

## Run locally (for testing and development)

Requirements: **Node 24** (`nvm use` picks it up from `.nvmrc`). On an older Node, npm refuses to install or run anything.

```bash
npm install
npm run dev
```

- Web app with hot reload: <http://localhost:5173>
- API: <http://localhost:3000> (Vite proxies `/api` and `/auth` to it)
- Vite answers on this machine only, but the API on :3000 listens on every network interface: under the default `AUTH_MODE=none`, anyone on the same network can read and change the dev database through it. To try the app from a phone on the same network, run `npm run dev:server` and `npm run dev:client -- --host` in two terminals and open the network address Vite prints.
- Database: `./data/focus.db` (gitignored). Delete the file to start fresh.

Other commands:

```bash
npm test               # unit tests (timeclock math, alarms), hook and component tests + API tests against an in-memory DB
npm run test:coverage  # the same, failing unless server/, shared/, the client's API calls, libs and hooks are 100% covered (CI runs this)
npm run typecheck      # client + server type check
npm run lint           # oxlint (correctness, type-aware TypeScript, React hooks and accessibility rules)
npm run format         # Prettier (CI runs format:check)
npm run seed           # fill the local database with sample days (see below)
npm run build          # production build → dist/
npm start              # serve the production build on http://localhost:3000 (PORT to change; Docker sets 8080)
```

### Sample data

A fresh checkout has an empty database, so History, the retrospective and the week / month
/ quarter review have nothing to show. `npm run seed` fills `./data/focus.db` with the last
ten weekdays, each with punches, priorities, focus sessions and a retrospective note (an extra
out / in pair, an overtime day, a day never marked reviewed and a half day among them), and
today, clocked in two hours ago. It also writes four categories, two recurring priorities and
some tasks on the board. [AGENTS.md](AGENTS.md#dev-data-is-disposable) and
[server/dev/seed.ts](server/dev/seed.ts) say what each day holds.

Dates are relative to the day you run it, so the sample always lands in the current week.
Each run first deletes every day, task (recurring priorities included) and category of the user
it seeds, including ones you entered by hand; settings stay unless you pass `--fresh`. It only
writes to the local database (`DATA_DIR`, default `./data`); it never touches a Docker `/data`
volume. Safe to run while `npm run dev` is up; reload the page.

```bash
npm run seed                      # the default set above
npm run seed -- --running         # also leave a 25-minute focus timer running, started ten
                                  # minutes ago
npm run seed -- --quarter         # every weekday since the start of last quarter, for the
                                  # month and quarter reviews
npm run seed -- --days 30         # a specific number of past weekdays
npm run seed -- --fresh           # also reset the seeded users' settings and sign them out
npm run seed -- --today 2026-03-02   # the same sample around another date, at the current
                                     # time of day
npm run seed -- --now 10:30       # pin the time of day: clock-in two hours before it, a
                                  # --running timer ten minutes before it
```

### Trying the auth modes locally

```bash
AUTH_MODE=local npm run dev       # first visit shows the "create account" page; its setup code is in the terminal
AUTH_MODE=local npm run seed      # creates users "admin" (admin) and "sam", password
                                  # clockspan-dev, each with their own sample days
```

For OIDC you need a reachable provider; see [Authentik](#authentik-oidc) below and run with the `OIDC_*` and `APP_URL` variables set (`APP_URL=http://localhost:5173` while developing).

---

## Docker

Images are published to GitHub Container Registry for `linux/amd64` and `linux/arm64` (a Raspberry Pi 4 or 5 on a 64-bit OS, an ARM home server); Docker pulls the one that matches the host. The image holds Node and the app, without npm, npx, corepack or yarn. The tags:

| Tag | What it is |
| --- | --- |
| `ghcr.io/geransmith/clockspan:latest` | the newest release |
| `ghcr.io/geransmith/clockspan:X` | the newest release of one major version, e.g. `:2`: new features and fixes, never a breaking change |
| `ghcr.io/geransmith/clockspan:X.Y.Z`, `:X.Y` | a specific release (`:X.Y` follows its patch releases) |
| `ghcr.io/geransmith/clockspan:edge` | built from `main` after each merge; it has passed CI and nothing else. When two merges land close together their builds race, and `:edge` can stay on the earlier one until the next merge |

Versions follow [Semantic Versioning](https://semver.org) from 1.0.0. A major release (2.0.0) is the only kind that can need something from you, such as a changed variable; its release notes open with a *Breaking changes* section that says what to do. [CONTRIBUTING.md](CONTRIBUTING.md#releases) has the full rule.

```bash
cp .env.example .env   # optional: sign-in mode, public URL, OIDC; without it there is no sign-in
docker compose up -d
```

Then open <http://localhost:8080>. The database is in `./data` next to the compose file (`DATA_PATH` in `.env` moves it). Equivalent `docker run`:

```bash
docker run -d --name clockspan -p 8080:8080 -v /path/on/host:/data \
  -e AUTH_MODE=local ghcr.io/geransmith/clockspan:latest
```

The container drops to an unprivileged user (uid/gid 1000 by default; set `PUID`/`PGID` in `.env` to match the owner of the host directory) after taking ownership of `/data`.

To update:

```bash
docker compose pull && docker compose up -d
```

The database stays in the mounted volume. A new release migrates it forward when it starts, and going back to an older release after that isn't supported, so take a backup first (see [Backups](#backups)). A page left open during the update shows *Clockspan was updated* with a **Reload** button the next time it hears from the server; reload it so your changes keep saving. A page opened before v2.4.0 has no such notice, so reload it by hand. To build from source instead, `docker build -t ghcr.io/geransmith/clockspan:latest .` and then `docker compose up -d`; the local image wins over the registry.

### Unraid

The Unraid template, [`unraid/clockspan.xml`](unraid/clockspan.xml), keeps the database in `/mnt/user/appdata/clockspan`, runs the app as `99:100` (`PUID`/`PGID`) and serves it on port 8080. Every variable below is a field on its form except `PORT` and `DATA_DIR`, which the image sets, and `DATA_PATH`, whose place the *Data* path takes. The sign-in mode (a dropdown) and the App URL are on the form itself; the rest are under *Show more settings*. Fields left blank take the defaults.

Install it from the **Apps** tab (search *Clockspan*). Without the Community Applications plugin, add the template by hand from the Unraid terminal, then pick **clockspan** under *Docker → Add Container → Template*:

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-clockspan.xml https://raw.githubusercontent.com/geransmith/clockspan/main/unraid/clockspan.xml
```

### Environment variables

Set these in `.env` (start from `.env.example`, which documents each one) or in the Unraid template's fields. A variable set to an empty value counts as unset, so its default applies. The server checks each value it reads when it starts, and one it can't read stops it with a message that names the variable. `COOKIE_SECURE` is the exception: a value it can't read is logged and ignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` (Docker) / `3000` (from source) | Listen port. Running from source only: under Docker, change the host side of the port mapping instead |
| `DATA_DIR` | `/data` (Docker) / `./data` (from source) | Where `focus.db` lives. Running from source only: under Docker, `DATA_PATH` (or the Unraid *Data* path) picks the host directory |
| `AUTH_MODE` | `none` | `none`, `local` or `oidc` |
| `APP_URL` | — | Public URL of the app: scheme and host only (a path is ignored with a warning). Required for `oidc`; also turns on Secure cookies and HSTS when `https` |
| `ALLOWED_HOSTS` | — | `AUTH_MODE=none` only: other host names the app answers to, comma-separated; a leading dot (`.lan`) takes a domain and every name under it. Which names always work: see [Auth and users](#auth-and-users) |
| `TRUST_PROXY` | `false` | Number of reverse proxies in front of the app (usually `1`), or the proxies' addresses: `loopback`, `linklocal`, `uniquelocal`, IP addresses and CIDR ranges, comma-separated. Never `true`: the server starts with it and logs a warning, but it trusts any `X-Forwarded-For` a client sends, which defeats the login rate limit |
| `COOKIE_SECURE` | derived from `APP_URL` | Force session cookies to `Secure` and the HSTS header on (`true`) or off (`false`); `1`/`0`, `yes`/`no` and `on`/`off` work too |
| `SESSION_TTL_DAYS` | `30` | Sliding session lifetime |
| `RETENTION_DAYS` | unset | Server-wide ceiling on history: every user's days older than this many days (30 to 3650) are deleted every few hours. Unset keeps everything; users can still choose a shorter limit in Settings → Data |
| `OIDC_ISSUER` | — | Provider issuer URL, `https://` only (discovery is done from it) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Confidential client credentials |
| `OIDC_SCOPES` | `openid profile email` | Scopes to request |
| `PUID` / `PGID` | `1000` / `1000` | Docker only: own `/data` and run as this user and group; `PUID=0` keeps root |
| `DATA_PATH` | `./data` | Docker only: the host directory mounted at `/data`. Read by `docker-compose.yml`, not by the app |

---

## Auth and users

| Mode | Who can use it | Sign-in | Users |
| --- | --- | --- | --- |
| `none` | Anyone who can reach the port | none | one implicit user |
| `local` | Accounts you create | username + password | first account is admin; admin adds/removes users in **Settings → Account** |
| `oidc` | Whoever your provider admits | redirect to the provider | created automatically on first sign-in |

Each user has their own sheet, history, board, settings and layout.

**No sign-in (`none`).** Meant for a network you trust: anyone who can reach the port can read and change the data. A web page from another site, open in a browser on that network, can't: the browser won't let it read the API, and the app refuses its writes. That site could still point one of its own names at the server's address (DNS rebinding) and pass as the app, so the app answers only names no outside site can use, plus the ones you list. IP addresses (`http://192.168.1.10:8080`), `localhost`, one-word names (`http://tower:8080`), `.local`, `.home.arpa` and `.internal` names and `APP_URL`'s name always work. Reach the app by another name, such as a domain on your reverse proxy or a `.lan` name? Set `APP_URL` to it, or list it in `ALLOWED_HOSTS`; until then the page says *Can't reach the server* and names the host to add.

**Local mode.** The first visit shows a *create account* page; that account is the admin. The page asks for a setup code, which the server prints in its log when it starts with no account yet (`docker logs clockspan`, or the container's log in Unraid): someone who finds a fresh install before you can't claim it. A restart prints a new code. The admin adds users in **Settings → Account** with a temporary password; a new user has to choose their own the first time they sign in, before the sheet opens. Passwords are hashed with scrypt. Change your password in **Settings → Account**. Forgot it?

```bash
docker exec clockspan node dist/server/cli.js reset-password <username>
# or locally: npm run reset-password -- <username>
```

Without a password after the username, the command prints a temporary one, and the user chooses their own at the next sign-in. Prefer that form: a password typed after the username stays in your shell history. Either way, every session of that user is signed out.

Login is rate-limited to 5 failed attempts per 15 minutes per IP, counting an IPv6 client by its /64 (set `TRUST_PROXY` behind a proxy so that's the real client IP; the server logs a warning when a proxy's `X-Forwarded-For` arrives without it), and to 50 failed attempts per 15 minutes per username from all addresses together. A locked account can't sign in on a new device until the 15 minutes pass; devices already signed in keep working. Changing your password signs out every other session.

### Authentik (OIDC)

1. **Applications → Providers → Create → OAuth2/OpenID Provider.**
   - Client type: **Confidential**
   - Redirect URIs: `https://focus.example.com/auth/callback` (exactly `${APP_URL}/auth/callback`, with only `APP_URL`'s scheme and host, in lowercase, which is how the app uses it)
   - Scopes: `openid`, `profile`, `email`
   - Note the *Client ID* and *Client Secret*.
2. **Applications → Applications → Create.** Name it, pick the provider you just made, and set the slug (e.g. `clockspan`). Use *Policy / Group / User Bindings* on this application to control who may sign in.
3. Open the provider and copy its **OpenID Configuration Issuer** URL, e.g. `https://auth.example.com/application/o/clockspan/`.
4. In `.env`:

   ```
   AUTH_MODE=oidc
   APP_URL=https://focus.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/clockspan/
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...
   TRUST_PROXY=1
   ```

The app refuses to start if `APP_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` or `OIDC_CLIENT_SECRET` is missing, or if `OIDC_ISSUER` isn't an `https://` URL (the sign-in library never contacts a provider over plain http). If Authentik is briefly unreachable at startup the app still boots and retries discovery in the background. Sign out also ends the Authentik session when the provider advertises an end-session endpoint.

**Switching modes later.** Data is keyed by user. A sign-in belongs to the mode it was made in, so after a switch everyone signs in again (under `local` with no account yet, the first visit shows the create-account page). Going from `none` to `local` creates a fresh admin; the old implicit user's data stays in the database. To hand it to the new account, stop the container and run the script below before the new account records a day of its own (a user has one row per date, so a date both accounts used stops the script and nothing moves). Days move together with their sessions and breaks, which belong to a user as well as a day. Tasks (each priority, board card and recurring priority) and categories move too; their ids are random, so the two accounts never clash on them. The last two statements bring the old settings along, replacing any the admin saved; leave them out to keep the admin's.

```bash
sqlite3 /path/on/host/focus.db <<'SQL'
.bail on
BEGIN;
CREATE TEMP TABLE handover AS SELECT
  (SELECT id FROM users WHERE kind = 'default') AS from_id,
  (SELECT id FROM users WHERE kind = 'local' ORDER BY id LIMIT 1) AS to_id;
UPDATE days        SET user_id = (SELECT to_id FROM handover) WHERE user_id = (SELECT from_id FROM handover);
UPDATE sessions    SET user_id = (SELECT to_id FROM handover) WHERE user_id = (SELECT from_id FROM handover);
UPDATE breaks      SET user_id = (SELECT to_id FROM handover) WHERE user_id = (SELECT from_id FROM handover);
UPDATE items       SET user_id = (SELECT to_id FROM handover) WHERE user_id = (SELECT from_id FROM handover);
UPDATE categories  SET user_id = (SELECT to_id FROM handover) WHERE user_id = (SELECT from_id FROM handover);
DELETE FROM settings WHERE user_id = (SELECT to_id FROM handover)
                AND EXISTS (SELECT 1 FROM settings WHERE user_id = (SELECT from_id FROM handover));
UPDATE settings SET user_id = (SELECT to_id FROM handover) WHERE user_id = (SELECT from_id FROM handover);
COMMIT;
SQL
```

Going from `none` to `oidc` works the same way. Sign in through your provider once first, since that creates your account, then run the script with `kind = 'oidc'` in place of `kind = 'local'`.

---

## Using it

- **Timeclock.** Tap **Now** on *Clock in* when you start. The *Lunch by* tile counts down, and *Focused* adds up the day's focus sessions; punch *Lunch out* / *Lunch in* around your break, and *Clock out* when you leave. Clocking out ends the day, even if you left early. A *Clock out* typed ahead of time counts once the clock reaches it, and an extra pair's *Out* never ends the day.
  - **Work-day length.** A half day, or a longer one? **Work day → Change** on the card sets this day's length (*Half day*, back to *Usual*, or any length), and the clock-out time, the alarms, the lunch rule and History go by it.
  - **The week.** Under the tiles, *This week* adds up Monday to the day on screen against *Settings → Timeclock → Work week* (40 hours by default; 0 hides the line). A day whose punches are out of order counts in no hours total until you fix them; the card names the punch that is out of place.
  - **Typing a time.** To enter a time by hand, click the hour and type: `0730` moves through hour and minute on its own, fills in AM or PM (morning for 5–11, afternoon for 12 and 1–4; on a later row, a morning hour that falls wholly before your clock-in becomes PM, so the clock-in's own hour stays AM: 8:10 after an 8:30 clock-in saves as 8:10 AM) and saves as soon as the last part is in; press `a` or `p`, or ↑/↓ on any part, to change it. A half-typed time is dropped when you click away, so what the row shows is what is stored. Times follow your browser's clock; *Settings → Timeclock → Time format* forces 12-hour or 24-hour.
  - **Extra out / in.** Need to step out for an appointment? **Add extra out / in** for as many pairs as you need. A pair sits above lunch until *Lunch out* is punched; after that only a pair punched out before lunch stays above. Your projected *Clock out at* accounts for everything. Came back after clocking out? Tap **Add extra out / in**: your clock-out time becomes that pair's *Out*, tap **Now** on its *In*, and you get a fresh *Clock out* row.
  - **Past midnight.** A day's punches fall on its own date, and at midnight the sheet moves to the new day, whose alarms start over. A shift that runs past midnight is two days here. Go back (◀) and clock out at 11:59 PM, then clock in at 12:00 AM on the new day (type `1200`, then `a`; `0000` with 24-hour time). The new day counts its lunch deadline and clock-out from midnight, so under **Work day → Change** set its length to the hours left.
  - **Celebrations.** The day-complete line comes with a burst of emoji and a sound; reaching the work week on today's sheet gets a smaller burst and its own sound, and so does ticking a priority (its sound is off until you pick one): *Settings → Sheet → Celebrations* turns the bursts off (so does the system's reduce-motion setting), and *Settings → Alarms → Sounds* picks the sounds.
- **Top priorities.** **Add priority** goes to the first row nothing was written in, or adds a row at the end; past three one-off rows with text (routines aside), or past your configured count when that is higher, it asks first. With some rows ticked, the notice lists what's done and the buttons read *Add anyway / Finish what's open*; with everything ticked, *Add a bonus / Stop here*. *Settings → Sheet → Priorities → Rows per day* sets how many rows a new day starts with, and how many of *Next*'s cards the morning notice lists under *Up next*.
  - **Renaming.** A task has one name. Type over a row's name and the task is renamed on every day it is on, past days included; when earlier days hold it, a line under the box says how many (*Also renames it on 3 earlier days.*). Emptying the box doesn't remove the task: leave the box and its name comes back.
  - **Notes.** The note button on a row with text (before its category chip) opens a box under the row for the details, like a ticket number or the steps. The button is drawn filled when the task has a note; with a mouse, an empty one shows when you point at the row. The note saves as you type, up to 1000 characters of plain text, and Escape closes the box. A task has one note on every day it is on, a recurring priority's included. Nothing but the sheet and the board shows notes: not the retrospective, Review or the timer.
  - **Taking a task off.** × sits on every row with text, and on empty rows past your Rows per day. Within your Rows per day it leaves an empty row; past them the row goes. When the task is on other days, has time logged on it (a timer running on it counts) or has a note, × asks first: **Off this day** takes it off this day's list only, and **Delete everywhere** takes it off every day and deletes it. When a note is the only reason it asks, Off this day deletes the task and its note too, unless the board keeps it in Later or Next. The time logged on it stays in the day log as unplanned time, under its name. A recurring priority's row comes off that day without asking.
  - **Left open and Up next.** While today's list has nothing written on it (recurring rows aside), the card offers what the last day with a plan in the past two weeks left unticked, and under *Up next* the top cards of the board's *Next*. Each has a box: the left-open rows start ticked, and *Up next*'s cards are ticked from the top until the ticked rows reach your Rows per day. **Add to today** puts the ticked ones on today's list as the same tasks, and **Start fresh** hides the offer for the rest of the day on that device.
- **Timer.** Type what you're about to do, tap 15/25/50 (*Settings → Sheet → Focus timer* sets these and the break). Click or type in the box and it lists today's open priorities: pick one, or type its name, and the session is linked to that row. New task from your manager? Type it and start: it goes on today's list (the first row nothing was written in, or a new row at the end) with any category you picked beside the box, and the session is linked to it. Starting a timer never asks the past-three question; on a full list (20 rows, all written) the session starts on no priority. The bar at the top follows you around; **−5m / +5m** adjust the current session (on a phone the bar leaves −5m and Cancel to the timer card), **Pause** stops the clock for an interruption (the time away isn't logged, and a pause left for an hour closes the session where it began), **Finish** ends it early and logs the real duration, and **Done**, shown while the session's priority is still open, does the same and ticks it. Reaching zero chimes and the countdown goes negative while it waits: **+5m** keeps going, and **Finish** or **Done** logs the planned length, or, once you are a minute or more over, asks whether to log the planned length or the time you actually worked; left unanswered for ten minutes it logs the planned length on its own.
- **Day log.** Rows show a small number when the session was for a priority, and its current name, so a rename reaches the day log, the timer and its alerts. Tap the name to change which priority it was for; it can't be retyped while the session is linked to one. *Unplanned* unlinks it and keeps the name as its own label, which you can then edit like any session's. A break row shows how long you rested (**End break** on the timer card logs a short one as it was), and the trash button removes one you didn't mean to take.
- **Retrospective.** The last card on the sheet, unless you move it. Until you clock out, today's card is one line (planned, done, focused) with **Open** to show the rest. *Planned* is each priority with the focused time logged against it (rows put on the list after your first session are marked *added HH:MM*), and its heading counts the rows ticked, then the recurring ones again on their own (*4 of 5 done · routines 1 of 1*); *Not on the plan* is every session without a priority, or whose priority was taken off that day. Write why the day went the way it did and tap **Mark reviewed**. *Settings → Alarms → Retrospective* controls the reminder (default: 30 minutes before clock-out; it isn't silenced by overtime approval, marking the day reviewed clears it, and hiding the card under *Customize* turns it off). The banner's **Open retrospective** button takes you to the card and opens it.
- **Alarms.** Settings → Alarms. Per alarm: warn-before chips (30/15/10/5/1 min), *when reached*, and *repeat while over*. Under *Sounds*, each event (a warning, a deadline reached, a repeat, the timer finishing, a break ending, the day completing, the work week reached, a priority ticked) gets one of a few chimes or bundled clips, or none, with a Test button. The tiles turn amber when you're inside the first warning window and red when you're over.
  - **Second meal period.** On a day heading past 10 hours worked (overtime approved, already over your target, or a target longer than 10 hours) the sheet shows when your 10th hour ends and alarms before it. A day of exactly 10 hours, like a 4×10 schedule, owes no second meal and gets no alarm. An extra out / in punched after lunch out counts as taken; a break on the timer card doesn't. Adjust the threshold under *Settings → Timeclock*, or turn the alarm off if you've waived it.
  - **Overtime approved.** A switch on the timeclock card, and a button on the clock-out alarm banner, that silences that day's clock-out alarm. Meal alarms stay on. If overtime doesn't apply to you, turn off *Settings → Timeclock → Overtime*: both disappear, and time past your day reads as *past your day* instead of a red *Over by*.
  - **About the defaults.** Lunch within 5 hours, a second meal period after 10 hours worked, and keeping meal alarms on during approved overtime all follow California labor rules, because that's where the author works. Other states and countries differ. Everything is adjustable in Settings, and pull requests that add presets or rules for other places are welcome.
  - **Salaried or exempt.** *Settings → Timeclock* has a switch for each part that may not apply. *Meal periods* off: no lunch deadline or second meal period, no alarms for them and no *Lunch by* tile (a lunch you punch still counts); *Lunch punches* off as well hides the *Lunch out* / *Lunch in* rows, except on a day that already has a lunch punched, and drops the *Lunch taken* sticker. *Overtime* off: see above. *Show hours* off: no week line, no hours on the History calendar or in the review, and no *Clocked out* sticker. Don't want to punch at all? Hide the timeclock card under *Customize*; priorities, the timer, breaks and the retrospective work without it.
- **History.** **History** → **Days** is a month calendar with each day's hours and a bar for how much of its work day that was; ◀ steps back as far as your data goes. Tap a day for its worked, focused and priorities numbers, a tick if it was reviewed, and its note, then **Open day** or **Review this week**; Back from the day returns to the calendar with it picked. The sheet's ◀ ▶ and date picker reach past days too. Past days are editable; timers only start on today. Work weekdays only? *Settings → Sheet → History → Show weekends* off drops Saturday and Sunday from the calendar and its sticker counts; a weekend day is still reachable from the sheet's date picker.
  - **Sticker chart.** Off by default: turn it on under *Settings → Sheet → History*. Every day on the History calendar then wears a sticker for each thing it did instead of its hours, with the month's count on top and a day that earned every one picked out. The legend chips count each kind; tap one to show only that sticker, tap again for all of them. Today updates as you go. Hover a sticker for what it was for.
- **Review.** History → **Review**. Pick *Week* (Monday to Sunday), *Month* or *Quarter* and step back with ◀. The tiles show days and hours worked against a target, focused time with the number of sessions and how much of it was on plan, and priorities done with the days reviewed. A week's target is *Work week* under *Settings → Timeclock*; a month's or a quarter's adds up the length of each work day you clocked in on, a half day at its own length. Under the tiles: the rows added mid-day and how many got ticked, the timer breaks and their total, and for a week or a month a typical day (the middle count of rows written and ticked over the days before today). Recurring priorities count like any other priority in the *Priorities* tile, *Added mid-day* and *Typical day*, and time on one counts as on plan. Then the lists, where a row opens its day (the latest, for a merged row) and Back returns to the review:
  - *By category*, with a category on anything in the period: each category's focused time as a bar, solid for time on a priority and striped for time off the plan, with how many priorities were ticked under it. A task counts under its current category, so changing it moves the task's past time too. Its rows open no day. *Added mid-day* above it then names a category when more than half of those rows had it (*mostly Tickets*).
  - *Off the plan*: sessions without a priority, or whose priority was taken off that day, merged by task (else by label), longest first.
  - *Routines*, when the period had recurring priorities: each one's days ticked out of the days it was on the list (*4 of 5 days*) and its focused time, under its current title.
  - *Not done*: one-off priorities not ticked by the end of the period. A task carried from day to day is one row; a routine's missed days stay under *Routines*.
  - *Why*: each day's note.
- **The board.** The **Board** button in the header opens it.
  - **Board page.** A row above the columns shows today's clock in, lunch deadline (with meal periods on) and clock out time with the time left, worked out as the timeclock card does; *Settings → Timeclock → Times on the board* turns it off. Press **+** in the head of *Later*, *Next* or *In progress* (or press `N` for *Later*) and type a task: Enter adds it and leaves the box open for the next one, and Enter on an empty box or Escape closes it. *Later*'s go at the top, *Next*'s at the end. *In progress* is today's priorities: every row you write on the sheet shows there, a task typed into its box becomes a row of today's list, and so does a card moved to *In progress* (past three one-off rows either one asks first, as **Add priority** does). Tick it on either page and it goes to *Done*, which shows today's in full and the rest of the week folded, and starts over on Monday; History keeps everything. Drag a card to another column, or to a new place in *Later* or *Next* (on a touch screen, hold it first); from the keyboard, Tab to the card, press Space, move it with the arrow keys and press Space again (Escape puts it back). Click a card, or press Enter on it, to open its details: rename it, give it a category, write its note, pick the days it repeats on, start the focus timer on it, send it to another column with *Move to*, or delete it. **Start timer** offers the timer's lengths on today's open rows and on the cards in *Later* and *Next*: a card goes onto today's list first, without the question *Move to* asks past three rows, and the session is for that task. While a timer runs, no card offers it, and the card the timer is on shows *running* or *paused*. A card with a note shows a note mark. A card and its rows on the sheet are one task, so a rename, a category or a note on the board shows on every day's sheet, and one on a sheet shows on the board. **Delete** takes the task off every day's list, past and later days included, and deletes it; the confirm says how many days it is on and how much time is logged on it, and that time stays in the day log as unplanned time. A task typed on the sheet gets no place in *Later* or *Next* by itself: it shows in *In progress* on its day. Left open, it shows in *Next* as *Left open from …* for two weeks, below *Next*'s own cards. After that it leaves the board, and History and Review still show it. Moving or dragging it to *Later* or *Next* gives it a place of its own. The next morning's offer brings a left-open task back too, unless you moved it to *Later*, finished it or deleted it on the board. Under *Up next* it lists the top of *Next*'s own cards. A task ticked on an earlier day this week shows in *Done* with no checkbox: untick it on that day's sheet, or move it to *In progress* to work on it again. You can still rename it, change its category or delete it there. A done task stays done: moved to *Later* or *Next*, the board offers a new card with its title instead; if it keeps coming back, open it and pick its days under *Repeat*. *Later* and *Next* hold 300 open cards between them. In a window narrower than 900 px, a phone included, the board shows one column at a time, picked with the switch above them.
  - **Categories.** A *Category* chip sits in each card's details, on the sheet's rows with text (beside the row, under it on a phone; with a mouse, an empty chip shows when you point at the row), beside the timer's box while it holds a new task's name, and in the day log's edit of a session that wasn't for a priority. Pick one from its list, or type a name into *New category* and press Enter to make it and pick it; a pick saves at once. The chip in a board column's box sets the category for new cards and rows, the same in every column, and stays picked on that device. A task has one category on every day it is on, and Review counts its past time under the current one. A session counts under its priority's category. One that wasn't for a priority can have its own, shown as a dot before its label in the day log (point at the dot, or open the edit, for its name). So can one whose priority was taken off that day: picking a category for it unlinks it from the task. Linking a session to a priority drops a category of its own. *Settings → Board → Categories* adds, renames, recolours or removes them. A removed category stays on past days, and typing its name again brings it back. Up to 100 can be in use; the eight colours repeat.
  - **Recurring priorities.** Open a card and press days under *Repeat*, and the task comes back on those weekdays. The first day you press asks first, since a recurring priority can't go back to a one-off. Off today's list it shows under *Repeats* at the end of *Later*, with its days, and from there *Move to* or a drag puts it on today's list. On its days, today's *Top priorities* offers it under *Repeats today* until you answer, in the same notice as the left-open rows and *Up next*. The first recurring ones start ticked, up to *Settings → Board → Recurring priorities → Recurring rows per day* (3 by default; tick more and it says so, then adds them anyway). **Add to today** adds what's ticked, the recurring ones after the empty rows with a repeat mark; **Not today** adds nothing. Either way the notice doesn't come back that day on that device. A recurring row counts like any priority (done, Review, stickers) but not toward the past-three question, and the left-open offer doesn't carry it over: it comes back on its own days. × on its row takes it off that day without asking. On the board, today's row shows in *In progress* with a repeat mark and doesn't drag: tick it there, or take it off today's list with *Remove from today*. Rename it or change its category on its card or on the sheet, and every day it was on shows the change. Its days can change at any time, but the last day left on can't be turned off. **Stop repeating**, in its details, asks first, then takes it off *Repeats* and the morning notice; the days it was on keep it under its name.
- **Two devices.** A laptop and a phone can have the app open at once. While it is on screen, a change saved on one shows on the other within a second: today's sheet, the timer, the settings and the board. Each also reads them every minute, when you come back to it and at once when the server refuses a save because of a change made on the other, and reads a past day, History and Review again when you open them. Priority edits merge row by row: a row or tick saved on one stays when the other saves, a row removed on one stays gone unless the other changed it, and the same task added on both (by the morning offer or the board) is kept once. The same text typed as a new row on each makes two tasks; delete the extra one. When both rename a task, change its category or edit its note, the later change wins. A settings change saves only that setting, so it doesn't undo one made on the other device. There is one timer: starting one while the other device runs one shows that one instead, with a banner. Each device raises its own alarms, and *Start fresh*, *Not today* and the category in the board's boxes hold only on the device where you chose them.
- **Layout.** In a window 1100 px wide or more, the sheet has two columns: by default the timeclock and priorities on the left, the timer, day log and retrospective on the right. Narrower windows and phones show one column. Tap **Customize** to drag a card by its grip, use ↑/↓, or hide a card; with two columns, dragging and ↑/↓ stay within a column, and ← or → moves a card to the other one (on a phone or a narrow window its place doesn't change). Hidden cards appear in a strip at the bottom while customizing. A window resized across 1100 px keeps its layout until you reload or come back to the sheet from History or the board. *Settings → Sheet → Layout → Reset to default* restores everything, columns included.
- **Keyboard.** With no dialog open and the focus outside a text box: `N` adds a priority on the sheet as **Add priority** does, or opens *Later*'s box on the board; `S` goes to today's sheet, `B` to the board and back and `H` to History and back; `?` lists the keys. While a timer runs, `P` pauses or resumes it, `+` adds the adjust step, and `F` finishes it once time's up (it may ask how much to log). On today's sheet with no timer running, `R` starts the break the timer card's **Break** offers. A key does nothing where its button isn't shown or can't be pressed; letters work in either case, and Ctrl, Cmd and Alt combinations are left to the browser. *Settings → Sheet → Keyboard → Keyboard shortcuts* turns them all off.
- **Settings.** Six tabs; *Account* shows only when it applies:
  - *Timeclock*: the work day, *Meal periods* (and *Lunch punches* when they're off), the lunch deadline and length, the second meal threshold, *Overtime*, *Times on the board*, *Show hours* with the work week, and the time format.
  - *Alarms*: each alarm's warnings, the *Sound* and *Browser notifications* switches, and a sound for each event.
  - *Sheet*: the theme, *Keyboard shortcuts*, rows per day, the timer's start buttons, adjust step and break length, *Suggest a break after each session*, *Keep screen awake*, emoji bursts, the History switches (sticker chart, weekends) and the layout's *Reset to default*.
  - *Board*: categories, then *Recurring rows per day*.
  - *Data*: deleting old days, and **Reset all settings**, which puts every setting back to its default; days, punches, sessions and the board are untouched.
  - *Account*, with local accounts: your password, and for the admin, the users.
- **Data.** Settings → Data. *Delete old days automatically* keeps the last N days (30 to 3650) and drops the rest, with their punches, priorities, sessions, breaks and notes, and the tasks finished or deleted before then; the server checks every few hours. *Delete days before* a date does the same once, after showing how many days it will remove. Today and a day with a running timer are never deleted; settings are kept. If the admin set `RETENTION_DAYS`, the tab says so and that ceiling applies whatever you choose.
- **Phone.** Add to Home Screen (Android: *Install app*; iOS: Share → *Add to Home Screen*). Browser notifications on iOS only work from the installed app. *Settings → Sheet → Focus timer → Keep screen awake* keeps the screen on while a focus timer counts down (not while it is paused or has run out); if the phone sleeps anyway, the alert fires when you come back.

## Exposing it to the internet

The app is built to sit behind a reverse proxy on a host name of its own (`focus.example.com`); serving it under a path (`example.com/clockspan`) isn't supported. Before opening the port:

- **Use `AUTH_MODE=local` or `oidc`.** `none` means anyone who reaches the port owns the data; the server logs a warning at startup when it's running that way. The exception is a proxy that signs people in itself (forward auth from Authelia or Authentik, for example), and only if the container's port can't be reached from the internet except through that proxy. Docker's `-p 8080:8080` listens on every interface and gets past ufw, so on a public server publish `127.0.0.1:8080:8080` or put the proxy on the container's Docker network and drop the port.
- **Terminate HTTPS at the proxy** and set `APP_URL=https://your.domain`. That marks the session cookie `Secure` and turns on HSTS.
- **Set `TRUST_PROXY` to the number of proxies** between the internet and the container, usually `1`. With `true`, Express believes whatever `X-Forwarded-For` a client sends, which lets an attacker dodge the login rate limit.
- **Finish setup first.** In `local` mode the admin account is created on the first visit, with the setup code from the server log; do that before the proxy is open to the internet anyway. Once `APP_URL` is https the session cookie is Secure and only an https page can keep it, so sign in through the proxy's https address (the sign-in page says so when it is opened over plain http); for a one-off LAN setup, start with `COOKIE_SECURE=false` (which also turns HSTS off) and remove it afterwards.
- Keep `/data` backed up (below).
- **Live updates** come over `/api/changes`, a server-sent event stream: one long answer with a comment every 25 s and `X-Accel-Buffering: no`. nginx, Caddy, Traefik and Cloudflare Tunnel pass it as it is. A proxy that buffers or compresses it leaves each device picking up the other's changes every minute instead. Over plain HTTP/1.1 a browser opens at most six connections to a host and each tab on screen keeps one, so with several tabs open serve the app over HTTPS, which proxies usually give HTTP/2.

What the app does on its own: a strict same-origin Content-Security-Policy plus `nosniff`, `frame-ancestors 'none'` and `Referrer-Policy` on every response, and `Cache-Control: no-store` on every API answer; API writes that the browser marks as sent from another site are refused (this also covers `AUTH_MODE=none`, where there is no cookie); under `AUTH_MODE=none` the API also refuses host names it doesn't know, which stops DNS rebinding (see [Auth and users](#auth-and-users)); HttpOnly, SameSite=Lax session cookies with the token stored hashed; scrypt password hashes; a per-IP login limit (per /64 for IPv6); a non-root container user. It is still a small self-hosted app: keep it updated and behind the protections your proxy already gives you. Found a hole? [SECURITY.md](SECURITY.md) says how to report it privately.

## Backups

The whole state is one file: `focus.db` (plus `-wal`/`-shm` while running). Either stop the container and copy the directory, or take a consistent snapshot live:

```bash
sqlite3 /path/on/host/focus.db ".backup /path/to/backups/focus-$(date +%F).db"
```

A page left open while you restore a backup shows *Restored from a backup* with a **Reload** button the next time it hears from the server; reload it to see the restored data.

Deleting old days (Settings → Data, or `RETENTION_DAYS`) or a user (Settings → Account) is permanent and compacts the file afterwards, so take a backup first if you might want them back.

## Development notes

See [AGENTS.md](AGENTS.md) for the repo map, architecture rules and checklists for adding cards, settings, alarms and routes.

Every change is a squash-merged pull request with CI green; a release is a version-bump PR, and merging it builds the image, tags it and writes the release notes. The rules and the checklist are in [CONTRIBUTING.md](CONTRIBUTING.md).

The bundled sounds are CC0 clips from Freesound; [client/src/sounds/README.md](client/src/sounds/README.md) lists each one's author and source.

The screenshots above come from `npm run screenshots`. It starts the dev server if one isn't running, seeds sample data with the clock pinned to 10:30 (replacing the dev database's days and board and resetting the default user's settings, as `npm run seed -- --fresh` does), turns on the sticker chart (it stays on afterwards), drives a local Chromium headless and writes `docs/screenshots/*.png`. It looks for Chrome, Chromium, Edge or Brave and otherwise fetches a Chrome for Testing build into `node_modules/.cache` the first time; set `CHROME_BIN` to force a particular browser.
