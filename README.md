# Clockspan

*Vibe coded — built almost entirely with AI ([Claude Code](https://claude.com/claude-code)), with light human review.*

**Clockspan** is a self-hosted, single-day focus sheet for getting through a workday with ADHD. One page, four cards:

- **Timeclock** — clock in, punch out for lunch, punch back in, clock out (plus any extra out/in pairs, before or after lunch). The sheet tells you **when lunch must start by** (default: within 5 hours) and **when your day ends** (default: 8 hours worked + 30-minute lunch), live, and re-plans if lunch runs long. Clocking out ends the day with a small celebration.
- **Top priorities** — the few things that would make today a win. Starts at three (adjustable); you can add more, with a gentle nudge when the list gets long.
- **Focus timer** — 15 / 25 / 50-minute sessions with a label. Extend or shorten with ± while running, finish early, and it logs what you did and for how long. The running timer floats at the top of the page on every view.
- **Day log** — every session with its actual duration and the day's total focused time.

Every day is saved. Step back through previous days from the date picker or the History view. **Alarms** warn you as lunch, clock-out and (on long days) the second meal period approach (chime, browser notification, in-app banner). If overtime was approved, one switch silences the clock-out alarm for that day. Cards can be reordered or hidden per user. Works on phones and can be added to the Home Screen.

Data is **per user**. Sign-in is optional: run it open on your LAN, create a local account on first launch, or sign in through Authentik (OIDC).

---

## Run locally (for testing and development)

Requirements: **Node 24** (`nvm use 24` if you use nvm).

```bash
npm install
npm run dev
```

- Web app with hot reload: <http://localhost:5173>
- API: <http://localhost:3000> (Vite proxies `/api` and `/auth` to it)
- Database: `./data/focus.db` (gitignored). Delete the file to start fresh.

Other commands:

```bash
npm test               # unit tests for the timeclock math and alarm scheduling
npm run typecheck      # client + server type check
npm run build          # production build → dist/
npm start              # serve the production build on http://localhost:8080
```

### Trying the auth modes locally

```bash
AUTH_MODE=local npm run dev       # first visit shows the "create account" page
```

For OIDC you need a reachable provider; see [Authentik](#authentik-oidc) below and run with the `OIDC_*` and `APP_URL` variables set (`APP_URL=http://localhost:5173` while developing).

---

## Docker

```bash
docker compose up -d --build
```

Then open <http://localhost:8080>. The database lives in the mounted `/data` volume. Equivalent `docker run`:

```bash
docker build -t clockspan .
docker run -d --name clockspan -p 8080:8080 -v /path/on/host:/data \
  -e PUID=1000 -e PGID=1000 -e AUTH_MODE=local clockspan
```

To update: pull the latest code, rebuild the image, and restart the container — the database in the mounted volume is untouched.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` (Docker) / `3000` (dev) | Listen port |
| `DATA_DIR` | `/data` (Docker) / `./data` | Where `focus.db` lives |
| `AUTH_MODE` | `none` | `none`, `local` or `oidc` |
| `APP_URL` | — | Public URL of the app. Required for `oidc`; also turns on Secure cookies when `https` |
| `TRUST_PROXY` | `false` | `true` or a hop count when behind a reverse proxy |
| `COOKIE_SECURE` | derived from `APP_URL` | Force session cookies to `Secure` on/off |
| `SESSION_TTL_DAYS` | `30` | Sliding session lifetime |
| `OIDC_ISSUER` | — | Provider issuer URL (discovery is done from it) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Confidential client credentials |
| `OIDC_SCOPES` | `openid profile email` | Scopes to request |
| `PUID` / `PGID` | — | Docker only: run as this user and own `/data` |

---

## Auth and users

| Mode | Who can use it | Sign-in | Users |
| --- | --- | --- | --- |
| `none` | Anyone who can reach the port | none | one implicit user |
| `local` | Accounts you create | username + password | first account is admin; admin adds/removes users in **Settings → Users** |
| `oidc` | Whoever your provider admits | redirect to the provider | created automatically on first sign-in |

Each user has their own sheet, history, settings and layout.

**Local mode.** The first visit shows a *create account* page; that account is the admin. Passwords are hashed with scrypt. Change your password in **Settings → Account**. Forgot it?

```bash
docker exec clockspan node dist/server/cli.js reset-password <username>
# or locally: npm run reset-password -- <username>
```

Login is rate-limited to 5 attempts per 15 minutes per IP (set `TRUST_PROXY` behind a proxy so that's the real client IP).

### Authentik (OIDC)

1. **Applications → Providers → Create → OAuth2/OpenID Provider.**
   - Client type: **Confidential**
   - Redirect URIs: `https://focus.example.com/auth/callback` (exactly `${APP_URL}/auth/callback`)
   - Scopes: `openid`, `profile`, `email`
   - Note the *Client ID* and *Client Secret*.
2. **Applications → Applications → Create.** Name it, pick the provider you just made, and set the slug (e.g. `clockspan`). Use *Policy / Group / User Bindings* on this application to control who may sign in.
3. Open the provider and copy its **OpenID Configuration Issuer** URL, e.g. `https://auth.example.com/application/o/clockspan/`.
4. Configure the container:

   ```
   AUTH_MODE=oidc
   APP_URL=https://focus.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/clockspan/
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...
   TRUST_PROXY=true
   ```

The app refuses to start with a clear message if any of these are missing. If Authentik is briefly unreachable at startup the app still boots and retries discovery in the background. Sign out also ends the Authentik session when the provider advertises an end-session endpoint.

**Switching modes later.** Data is keyed by user. Going from `none` to `local` creates a fresh admin; the old implicit user's data stays in the database. To hand it to the new account:

```bash
sqlite3 /path/on/host/focus.db \
  "UPDATE days SET user_id = (SELECT id FROM users WHERE kind='local' ORDER BY id LIMIT 1) WHERE user_id = (SELECT id FROM users WHERE kind='default');"
```

(Repeat for `sessions` and `settings` if you want those too.)

---

## Using it

- **Timeclock.** Tap **Now** on *Clock in* when you start. The *Lunch by* tile counts down; punch *Lunch out* / *Lunch in* around your break, and *Clock out* when you leave. Clocking out ends the day, even if you left early. Need to step out for an appointment? **Add extra out / in** for as many pairs as you need. A pair you add before lunch is punched sits above lunch; otherwise it sits below. Your projected *Clock out at* accounts for everything. Came back after clocking out? Tap **Add extra out / in**: your clock-out time becomes that pair's *Out*, tap **Now** on its *In*, and you get a fresh *Clock out* row.
- **Top priorities.** A row can only be ticked once it has text. **Add priority** adds a row; past three (or your configured count) it asks first, gently. Rows beyond your default can be removed with the ×. *Settings → Priorities → Rows per day* sets how many rows a new day starts with.
- **Timer.** Type what you're about to do, tap 15/25/50. The bar at the top follows you around; **−5m / +5m** adjust the current session, **Finish** ends it early and logs the real duration, and reaching zero ends it automatically with a chime. Timers keep correct time across reloads and phone sleep because the start time lives on the server.
- **Alarms.** Settings → Alarms. Per alarm: warn-before chips (30/15/10/5/1 min), *when reached*, and *repeat while over*. The tiles turn amber when you're inside the first warning window and red when you're over.
  - **Second meal period.** On a day heading past 10 hours worked (overtime approved, already over your target, or a target that long) the sheet shows when your 10th hour ends and alarms before it. Any break after lunch counts as taken. Adjust the threshold under *Settings → Timeclock*, or turn the alarm off if you've waived it.
  - **Overtime approved.** A switch on the timeclock card, and a button on the clock-out alarm banner, that silences that day's clock-out alarm. Meal alarms stay on. If overtime doesn't apply to you, turn off *Settings → Alarms → Overtime approval* and both disappear.
  - **About the defaults.** Lunch within 5 hours, a second meal period after 10 hours worked, and keeping meal alarms on during approved overtime all follow California labor rules, because that's where the author works. Other states and countries differ. Everything is adjustable in Settings, and pull requests that add presets or rules for other places are welcome.
- **Layout.** Tap **Customize** to drag cards (long-press on phones), use ▲/▼, or hide a card. Hidden cards appear in a strip at the bottom while customizing. *Settings → Layout → Reset to default* restores everything.
- **Past days.** Use ◀ ▶ or the date picker; History shows every recorded day with worked / focused / priorities. Past days are editable; timers can only start on today.
- **Phone.** Add to Home Screen (Android: *Install app*; iOS: Share → *Add to Home Screen*). Browser notifications on iOS only work from the installed app. *Keep screen awake* keeps the countdown and chime live while the app is open; if the phone sleeps anyway, the alert fires when you come back.

## Reverse proxy notes

Set `TRUST_PROXY=true` so the app sees real client IPs (rate limiting) and `APP_URL=https://…` so session cookies are marked Secure. WebSockets are not used.

## Backups

The whole state is one file: `focus.db` (plus `-wal`/`-shm` while running). Either stop the container and copy the directory, or take a consistent snapshot live:

```bash
sqlite3 /path/on/host/focus.db ".backup /path/to/backups/focus-$(date +%F).db"
```

## Development notes

See [AGENTS.md](AGENTS.md) for the repo map, architecture rules and checklists for adding cards, settings, alarms and routes.
