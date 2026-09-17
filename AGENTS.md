# Clockspan — agent guide

## What this is

A self-hosted, single-day **focus sheet** for working through a workday with ADHD: a punch-style
timeclock that computes when lunch must start and when the day ends (with a small celebration
when it does), the day's top priorities (default three, configurable, with a gentle nudge when
the list grows), a Pomodoro-style focus timer that logs what was done, and alarms as lunch,
clock-out and the second meal period approach. A per-day "Overtime approved" switch silences
the clock-out alarm only. Every day is persisted so past days can be revisited. Data is **per
user**; auth is optional (`AUTH_MODE=none | local | oidc`). Runs as one Docker container with
SQLite on a `/data` volume. Mobile-first and installable (PWA manifest, pass-through service
worker). Meal-period defaults follow California rules; everything is adjustable.

## Stack & versions

- Node **24** (Active LTS). `nvm use 24` locally; `node:24-alpine` in Docker.
- Frontend: React 19 + TypeScript + Vite 7. Drag/drop: `@dnd-kit/sortable`. No router lib — the
  date and view live in the URL query (`hooks/useRoute.ts`). No CSS framework.
- Backend: Express 5 (ESM, `NodeNext`, imports use `.js` extensions), `better-sqlite3` (native),
  `openid-client` v6 for OIDC, `cookie` for cookie parsing. Passwords: `node:crypto` scrypt.
- Tests: Vitest 5, pure-function tests only (`client/src/lib/*.test.ts`).
- One `package.json` for both sides; `tsconfig.json` = client, `tsconfig.server.json` = server.

## Repo map

```
server/                 Express API → dist/server (tsc)
  index.ts              boot: load config, open DB, listen, SIGTERM handling
  app.ts                createApp(): trust proxy, /api/health, resolveUser, auth routers,
                        data routers behind requireAuth, static dist/client + SPA fallback
  config.ts             env parsing; throws with a clear message on bad/missing config
  db.ts                 open + pragmas (WAL, foreign_keys), append-only MIGRATIONS, default user
  cli.ts                `reset-password <username> [password]`
  auth/session.ts       cookie session (token hashed in DB, sliding 30d expiry)
  auth/password.ts      scrypt hash/verify + username/password validation
  auth/middleware.ts    resolveUser / requireAuth / requireAdmin / currentUser(req)
  auth/local.ts         /api/auth: me, setup, login (rate-limited), logout, password, users (admin)
  auth/oidc.ts          /api/auth/{me,logout} + /auth/{login,callback}; lazy discovery w/ retry
  routes/shared.ts      isValidDateKey, findDay/ensureDay, SessionRow → JSON
  routes/days.ts        GET /days (history summaries), GET /days/:date, PUT punches,
                        PUT priorities (full replace, sparse rows), PUT overtime
  routes/sessions.ts    POST /days/:date/sessions (start), GET /sessions/running,
                        PATCH/:id, POST /:id/finish, POST /:id/cancel, DELETE /:id
  routes/settings.ts    DEFAULT_SETTINGS + mergeSettings() validator; GET/PUT /settings
client/                 Vite root → dist/client
  index.html            viewport-fit=cover, theme-color, manifest, apple-mobile-web-app meta
  public/               manifest.webmanifest, icons/, sw.js (pass-through)
  src/App.tsx           provider stack + Shell (route, customize, settings, today's alarms)
  src/api.ts            fetch wrapper; dispatches UNAUTHENTICATED_EVENT on 401
  src/types.ts          shared client types (mirror of server JSON shapes)
  src/styles.css        design tokens (:root, dark via prefers-color-scheme), all component CSS
  src/lib/timeclock.ts  PURE: computeTimeclock(punches, settings, now, {frozen}) → tiles/state,
                        normalizePunches/clockOutPosition/extraPairs (row model), secondMealApplies
  src/lib/alarms.ts     PURE: dueEvents(...) scheduler + describeEvent() copy
  src/lib/alerts.ts     the ONLY place that plays audio / calls Notification / pushes banners
  src/lib/copy.ts       every editable phrase (celebrations, gentle warnings) — no logic
  src/lib/celebrate.ts  PURE: pickCelebration(seed) for the end-of-day notice
  src/lib/priorities.ts PURE: padPriorities(), warnThreshold(), pickWarning(), MAX_PRIORITIES
  src/lib/format.ts     date keys, time/duration formatting, <input type=time> conversions
  src/lib/layout.ts     card registry (CARDS), DEFAULT_LAYOUT, normalizeLayout()
  src/hooks/useSettings.tsx  SettingsProvider: settings + update(patch) (optimistic, PUT)
  src/hooks/useDay.tsx       DayProvider: per-date cache, setPunches/setPriorities/setOvertimeApproved,
                             session upserts
  src/hooks/useTimer.tsx     TimerProvider: running session, remaining/progress, start/adjust/
                             finish/cancel, completion + chime, wake lock, tab title, re-sync
  src/hooks/useAlarms.ts     app-level alarm engine (fired keys in localStorage per day)
  src/hooks/useNow.ts useRoute.ts useSettled.ts useWakeLock.ts useMediaQuery.ts
  src/auth/              AuthGate (mode/user → Setup | Login | OIDC button | app), pages
  src/components/        Header, RunningTimerBar, Banners, Sheet (dnd-kit) + CardShell,
                         Timeclock, Priorities, FocusTimer, SessionLog, History, SettingsDialog, Icons
docker/entrypoint.sh    PUID/PGID → chown /data + su-exec
Dockerfile docker-compose.yml .env.example README.md
```

## Commands

```bash
nvm use 24
npm install
npm run dev            # API on :3000 (tsx watch, PORT pinned) + Vite on :5173 (proxies /api, /auth)
npm test               # vitest
npm run typecheck      # both tsconfigs
npm run build          # dist/client + dist/server
npm start              # node dist/server/index.js (PORT default 3000; Docker sets 8080)
npm run reset-password -- <username>
docker compose up -d --build
```

Dev DB: `./data/focus.db` (gitignored). Delete it to start fresh. `AUTH_MODE=local npm run dev`
to exercise the setup/login pages.

## Architecture rules (do not break)

- **The server stores epoch milliseconds and never decides what "today" is.** The client sends
  the local date key `YYYY-MM-DD` (`lib/format.ts: todayKey`). The container's TZ is irrelevant.
- **Every data query is scoped by `req.user.id`** (`currentUser(req)`). In `AUTH_MODE=none` that
  is the single `kind='default'` user. Never add a data route outside the `requireAuth` router
  in `app.ts`.
- **Settings are stored sparse** and merged with `DEFAULT_SETTINGS` by `mergeSettings()` on every
  read and write (`server/routes/settings.ts`). Unknown keys are dropped, invalid values fall
  back. Add settings by adding a default + validation there, never by migrating rows.
- **Timeclock math lives only in `client/src/lib/timeclock.ts`; alarm scheduling only in
  `client/src/lib/alarms.ts`.** Both are pure functions of `(inputs, settings, now)` with tests.
  Components and hooks never re-derive these. Past days call `computeTimeclock` with
  `now = min(now, endOfDay)` and `{ frozen: true }`.
- **All user-facing alerts go through `client/src/lib/alerts.ts`** (`alert()`, `chime()`,
  banners). Never call `new Notification(...)` or create an `AudioContext` anywhere else.
  `unlockAudio()` must be called from a user gesture (timer start does this) for iOS.
- **Timer remaining time is derived from the server's `startedAt + plannedSeconds`** on every
  tick — never a client-side counter. `useTimer` keeps a `mutationSeq` so a slow `GET
  /sessions/running` can't overwrite an optimistic update; keep that pattern for new mutations.
- **Punch positions are fixed**: 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in
  pairs, and **the last row is always the Clock out** (an odd position ≥ 3; `normalizePunches`
  enforces it and drops an unset trailing `in` from pre-Clock-out data). Kind is parity
  (`kindForPosition`). The math evaluates *set* punches chronologically, so storage order is
  not time order: `extraPairs()` decides where the card *shows* a pair (before lunch until
  lunch is punched, then by its out time). An explicit Clock out that is the latest punch ends
  the day even if the target isn't met. "Add extra out / in" appends two rows, so the old
  Clock out becomes the new pair's Out. Lunch semantics come only from positions 1 and 2.
- **Overtime approval (`days.overtime_approved`) silences only the `clockOut` alarm target.**
  Lunch and the second meal period stay armed: California Labor Code §512 still requires them
  on an overtime day. The setting `overtimeApproval` only shows/hides the switch and banner
  button; a flagged day is silent only while the setting is on (`App.tsx`).
- **Priorities are stored sparse**: the server keeps only the rows that exist (positions
  1..n, contiguous, ≤ 20) and never stores `done` on an empty row; the client pads to
  `settings.priorityCount` with `padPriorities()`. `PUT /days/:date/priorities` is a full
  replace, so removing a row is sending the list without it.
- **Alarm event keys embed the target minute** (`eventKey`), so a moved target re-arms and a
  reload never re-fires. Fired keys live in `localStorage` under `focus:alarms:<date>` and are
  pruned to today. Today's punches are settled for 3 s (`useSettled`) before evaluation.
- Static assets are public; **all data is behind `/api/*`**. The SPA fallback serves
  `index.html` for any non-API path.
- **Migrations are append-only** in `server/db.ts` (`MIGRATIONS[]`, `PRAGMA user_version`).
  Every FK to `users` or `days` is `ON DELETE CASCADE`.

## How to add…

- **A card**: add `{ id, title }` to `CARDS` in `client/src/lib/layout.ts` and the id to
  `CARD_IDS` in `server/routes/settings.ts` (and the `CardId` union in `client/src/types.ts`) →
  write the component → add a `case` in `Sheet.tsx`'s `render()`. Existing users get it
  automatically (visible) because layouts merge with the registry.
- **A per-user setting**: add to `DEFAULT_SETTINGS` + `mergeSettings()` validation (server),
  the `Settings` type (`client/src/types.ts`) and `FALLBACK` (`hooks/useSettings.tsx`) → add the
  control to `SettingsDialog.tsx` (use `DurationField` / `MinutesField` — it takes a `unit`
  suffix, default "min" — / `Toggle`).
- **An alarm target** (existing: `lunchBy`, `clockOut`, `secondMeal`): expose the instant from
  `computeTimeclock` → add a target in `useAlarms.ts` (`targets[]`, with an `armed` rule; put
  a rule the card also needs in a pure helper like `secondMealApplies`) → add its default
  under `alarms` on both sides and the `AlarmId` union → add an `AlarmEditor` in
  `SettingsDialog.tsx` → copy in `describeEvent()`: a `kicker` naming the alarm + rule
  ("X alarm · 15 min warning"), a title, and a body that says where the deadline came from
  (it gets an `EventContext`; extend that if the new target needs more inputs). A banner can
  carry one `action` button (see the clock-out alarm's "Overtime approved").
- **A per-day field** (like `overtimeApproved`): append a migration adding the column to
  `days` → read it in `findDay` (`routes/shared.ts`) and return it from `GET /days/:date` →
  add a `PUT /days/:date/<field>` route → `Day` type + `api.ts` → an optimistic setter in
  `useDay.tsx` (mirror `setOvertimeApproved`) → pass it from `Sheet.tsx` to the card, and from
  `App.tsx` into `useAlarms` if alarms depend on it.
- **An API route**: put it on the `api` router in `app.ts` (behind `requireAuth`), scope by
  `currentUser(req).id`, validate input, return `{ error }` JSON on failure → add the call to
  `client/src/api.ts` and types to `types.ts`.
- **A schema change**: append a migration string to `MIGRATIONS` in `db.ts`. Never edit an
  existing entry.

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. Named exports. Server imports end in `.js`.
- CSS: tokens on `:root` in `client/src/styles.css`, dark mode via `prefers-color-scheme`,
  **mobile-first** (base = phone; `@media (min-width: 640px)` enhances). Tap targets ≥ 44 px
  (`.btn`, `.input` set `min-height: 44px`). Inputs are 16 px so iOS doesn't zoom. No external
  fonts or assets. Safe-area insets via `--safe-top` / `--safe-bottom`.
- Numeric settings inputs commit on blur/Enter (never on every keystroke); priorities debounce
  400 ms; punches and checkboxes save immediately.
- Comments explain *why* (browser quirks, math), not what.
- No new runtime dependency without stating the reason in the commit message.
- **Copy**: phrases the app says (celebrations, gentle warnings) live in
  `client/src/lib/copy.ts`, never inline. Write them plainly and check new ones against
  Wikipedia's "Signs of AI writing" (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing):
  no "not just X, but Y", no rule-of-three flourishes, no em-dash chains, no "Gentle
  reminder:" / "Deep breath." openers, no cheerleading, no puffery words. Short, dry, specific.

## Verification expectations

- `npm test` green and `npm run typecheck` clean.
- Walk the flow you touched at desktop width **and** the 375 px mobile preset.
- Check light and dark if you touched CSS.
- If you touched the timer or alarms: reload mid-timer, background/foreground the tab, and let a
  short timer expire — the log must show the planned duration and one chime.
- If you touched punches: walk a pair added before lunch, an early Clock out (done +
  celebration), "Add extra out / in" after it (old Clock out becomes Out N), and removing that
  pair (time returns to Clock out).
- If you touched alarms: with "Overtime approved" on, the clock-out banner must stop and the
  lunch tile must keep counting down.

## Gotchas

- `better-sqlite3` is native. The Dockerfile installs alpine build deps so it compiles when no
  prebuilt binary matches. Docker is verified only in the deployed environment, not on the dev
  Mac (no Docker here).
- The preview harness exports `PORT=5173`; that's why `dev:server` pins `PORT=3000`.
- `client/public/sw.js` is intentionally a pass-through service worker (installability only).
  Do not add caching without a versioning strategy or users will see stale assets.
- `vite.config.ts` imports `defineConfig` from `vitest/config` so the `test` block type-checks.
- OIDC: `APP_URL` must match the redirect URI registered in Authentik exactly
  (`${APP_URL}/auth/callback`); the callback reconstructs its URL from `APP_URL`, not from
  request headers, so it works behind proxies.
- scrypt needs `maxmem` above Node's 32 MB default at N=2^15 — already set in `password.ts`.
- `window` `focus` events fire on ordinary clicks in some embedded browsers; timer re-sync is
  throttled and seq-guarded for that reason. Don't add unthrottled focus-driven refetches.
