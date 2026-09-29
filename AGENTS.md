# Clockspan — agent guide

## What this is

A self-hosted, single-day **focus sheet** for working through a workday with ADHD: a punch-style
timeclock (lunch deadline, end of day, celebration), top priorities (default three, with a
nudge when the list grows), a focus timer that logs what was done and for which priority, a
retrospective card (plan vs. log, a "why" note, a nudge before clock-out), a week / month /
quarter review, and alarms for lunch, clock-out and the second meal period. "Overtime
approved" silences the clock-out alarm only. Every day is persisted; old days can be pruned.
Data is **per user**; auth is optional (`AUTH_MODE=none | local | oidc`). One Docker container,
SQLite on `/data`. Mobile-first PWA. Meal-period defaults follow California rules; three
switches (meal periods, overtime, hours) turn off what doesn't apply to exempt or salaried
work. The README has the user-facing description.

## Stack & versions

- Node **24** (`.nvmrc`, so a bare `nvm use`; `node:24-alpine` in Docker). `devEngines` in
  `package.json` makes npm refuse `install`, `ci` and `run` on an older Node.
- Client: React 19, TypeScript 7 (the native `tsc`), Vite 8. `@dnd-kit/sortable` for drag/drop (loaded on the first Customize);
  `react-aria` + `react-stately` + `@internationalized/date` for the punch time field. No router
  (the date and view live in the URL query, `hooks/useRoute.ts`; today is `date: null`, so a
  sheet left open over midnight moves to the new day) and no CSS framework.
- Server: Express 5 (ESM, `NodeNext`, imports end in `.js`), `better-sqlite3`, `openid-client`
  v6, `cookie`. Passwords: `node:crypto` scrypt (async).
- Tests: Vitest 5; hook tests run under happy-dom with `@testing-library/react`. Lint: oxlint
  (`.oxlintrc.json`) with type-aware rules run by `oxlint-tsgolint`. Formatting: Prettier. What
  CI runs is in CONTRIBUTING.md ("What CI does").
- One `package.json` for both sides; `tsconfig.json` = client + shared, `tsconfig.server.json` =
  server + shared (`rootDir: .`, so `dist/server` and `dist/shared`). `dependencies` is only
  what the server loads at run time; the client's libraries are bundled by Vite and live in
  `devDependencies`, so the image's `npm prune --omit=dev` leaves them out.

## Repo map

File names say most of it. This lists where things live and the files a rule is attached to.

```
shared/                 imported by both sides, always with a `.js` suffix
  settings.ts           Settings, DEFAULT_SETTINGS, CARD_IDS, normalizeLayout, MAX_PRIORITIES, SETTING_LIMITS,
                        retention bounds
  api.ts                every wire type and `emptyDay`; the server's JSON builders and client/src/api.ts both use them
  sounds.ts             the sound catalog (SOUNDS, SOUND_EVENTS)
  dates.ts, timer.ts    date keys; pause-aware session timing (activeMs, plannedEndAt, PLANNED_SECONDS)
  punches.ts            kindForPosition: a punch row's kind is its position's parity
  backoff.ts            nextBackoff: the wait between retries of a request that must answer
server/                 Express API → dist/server
  app.ts                createApp(): headers, /api/health, auth routers, data routers behind
                        requireAuth, static files and the SPA fallback; startBackgroundJobs() (the
                        login purge and the retention schedule, started by index.ts only)
  security.ts           every security header, rejectCrossSiteWrites and rejectUnknownHosts
  config.ts, db.ts      env parsing (throws on bad config); pragmas, MIGRATIONS, the default user
  settings.ts           mergeSettings (defaults + validation on every read and write), loadSettings
  retention.ts          old-day pruning (pruneDays, runRetention, the RETENTION_DAYS cap)
  auth/                 session cookie, scrypt passwords, the login limiter, publicUser/logName (users.ts),
                        middleware (currentUser), local + OIDC routes
  routes/               the days, sessions, breaks and settings routers; shared.ts has requireDate, findDay,
                        and the row → JSON builders
  dev/                  seed.ts + seed-cli.ts (`npm run seed`), harness.ts (startTestApp for route tests)
  index.ts, cli.ts      the process entrypoints: the server (warns under AUTH_MODE=none), reset-password
client/                 Vite root → dist/client
  public/               manifest, sw.js, icons/icon.svg (the icon's one source; `npm run icons` renders
                        the PNGs next to it)
  src/App.tsx           provider stack + Shell (route, settings dialog, today's alarms)
  src/api.ts            fetch wrapper (30 s timeout; UNAUTHENTICATED_EVENT on 401; throws lib/apiError.ts's
                        ApiError, which a caller checks with instanceof); src/types.ts re-exports shared types
  src/lib/              pure logic with a test beside each file: timeclock, alarms, timer, breaks,
                        retro, review, calendar, stickers, priorities, format, timefield, layout, celebrate,
                        plan, tiles, week, optimistic (a server copy plus pending changes, which the day store is built on)
    alerts.ts           the one place that plays sound, shows notifications and pushes banners
    copy.ts             every line the app raises at the user; no logic
    storage.ts          localStorage that never throws (private mode, quota)
  src/hooks/            state and effects (useDay, useTimer, useSettings, useAlarms, …), each with a
                        happy-dom test beside it (useLatest and useTimeFormat are covered through the
                        hooks that use them); src/test/hooks.tsx has the fixtures and provider stack
  src/components/       the cards, History (Calendar + Review), Banners, FinishChoice; pieces more than
                        one place uses (TimerControls, Toggle, NewPasswordFields, Tile); settings/ holds
                        SettingsDialog (the shell and tabs), a file per tab, and controls.tsx
  src/auth/             AuthGate and the setup / login / new-password pages
  src/sounds/           bundled CC0 clips; the README.md there is the only record of their sources
  src/styles.css        design tokens and all component CSS
scripts/                screenshots.mjs and icons.mjs (headless Chromium via browser.mjs), smoke-image.sh
docs/screenshots/       the PNGs the README embeds
Dockerfile, docker/     the image; entrypoint.sh owns /data as PUID:PGID and drops root
unraid/clockspan.xml    the Unraid template, a field per .env.example variable (config.test.ts checks);
                        Unraid reads it from main, so an edit reaches users when it merges
ca_profile.xml          the Community Apps profile. Both XML files link icons/icon-512.png and
                        docs/screenshots/*.png by raw URL on main: moving those breaks the listing
.github/workflows/      ci.yml (check, image-smoke, image, release), codeql.yml, workflow-lint.yml (zizmor)
```

## Commands

```bash
nvm use                # reads .nvmrc (24)
npm install
npm run dev            # API on :3000 (tsx watch, PORT pinned) + Vite on :5173 (proxies /api, /auth)
npm test               # vitest: shared + client lib + hook + component tests + server API tests
npm test -- server/routes/days   # one file
npm run test:coverage  # the gate CI runs: the same suite, and every file in server/, shared/, client/src/api.ts,
                       # client/src/lib and client/src/hooks must be 100% covered (text table of gaps + coverage/index.html)
npm run typecheck      # client + server (tsconfig.server.test.json also covers dev/ and tests)
npm run lint           # oxlint
npm run format         # prettier --write . (format:check is what CI runs)
npm run seed           # fill data/focus.db with sample days; see "Dev data is disposable"
npm run screenshots    # regenerate docs/screenshots/ (starts the dev server if needed; finds or
                       # fetches a Chromium into node_modules/.cache; CHROME_BIN to force one)
npm run icons          # render the PNG icons from client/public/icons/icon.svg (same Chromium)
npm run build          # dist/client + dist/server + dist/shared
npm start              # node dist/server/index.js (PORT default 3000; Docker sets 8080)
npm run reset-password -- <username>
docker compose pull && docker compose up -d   # the published image; see README for building locally
```

`AUTH_MODE=local npm run dev` shows the setup and login pages. `.claude/launch.json` has `web`
(the dev server), `web-local` / `web-oidc` (the same under `AUTH_MODE=local` / `oidc`; the OIDC
provider isn't there, so its sign-in button can't complete and discovery logs a retry now and
then; everything after sign-in works) and `prod` (the built bundle with the real headers on
:8090). The `web*` configs share :5173, so run one at a time.

## Branches, PRs and releases

`main` is protected: every change is a branch → PR → green checks → squash merge, and a release
is a version-bump PR that CI tags and publishes. `CONTRIBUTING.md` has the PR requirements
(title, one label, what must pass), the release checklist, the version rule and the Dependabot
routine. Follow it as written; it is not advice.

## Dev data is disposable

On a dev checkout `./data/focus.db` (gitignored) is test data and nothing else: add, edit and
delete rows, users, days, punches, sessions and settings as the task needs, or delete the file
to start over, with no confirmation. Production data lives only on the Docker `/data` volume,
which the dev machine cannot reach. Run the destructive paths for real: delete a session or
user, cancel a timer, `DELETE /api/settings`.

Start from `npm run seed`, not an empty DB: the last 10 weekdays for the default user (a normal
day, an extra out/in pair with a mid-day priority, approved overtime, an unreviewed day with a
cancelled session, a half day with no lunch) plus today, clocked in two hours ago. Flags are in
the `seed-cli.ts` header: `--running` for timer work, `--quarter` for Month / Quarter review,
`--fresh` to also reset settings and logins. Under `AUTH_MODE=local` (or `--auth local`, which
stands in for the env var) it creates `admin` and `sam` (password `clockspan-dev`); under
`oidc`, one "Dev User". `--sessions` signs every seeded user in and prints a
`document.cookie = 'fs_session=…'` line per user: run it in the page and reload to be that user,
with no password typed and no provider. A run replaces the user's days, never deletes users,
and is safe while `npm run dev` is up (reload the page).

Ways in, cheapest first:

- `npm test`: route tests boot the real app on an in-memory DB with `startTestApp()`
  (`server/dev/harness.ts`) and call it with `fetch`. `seed: true` adds the sample days and a
  manifest of them (`app.seeded`); `app.db` sets up what the API can't (a session that started
  an hour ago). One app per test.
- `curl` against `http://localhost:3000/api/...` while `npm run dev` is up; `sqlite3
  data/focus.db` for direct inserts or a look at what a route wrote.
- `DATA_DIR=<scratch dir>` on `npm run seed` and `npm run dev` when the current DB should
  survive. Never point it outside the repo or the session scratchpad.
- The UI in the preview pane, for what only the UI shows.

Tests sit beside the code: pure-function tests in `shared/` and `client/src/lib`; hook tests in
`client/src/hooks` (`// @vitest-environment happy-dom`, `vi.mock('../api')`, fake timers;
fixtures and the provider stack in `client/src/test/hooks.tsx`); `client/src/api.test.ts` for
every call's method, path and body (a stubbed `fetch`); component tests beside a component
that holds logic worth pinning (drafts that save on a timer or on unmount, which page
`AuthGate` shows), under happy-dom with the same fixtures; harness tests in
`server/**/*.test.ts` for routes, validation, scoping, headers, `mergeSettings`, and migrations
(`migrate(db, upTo)` stops early so a backfill can be tested, see `server/db.test.ts`). No temp
files: `openDatabase(':memory:')`.

Never commit `data/` or `.env`.

## Architecture rules (do not break)

- **Anything both sides need lives in `shared/`** (`settings.ts`, `dates.ts`, `api.ts`) and is
  imported from there with a `.js` suffix. Never mirror a constant, default or type into the
  other tree; the client's `types.ts` re-exports the shared types so component imports stay
  short, and date helpers (`addDays`, `todayKey`, `MINUTE_MS`, …) come straight from
  `shared/dates.js`, never through another module. Every response body has a `shared/api.ts` type: builders are annotated with it
  (`sessionRowToJson(): Session`, `dayJson(): Day`, …) and each route's answer names its
  envelope with `satisfies` (`res.json({ deleted } satisfies PruneResult)`), while
  `client/src/api.ts` reads the same types, so a field renamed on one side fails `typecheck`
  on the other. Server-only row types (`UserRow` in `db.ts`, a day's rows in `routes/shared.ts`)
  take their unions from there too (`PunchRow.kind` is `Punch['kind']`).
- **Security headers are set only in `server/security.ts`** (applied first in `createApp`):
  the CSP, `nosniff`, framing, referrer, HSTS and the API's `no-store`. Headers that describe
  one answer stay with the code that sends it: the static files' `Cache-Control` in `app.ts`,
  `Retry-After` on a 429 in `auth/limiter.ts` (`refuseTooMany`), `Set-Cookie` through `cookieOptions()`. The CSP is same-origin with no `unsafe-inline`, so no inline `<script>`/`<style>` in
  `index.html` and no third-party assets; React `style={{}}` props are fine (CSSOM). Changing
  it means one look at the `prod` config's console. Cookies are set only through
  `cookieOptions()` (`auth/session.ts`), and the session is resolved under `/api` only
  (`resolveUser` is mounted there), so a static answer, which is publicly cacheable, never
  carries a `Set-Cookie`. `rejectCrossSiteWrites` (also in `security.ts`, mounted on `/api`
  before `resolveUser`) refuses any non-GET request the browser marks `Sec-Fetch-Site:
  cross-site` or `same-site`, and, from a browser that sends no `Sec-Fetch-Site` (Safari
  before 16.4), one whose `Origin` host is neither the `Host` header nor `APP_URL`'s: under
  `AUTH_MODE=none` there is no cookie for SameSite to hold back, and a body-less POST
  (finish, cancel) needs no preflight. Keep write routes under
  `/api` so it covers them. Under `AUTH_MODE=none` only, `rejectUnknownHosts` (also in
  `security.ts`, mounted on `/api` after `/api/health`) refuses a request whose `Host` names
  something other than an IP address, a one-word name, `localhost`, a `.local`, `.home.arpa`
  or `.internal` name, `APP_URL`'s host or an `ALLOWED_HOSTS` entry: DNS rebinding makes a
  page same-origin, and with no cookie nothing else would stop it reading or writing. It reads
  the raw `Host` header, never `req.hostname`, which believes `X-Forwarded-Host` under
  `TRUST_PROXY`, and a same-origin page can set that. The HTML pages the server writes itself (the OIDC error pages in
  `auth/oidc.ts`) carry fixed text: no request data or error message goes into HTML, and the
  cause goes to the log. Password hashing is async
  (`scrypt`, never `scryptSync`); login verifies against `DUMMY_HASH` when the user is unknown.
- **The server stores epoch milliseconds and never decides what "today" is.** The client sends
  the local date key `YYYY-MM-DD` (`shared/dates.ts: todayKey`). The container's TZ is
  irrelevant. The one exception is `cutoffKey` in `server/retention.ts`, which turns "keep the
  last N days" into a UTC date key: the minimum is 30 days, so a day of zone slop changes
  nothing, and no user zone is known server-side.
- **Old-day deletion goes through `pruneDays` (`server/retention.ts`)**, whether from the
  Data tab's button (`POST /days/prune`) or the scheduled `runRetention`. It deletes `days`
  rows before a date key (cascades take punches, priorities, sessions, breaks), never a day with a
  running session, and never settings. The per-user setting `retention { enabled, days }` is
  capped by `RETENTION_DAYS` (`config.retentionDays`) via `effectiveKeepDays`; a user with no
  settings row still gets the cap. `reclaimSpace` (VACUUM + WAL checkpoint) runs after any
  deletion so the file actually shrinks; it must not run inside a transaction.
- **Every data query is scoped by `req.user.id`** (`currentUser(req)`). In `AUTH_MODE=none` that
  is the single `kind='default'` user. Never add a data route outside the `requireAuth` router
  in `app.ts`. `/:date` routes take `requireDate`; `/sessions/:id` routes take
  `loadOwnedSession` and `/breaks/:id` routes `loadOwnedBreak`, both made by `ownedRows()` in
  `routes/shared.ts`, which is where the ownership check lives.
- **Settings go through `mergeSettings()` on every read and write** (`server/settings.ts`):
  the stored JSON is merged onto `DEFAULT_SETTINGS`, unknown keys are dropped, invalid values
  fall back, and a PUT stores the merged result (so a key missing from an old row takes the
  current default, while a value a user has saved stays put). Add settings by adding a default
  (shared) + validation there, never by migrating rows. `DELETE /api/settings` drops the user's
  row, which is what "Reset all settings" does.
- **Timeclock math lives only in `client/src/lib/timeclock.ts`; alarm scheduling only in
  `client/src/lib/alarms.ts`.** Both are pure functions of `(inputs, settings, now)` with tests.
  Components and hooks never re-derive these. Past days go through `timeclockForDate`
  (`now = min(now, endOfDay)` and `{ frozen: true }`).
- **Times are written through `useTimeFormat()`** (components) or `formatTime(ms, hour12)` with
  an explicit `hour12` (pure libs: `describeEvent` takes it on `EventContext`). The setting is
  `timeFormat: 'auto' | '12h' | '24h'`; `resolveHour12('auto')` asks the browser locale, so the
  default changes nothing for anyone. `TimeField` shows its AM/PM segment from the same answer.
- **All user-facing alerts go through `client/src/lib/alerts.ts`** (`alert()`, `playSound()`,
  banners). Never call `new Notification(...)` or `showNotification()` (its fallback where the
  constructor is refused, Chrome on Android), create an `AudioContext` or fetch a clip
  anywhere else. `unlockAudio()` must be called from a user gesture (timer start and every
  punch commit do this) for iOS. What plays is `settings.sounds[event]`, an id from the
  catalog in `shared/sounds.ts`; `settings.sound` is the master switch over all of them, and
  `none` is the per-event off. A celebration (day complete and work week reached in
  `Timeclock.tsx`, a priority ticked in `Priorities.tsx`, the next day planned in
  `PlanNext.tsx`) is a `useCelebration(moment, event)` (`hooks/useCelebration.ts`): the sound
  under `settings.sound`, the burst under `settings.celebrations`. A state's moment comes from
  `useBecameTrue`, so it is the day *becoming* done while the card is mounted, never a done day
  opening. The sound plays after the render, so a moment set by a tap calls `unlockAudio()` in
  that handler first.
- **Timer remaining time is derived from the server's `startedAt`, `plannedSeconds` and pauses**
  on every tick (`timerView()` in `client/src/lib/timer.ts`, on `shared/timer.ts`) — never a
  client-side counter. A paused session is still `status = 'running'` with `pausedAt` set;
  `pausedSeconds` holds the pauses that have ended, and the planned end moves forward while
  paused. A finish while paused ends the session where the pause began, and a pause left for
  `PAUSE_LIMIT_SECONDS` (an hour) is finished by the client with a quiet banner. **A timer that
  runs out is not finished by the client**: it is `due`, announced once per (session, planned
  end) — `dueKey`, kept in `localStorage['focus:timer-due']` so a reload shows the banner again
  without a second chime — and waits `DUE_GRACE_SECONDS` (10 min) for an answer before the
  auto-finish (which chimes only if nothing has for that end). While due the countdown shows
  the overrun as a negative number, `adjust(+N)` is N minutes from now, `finish()` logs the
  planned length (the server's clamp) and `finish(true)` sends `countOverrun` so the time past
  the end is logged too. The Finish buttons call `requestFinish()`: it finishes at once unless
  the planned and worked lengths differ by a whole minute, where `finishChoice` opens the
  `FinishChoice` sheet (Planned · Nm / Worked · Mm / Back). Both alerting effects wait for
  `settings.loaded`, or an alert raised on load would use the default sound and switch; the
  alarms in `App.tsx` wait for it the same way (`settled`), or a longer work day than the
  default would ring the clock-out alarm on load. So `loaded` only turns true on a real answer:
  a failed `GET /settings` is retried (`nextBackoff` in `shared/backoff.ts`: 2 s doubling to a
  minute), never settled with the defaults.
  `useTimer` keeps the running session the way the day store keeps a day
  (`lib/optimistic.ts`): a press shows at once and goes out after the writes before it, a
  failure drops only that press, and a sync's answer never hides a press still on its way.
  Keep that pattern for new mutations.
  **One running session per user is a schema invariant** (a unique partial index), and another
  device may own it: a 409 on start is adopted with a banner, a sync whose answer differs from
  the session shown reloads that day so the log catches up, a 404/409 on adjust/finish/cancel
  re-syncs at once, and the completion chime only plays when the server says `completed`.
  **Today's day is kept in step the same way** (`useRefreshDay` in `useDay.tsx`: a refresh
  when the tab comes back, throttled, and every minute), so the alarms in `App.tsx` judge the
  server's copy of the punches, not one from hours ago; they wait while a come-back refresh is
  out. A today whose first load failed is loaded again on the same ticks (no second banner), so
  its alarms come back with the server.
- **The day store keeps the server's copy and this device's changes apart**
  (`lib/optimistic.ts`): each day is its confirmed copy plus the changes not confirmed yet, and
  the sheet shows the one laid over the other. A failed write just drops its change, so the
  screen is back on the stored copy at once (with the "Change not saved" banner) and the day is
  asked for again. A read's answer replaces the confirmed copy and never a change still on its
  way; it is dropped only when the server confirmed a change after the read went out
  (`version`), and a day never loaded takes it anyway and is asked for again. A day not loaded
  yet keeps its changes until the server's copy arrives, so nothing made up stands in for it.
  `apply` and commit functions are pure: read the clock outside them.
- **Break lengths come only from `client/src/lib/breaks.ts`** (`suggestBreak`, pure, over a
  day's sessions: a fifth of the session, a long break for the fourth in a row, a 15-minute gap
  restarts the count). With `suggestBreaks` on, `useBreak` offers today's suggestion on the
  Break button and as a quiet banner off `useTimer().finished`, which only a finish by hand
  sets (Finish, the finish choice, − past the time worked), never the auto-finish or another
  device.
- **A break is a row in the day's log** (`breaks` table, `Day.breaks`), never device state.
  `ended_at` is the planned end from the start and moves back when the break is ended early
  (`POST /breaks/:id/end`), so nothing finishes a break that runs out: it is running while
  `endedAt` is ahead of now (`runningBreak`), and one that ended before its planned end was cut
  short, which is why only a full-length break rings "Break's over" (once per break id,
  `localStorage['focus:break-over']`). The server keeps breaks from overlapping sessions: a
  break start ends a running break and is refused (409) while a focus timer runs, and a
  session start ends a running break (`endRunningBreak`, `routes/shared.ts`). However a break
  ends, one that ran under `BREAK_SECONDS.min` is deleted, not logged (`POST /breaks/:id/end`
  answers `{ break: null }`). The client mirrors both rules with `endBreaksAt` (in `useDay`'s
  break writes and `applySession`), so it never sends an end after a session start: the break
  may already be gone. Break writes share one `inOrder` key (`breaks`).
- **Saves reach the server in the order they were made.** `setPunches` and `setPriorities`
  replace a whole list, so one PUT per day is in flight and only the newest waiting list follows
  it (`sendLatest` in `useDay.tsx`); the other day fields, each session and the breaks queue
  one after another (`inOrder`); `useSettings` sends its PUTs one at a time too. A new write
  goes through one of these, never straight to `api`.
- **Punch positions are fixed**: 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in
  pairs, and **the last row is always the Clock out** (an odd position ≥ 3; `normalizePunches`
  enforces it). Kind is parity (`kindForPosition`, `shared/punches.ts`). The math evaluates *set* punches
  chronologically; `extraPairs()` only decides where the card *shows* a pair. An explicit
  Clock out that is the latest punch ends the day even if the target isn't met. "Add extra
  out / in" appends two rows, so the old Clock out becomes the new pair's Out. Lunch semantics
  come only from positions 1 and 2.
- **A punch row saves only complete times.** `TimeField` (React Aria segments) commits the
  moment hour, minute and period are all filled, and throws a half-typed draft away when
  focus leaves the field, so the row never shows a time the server doesn't have. In 12-hour
  mode the period is filled in as the hour is typed (`guessPeriod` in `lib/timefield.ts`: 5–11
  → AM, 12 and 1–4 → PM, kept after the day's clock-in), and left alone once the user has
  touched that segment. Clearing is the row's × button only. Punch PUTs are queued per day (see
  "Saves reach the server in the order they were made").
- **Overtime approval (`days.overtime_approved`) silences only the `clockOut` alarm target.**
  Lunch and the second meal period stay armed: California Labor Code §512 still requires them
  on an overtime day. The setting `overtimeApproval` shows/hides the switch and banner
  button, and with it off the Clock out tile reads time past the day as "past your day"
  rather than a red "Over by"; a flagged day is silent only while the setting is on (`App.tsx`).
- **`mealRules: false` turns the meal periods off in the math, not in the components.**
  `computeTimeclock` then never needs a lunch (`not-needed`, so no lunch alarm and no lunch
  added to the clock-out time) and `secondMealApplies` is false; a lunch that was punched still
  counts. The card drops the Lunch by tile (the Focused tile shows either way), and with
  `lunchPunches: false` too it hides the Lunch out / in rows, which stay in the data at
  positions 1 and 2: `lunchRowsShown` decides (never on a day with a lunch punched) and
  `nextPunchPosition` skips them. `trackHours: false` only hides hours outside the day's own
  tiles (the week line, History's hours, the Clocked out sticker via `stickerReasons`); the
  timeclock still runs.
- **Priorities are stored sparse** (positions 1..n, contiguous, ≤ `MAX_PRIORITIES`; no `done`
  on an empty row); the client pads to `settings.priorityCount` with `padPriorities()`.
  `PUT /days/:date/priorities` is a full replace, so removing a row is sending the list without it.
- **A priority's identity is its `uid`, never its position.** The client mints it
  (`newUid()`) the first time a row gets text and stamps `addedAt`; both survive a text clear
  and a renumber. `sessions.priority_uid` points at it (null or a removed row = unplanned).
  `POST/PATCH` sessions check the uid exists on that day.
- **Plan-vs-actual math lives only in `client/src/lib/retro.ts` and `review.ts`** (pure, with
  tests). "Added mid-day" means `addedAt` is after the day's first completed session started —
  one rule, no clock-in fallback. `GET /days/range` returns full days and the client does the
  rollup (the review, the History calendar and the week line all fetch it through `useRange`,
  one period at a time, which lays the day store's copies over the answer so an edit shows at
  once); register any new literal path under `/days` before `/:date`.
- **History → Days opens on the route's date.** `App.tsx` passes `route.date ?? today` to `History`;
  the calendar starts on that month with that day picked (`periodOffset('month', …)`), and
  only "Open day" navigates. So the header's History button lands on the month of the day
  being viewed, and browser Back from a day returns to it. The month grid is
  `calendarMonth()` (pure); the panel's numbers come from `timeclockForDate` + `daySummaryOf`,
  the same math as the sheet.
- **The `retro` alarm target is the clock-out instant** ("warn before" = minutes before the
  end of the day) and is **not** silenced by overtime approval; marking the day reviewed
  (`days.retro_at`) disarms it. Its banner button jumps to the card (`jumpTo` in `App.tsx`).
- **Alarm event keys embed the target minute** (`eventKey`), so a moved target re-arms and a
  reload never re-fires. Fired keys live in `localStorage` under `focus:alarms:<date>` and are
  pruned to today. Today's punches are held while focus is inside the punch rows and settle
  for 3 s after it leaves (`useSettled(value, ms, hold)`, wired in `App.tsx`) before evaluation.
- **Per-date card drafts reset by remounting**: `Sheet.tsx` keys `Priorities` and `Retro` by
  date, so neither needs a "date changed" effect. Local drafts that mirror a prop use the
  "adjust state while rendering" form (see `DurationField`), not a `useEffect` + `setState`,
  unless the draft is gated by a dirty flag: a ref can't be read during render, so there the
  effect form is the one the react-hooks rules allow. A typed draft that saves on a timer is
  `useDebouncedDraft(stored, save, ms)` (`Priorities`, `Retro`): it saves after the wait, at
  once on `flush()` or an edit made now, and on unmount, so a day left mid-sentence still
  saves. Callbacks that must read the latest value use `useLatest()`, never a ref written in
  render (the react-hooks lint enforces both).
- Static assets are public; **all data is behind `/api/*`**. The SPA fallback serves
  `index.html` for any non-API path. `/assets/*` is fingerprinted and cached immutable.
- **History, the settings dialog and drag and drop are lazy chunks** (`lazy()` in `App.tsx`
  for `History` and `SettingsDialog`, in `Sheet.tsx` for `SortableCards`, which holds every
  `@dnd-kit` import). A static import of one of them from the first screen folds it back into
  the main chunk. The sheet renders plain `CardFrame`s until the first Customize and stays on
  `SortableCards` after it, since swapping lists remounts the cards. A chunk that fails to
  load (an upgrade while the page was open) reloads the page once a minute at most
  (`vite:preloadError` in `main.tsx`, `lib/reload.ts`); otherwise the `ErrorBoundary` shows.
- **Migrations are append-only** in `server/db.ts` (`MIGRATIONS[]`, `PRAGMA user_version`).
  Every FK to `users` or `days` is `ON DELETE CASCADE`. A column nothing uses stays in the
  table rather than a migration dropping it: `sessions.notes` is one (never shown or edited;
  the API no longer reads or writes it).

## How to add…

- **A card**: add the id to `CARD_IDS` and its default under `CARD_DEFAULT_VISIBLE` in
  `shared/settings.ts`, and its title to `CARD_TITLES` in `client/src/lib/layout.ts` (the
  types make a missing entry an error) → write the component → add a `case` in `Sheet.tsx`'s
  `render()`. Existing users get it automatically because every layout goes through
  `normalizeLayout` (`shared/settings.ts`; `mergeSettings` runs it on the server, `useSettings`
  on the client), which appends a missing card with that default; a card whose default is
  hidden shows up under Customize → Hidden → Show. Removing a card is the reverse (drop the
  id everywhere; the merge discards it from saved layouts), and if the card
  recorded a choice worth keeping, `mergeSettings` can read it off the old layout entry the
  way the sticker chart's `stickers` setting does.
- **A per-user setting**: add it to the `Settings` type and `DEFAULT_SETTINGS` in
  `shared/settings.ts`, and a number's bounds to `SETTING_LIMITS` there → validate it in
  `mergeSettings()` (`server/settings.ts`; `limited(key)` checks a number against its
  bounds) → add the control to its tab in `client/src/components/settings/` (`TimeclockTab`,
  `AlarmsTab`, `SheetTab`, `DataTab`, `AccountTab`; the Sheet tab's "History" section holds
  the calendar's switches) using `DurationField` / `NumberField` (`settings/controls.tsx`) with
  `{...SETTING_LIMITS.<key>}` for `min` and `max` — `NumberField` takes a `unit` suffix,
  default "min" — / `Toggle` (`NumberInput` alone puts several numbers on one row, like the
  timer's start buttons). Nothing else to mirror.
- **A sound**: drop the clip in as `client/src/sounds/<id>.mp3` (CC0 only, MP3 so Safari can
  decode it, a couple of seconds at most) → add `{ id, label, kind: 'clip' }` to `SOUNDS` in
  `shared/sounds.ts` → add its title, author and source line to `client/src/sounds/README.md`.
  Nothing else: the settings selects, the validator (`mergeSounds`), the `SoundId` type and the
  Test buttons read the catalog, and `client/src/lib/sounds.test.ts` fails if the folder and
  the catalog disagree. A synthesized pattern is an entry with `kind: 'synth'` plus its
  `beep()` sequence in the `SYNTH` map in `alerts.ts` (the type makes a missing one an error).
  A new event that can make a noise is an id in `SOUND_EVENTS`, a default in
  `DEFAULT_SETTINGS.sounds`, a label in `SOUND_EVENT_LABELS`, and a `playSound(settings.sounds.<event>)`
  call gated by `settings.sound` (or a `useCelebration` for a moment worth a burst).
- **An alarm target** (existing: `lunchBy`, `clockOut`, `secondMeal`, `retro`): expose the instant from
  `computeTimeclock` → add a target to `alarmTargets()` in `lib/alarms.ts`, with an `armed` rule
  and a test case (a rule the card also needs goes in a pure helper like `secondMealApplies`) → add its default
  under `alarms` in `shared/settings.ts` and the `AlarmId` union there → add an `AlarmEditor` in
  `settings/AlarmsTab.tsx` → its name in `ALARM_NAMES` (`lib/alarms.ts`; the type makes a
  missing one an error) and copy in `describeEvent()`: a `kicker` naming the alarm + rule
  ("X alarm · 15 min warning"), a title, and a body that says where the deadline came from
  (it gets an `EventContext`; extend that if the new target needs more inputs). A banner can
  carry one `action` button (see the clock-out alarm's "Overtime approved" and the retro
  alarm's "Open retrospective", chosen in `useAlarms` from the `AlarmDayState` callbacks).
- **A per-day field** (like `overtimeApproved`, `retroNote`/`retroAt`): append a migration adding the column to
  `days` → add the column to `DAY_COLUMNS` (`routes/shared.ts`; `findDay` and `/days/range` both
  read it) and return it from `dayJson` → add a `PUT /days/:date/<field>` route (with
  `requireDate`) → `Day` and its default in `emptyDay` (`shared/api.ts`) +
  `client/src/api.ts` → an optimistic setter in `useDay.tsx` that goes through `inOrder` on
  the day's `day:<date>` key with the change and a commit from the server's answer (mirror
  `setOvertimeApproved`; a failure drops the change, raises the "Change not saved" banner and
  reloads the day, so the setter never rejects) → pass it from `Sheet.tsx`
  to the card, and from `App.tsx` into `useAlarms` if alarms depend on it.
- **An API route**: put it on the `api` router in `app.ts` (behind `requireAuth`), scope by
  `currentUser(req).id` (`requireDate` / `loadOwnedSession` / `loadOwnedBreak` where they fit), validate input
  (cast `req.body` to `{ field?: unknown }` and check each field; the `no-unsafe-*` lint
  refuses reading it as `any`), return `{ error }` JSON on failure → add the call to `client/src/api.ts` and the response
  type to `shared/api.ts` (the route's `res.json(… satisfies <Type>)` and the client's
  `request<Type>` both name it) → cover it in that router's
  `*.test.ts`: happy path, each 400, and that another
  user gets a 404/empty result (the scoping test is not optional). If the seed should carry
  the new field, add it to `server/dev/seed.ts` and its manifest.
- **A schema change**: append a migration string to `MIGRATIONS` in `db.ts`. Never edit an
  existing entry. A new table with a `user_id` also joins the README's script under "Switching
  modes later" (and its count of places); `server/db.test.ts` fails until it does.
- **A security header, CSP source or request guard**: `server/security.ts` only (tests in
  `server/app.test.ts`), then the `prod` config check.
- **A config env var**: parse and validate it in `server/config.ts` (throw with a clear
  message on a bad value) → cover it in `server/config.test.ts` → document it in
  `.env.example` (commented out, with its default) and the README's variables table → add a
  `Config` field for it to `unraid/clockspan.xml` (`config.test.ts` fails otherwise).
  `.env.example` is the only place the container is configured; `docker-compose.yml` never
  lists variables, it only passes `.env` through (`env_file`). `loadConfig` drops empty values
  before parsing (Unraid passes every template field, blank or not), so an empty variable
  already means its default; don't test for `''` in the parser.

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. Named exports. Server and shared imports
  end in `.js`. `npm run lint` and `npm run format:check` must pass; `_`-prefixed names are the
  only allowed unused vars.
- CSS: tokens on `:root` in `client/src/styles.css`, dark mode via `prefers-color-scheme`
  unless the `theme` setting forces one (`data-theme` on `<html>`, set by `lib/theme.ts`; the
  two dark token blocks must match, `theme-css.test.ts` checks), **mobile-first** (base = phone; `@media (min-width: 640px)` enhances). Tap targets are
  44 px on a touch screen: `.btn` and `.input` set `min-height: 44px`, and a compact control
  (chip, segment, running-bar button, banner close/action, log delete) keeps its drawn size
  and gets the rest from the `@media (pointer: coarse)` block at the end of `styles.css`, an
  empty `::after` reaching past its edge (a control that clips its overflow grows its padding
  instead). Where two controls sit closer than that, each reaches half the gap. A new compact
  control joins that block. Inputs are 16 px so iOS doesn't zoom. No external
  fonts or assets (the CSP would block them anyway). Safe-area insets via `--safe-top` / `--safe-bottom`.
- Numeric settings inputs commit on blur/Enter (never on every keystroke); priorities debounce
  400 ms; punches and checkboxes save immediately.
- A form that sends a request submits through `useSubmit()` (`hooks/useSubmit.ts`): one send at
  a time with the button disabled, and one error line, cleared when a send starts and filled
  with what it throws (a mismatched confirmation throws too).
- Comments explain *why* (browser quirks, math), not what.
- No new dependency (a server one or a client library the bundle carries) without stating the
  reason in the commit message.
- **Copy**: what the app raises at the user (celebrations, the priority warnings, confirms,
  alerts and banners, the sheet's notices) lives in `client/src/lib/copy.ts`, never inline;
  alarm lines are built in `describeEvent()`. Labels, settings hints and empty-state lines sit
  beside the control or view they describe, and must not assume a card order the user can
  change ("above", "at the bottom"). Write all of it plainly and check new ones against
  Wikipedia's "Signs of AI writing"
  (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing): no "not just X, but Y", no
  rule-of-three flourishes, no em-dash chains, no "Gentle reminder:" / "Deep breath." openers,
  no cheerleading, no puffery words. Short, dry, specific.

## Verification expectations

Prove a change at the cheapest level that can show it, and stop there:

1. Pure functions (`shared/`, `client/src/lib`): a unit test. A hook (`client/src/hooks`): a
   happy-dom test beside it, with the API mocked and fake timers for polls, retries and races.
   A component's own logic (when a draft saves, what a click sends, which page shows): a
   happy-dom test beside it with `@testing-library/react`. Its looks stay a browser matter.
2. Anything in `server/`: a harness test in the router's `*.test.ts`. Route behavior,
   validation, scoping, headers, persistence and migrations are proven here, never by clicking.
3. One-off looks at live data: `curl` against the seeded dev DB.
4. The browser, only for what tests cannot show: how a card renders, drag/drop, banners, the
   timer bar, light/dark, the 375 px pass. Seed first (`--running` for timer work), scope it to
   the surface you touched, and make one pass at the mobile preset unless the change is
   desktop-only layout. Do not re-walk flows a test already covers.

The gate: `npm run test:coverage` green and `typecheck`, `lint` and `format:check` clean. Every
file under `server/`, `shared/`, `client/src/lib/` and `client/src/hooks/`, and `client/src/api.ts` (minus the two
process entrypoints and `server/dev/`) must be 100% covered on statements, branches, functions
and lines, so new code there ships with the tests that reach it. A branch that cannot be
reached is deleted, never hidden behind a `v8 ignore` comment; `alerts.ts` shows how a
browser-only module is tested (stub the globals).

The browser pass for each surface (the logic under it is already tested):

- **CSS or a component**: the touched surface at the 375 px mobile preset (and desktop width
  if the change has a desktop-only branch), in light and dark.
- **`security.ts`, `index.html` or how assets load**: the `prod` config, with the console free
  of CSP violations; `curl -sI localhost:8090/api/health` shows the headers.
- **The timer**: make the seeded session run out (PATCH `plannedSeconds` to elapsed + 30, then
  reload so the client has the new plan). The bar and the card count below zero, the "Time's
  up" banner offers **Add 5 min**, and a minute or more over, **Finish** opens "How much to
  log?". Pause and resume: the countdown holds and the log row's pill follows.
- **Alarms**: a banner firing at the mobile preset. With "Overtime approved" on, the clock-out
  banner stops and the lunch tile keeps counting down.
- **Sounds**: Settings → Alarms → Sounds. Test on a clip row fetches the file once (the network
  list); a second Test fetches nothing. A clock-out set today plays the day-complete sound once,
  and not again on reload.
- **Punches**: a pair added before lunch, an early Clock out (done, celebration), "Add extra
  out / in" after it (the old Clock out becomes Out N) and removing that pair. In the time
  field: clear Clock in and press `0` `7` `3` `0` (the hour advances, the period fills, the
  tiles move with no further key), `p` flips the period, ↑/↓ on a segment saves each step, and
  a half-typed row reverts when focus leaves. In the browser pane send single `key` presses;
  the `type` action pastes the whole string into one segment.
- **Priorities or the timer card**: tick one row and press Add priority (the notice lists the
  ticked row); tap a chip, start, and the log row shows the number; "Also add to today's
  priorities" fills the first empty row; a log row's select reassigns it.
- **Retro or review**: one seeded day's retro card and History → Review → Week (`--quarter` for
  Month / Quarter).
- **The History calendar**: one month at the mobile preset: ◀ to a seeded month, tap a day,
  **Open day** and back through the header, **Review this week** lands on that week. With the
  sticker chart on (`PUT /api/settings {"stickers":true}`), a chip narrows the grid to one
  sticker and a second tap clears it; with Show weekends off, five columns.
- **Retention**: one look at Settings → Data (count line, toggle saves); drive the delete with
  curl (`POST /api/days/prune`) because of the confirm dialog.
- **Auth**: no browser pass; `server/auth/local.test.ts` covers setup, login, the limiter,
  password change and user management.
- **Anything a README screenshot shows** (sheet, retro, review, settings): `npm run screenshots`
  and commit the PNGs that changed.

## Gotchas

- `better-sqlite3` is native but ships N-API prebuilds for every platform the image runs on
  (linux-musl x64 and arm64 included) and picks one at run time, so `node_modules` is the same on
  every platform: the Dockerfile's build stage runs on the builder's platform and only the
  runtime stage is emulated for arm64. Its `binding.gyp` still makes npm try `node-gyp rebuild`, so the
  Dockerfile and CI run `npm ci --ignore-scripts`, which also keeps every dependency's install
  script from running; `npm audit signatures` then checks registry signatures. There is no
  Docker on the dev machine: `image-smoke` (`scripts/smoke-image.sh`) on each PR is the first
  run of the image.
- The preview harness exports `PORT=5173`, which is why `dev:server` pins `PORT=3000` and the
  `prod` config `PORT=8090`.
- `client/public/sw.js` is a pass-through service worker on purpose: installability, and the
  `notificationclick` handler for notifications `alerts.ts` shows through it (Chrome on Android
  refuses `new Notification()`). It is registered only in a production build. No caching
  without a versioning strategy, or users see stale assets.
- `vite.config.ts` imports `defineConfig` from `vitest/config` so the `test` block type-checks.
- OIDC: `APP_URL` must match the redirect URI registered with the provider exactly
  (`${APP_URL}/auth/callback`). The callback builds its URL from `APP_URL`, not from request
  headers, so it works behind proxies.
- `TRUST_PROXY` is a hop count (`1`), never `true`: `true` trusts the leftmost
  `X-Forwarded-For`, which the client controls, and the login limiter keys on `req.ip`. Left
  unset behind a proxy, every sign-in is the proxy's address; under `AUTH_MODE=local`,
  `warnUntrustedProxy` (`auth/limiter.ts`) logs that once, the first time `X-Forwarded-For`
  reaches `/api/auth`.
- scrypt at N=2^15 needs `maxmem` above Node's 32 MB default (set in `password.ts`).
  `DUMMY_HASH` is computed with a top-level `await`, so `password.ts` is ESM-only.
- `window` `focus` events fire on ordinary clicks in some embedded browsers; timer re-sync is
  throttled and seq-guarded for that reason. Don't add unthrottled focus-driven refetches.
- `npm version` without `--no-git-tag-version` tags the branch commit, which is not the squash
  commit that lands on `main`. CI creates the `vX.Y.Z` tag on the merge.
- Prettier (`.prettierrc`): single quotes, trailing commas, 160 columns. Markdown is left alone
  (`.prettierignore`): the docs have hand-laid tables and wrapping.
- oxlint ignores a misspelled rule name without a word. After editing `.oxlintrc.json`, check
  that `npx oxlint --print-config` lists what you meant and that a deliberately bad snippet is
  caught. A promise deliberately not awaited is written `void p`, and an async handler passed to
  JSX or a timer is wrapped: `onSubmit={(e) => void submit(e)}`.
- A push, merge, tag or release a workflow makes with `GITHUB_TOKEN` starts no other workflow
  (`workflow_dispatch` and `repository_dispatch` aside), which is why the release job's tag
  starts no second run. A step that must trigger CI needs a GitHub App or personal token.
- TypeScript 7 is the native compiler: the `typescript` package has no `tsserver` or JS API.
  Editors need the native TypeScript extension; `npm run typecheck` is the source of truth.
- The Node floor (`engines` and `devEngines` in `package.json`) has no upper bound, and `.npmrc`
  has no `engine-strict`, on purpose: Dependabot's updater reads both files and runs its own
  Node (24 at the time of writing; it follows the active LTS). A cap it outgrows, or a package
  whose `engines` leaves its Node out under `engine-strict`, stops its npm updates without
  failing any check: the PRs just stop coming. A new Node major moves `.nvmrc`, both fields,
  CI and the Dockerfile together.
