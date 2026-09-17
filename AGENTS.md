# Clockspan — agent guide

## What this is

A self-hosted, single-day **focus sheet** for working through a workday with ADHD: a punch-style
timeclock (lunch deadline, end of day, celebration), top priorities (default three, with a
nudge when the list grows), a focus timer that logs what was done and for which priority, a
retrospective card (plan vs. log, a "why" note, a nudge before clock-out), a week / month /
quarter review, and alarms for lunch, clock-out and the second meal period. "Overtime
approved" silences the clock-out alarm only. Every day is persisted; old days can be pruned.
Data is **per user**; auth is optional (`AUTH_MODE=none | local | oidc`). One Docker container,
SQLite on `/data`. Mobile-first PWA. Meal-period defaults follow California rules. The README
has the user-facing description.

## Stack & versions

- Node **24** (Active LTS). `nvm use 24` locally; `node:24-alpine` in Docker.
- Frontend: React 19 + TypeScript + Vite 8. Drag/drop: `@dnd-kit/sortable`. Punch time entry:
  `react-aria` + `react-stately` (`useTimeField`, segments) with `@internationalized/date`.
  No router lib — the date and view live in the URL query (`hooks/useRoute.ts`). No CSS framework.
- Backend: Express 5 (ESM, `NodeNext`, imports use `.js` extensions), `better-sqlite3` (native),
  `openid-client` v6 for OIDC, `cookie` for cookie parsing. Passwords: `node:crypto` scrypt (async).
- Tests: Vitest 5. Lint: ESLint flat config (`eslint.config.js`: typescript-eslint + react-hooks,
  syntax rules only). CI: `.github/workflows/ci.yml` runs typecheck, lint, test, build on
  every PR and push; on `main` it also publishes the `edge` image, on `v*` tags the release.
- One `package.json` for both sides; `tsconfig.json` = client + shared, `tsconfig.server.json` =
  server + shared (`rootDir: .`, so `dist/server` and `dist/shared`).

## Repo map

```
shared/                 Imported by BOTH sides (always with a `.js` suffix); pure data + functions
  settings.ts           Settings type, DEFAULT_SETTINGS, CARD_IDS, MAX_PRIORITIES, retention bounds
  api.ts                the wire types (Day, Session, Punch, Priority, DaySummary, PruneInfo, AuthInfo…);
                        server JSON builders are annotated with them, the client reads them
  dates.ts              date keys: dateKey/todayKey/parseDateKey/isValidDateKey/addDays/endOfDay,
                        startOfWeek/Month/Quarter, addMonths (+ dates.test.ts)
server/                 Express API → dist/server (tsc)
  index.ts              boot: load config, warn if AUTH_MODE=none, open DB, listen, SIGTERM
  app.ts                createApp(): trust proxy, securityHeaders, /api/health, resolveUser, auth
                        routers, data routers behind requireAuth, static dist/client + SPA fallback
  security.ts           the ONLY place response headers (CSP, nosniff, frame, referrer, HSTS) are set
  config.ts             env parsing; throws with a clear message on bad/missing config
  db.ts                 open + pragmas (WAL, foreign_keys), append-only MIGRATIONS, default user
  retention.ts          old-day cleanup: cutoffKey, countDays, pruneDays, runRetention (all users,
                        user setting capped by RETENTION_DAYS), scheduleRetention (30 s + 6 h)
  cli.ts                `reset-password <username> [password]`
  dev/seed.ts           seedDatabase(db, opts) → SeedManifest; ensureLocalUsers(). Dev + tests only
  dev/seed-cli.ts       `npm run seed` (flags: --fresh --running --days N --quarter --today --now)
  dev/harness.ts        startTestApp(): real app on an in-memory DB + fetch client w/ cookie jar
  **/*.test.ts          route/auth/db/header tests beside the code they cover (Vitest, via the harness)
  auth/session.ts       cookie session (token hashed in DB, sliding 30d expiry), cookieOptions(),
                        revokeOtherSessions()
  auth/password.ts      async scrypt hash/verify, DUMMY_HASH, username/password validation
  auth/middleware.ts    resolveUser / requireAuth / requireAdmin / currentUser(req)
  auth/local.ts         /api/auth: me, setup, login (rate-limited), logout, password, users (admin)
  auth/oidc.ts          /api/auth/{me,logout} + /auth/{login,callback}; lazy discovery w/ retry
  routes/shared.ts      requireDate + dateParam, findDay/ensureDay, UID_RE, SessionRow → JSON
  routes/days.ts        GET /days (history summaries), GET /days/range?from&to (full days),
                        GET|POST /days/prune, GET /days/:date, PUT punches, PUT priorities (full
                        replace, sparse rows, uid/addedAt), PUT overtime, PUT retro (note, done)
  routes/sessions.ts    POST /days/:date/sessions (start, optional priorityUid), GET /sessions/running,
                        PATCH/:id (label, notes, planned, priorityUid), POST /:id/finish|cancel, DELETE /:id
                        (`loadOwnedSession` does the 404 + scoping for every /:id route)
  routes/settings.ts    mergeSettings() validator; GET/PUT/DELETE /settings
client/                 Vite root → dist/client
  index.html            viewport-fit=cover, theme-color, manifest, apple-mobile-web-app meta
  public/               manifest.webmanifest, icons/, sw.js (pass-through)
  src/App.tsx           provider stack + Shell (route, customize, settings, today's alarms)
  src/api.ts            fetch wrapper; dispatches UNAUTHENTICATED_EVENT on 401
  src/types.ts          re-exports only: the shared wire types (api.ts) and Settings types
  src/styles.css        design tokens (:root, dark via prefers-color-scheme), all component CSS
  src/lib/timeclock.ts  PURE: computeTimeclock(punches, settings, now, {frozen}) → tiles/state,
                        timeclockForDate/clampToDay (past days freeze at their end), normalizePunches/
                        clockOutPosition/extraPairs (row model), secondMealApplies
  src/lib/alarms.ts     PURE: dueEvents(...) scheduler + describeEvent() copy
  src/lib/alerts.ts     the ONLY place that plays audio / calls Notification / pushes banners
  src/lib/copy.ts       every editable phrase (celebrations, warning pools, confirms, timer-done,
                        retro prompt, settings status) — no logic
  src/lib/celebrate.ts  PURE: pickCelebration(seed) for the end-of-day notice, pickBurst(seed, n)
                        for the emoji burst (pieces + flight)
  src/lib/priorities.ts PURE: padPriorities(), warnThreshold(), warningKind(), pickWarning(kind),
                        newUid(), placePriority() (timer → priorities)
  src/lib/retro.ts      PURE: reviewDay(priorities, sessions) → on/off-plan time, mid-day rows
  src/lib/stickers.ts   PURE: stickersForDay(summary) (clocked out, lunch, all priorities, focus,
                        reviewed), stickerEmoji(date, id) (fixed, distinct per day), daySummaryOf(day)
                        (the GET /days rollup, for a live today), countStickers(weeks) (total, full
                        days, per reason)
  src/lib/review.ts     PURE: periodRange(kind, today, offset) (Mon-start weeks), periodOffset(kind, today,
                        date) (the offset that lands on a date's period), reviewRange(days)
  src/lib/calendar.ts   PURE: calendarMonth(days, settings, today, now, monthStart, showWeekends) →
                        Mon-start rows of CalendarDay (outside / future / hasData / stickers) for
                        History → Days; 5-wide rows without weekends, so hidden days are never counted
  src/lib/format.ts     Intl formatting (time, dates, durations, dayName); formatTime(ms, hour12)
                        + resolveHour12(timeFormat); re-exports shared/dates
  src/lib/timefield.ts  PURE: msToTime/timeToMs (epoch ms ↔ @internationalized/date Time on a
                        date key), guessPeriod() (the AM/PM the time field fills in)
  src/lib/layout.ts     CARDS (titles for CARD_IDS), DEFAULT_LAYOUT, normalizeLayout()
  src/hooks/            useSettings (SettingsProvider, optimistic PUT), useDay (per-date cache +
                        setters), useTimer (running session, remaining/progress, mutationSeq re-sync,
                        wake lock, tab title), useAlarms (fired keys in localStorage per day),
                        useLatest (ref that tracks a value for callbacks), useNow, useRoute,
                        useSettled, useTimeFormat ({ hour12, formatTime } from the setting), useWakeLock
  src/auth/             AuthGate (mode/user → Setup | Login | OIDC button | app), pages
  src/components/       Header, RunningTimerBar, Banners, Sheet (dnd-kit) + CardShell,
                        Timeclock + TimeField (React Aria hour/minute/AM-PM segments), Priorities,
                        Burst (emoji flying from an anchor, portalled to body; off under reduced
                        motion and the `celebrations` setting), FocusTimer, SessionLog, Retro,
                        History (Days | Review; owns the review period so the calendar can point it at a
                        week), Calendar (month grid, stickers when `settings.stickers`, legend filter,
                        picked-day panel), Review (controlled by History), PeriodNav (◀ label ▶, shared),
                        SettingsDialog (tabs incl. Data: retention + delete-before), Icons
scripts/screenshots.mjs `npm run screenshots`: dev server (reused or started) + seed + headless
                        Chromium over CDP → docs/screenshots/*.png for the README
docs/screenshots/       committed PNGs the README embeds; regenerate after a visible UI change
docker/entrypoint.sh    PUID/PGID (default 1000/1000) → chown /data + su-exec; 0 keeps root
Dockerfile docker-compose.yml .env.example README.md eslint.config.js
CONTRIBUTING.md         PR and release rules (imported by CLAUDE.md; see "Branches, PRs and releases")
.github/workflows/ci.yml  check → image (ghcr.io) → release; .github/release.yml groups notes by label
```

## Commands

```bash
nvm use 24
npm install
npm run dev            # API on :3000 (tsx watch, PORT pinned) + Vite on :5173 (proxies /api, /auth)
npm test               # vitest: shared + client lib tests + server API tests (~1.5 s)
npm test -- server/routes/days   # one file
npm run typecheck      # client + server (tsconfig.server.test.json also covers dev/ and tests)
npm run lint           # eslint .
npm run seed           # fill data/focus.db with sample days; see "Dev data is disposable"
npm run screenshots    # regenerate docs/screenshots/ (starts the dev server if needed; finds or
                       # fetches a Chromium into node_modules/.cache; CHROME_BIN to force one)
npm run build          # dist/client + dist/server + dist/shared
npm start              # node dist/server/index.js (PORT default 3000; Docker sets 8080)
npm run reset-password -- <username>
docker compose pull && docker compose up -d   # the published image; see README for building locally
```

Dev DB: `./data/focus.db` (gitignored). Delete it to start fresh. `AUTH_MODE=local npm run dev`
to exercise the setup/login pages. The `prod` config in `.claude/launch.json` builds and serves
the real bundle on :8090 with the real headers; the `web` config is the dev server.

## Branches, PRs and releases

`main` is protected. Every change is a branch → PR → `check` green → squash merge, and a
release is a version-bump PR followed by a tag pushed from `main`. The checklist, the PR
requirements (title, one label, what must pass) and the version rule are in `CONTRIBUTING.md`.
Follow it as written; it is not advice.

## Dev data is disposable

On a dev checkout, `./data/focus.db` is test data and nothing else. Add, edit, and delete
rows, users, days, punches, sessions, and settings as the task needs; delete the file to start
over. None of this needs confirmation. Production data lives only on the Docker `/data` volume,
which the dev machine cannot reach; the only local state worth protecting is the source tree.

Run the destructive paths for real: delete a session or user, cancel a timer, `DELETE
/api/settings`.

Start from `npm run seed`, not from an empty DB: the last 10 weekdays for the default user
(a normal day, an extra out/in pair with a mid-day priority, approved overtime, an unreviewed
day with a cancelled session, a half day with no lunch) plus today clocked in two hours ago.
Flags are in the `seed-cli.ts` header (`--running` for timer work, `--quarter` for Month /
Quarter review, `--fresh` to also reset settings and logins). Under `AUTH_MODE=local` it
creates `admin` and `sam` (password `clockspan-dev`). It replaces the user's days each run,
never deletes user rows, and is safe while `npm run dev` is up; reload the page.

Ways in, cheapest first:

- `npm test`: server tests boot the real app on an in-memory DB through `startTestApp()`
  (`server/dev/harness.ts`) and hit it with `fetch`. `seed: true` gives the test the sample
  days and a manifest of what was inserted (`app.seeded`). Reach into `app.db` for what the
  API cannot set up (a session that started an hour ago). One app per test.
- `curl` against `http://localhost:3000/api/...` while `npm run dev` is up.
- `sqlite3 data/focus.db` for direct inserts or a look at what a route wrote.
- `DATA_DIR=<scratch dir>` on `npm run seed` and `npm run dev` when the current DB should survive.
- The UI in the preview pane, for what only the UI shows.

Tests: pure-function tests in `shared/` and `client/src/lib`; harness tests in
`server/**/*.test.ts` for routes, validation, scoping, headers, `mergeSettings`, and migrations
(`migrate(db, upTo)` stops early so a backfill can be tested, see `server/db.test.ts`). No
temp files: `openDatabase(':memory:')`.

Limits that still hold: never commit `data/` or `.env`, and never point `DATA_DIR` outside the
repo or the session scratchpad.

## Architecture rules (do not break)

- **Anything both sides need lives in `shared/`** (`settings.ts`, `dates.ts`, `api.ts`) and is
  imported from there with a `.js` suffix. Never mirror a constant, default or type into the
  other tree; the client's `types.ts` re-exports the shared types so component imports stay
  short, and every server function that builds a response body is annotated with the
  `shared/api.ts` type it returns (`sessionRowToJson(): Session`, `dayJson(): Day`, …) so a
  field renamed on one side fails `typecheck` on the other.
- **Response headers are set only in `server/security.ts`** (applied first in `createApp`).
  The CSP is same-origin with no `unsafe-inline`, so no inline `<script>`/`<style>` in
  `index.html` and no third-party assets; React `style={{}}` props are fine (CSSOM). Changing
  it means one look at the `prod` config's console. Cookies are set only through
  `cookieOptions()` (`auth/session.ts`). Never interpolate request data or an error message
  into HTML without `escapeHtml` (see `auth/oidc.ts`). Password hashing is async
  (`scrypt`, never `scryptSync`); login verifies against `DUMMY_HASH` when the user is unknown.
- **The server stores epoch milliseconds and never decides what "today" is.** The client sends
  the local date key `YYYY-MM-DD` (`shared/dates.ts: todayKey`). The container's TZ is
  irrelevant. The one exception is `cutoffKey` in `server/retention.ts`, which turns "keep the
  last N days" into a UTC date key: the minimum is 30 days, so a day of zone slop changes
  nothing, and no user zone is known server-side.
- **Old-day deletion goes through `pruneDays` (`server/retention.ts`)**, whether from the
  Data tab's button (`POST /days/prune`) or the scheduled `runRetention`. It deletes `days`
  rows before a date key (cascades take punches, priorities, sessions), never a day with a
  running session, and never settings. The per-user setting `retention { enabled, days }` is
  capped by `RETENTION_DAYS` (`config.retentionDays`) via `effectiveKeepDays`; a user with no
  settings row still gets the cap. `reclaimSpace` (VACUUM + WAL checkpoint) runs after any
  deletion so the file actually shrinks; it must not run inside a transaction.
- **Every data query is scoped by `req.user.id`** (`currentUser(req)`). In `AUTH_MODE=none` that
  is the single `kind='default'` user. Never add a data route outside the `requireAuth` router
  in `app.ts`. `/:date` routes take `requireDate`; `/sessions/:id` routes take
  `loadOwnedSession`, which is where the ownership check lives.
- **Settings go through `mergeSettings()` on every read and write** (`server/routes/settings.ts`):
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
- **All user-facing alerts go through `client/src/lib/alerts.ts`** (`alert()`, `chime()`,
  banners). Never call `new Notification(...)` or create an `AudioContext` anywhere else.
  `unlockAudio()` must be called from a user gesture (timer start does this) for iOS.
- **Timer remaining time is derived from the server's `startedAt + plannedSeconds`** on every
  tick — never a client-side counter. `useTimer` keeps a `mutationSeq` so a slow `GET
  /sessions/running` can't overwrite an optimistic update; keep that pattern for new mutations.
- **Punch positions are fixed**: 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in
  pairs, and **the last row is always the Clock out** (an odd position ≥ 3; `normalizePunches`
  enforces it). Kind is parity (`kindForPosition`). The math evaluates *set* punches
  chronologically; `extraPairs()` only decides where the card *shows* a pair. An explicit
  Clock out that is the latest punch ends the day even if the target isn't met. "Add extra
  out / in" appends two rows, so the old Clock out becomes the new pair's Out. Lunch semantics
  come only from positions 1 and 2.
- **A punch row saves only complete times.** `TimeField` (React Aria segments) commits the
  moment hour, minute and period are all filled, and throws a half-typed draft away when
  focus leaves the field, so the row never shows a time the server doesn't have. In 12-hour
  mode the period is filled in as the hour is typed (`guessPeriod` in `lib/timefield.ts`: 5–11
  → AM, 12 and 1–4 → PM, kept after the day's clock-in), and left alone once the user has
  touched that segment. Clearing is the row's × button only. `setPunches` queues PUTs per day
  (one in flight, the newest waiting) because each PUT replaces the whole day.
- **Overtime approval (`days.overtime_approved`) silences only the `clockOut` alarm target.**
  Lunch and the second meal period stay armed: California Labor Code §512 still requires them
  on an overtime day. The setting `overtimeApproval` only shows/hides the switch and banner
  button; a flagged day is silent only while the setting is on (`App.tsx`).
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
  rollup (the review and the History calendar both fetch it, one period at a time); register
  any new literal path under `/days` before `/:date`.
- **History → Days opens on the route's date.** `App.tsx` passes `route.date` to `History`;
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
  unless the draft is gated by a dirty flag (`Priorities`, `Retro`): a ref can't be read during
  render, so there the effect form is the one the react-hooks rules allow. Callbacks that must
  read the latest value use `useLatest()`, never a ref written in render (the react-hooks lint
  enforces both).
- Static assets are public; **all data is behind `/api/*`**. The SPA fallback serves
  `index.html` for any non-API path. `/assets/*` is fingerprinted and cached immutable.
- **Migrations are append-only** in `server/db.ts` (`MIGRATIONS[]`, `PRAGMA user_version`).
  Every FK to `users` or `days` is `ON DELETE CASCADE`.

## How to add…

- **A card**: add the id to `CARD_IDS` and its default under `CARD_DEFAULT_VISIBLE` in
  `shared/settings.ts`, and its title to `CARD_TITLES` in `client/src/lib/layout.ts` (the
  types make a missing entry an error) → write the component → add a `case` in `Sheet.tsx`'s
  `render()`. Existing users get it automatically because layouts merge with the registry on
  both sides (`normalizeLayout`, `mergeSettings`), appended with that default; a card whose
  default is hidden shows up under Customize → Hidden → Show. Removing a card is the reverse
  (drop the id everywhere; both merges discard it from saved layouts), and if the card
  recorded a choice worth keeping, `mergeSettings` can read it off the old layout entry the
  way the sticker chart's `stickers` setting does.
- **A per-user setting**: add it to the `Settings` type and `DEFAULT_SETTINGS` in
  `shared/settings.ts` → validate it in `mergeSettings()` (`server/routes/settings.ts`) → add
  the control to the right tab in `SettingsDialog.tsx` (Timeclock · Alarms · Sheet · Data ·
  Account; each is a `case` in `panel()`; the Sheet tab's "History" section holds the
  calendar's switches) using `DurationField` / `MinutesField` — it takes a `unit` suffix,
  default "min" — / `Toggle`. Nothing else to mirror.
- **An alarm target** (existing: `lunchBy`, `clockOut`, `secondMeal`, `retro`): expose the instant from
  `computeTimeclock` → add a target in `useAlarms.ts` (`targets[]`, with an `armed` rule; put
  a rule the card also needs in a pure helper like `secondMealApplies`) → add its default
  under `alarms` in `shared/settings.ts` and the `AlarmId` union there → add an `AlarmEditor` in
  `SettingsDialog.tsx` → copy in `describeEvent()`: a `kicker` naming the alarm + rule
  ("X alarm · 15 min warning"), a title, and a body that says where the deadline came from
  (it gets an `EventContext`; extend that if the new target needs more inputs). A banner can
  carry one `action` button (see the clock-out alarm's "Overtime approved" and the retro
  alarm's "Open retrospective", chosen in `useAlarms` from the `AlarmDayState` callbacks).
- **A per-day field** (like `overtimeApproved`, `retroNote`/`retroAt`): append a migration adding the column to
  `days` → read it in `findDay` (`routes/shared.ts`) and return it from `GET /days/:date` →
  add a `PUT /days/:date/<field>` route (with `requireDate`) → `Day` in `shared/api.ts` +
  `client/src/api.ts` → an optimistic setter in `useDay.tsx` that goes through `persist()`
  (mirror `setOvertimeApproved`; failures reload the day and raise the "Change not saved"
  banner, so the setter never rejects) → pass it from `Sheet.tsx`
  to the card, and from `App.tsx` into `useAlarms` if alarms depend on it.
- **An API route**: put it on the `api` router in `app.ts` (behind `requireAuth`), scope by
  `currentUser(req).id` (`requireDate` / `loadOwnedSession` where they fit), validate input,
  return `{ error }` JSON on failure → add the call to `client/src/api.ts` and the response
  type to `shared/api.ts` (annotate the server builder with it) → cover it in that router's
  `*.test.ts`: happy path, each 400, and that another
  user gets a 404/empty result (the scoping test is not optional). If the seed should carry
  the new field, add it to `server/dev/seed.ts` and its manifest.
- **A schema change**: append a migration string to `MIGRATIONS` in `db.ts`. Never edit an
  existing entry.
- **A response header or CSP source**: `server/security.ts` only, then the `prod` config check.

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. Named exports. Server and shared imports
  end in `.js`. `npm run lint` must pass; `_`-prefixed names are the only allowed unused vars.
- CSS: tokens on `:root` in `client/src/styles.css`, dark mode via `prefers-color-scheme`,
  **mobile-first** (base = phone; `@media (min-width: 640px)` enhances). Tap targets ≥ 44 px
  (`.btn`, `.input` set `min-height: 44px`). Inputs are 16 px so iOS doesn't zoom. No external
  fonts or assets (the CSP would block them anyway). Safe-area insets via `--safe-top` / `--safe-bottom`.
- Numeric settings inputs commit on blur/Enter (never on every keystroke); priorities debounce
  400 ms; punches and checkboxes save immediately.
- Comments explain *why* (browser quirks, math), not what.
- No new runtime dependency without stating the reason in the commit message.
- **Copy**: phrases the app says (celebrations, gentle warnings, confirms, the timer-done
  alert) live in `client/src/lib/copy.ts`, never inline. Write them plainly and check new
  ones against Wikipedia's "Signs of AI writing"
  (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing): no "not just X, but Y", no
  rule-of-three flourishes, no em-dash chains, no "Gentle reminder:" / "Deep breath." openers,
  no cheerleading, no puffery words. Short, dry, specific.

## Verification expectations

Prove a change at the cheapest level that can show it, and stop there:

1. Pure functions (`shared/`, `client/src/lib`): a unit test.
2. Anything in `server/`: a harness test in the router's `*.test.ts`. Route behavior,
   validation, scoping, headers, persistence and migrations are proven here, never by clicking.
3. One-off looks at live data: `curl` against the seeded dev DB.
4. The browser, only for what the API cannot show: how a card renders, drag/drop, banners
   and alarms firing, the timer bar, light/dark, the 375 px pass. Run `npm run seed` first
   (with `--running` for timer work) so the pass starts with data. Scope it to the surface
   you touched; one pass at the mobile preset is enough unless the change is desktop-only
   layout. Do not re-walk flows a test already covers.

- `npm test` green, `npm run typecheck` clean, `npm run lint` clean.
- If you touched CSS or a component: walk the touched surface at the 375 px mobile preset
  (and desktop width if the change has a desktop-only branch); check light and dark.
- If you touched `security.ts`, `index.html`, or how assets load: run the `prod` config and
  read the console for CSP violations; `curl -sI localhost:8090/api/health` shows the headers.
- If you touched the timer or alarms: reload mid-timer, background/foreground the tab, and let a
  short timer expire — the log must show the planned duration and one chime.
- If you touched punches: walk a pair added before lunch, an early Clock out (done +
  celebration), "Add extra out / in" after it (old Clock out becomes Out N), and removing that
  pair (time returns to Clock out). For the time field: clear Clock in, press `0` `7` `3` `0`
  (the hour advances, the period fills, the tiles move with no further key), `p` flips it, ↑/↓
  on a segment saves each step, and a half-typed row reverts when you click away. In the
  browser pane send single `key` presses; the `type` action pastes the whole string into one
  segment.
- If you touched alarms: with "Overtime approved" on, the clock-out banner must stop and the
  lunch tile must keep counting down. The retro banner must still fire, and "Mark reviewed"
  must clear it without a repeat.
- If you touched priorities or the timer: tick one row and press Add priority (the notice
  lists the ticked row); tap a chip in the timer, start, and the log row shows the number;
  "Also add to today's priorities" fills the first empty row; reassign a log row via its select.
- If you touched the retro or review: `retro.test.ts` / `review.test.ts` prove the split and
  the rollup; the browser check is one look at a seeded day's retro card and at History →
  Review → Week (`--quarter` for Month / Quarter).
- If you touched the History calendar: `calendar.test.ts` proves the grid and `review.test.ts`
  the `periodOffset` round trip; the browser check is one month at the mobile preset (◀ to a
  seeded month, tap a day, **Open day** and back through the header, **Review this week** lands
  on that week). With the sticker chart on (Settings → Sheet → History, or `PUT /api/settings
  {"stickers":true}`): the count line, a chip narrows the grid to one sticker and a second tap
  clears it. With Show weekends off: five columns, and a seeded weekend day's stickers leave
  the counts.
- If you touched retention: `server/retention.test.ts` and the `/prune` block in
  `days.test.ts` prove the cutoff, the cap, the running-session guard and the cascade; the
  browser check is one look at Settings → Data (count line, toggle saves), with the delete
  itself driven by curl (`POST /api/days/prune`) because of the confirm dialog.
- If you touched auth: `server/auth/local.test.ts` covers setup, login, the limiter, password
  change (which revokes other sessions) and admin user management; no browser pass needed.
- If the change is visible in a README screenshot (sheet, retro, review, settings), run
  `npm run screenshots` and commit the PNGs that changed.

## Gotchas

- `better-sqlite3` is native. Since v13 it bundles N-API prebuilds for every platform the
  image can run on (including linux-musl), so no compiler toolchain is needed, but its
  `binding.gyp` still makes npm try `node-gyp rebuild`; the Dockerfile runs
  `npm ci --ignore-scripts` so the prebuild is used regardless of which npm version (11 or 12)
  is in the base image and how it applies `allowScripts`. Docker is verified only in the
  deployed environment, not on the dev Mac (no Docker here); the `edge` image build on CI is
  the earliest signal.
- The preview harness exports `PORT=5173`; that's why `dev:server` pins `PORT=3000` and the
  `prod` config pins `PORT=8090`.
- `client/public/sw.js` is intentionally a pass-through service worker (installability only).
  Do not add caching without a versioning strategy or users will see stale assets.
- `vite.config.ts` imports `defineConfig` from `vitest/config` so the `test` block type-checks.
- OIDC: `APP_URL` must match the redirect URI registered in Authentik exactly
  (`${APP_URL}/auth/callback`); the callback reconstructs its URL from `APP_URL`, not from
  request headers, so it works behind proxies.
- `TRUST_PROXY` is documented as a hop count (`1`), never `true`: `true` trusts the leftmost
  `X-Forwarded-For`, which the client controls, and the login limiter keys on `req.ip`.
- scrypt needs `maxmem` above Node's 32 MB default at N=2^15 — already set in `password.ts`.
  `DUMMY_HASH` is computed at import with a top-level `await`, so `password.ts` is ESM-only.
- `window` `focus` events fire on ordinary clicks in some embedded browsers; timer re-sync is
  throttled and seq-guarded for that reason. Don't add unthrottled focus-driven refetches.
- `npm version` without `--no-git-tag-version` tags the branch commit, which is not the squash
  commit that lands on `main`; the release checklist tags `main` after the merge for that reason.
- Prettier is not configured: the tree was never consistently formatted, so a `--check` would
  touch most files. Match the surrounding style by hand.
