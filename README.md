# Focus Sheet

A self-hosted, single-day focus sheet for getting through a workday with ADHD. One page, four cards:

- **Timeclock** — punch in, punch out for lunch, punch back in (plus any extra out/in pairs). The sheet tells you **when lunch must start by** (default: within 5 hours) and **when your day ends** (default: 8 hours worked + 30-minute lunch), live, and re-plans if lunch runs long.
- **Top 3 priorities** — the three things that would make today a win.
- **Focus timer** — 15 / 25 / 50-minute sessions with a label. Extend or shorten with ± while running, finish early, and it logs what you did and for how long. The running timer floats at the top of the page on every view.
- **Day log** — every session with its actual duration and the day's total focused time.

Every day is saved. Step back through previous days from the date picker or the History view. **Alarms** warn you as lunch and clock-out approach (chime, browser notification, in-app banner). Cards can be reordered or hidden per user. Works on phones and can be added to the Home Screen.

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
docker build -t focus-sheet .
docker run -d --name focus-sheet -p 8080:8080 -v /path/on/host:/data \
  -e PUID=1000 -e PGID=1000 -e AUTH_MODE=local focus-sheet
```

### Unraid

There is no Community Applications template yet, so use one of these:

**Option A — Compose Manager plugin.** Install *Compose Manager* from Community Applications, create a new stack, paste `docker-compose.yml`, put the repository next to it (or point `build:` at wherever you cloned it), and start the stack. The compose file already maps `/mnt/user/appdata/focus-sheet:/data` and sets `PUID=99` / `PGID=100`.

**Option B — build over SSH, add the container in the Docker tab.**

```bash
ssh root@tower
cd /mnt/user/appdata && git clone <this repo> focus-sheet-src && cd focus-sheet-src
docker build -t focus-sheet .
```

Then Docker tab → *Add Container* → toggle *Advanced view*:

| Field | Value |
| --- | --- |
| Repository | `focus-sheet` |
| Port | `8080` → `8080` |
| Path | container `/data` → host `/mnt/user/appdata/focus-sheet` |
| Variable | `PUID=99`, `PGID=100` |
| Variable | `AUTH_MODE=none` / `local` / `oidc` |
| Variable (oidc) | `APP_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` |
| Variable (behind a proxy) | `TRUST_PROXY=true` |

To update: pull, `docker build -t focus-sheet .` again, and restart the container. Data is untouched.

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
docker exec focus-sheet node dist/server/cli.js reset-password <username>
# or locally: npm run reset-password -- <username>
```

Login is rate-limited to 5 attempts per 15 minutes per IP (set `TRUST_PROXY` behind a proxy so that's the real client IP).

### Authentik (OIDC)

1. **Applications → Providers → Create → OAuth2/OpenID Provider.**
   - Client type: **Confidential**
   - Redirect URIs: `https://focus.example.com/auth/callback` (exactly `${APP_URL}/auth/callback`)
   - Scopes: `openid`, `profile`, `email`
   - Note the *Client ID* and *Client Secret*.
2. **Applications → Applications → Create.** Name it, pick the provider you just made, and set the slug (e.g. `focus-sheet`). Use *Policy / Group / User Bindings* on this application to control who may sign in.
3. Open the provider and copy its **OpenID Configuration Issuer** URL, e.g. `https://auth.example.com/application/o/focus-sheet/`.
4. Configure the container:

   ```
   AUTH_MODE=oidc
   APP_URL=https://focus.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/focus-sheet/
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...
   TRUST_PROXY=true
   ```

The app refuses to start with a clear message if any of these are missing. If Authentik is briefly unreachable at startup the app still boots and retries discovery in the background. Sign out also ends the Authentik session when the provider advertises an end-session endpoint.

**Switching modes later.** Data is keyed by user. Going from `none` to `local` creates a fresh admin; the old implicit user's data stays in the database. To hand it to the new account:

```bash
sqlite3 /mnt/user/appdata/focus-sheet/focus.db \
  "UPDATE days SET user_id = (SELECT id FROM users WHERE kind='local' ORDER BY id LIMIT 1) WHERE user_id = (SELECT id FROM users WHERE kind='default');"
```

(Repeat for `sessions` and `settings` if you want those too.)

---

## Using it

- **Timeclock.** Tap **Now** on *Clock in* when you start. The *Lunch by* tile counts down; punch *Lunch out* / *Lunch in* around your break. Need to step out for an appointment? **Add clock out / in** for as many extra pairs as you need — they can be before or after lunch. Your projected *Clock out at* accounts for everything. A final *Out* with no *In* ends the day.
- **Timer.** Type what you're about to do, tap 15/25/50. The bar at the top follows you around; **−5m / +5m** adjust the current session, **Finish** ends it early and logs the real duration, and reaching zero ends it automatically with a chime. Timers keep correct time across reloads and phone sleep because the start time lives on the server.
- **Alarms.** Settings → Alarms. Per alarm: warn-before chips (30/15/10/5/1 min), *when reached*, and *repeat while over*. The tiles turn amber when you're inside the first warning window and red when you're over.
- **Layout.** Tap **Customize** to drag cards (long-press on phones), use ▲/▼, or hide a card. Hidden cards appear in a strip at the bottom while customizing. *Settings → Layout → Reset to default* restores everything.
- **Past days.** Use ◀ ▶ or the date picker; History shows every recorded day with worked / focused / priorities. Past days are editable; timers can only start on today.
- **Phone.** Add to Home Screen (Android: *Install app*; iOS: Share → *Add to Home Screen*). Browser notifications on iOS only work from the installed app. *Keep screen awake* keeps the countdown and chime live while the app is open; if the phone sleeps anyway, the alert fires when you come back.

## Reverse proxy notes

Set `TRUST_PROXY=true` so the app sees real client IPs (rate limiting) and `APP_URL=https://…` so session cookies are marked Secure. WebSockets are not used.

## Backups

The whole state is one file: `focus.db` (plus `-wal`/`-shm` while running). Either stop the container and copy the directory, or take a consistent snapshot live:

```bash
sqlite3 /mnt/user/appdata/focus-sheet/focus.db ".backup /mnt/user/backups/focus-$(date +%F).db"
```

## Development notes

See [AGENTS.md](AGENTS.md) for the repo map, architecture rules and checklists for adding cards, settings, alarms and routes.
