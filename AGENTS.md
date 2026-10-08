# Clockspan — agent guide

## What this is

A self-hosted, single-day **focus sheet** for working through a workday with ADHD: a punch-style
timeclock (lunch deadline, end of day, celebration), top priorities (default three, with a
nudge when the list grows), a focus timer that logs what was done and for which priority, a
retrospective card (plan vs. log, a "why" note, a nudge before clock-out), a week / month /
quarter review, alarms for lunch, clock-out and the second meal period, and an optional Board
page for tasks that aren't for today (off by default; its In progress column is today's Top
priorities, and its cards carry categories, made from a card's chip or in Settings → Board).
"Overtime approved" silences the clock-out alarm only. Every day is persisted; old days can be
pruned. Data is **per user**; auth is optional (`AUTH_MODE=none | local | oidc`). One Docker
container, SQLite on `/data`. A PWA used mostly on a laptop or desktop and laid out for phones
too. Meal-period defaults follow California rules; three switches (meal periods, overtime,
hours) turn off what doesn't apply to exempt or salaried work. The README has the user-facing
description.

## Stack & versions

- Node **24** (`.nvmrc`, so a bare `nvm use`; `node:24-alpine` in Docker). `devEngines` in
  `package.json` makes npm refuse `install`, `ci` and `run` on an older Node.
- Client: React 19, TypeScript 7 (the native `tsc`: the `typescript` package has no `tsserver` or
  JS API, so editors need the native TypeScript extension, and `npm run typecheck` is the source
  of truth), Vite 8. `@dnd-kit/sortable` for drag/drop (loaded on the first Customize, and with
  the board); `react-aria` + `react-stately` + `@internationalized/date` for the punch time
  field. No router (the date, the view (the sheet, History or the board) and the review period a
  day was opened from live in the URL query, `hooks/useRoute.ts`; today is `date: null`, so a
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
  settings.ts           Settings, DEFAULT_SETTINGS, CARD_IDS, DEFAULT_SIDE (each card's column), normalizeLayout,
                        MAX_PRIORITIES, SETTING_LIMITS, RETENTION_LIMITS
  api.ts                every wire type and `emptyDay`; the server's JSON builders and client/src/api.ts both use them,
                        the input limits both sides check (LIMITS, USERNAME, PASSWORD_LENGTH), the board's
                        lanes (LANES), the server's caps on it (BOARD_LIMITS) and the category colours
                        (CATEGORY_COLORS)
  sounds.ts             the sound catalog (SOUNDS, SOUND_EVENTS)
  dates.ts, timer.ts    date keys; pause-aware session timing (activeMs, plannedEndAt, pausedSecondsAfter,
                        PLANNED_SECONDS)
  punches.ts            kindForPosition: a punch row's kind is its position's parity; punchesKey: a list's
                        rows and times as one string; samePunches compares two lists by it;
                        MAX_PUNCHES (the server's row cap; the card hides Add extra out / in at it)
  priorities.ts         hasText; isFree (a row never written in, where a new priority may go); mergePriorities:
                        a priorities save laid onto the stored list as the changes made since its base,
                        field by field as MERGED lists ('merge' or 'fixed'); sharesLink (two rows on one
                        card or recurring priority); repeatedLink (what the PUT refuses); the merge's
                        clean-up, dedupeLinks (one text row per link) and dropShadowedLinks (an emptied
                        row loses a link a text row holds)
  text.ts               sameText: the key the same text typed twice is matched by, and category names are
                        compared by; categoryName: a category's name as the server stores it
  backoff.ts            nextBackoff: the wait between retries of a request that must answer
server/                 Express API → dist/server
  app.ts                createApp(): headers, /api/health, /api/auth/me for every mode, auth routers,
                        data routers behind requireAuth, static files and the SPA fallback;
                        startBackgroundJobs() (the login purge, the retention schedule and, under
                        OIDC, warming the `Discovery` index.ts passes in; started by index.ts only)
  security.ts           every security header, rejectCrossSiteWrites and rejectUnknownHosts
  config.ts, db.ts      env parsing (throws on bad config); pragmas, MIGRATIONS, the default user
  settings.ts           mergeSettings (defaults + validation on every read and write), loadSettings
  board.ts              the board's cards as stored: boardJson (listDate and held read from the rows;
                        the categories and the recurring priorities), weekdayMask / weekdaysOf (a
                        recurring priority's weekdays to the table's mask and back), placing and
                        renumbering, and mirrorCards (the cards following a priorities save)
  retention.ts          old-day pruning (pruneDays, runRetention, the RETENTION_DAYS cap)
  validate.ts           isWholeNumber: the one check for every bounded whole number the server takes;
                        isOneOf: a value from a fixed list (a setting's choices, a category's colour)
  refuse.ts             refuse(): sends an ErrorResponse; every API refusal but the timer-start 409 goes through it
  auth/                 session cookie, scrypt passwords, the login limiter, publicUser/logName (users.ts),
                        middleware (currentUser), local + OIDC routes, resetPassword (reset.ts: what the
                        reset-password command does)
  routes/               the days, sessions, breaks, settings and board routers; shared.ts has findDay,
                        ownedRouter (rows of a day, by id), uidRouter (rows of a user, by uid) and the
                        session and break row → JSON builders (dayJson is in days.ts)
  dev/                  seed.ts + seed-cli.ts (`npm run seed`), harness.ts (startTestApp for route tests)
  index.ts, cli.ts      the process entrypoints: the server (warns under AUTH_MODE=none), reset-password
                        (reads the arguments and prints resetPassword's answer)
client/                 Vite root → dist/client
  public/               manifest, sw.js, icons/icon.svg (the icon's one source; `npm run icons` renders
                        the PNGs next to it)
  src/App.tsx           Shell (route, settings dialog) inside AppProviders (hooks/AppProviders.tsx); today's
                        alarms are hooks/useTodayAlarms.ts
  src/api.ts            fetch wrapper (30 s timeout; UNAUTHENTICATED_EVENT on a 401 from anything but login and
                        /me; throws lib/apiError.ts's ApiError, which a caller checks with instanceof);
                        src/types.ts re-exports the shared types (types only)
  src/lib/              logic with no React, a test beside each file (the browser-facing ones stub the
                        globals, as alerts.ts does; apiError is covered through api.test)
    optimistic.ts       a server copy plus pending changes, which the stores are built on, and `serial()`,
                        their write queue
    alerts.ts           the one place that plays sound, shows notifications and pushes banners
    copy.ts             every line the app raises at the user; no logic
    storage.ts          localStorage that never throws (private mode, quota); the per-user keys (USER_KEYS:
                        fired alarms, Start fresh, the break-over mark, the capture box's category) and
                        adoptUser, which records who the app is open for under AUTH_USER_KEY and drops
                        the last user's keys
    board.ts            the board's columns from the cards and today's rows (boardColumns), what a move
                        does and which store it writes (planMove, moveTargets, MoveRefused), where a drop
                        lands and what a drag says (dropTarget, withDrag, overAnnouncement,
                        moveAnnouncement), the cards the left-open offer may bring back
                        (offeredLeftovers), the category chip's data (CategoryPick) and what New
                        category makes of a name (categoryForName, nextColor, categoryNameTaken), and
                        the board as a write shows it (withCard, withPatch, withoutCard, withCategory,
                        withCategoryPatch, withoutCategory)
    popover.ts          placePopover: where the category chip's list goes on screen (under the chip or
                        above it, inside the viewport)
  src/hooks/            state and effects (useDay, useTimer, useSettings, useBoard, useAlarms, …), each
                        with a happy-dom test beside it (useLatest is covered through the hooks that use
                        it, and AppProviders through the tests that render it).
                        useClock is the app's one 1-second clock; useSaveStatus
                        (Saving… / Saved / Not saved) serves the settings dialog; useBoard is the
                        board's store (BoardProvider, its refresh and the daily sweep) and
                        useCategoryPick, the category chip's data and inline create; useMediaQuery
                        follows a media query for behaviour (the capture box's autofocus, the board's
                        drop glide under reduced motion).
                        src/test/fixtures.ts has the plain factories and TEST_SETTINGS (no React);
                        src/test/hooks.tsx re-exports fixtures.ts and AppProviders and has
                        SettingsAndDays, serveRange (a mocked getRange that answers from a list of
                        days) and the act() helpers
  src/components/       the cards, History (Calendar + Review), Banners, FinishChoice, and the pieces
                        several of them share (Folded: a long list's Show all; CategoryChip, the one
                        category picker, and CategoryDot); settings/ holds SettingsDialog (the shell
                        and tabs), a file per tab (BoardTab: the categories, shown while the board is
                        on), and controls.tsx; board/ holds the Board page (Board, BoardCard, Capture,
                        and dnd.ts: its collision and keyboard settings for dnd-kit), its own lazy
                        chunk
  src/auth/             AuthGate and the setup / login / new-password pages
  src/sounds/           bundled CC0 clips; the README.md there is the only record of their sources
  src/styles.css        design tokens and all component CSS
scripts/                screenshots.mjs and icons.mjs (headless Chromium via browser.mjs), smoke-image.sh
docs/screenshots/       the PNGs the README and the Unraid template embed, dark theme only (the
                        light one is checked in the browser pass, not pictured; sheet-desktop.png
                        is the template's alone)
Dockerfile, docker/     the image; entrypoint.sh owns /data as PUID:PGID and drops root
unraid/clockspan.xml    the Unraid template, a field per .env.example variable (config.test.ts checks);
                        Unraid reads it from main, so an edit reaches users when it merges
ca_profile.xml          the Community Apps profile. Both XML files link client/public/icons/icon-512.png
                        by raw URL on main; the template also links its own path (TemplateURL) and
                        three shots (sheet-phone-dark, sheet-desktop, history). Moving or renaming
                        any of those breaks the listing
.github/workflows/      ci.yml (check, image-smoke, image, release), codeql.yml, workflow-lint.yml (zizmor)
```

## Commands

```bash
nvm use                # reads .nvmrc (24)
npm install
npm run dev            # API on :3000 (tsx watch, PORT pinned) + Vite on :5173 (proxies /api, /auth)
npm test               # vitest: shared + client lib + hook + component tests + server API tests
npm test -- server/routes/days   # one file
npm run test:coverage  # the gate CI runs (scope under "Verification expectations"); lists only files short of 100%, full report in coverage/index.html
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

Start from `npm run seed`, not an empty DB (`server/dev/seed.ts`). A run deletes every day,
board card, category and recurring priority of the user it seeds, hand-made ones included, then
writes the last 10 weekdays and today. Each past weekday takes a template by its distance back
(`kindForDistance`): the last weekday has an extra out/in pair in the afternoon and a priority
added mid-day (the README's retro shot), then come a normal day, an overtime day (approved,
10 h 15 m worked, with the second meal taken as an out/in pair after lunch), an unreviewed day
(a note written but never marked reviewed, and a cancelled session) and a half day with its own
4 h 30 m work day and no lunch punched. Further back the templates recur at fixed intervals, so
the default 10 are three normal days, two each of the extra pair, overtime and unreviewed (two
cancelled sessions in all) and one half day. Every past day has two to four one-off priorities,
then a row for each recurring priority due on its weekday (below), and a note. Today is clocked
in two hours before *now*. Its three priorities were planned two minutes after the last
weekday's review, with that day's first open one-off row carried to position 1 (a row of its
own, with its own uid) and the second row ticked; its log has a 50-minute session for the
ticked row, an unplanned one paused for eight minutes and finished three minutes short of its
25, a full break and one cut short. The board holds what saves with the board on would have made
of the last weekday's and today's one-off rows (`insertBoard`), each row linked by its `cardUid`:
open rows in Next, ticked ones in Done, all untouched, and today's carried row on the same card,
in the same category, as its source row. Four cards were captured on the board: three in Later
("Write a KB for the SSO reset", "Review canned replies", "Look into the export timeout") and
one at the end of Next ("Follow up on the Acme SLA"). The board has four categories
(`SEEDED_CATEGORIES`: Tickets, Follow-ups, Knowledge base, Admin), and each sample text counts
under the same one on every day (`CATEGORY_OF`): most rows and their cards have one, two (a call
to the bank, a colleague's pull request) have none, the captured cards have one, and so do the
unplanned "Inbox" sessions (Tickets), the only sessions with a category of their own. The board
has two recurring priorities (`SEEDED_RECURRING`): "Monitor the queue" Monday to Friday, under
Tickets, and "Follow-ups" on Monday, Wednesday and Friday, under Follow-ups. Each past weekday
lists the ones due on it after its one-off rows, written with the list (`routineRows`), linked by
`recurringUid`, in the item's category and on no card: the queue is ticked, with a 25-minute
session, on every template's day but the unreviewed one; the follow-ups are ticked, with a
25-minute session, on normal and overtime days and left open on the rest. Today lists none, and
a routine left open is never the row carried over to it. The seed writes no settings, so the
board is off on a new dev DB or after `--fresh`; this turns it on:
`curl -X PUT localhost:3000/api/settings -H 'content-type: application/json' -d '{"board":true}'`.

`--running` leaves a 25-minute timer running, started ten minutes before *now*, for timer work;
`--quarter` seeds every weekday since the start of last quarter, for Month / Quarter review
(`--days N` for another count); `--now HH:MM` pins *now* to that time of day; `--today
YYYY-MM-DD` moves the whole sample to that date at the current time of day (or `--now`'s);
`--fresh` also deletes the seeded users' settings and logins. Under `AUTH_MODE=local` (or
`--auth local`, which stands in for the env var) it creates `admin` and `sam` (password
`clockspan-dev`; `sam` gets at most three past days and no timer); under `oidc`, one "Dev
User". `--sessions` signs every seeded user in and prints a `document.cookie = 'fs_session=…'`
line per user: run it in the page and reload to be that user, with no password typed and no
provider. A run never deletes users and is safe while `npm run dev` is up (reload the page).
`npm run screenshots` reseeds the dev DB and resets the default user's settings (see the
script's header).

The seed and the server migrate the file when they open it, so a new migration needs nothing
done by hand. To look at or change the dev DB directly: `curl` against
`http://localhost:3000/api/...` while `npm run dev` is up, or `sqlite3 data/focus.db` for direct
inserts or to see what a route wrote. To keep the current DB, run `npm run seed` and
`npm run dev` with `DATA_DIR=<scratch dir>`, never pointed outside the repo or the session
scratchpad. The level a change is proven at is under "Verification expectations".

## Architecture rules (do not break)

- **Anything both sides need lives in `shared/`** (`settings.ts`, `dates.ts`, `api.ts`) and is
  imported from there with a `.js` suffix. Never mirror a constant, default or type into the
  other tree; the client's `types.ts` re-exports every type of `shared/settings`, `sounds` and
  `api` (`export type *`, no list), so component imports stay short; constants and helpers, the
  date helpers (`addDays`, `todayKey`, `MINUTE_MS`, …) included, come straight from `shared/`,
  never through another module (a constant read through `types.ts` fails `typecheck`). Every
  success body has a `shared/` type
  (one in `api.ts`, or `Settings`); a failure is `ErrorResponse` (`{ error }`, whose message
  the client throws), sent through `refuse()` (`server/refuse.ts`); the timer-start 409 is
  `SessionConflict`, which extends it with the running session and is the one refusal sent
  without `refuse()`. Builders are annotated with these types
  (`sessionRowToJson(): Session`, `dayJson(): Day`, …) and each route's answer names its
  envelope with `satisfies` (`res.json({ deleted } satisfies PruneResult)`), while
  `client/src/api.ts` reads the same types, so a field renamed on one side fails `typecheck`
  on the other. Server-only row types (a day's rows in `routes/shared.ts`) take their unions
  from there too (`PunchRow.kind` is `Punch['kind']`); `UserRow.kind` follows the users
  table's CHECK, since no wire type carries it.
- **Security headers are set only in `server/security.ts`** (applied first in `createApp`):
  the CSP, `nosniff`, framing, referrer, HSTS and the API's `no-store`. The CSP is same-origin
  with no `unsafe-inline`, so no inline `<script>`/`<style>` in `index.html` and no third-party
  assets; React `style={{}}` props are fine (CSSOM). The request guards live there too, each
  with a doc comment on what it refuses and why: `rejectCrossSiteWrites` is mounted on `/api`
  before `resolveUser`, so keep write routes under `/api`; `rejectUnknownHosts` is mounted
  under `AUTH_MODE=none` only, on `/api` after `/api/health`, and reads the raw `Host` header,
  never `req.hostname`. Headers that describe one answer stay with the code that sends it: the
  static files' `Cache-Control` in `app.ts` and `Retry-After` in `refuseTooMany`
  (`auth/limiter.ts`).
- **Cookies, sessions and passwords stay in `server/auth/`.** A request's cookies are read only
  through `readCookie()` (`auth/session.ts`), and `Set-Cookie` is written only through
  `cookieHeader()` there; outside `server/dev/` (the test harness's cookie jar) no other module
  imports `cookie`. The session is resolved under `/api` only, so a static answer, which is
  publicly cacheable, never carries a cookie. The HTML the server writes itself (the OIDC error
  pages in `auth/oidc.ts`) is fixed text: no request data or error message goes into it, and the
  cause goes to the log. Password hashing is async (`scrypt`, never `scryptSync`); login
  verifies against `DUMMY_HASH` when the user is unknown.
- **Another user means another page.** Once `AuthGate` has opened the app for a user, it never
  swaps a gate page in over it: the stores' write queues, the drafts (which save on unmount),
  the banners and the tab title would carry on under the next session's cookie. Sign-out
  navigates away (to `/`, or the provider's end-session URL), and an `/api/auth/me` answer
  that no longer opens the app for that user (no one, a temporary password, someone else)
  reloads the page. Other tabs follow `localStorage['focus:auth-user']`, which `adoptUser`
  (`lib/storage.ts`) writes from each answer the gate shows and before a sign-out leaves,
  dropping the last user's `USER_KEYS` when it changes: a tab whose user it no longer names
  reloads, checked on the `storage` event, when the tab is shown again and when the bfcache
  brings it back. Once the page is leaving, `refresh` asks nothing more, so a late 401 can't
  turn a sign-out into a reload. A gate page whose re-read of `/me` failed shows the "Can't
  reach the server" card, whose Retry reads again instead of sending the form twice.
- **The server stores epoch milliseconds and never decides what "today" is.** The client sends
  the local date key `YYYY-MM-DD` (`shared/dates.ts: todayKey`). The container's TZ is
  irrelevant. The one exception is `cutoffKey` in `server/retention.ts`, which turns "keep the
  last N days" into a UTC date key: the minimum is 30 days, so a day of zone slop changes
  nothing, and no user zone is known server-side.
- **Old-day deletion goes through `pruneDays` (`server/retention.ts`)**, whether from the
  Data tab's button (`POST /days/prune`) or the scheduled `runRetention`. It deletes `days`
  rows before a date key (cascades take punches, priorities, sessions, breaks), never a day with a
  running session, and never settings, categories or recurring priorities. The Data tab sends it
  through the day store's `pruneBefore`, which reads the held days before the cutoff again and
  moves `generation`, so the ranges on screen ask again. The per-user setting
  `retention { enabled, days }` is capped by `RETENTION_DAYS` (`config.retentionDays`) via
  `effectiveKeepDays`; a user with no settings row still gets the cap. The same prune takes the
  board cards done before the cutoff and the untouched cards (made by a priorities save, never
  handled on the board) that no row is linked to any more, which would otherwise show again once
  their emptied row's day was gone; it answers both counts (`Pruned`), and `POST /days/prune`
  reports the days; the Data tab reads the board again after its delete while the board is on.
  `reclaimSpace` (VACUUM + WAL checkpoint) runs after a prune that deleted a day or a card and
  after an admin deletes a user (`DELETE /api/auth/users/:id`), so the file shrinks and deleted
  text does not stay in free pages; it must not run inside a transaction.
- **Every data query is scoped by `req.user.id`** (`currentUser(req)`). In `AUTH_MODE=none` that
  is the single `kind='default'` user. Never add a data route outside the `requireAuth` router
  in `app.ts`. Every `/:date` route sits on the days router (`routes/days.ts`), whose `date`
  param handler (`router.param`) answers 400 for anything but a real `YYYY-MM-DD`, so a route
  added there is checked with nothing to list. Register a literal path under `/days` (like
  `/range`, `/prune`) before `/:date`. The session and break starts are registered
  there with handlers from their own files. The `/sessions/:id` and `/breaks/:id` routes
  sit on a router made by `ownedRouter()` in `routes/shared.ts`, which is where the ownership
  check lives: it is that router's `id` param handler (`router.param`), so every route on it
  with an `:id` is checked, one added later included, with nothing to list on the route. It
  answers 404 for another user's row or none, and the handler reads the row with `owned(res)`.
  A table whose rows hang off the user rather than a day and are named by a uid (the board's
  cards, `/board/cards/:uid`, categories, `/board/categories/:uid`, and recurring priorities,
  `/board/recurring/:uid`) gets the same from `uidRouter()` beside it, as the router's `uid`
  param handler: the uid's shape is checked, it is matched lowercased, and anyone else's or none
  is a 404.
- **Settings go through `mergeSettings()` on every read and write** (`server/settings.ts`):
  the stored JSON is merged onto `DEFAULT_SETTINGS`, unknown keys are dropped, invalid values
  fall back, and a PUT stores the whole merged object, so a key added since a user's last save
  takes the current default while a value they saved stays put. The merge goes field by field
  through `alarms`, `sounds` and `retention`, so the client sends only what it changed
  (`SettingsPatch` in `client/src/api.ts`), down to one alarm's field, and a save on one device
  never writes its stale copy of the rest over another device's change; lists (`timerMinutes`,
  `layout`) go whole. A changed default of an existing key reaches only users with no row (a
  new user, or one who used Reset all settings). A change that must reach the others needs a
  `mergeSettings` rule that reads the stored value (as `stickers` reads the old layout), and
  that rule can't tell a value left at the old default from one the user chose. Add settings by
  adding a default (shared) + validation there, never by migrating rows. `DELETE /api/settings`
  drops the user's row, which is what "Reset all settings" does.
- **Timeclock math lives only in `client/src/lib/timeclock.ts`; alarm scheduling only in
  `client/src/lib/alarms.ts`.** Both are pure functions of `(inputs, settings, now)` with tests.
  Components and hooks never re-derive these. A stored day goes through `dayTimeclock`: its own
  length through `daySettings`, then `clampToDay` (`now = min(now, endOfDay)`) and
  `{ frozen: true }` once past.
- **Times are written through `useTimeFormat()`** (components) or `formatTime(ms, hour12)` with
  an explicit `hour12` (pure libs: `describeEvent` takes it on `EventContext`). The setting is
  `timeFormat: 'auto' | '12h' | '24h'`; `resolveHour12('auto')` asks the browser locale, so the
  default changes nothing for anyone. `TimeField` shows its AM/PM segment from the same answer.
- **All user-facing alerts go through `client/src/lib/alerts.ts`** (`alert()`, `playSound()`,
  banners). Never call `new Notification(...)` or `showNotification()` (its fallback where the
  constructor is refused, Chrome on Android), create an `AudioContext` or fetch a clip
  anywhere else. `unlockAudio()` must be called from a user gesture (the timer card's start
  buttons, `useBreak`'s `start` and every punch commit do this) for iOS. What plays is
  `settings.sounds[event]`, an id from the catalog in `shared/sounds.ts`;
  `settings.sound` is the master switch over all of them, and
  `none` is the per-event off. A celebration (day complete and work week reached in
  `Timeclock.tsx`, a priority ticked in `Priorities.tsx` or on the board (its checkbox, Move to
  Done, or a drop into Done), the next day planned in `PlanNext.tsx`) is a
  `useCelebration(moment, event)` (`hooks/useCelebration.ts`): the sound
  under `settings.sound`, the burst under `settings.celebrations`. A state's moment comes from
  `useBecameTrue`, so it is the day *becoming* done while the card is mounted, never a done day
  opening. The work-week moment is null until `loaded`, because its target is a setting; the day
  moment needs no wait, because done depends on the punches and the clock, never on the
  settings. The sound plays after the render, so a moment set by a tap calls `unlockAudio()` in
  that handler first.
- **Timer remaining time is derived from the server's `startedAt`, `plannedSeconds` and pauses**
  on every tick (`timerView()` in `client/src/lib/timer.ts`, on `shared/timer.ts`) — never a
  client-side counter. A paused session is still `status = 'running'` with `pausedAt` set;
  `pausedSeconds` holds the pauses that have ended, and the planned end moves forward while
  paused. A finish while paused ends the session where the pause began, and a pause left for
  `PAUSE_LIMIT_SECONDS` (an hour) is finished by the client with a quiet banner. **A timer that
  runs out is not finished at once**: it is `due`, announced once per (session, planned end) —
  `dueKey`, kept in the page and in `localStorage['focus:timer-due']` so a reload shows the
  banner again without a second chime — and waits `DUE_GRACE_SECONDS` (10 min) for an answer
  before the auto-finish (which chimes only if nothing has for that end). The banner goes while
  a press that took it away is on its way, and comes back, quietly, if that press fails. While
  due the countdown shows the overrun as a negative number, +N minutes (`adjust(N * 60)`; it
  takes seconds) is N minutes from now, `finish()` logs the planned length (the server's clamp)
  and `finish(true)` sends `countOverrun` so the time past the end is logged too. Plans are
  whole minutes: `adjust` rounds the new plan up to one and stops at `PLANNED_SECONDS.max`
  (8 h), where `canAdd` turns false, + is disabled and the "Time's up" banner drops its Add button.
  The Finish buttons call `requestFinish()`: it finishes unless the timer is due and the planned
  and worked lengths differ in their whole minutes (a minute or more over), where `finishChoice`
  opens the `FinishChoice` sheet (Planned · Nm / Worked · Mm / Back). `lib/timer.ts` holds these
  rules: `timerView` (which derives `countdownSeconds`, `canAdd` and `asksLength`) and
  `adjustedPlan` (the new plan, `'finish'`, or nothing for + at the longest plan). A finish goes
  out behind any press still on its way. The choice belongs to the due end it was asked for
  (`finishChoiceFor`, a `dueKey`): once the timer is no longer due at that end (time added or a
  pause, here or on another device, or the session ending however it ends), the sheet goes and
  stays gone. The bar and the log's running row edit the session through `useTimer().edit`, so
  their writes share its queue and both show the edit. `useTimer` keeps the running session the
  way the day store keeps a day: a press (adjust, edit, pause, resume) shows at once, a failure
  drops only that press, and a sync's answer never hides a press still on its way. Keep that
  pattern for new mutations.
- **One running session per user is a schema invariant** (a unique partial index), and another
  device may own it: a 409 on start is adopted with a banner, a sync whose answer differs from
  the session shown refreshes that day if the store holds it so the log catches up (a day it
  doesn't hold loads with the row when it is opened), a 404/409 on any press on the
  running session re-syncs at once (the loop's `runNow`: a sync sent after the refusal, chained
  behind any sync already out and counted for the throttle), and the completion chime only
  plays when the server says `completed`.
- **Nothing alerts before the settings have loaded.** The timer's two alerting effects and the
  break-over alert (`useBreak`) wait for `useSettings().loaded`, or an alert raised on load
  would use the default sound and switch; the alarms (`useTodayAlarms`) wait for it the same
  way (the punches they judge stay null until `loaded`), or a longer work day than the default
  would ring the clock-out alarm on load. So `loaded` only turns true on a real answer: a
  failed `GET /settings` is retried (`nextBackoff` in `shared/backoff.ts`: 2 s doubling to a
  minute), never settled with the defaults. After the first answer the settings are fetched
  again on `useRefreshLoop`, like today's day, since another device may change them.
- **Today's day is kept in step with the server** (`useRefreshDay` in `useDay.tsx`, on
  `useRefreshLoop`: every minute and when the tab comes back, throttled to 5 s per caller), so
  the alarms in `useTodayAlarms` judge the server's copy of the punches, not one from hours ago;
  they wait while a come-back refresh is out. A today whose first load failed is loaded again on
  the same ticks (no second banner), so its alarms come back with the server. Any day the store
  holds is also read again each time a view shows it (`useDay`; one whose first load failed is
  asked for again then, quietly), and a range read (`store.readRange`) lands on the held days in
  it under the same `version` rule.
- **The day store keeps the server's copy and this device's changes apart**
  (`lib/optimistic.ts`): each day is its confirmed copy plus the changes not confirmed yet, and
  the sheet shows the one laid over the other. The confirmed copy is the server's answers in the
  order they arrived (a read's copy with each save's answer laid on it), so it is not always
  what the server holds now: a save's answer can be older than a read that landed first. A
  failed write just drops its change, so the screen is back on the confirmed copy at once (with
  the "Change not saved" banner), and the day is asked for again. A writer off the Priorities
  card (the board) changes a list through `editPriorities(date, fn, touched)`: `fn` gets the
  rows the store shows now (`current()`), padded, and it answers `'saved'`, `'notLoaded'`,
  `'skipped'` (`fn` gave null) or `'failed'`, never rejecting. It saves through the same send as
  `setPriorities` and `addPriority`, so a save that takes off a row with a category a session
  was logged on reads the day again whichever of them sent it (`leavesCategory`). `shown(date)`
  is the day as it shows now, for a board job reading the list again after an await. A delete or
  a break's end the server answers 404 for counts as done: another device removed the row
  already. A read's answer replaces the confirmed copy and never a change still on its way. It
  is stale when the server confirmed a change after the read went out (`version`): a day read
  then drops it (a day never loaded takes it anyway) and asks for the day again, whoever sent
  the read, while a range read's stale day is left to the next read. An answer the same as the
  confirmed copy changes nothing, so a day that didn't change keeps its identity. A day not
  loaded yet keeps its changes until the server's copy arrives, so nothing made up stands in for
  it. `pruneBefore` is the one store write sent on no queue (the queues are keyed by day,
  session and breaks), so a change still on its way for a day before the cutoff can land after
  the prune and re-create that day, which the re-read after the prune shows. The day store,
  `useSettings`, `useTimer` and `useBoard` are all built on `useTracked`
  (`hooks/useTracked.ts`); a board write rejects when it fails, like a settings save, and the
  board is read again. `apply` and commit functions are pure: read the clock outside them. The
  board's move handlers are built in its render and passed down to its cards, where the React
  Compiler's purity lint refuses `Date.now()`, so a row the board places on today's list is
  stamped `addedAt` by the store as it goes out.
- **Suggested break lengths come only from `client/src/lib/breaks.ts`** (`suggestBreak`,
  pure, over a day's sessions: a fifth of the session, a long break for the fourth in a row, a
  15-minute gap restarts the count); with Suggest breaks off the Break button runs
  `settings.breakMinutes`. With `suggestBreaks` on, `useBreak` offers today's suggestion on the
  Break button and as a quiet banner off `useTimer().finished`, which only a finish by hand
  sets (Finish, the finish choice, − past the time worked), never the auto-finish or another
  device.
- **A break is a row in the day's log** (`breaks` table, `Day.breaks`), never device state.
  `ended_at` is the planned end from the start and moves back when the break is ended early
  (`POST /breaks/:id/end`), so nothing finishes a break that runs out: it is running while
  `endedAt` is ahead of now (`runningBreak`), and one that ended before its planned end was cut
  short, which is why only a full-length break rings "Break's over" (once per break, keyed by
  its start in `localStorage['focus:break-over']`, since SQLite gives a new break the id of a
  deleted newest one). The server keeps breaks from overlapping sessions: a
  break start ends a running break and is refused (409) while a focus timer runs, and a
  session start ends a running break (`endRunningBreak`, `routes/shared.ts`). However a break
  ends, one that ran under `MIN_BREAK_MS` is deleted, not logged (`POST /breaks/:id/end`
  answers `{ break: null }`). End break goes through `endRunningBreak` too, so the server
  has one copy of that rule. The client mirrors both rules with `endBreaksAt` (in `useDay`'s
  break writes and `applySession`, which ends a running break on any loaded day, since one
  started before midnight sits on the day before), so it never sends an end after a session
  start: the break may already be gone. The timer card disables its break buttons while a start
  is out, since a break write goes out on the day store's queue, not the timer's, and could
  reach the server after the start; for the same reason a session start takes the break
  banners down in its tap (`dismissByTag('break')`), whose Start break those buttons don't
  cover.
- **Saves reach the server in the order they were made**, each store's on its own queue
  (`serial()` in `lib/optimistic.ts`, made by `useTracked`). In the day store, `setPunches` and
  `setPriorities` send a whole list, so one PUT per list and day is in flight and only the
  newest waiting list follows it (`sendLatest` in `useDay.tsx`); a failed list save also drops
  the lists waiting behind it, which were built on the one refused. The newest priorities list
  goes with the base of the oldest list not sent yet, so it carries every change since. That
  needs every list that takes a waiting one's place to be built on `current()`: the Priorities
  card flushes its draft on blur, before any other sheet control acts, and `addPriority` builds
  on `current()` (a `useDay.test.tsx` case pins it). The day's other fields (`day:<date>`), each
  session (`session:<id>`) and the breaks (`breaks`) queue their writes one after another
  (`inOrder`). `useTimer` sends the running session's writes one at a time on its own queue:
  start, adjust, edit, pause, resume, finish and cancel, the log's edits of the running row
  included. That queue is not ordered against the day store's `session:<id>` queue, which
  carries the other rows' edits and deletes. Two jobs wait across queues: a session start or
  edit that names a priority's uid first waits, inside its own queue's job, for that day's
  priorities save still out (`prioritiesSaved`), since the server refuses a uid it hasn't
  stored; and a board job that changes a day's list waits for that save (below). `useSettings`
  sends its PUTs and resets one at a time. The board (`useBoard`) sends each write as one job on
  its `'board'` queue, its change to the cards shown from the moment it is made; a job that
  changes a day's list (a pull, a park, a tick, a rename, a Delete, the sweep) awaits that save
  inside the job, through `editPriorities` and so on the day store's list sends. A pull, a
  park's removal, a tick and a rename send the item's card as `touched`; a Delete and the sweep
  send none. A list that takes a waiting one's place goes with the `touched` of every list it
  replaced, as it goes with the oldest base. A new edit of a day's rows, the settings, the timer
  or the board goes through one of these, never straight to `api`. Reads are not queued, and in
  every store a read's answer never replaces a change still on its way.
- **Punch positions are fixed**: 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in
  pairs, and **the last row is always the Clock out** (an odd position ≥ 3; `normalizePunches`
  enforces it). Kind is parity (`kindForPosition`, `shared/punches.ts`). The math evaluates *set* punches
  chronologically; `extraPairs()` only decides where the card *shows* a pair. Today a time typed
  ahead of now counts once the clock reaches it (its order is checked at once); a past day counts
  every time it has. Today ends only at the Clock out, when it is the latest punch reached, with
  the target met or not; an extra pair's Out is a break, the second meal included, and never
  ends it. A past day ends once it is off the clock. "Add extra out / in" appends two rows, so the old Clock out
  becomes the new pair's Out. Removing the pair an Add just made, before any punch changes,
  undoes the Add and gives the Clock out its time back (`Timeclock` keeps the rows from before
  it in its state, so the undo ends when the card remounts: a reload, another date, the first
  Customize, a move to the other column, or the sheet switching between one list and two);
  removing any other pair drops its two rows (`removePunchPair`). Lunch semantics
  come only from positions 1 and 2.
- **A punch row saves only complete times.** `TimeField` (React Aria segments) commits the
  moment hour, minute and period are all filled, and throws a half-typed draft away when
  focus leaves the field or on Escape, which keeps focus in the field, so the row never shows a
  time the server doesn't have. In 12-hour mode the period is filled in as the hour is typed
  (`guessPeriod` in `lib/timefield.ts`: 5–11 → AM, 12 and 1–4 → PM; on a later row, a morning
  hour whose every minute falls before the day's clock-in turns PM unless the PM hour does too,
  and an afternoon guess never turns AM, so 8:10 after an 8:30 clock-in stays AM), and left
  alone once the user has touched that segment, until the row is cleared. Clearing is the row's
  × button only. Punch PUTs are queued per day (see "Saves reach the server in the order they
  were made").
- **Overtime approval (`days.overtime_approved`) silences only the `clockOut` alarm target.**
  Lunch and the second meal period stay armed: California Labor Code §512 still requires them
  on an overtime day. Approval also arms the second meal on a day whose work day doesn't pass
  its threshold: `secondMealApplies` counts an approved day as one that will pass it, so the
  alarm and the card's note start when the switch is set, not when the day runs over. The
  setting `overtimeApproval` shows/hides the switch and banner button, and with it off the
  Clock out tile reads time past the day as "past your day" rather than a red "Over by"; a
  flagged day counts only while the setting is on: `overtimeOn` (`lib/timeclock.ts`) decides,
  which `Timeclock` (the tiles get the flag from it) and `useTodayAlarms` call.
- **`mealRules: false` turns the meal periods off in the math, not in the components.**
  `computeTimeclock` then never needs a lunch (`not-needed`, so no lunch alarm and no lunch
  added to the clock-out time) and `secondMealApplies` is false; a lunch that was punched still
  counts. The card drops the Lunch by tile (the Focused tile shows either way), and with
  `lunchPunches: false` too it hides the Lunch out / in rows, which stay in the data at
  positions 1 and 2: `lunchRowsShown` decides (never on a day with a lunch punched). With
  `lunchPunches: false` too, `stickerReasons` drops the Lunch taken sticker (`lunchTracked`, the
  settings half of `lunchRowsShown`), and `stickersForDay` returns only the reasons it is given,
  so a day never wears a sticker the legend leaves out. `lunchInPunchOrder` decides the Now
  order (`nextPunchPosition`): it skips the lunch rows while they are hidden, on a day that
  needs no lunch with the meal periods on, and past the target with no lunch taken.
  `trackHours: false` only hides hours outside the day's own tiles (the week line, History's
  hours, the Clocked out sticker via `stickerReasons`); the timeclock still runs.
- **Priorities are stored as the client sends them, merged with what other devices saved**
  (positions 1..n, contiguous, ≤ `MAX_PRIORITIES`; no `done` on an empty row). A day never
  edited has none. The card saves the rows it shows, its padded empty ones included, so a
  cleared row keeps its `uid`, its `addedAt` and the sessions that point at it: it is the same
  item, and typing in it again renames it (with focus logged on it, the card says under it that
  the time stays). A new priority never lands on a cleared row: Add priority and the timer's
  Also add (`placePriority`, `hasRoom`) use a row never written in (`isFree`: empty, no uid) or
  a new one at the end, and `planNext` (Plan tomorrow, the left-open Add) drops only rows never
  written in. The nudge (`nudgeFor`) counts the rows with text. The server never pads: the
  client pads to `settings.priorityCount` with `padPriorities()`, and every reader of a list
  skips empty rows with `hasText` (`shared/priorities.ts`). `PUT /days/:date/priorities` takes
  the list and its `base`, the list it was built on (the card's draft sends what its edits were
  made on, `PlanNext` and `addPriority` the day's shown copy), and stores
  `mergePriorities(stored, base, list)`, which the day store also shows while the save is out.
  Rows match by uid. Each `'merge'` field in `MERGED` takes this device's value where it
  differs from `base`, else the stored one; a `'fixed'` field (`cardUid`, `recurringUid`) keeps
  the stored row's value whatever arrives. A link a save leaves out keeps its value: a missing
  `categoryUid` is read as the base row's, else the stored row's, and a missing card or
  recurring priority is none on a new row. A row this device removed goes; one another device
  removed stays gone unless this device changed it. A row another device added since `base`
  stays, in this device's first row never written in (never a cleared one, which still stands
  for its item) or at the end, and a row added on both with the same text (`sameText`) is one
  row, the stored one, when the row added here links to nothing (no card, no recurring
  priority) and the stored one has no recurring priority (a card it may hold: a save with
  `cards` made it); the stored row takes the category picked here when it has none, and keeps
  its own when it has one. Order is this device's. Removing a row is sending the list without
  it. With no base (curl, a tab from before the merge) the list replaces the stored one, the
  fixed fields aside.
- **A priority's identity is its `uid`, never its position.** The client mints it (`newUid()`)
  the first time a row gets text and stamps `addedAt`; both survive a text clear and a renumber.
  `sessions.priority_uid` points at it (null or a removed row = unplanned). `POST/PATCH`
  sessions check the uid exists on that day. Each day's row has its own uid, and three soft
  links tie it to its task across days: `cardUid` (the board card), `recurringUid` (the
  recurring priority it was added from) and `categoryUid`. They are checked for shape only
  (`UID_RE`; a row never written in holds none, and one row is never both a card and a recurring
  priority), and a null link matches nothing (`sharesLink`). Carry-over (the left-open Add and
  Plan tomorrow, through `planNext`'s seeds) gives the new day's row a fresh uid and `addedAt`
  and carries all three. `cardUid` and `recurringUid` are fixed once stored (no client changes
  them; the server fills a null `cardUid` when a save makes the row's card, see the board rule
  below); `categoryUid` changes like the text. A cleared row keeps all three. A stored list
  never holds two text rows with one card or one recurring priority: a sent list that repeats
  one is refused (400) when one of the two rows is new to the server (`repeatedLink`), and the
  merge keeps the stored row of a repeat, else the first, at the first of their places
  (`dedupeLinks`). A cleared row loses a card or recurring priority a text row of its list holds
  (`dropShadowedLinks`). `placePriority` and `planNext` never make a repeat: a row placed or
  planned whose link a text row holds is skipped, and a cleared row that holds it takes it back
  with its uid and `addedAt`, so the time logged on it counts again, and its category unless the
  row placed brings one (`takeBack`).
- **A board card follows its latest linked row** (`board_cards`, `server/board.ts`). A card's
  latest linked day is the latest day whose list holds a row with its `cardUid`, text or
  emptied; `BoardCard.listDate` is that day and `held` is derived from it on every read, never
  stored. Priorities are written only by their PUT, and `mirrorCards` runs inside its
  transaction, after the merge and before the rows are stored. The client says what the
  server can't know: `cards` (the board is on and the list's day is today or later) makes a
  card for each non-recurring text row with no `cardUid`, minted by the server and written onto
  the row the answer carries, and gives a row gaining text whose card is gone its card back
  under that `cardUid`, both under the 300-card cap on Later and Next (`BOARD_LIMITS`; at the
  cap the row waits for a later save, and the save never fails for it); `touched` names the
  cards a board action handled through their rows. Whatever `cards` is, only what the save
  changed is copied, and only from the card's latest linked day: a row gaining text (new to the
  list, or typed into again) gives the title, the category and the lane by its tick, new text
  the title, a new category the category, a tick Done and an untick the top of Next; a card a
  save makes takes its row's title and category. Done is reached only through a ticked row. A card a
  save made stays `untouched` until a board POST or PATCH, or a save whose `touched` names it:
  while its row there is emptied it is held (shown nowhere until the row has text again), and
  when that row is removed it is deleted, so a row typed and then removed leaves no card behind.
  A handled card is never deleted by a save: when its open row goes it stays where it is, or
  goes back to Done when that row had taken it out (it is in Next and its latest remaining row
  with text is ticked). A board `PATCH` carries the client's `today` and is refused (409) while
  a row on that day's list or a later one is linked to the card, since that row decides it; a
  `POST` of a uid that exists places that card (a park) instead of making one. A board write
  that adds a card to Later and Next (a new one, or one taken out of Done) is refused at the
  cap. Recurring rows never get a card.
- **A category is a row of its own, named by its uid** (`categories`, routes in
  `routes/board.ts`, answered in `Board.categories`). Rows, cards and sessions point at one by
  `categoryUid`, a soft link checked for shape only, so a category made on this device can reach
  the server after the row that names it. Removing one archives it (`archived_at`), never deletes
  it, so the time logged under it keeps its name; a `POST` of its uid brings it back with the name
  and colour sent. Names are unique among a user's categories in use, whatever their case or
  spacing (`sameText`), checked by the routes (the table has no UNIQUE on the name, which would
  stop the README's handover script), and a new uid can't take a removed one's name either: the
  client brings that one back. The server caps them at 100 in use and 1000 stored
  (`BOARD_LIMITS`), sanity caps with no product limit behind them; colours (`CATEGORY_COLORS`,
  checked with `isOneOf`) repeat. A session counts under the category of the written row it was
  logged on; its own `categoryUid` is one picked in the log, or the category of its row once a
  priorities save removes that row: the PUT copies it onto the day's sessions on that row that
  have none (`keepSessionCategories`, in the same transaction), and the day store, seeing that
  save take a row with a category off a list a session points at (`leavesCategory`), reads the
  day again. An emptied row stays on its list with its category, so its sessions keep counting
  under it, unless the day log gave one a category of its own, and nothing is copied. Once the
  row is written in again it decides: the PUT drops the `categoryUid` of the day's sessions on
  it (`dropSessionCategories`, in the same transaction), and the day store, seeing a save write
  in an emptied row that a session with a category of its own points at (`regainsText`), reads
  the day again, or its copy would keep the pick the server dropped. On the client
  `CategoryChip` is the one way a category is picked, fed by `useCategoryPick` (null while the board
  is off or before its first read, and then no chip shows), which the board page and the sheet call
  once and pass down as `pick`: the sheet's goes to Top priorities (a written row's chip, which
  saves at once), the timer (the row Also add makes, `addPriority(date, text, categoryUid)`), the
  day log (a session on no written row, in the edit's one PATCH) and, through the retrospective,
  Plan tomorrow (a row typed in). A press on the chip leaves the focus where it is until the list
  takes it or gives it back to the chip, since Safari and Firefox on macOS don't focus a pressed
  button and the day log's edit ends when the focus leaves it. Its New category box runs
  `categoryForName` (`lib/board.ts`): the category in use by that name, else a removed one brought
  back under its own uid, else a new one in `nextColor` (the colour the fewest categories in use
  have, so the eight repeat evenly). The chip sets that uid at once and the create goes
  out as an optimistic board write; opening the list reads the board again, and a create the
  server refuses (another device took the name, a cap) is taken off with the "Change not saved"
  banner, so what picked it reads as no category. The board's capture box remembers its last
  category on the device (`USER_KEYS.captureCategory`; a removed or unknown one reads as none).
  Settings → Board (`BoardTab`, shown while the board is on) adds (`categoryForName` again),
  renames (refusing a name in use, `categoryNameTaken`), recolours and removes, each through the
  dialog's `save`.
- **A recurring priority is a row of its own, named by its uid** (`recurring`, routes in
  `routes/board.ts`, answered in `Board.recurring` in the order they were made): a title, a
  category and the weekdays it is offered on, ISO 1 (Monday) to 7 on the wire and a mask in the
  table (bit 0 for Monday; `weekdayMask`, `weekdaysOf` in `server/board.ts`). The rows it adds
  point at it by `recurringUid`. Deleting one deletes it for good; those rows keep the link, now
  to nothing, and their own category. The server caps them at 100 (`BOARD_LIMITS`), a sanity cap
  with no product limit behind it, and never prunes them.
- **In progress is today's list** (`client/src/lib/board.ts`, `hooks/useBoard.tsx`). The board
  (on with the `board` setting, off by default) shows the cards and today's rows from the day
  store, matched by `cardUid` (`boardColumns`); nothing about In progress is stored, so the
  board and the sheet show one list. A card linked to a row of today's list shows only as that
  row: open in In progress, ticked in Done, emptied nowhere. A `held` card shows nowhere. A card
  a later day's list holds (`listDate` after today) is planned: shown in Next whatever its lane,
  and read-only but for Delete; planned applies only off today's list, so a row carried to today
  stays tickable. Done holds this week (`startOfWeek`): today's ticked rows and cards done
  today, then the rest of the week folded, with an earlier ticked row shown only where no card
  in the copy stands for it. Every Move to goes through `planMove`, which says what it writes: a
  card's lane or place (`editCard`, a PATCH with today's date), or today's list through the day
  store's `editPriorities` with the card as `touched` (a pull of a card or an earlier row onto
  the list, in the item's category, a tick, a park of a row to Later or Next), or nothing: a
  done item moved to Later or Next stays done and the notice offers a new card in its place,
  with its title and category, and a recurring row, a planned card and a park to Later of a row
  planned later are refused. A Done card's untick off today's list is a PATCH to Next, the
  correction for a mistaken tick, and such a card offers no Delete: an earlier day's ticked row
  would show in its place. The editor's category chip goes where its title goes: a row of today's
  list changes through the row (`editRow`, the card as touched, and the save copies it onto the
  card), any other card through a PATCH, and a planned card or an earlier day's row has none. The
  day store sends `cards` on every priorities PUT while the board is on and the list's day is
  today or later, read as the PUT goes out, so a row typed on the sheet gets its card. After a
  board read, once per page load and day, the board sends today's list asking for cards when a
  row has none (the sweep, on its queue), so rows typed while it was off have cards before Plan
  tomorrow carries them. A park places the row's card
  (`POST /board/cards` with the row's `cardUid`, and its title and category as the list shows
  them when the job runs, since the POST writes both onto the card) before it takes the row off
  the list, and a row with no card yet first goes out in a save that asks for one, so a retry
  after a failed removal places the same card. Delete takes the card's row off today's list and
  off its later day's list (loaded first), then deletes the card. One `role="status"` slot under
  the capture box holds the board notice: the pull nudge (`nudgeFor`, as Add priority asks), the
  done-item notice or a refusal; what the store refuses once a move is under way (`MoveRefused`:
  a full list, a stale card, a list not loaded) is a banner. With the board on, the left-open
  offer brings back a row whose card is in Next under the card's title, and leaves one whose
  card the board moved to Later, finished or deleted (`offeredLeftovers`). A drag (`Board.tsx`,
  with dnd-kit's settings in `components/board/dnd.ts`) starts at an item's grip. A planned card
  and a recurring row have none, and an item whose move is on its way can't be picked up until
  the move lands. Later's and Next's cards sort, each lane a `SortableContext` of the cards it
  shows (planned ones left out); In progress and Done take a drop as a whole column. While
  dragged, the item shows in the column it is over (`withDrag`); where it lands is `dropTarget`
  (in a lane, the place of the card it is over as the list showed it sorting, which is before
  that card for an item from another column; at the end of an empty lane; null where it
  started), and the drop goes through `planMove` as Move to does. What a screen reader hears
  comes from `BOARD_DRAG`, `overAnnouncement` and `moveAnnouncement` (a done item's line is
  `DONE_STAYS.announce`). dnd-kit's own focus return is off, since it would take the focus from
  the notice a drop brings: a keyboard drag puts it back on the item's grip, and so does closing
  the notice (on the title where the grip is hidden or missing).
- **Plan-vs-actual math lives only in `client/src/lib/retro.ts` and `review.ts`** (pure, with
  tests). "Added mid-day" means `addedAt` is after the day's first completed session started —
  one rule, no clock-in fallback. `GET /days/range` returns full days and the client does the
  rollup (through `useRange`). `reviewRange` walks the period's days up to today that have
  content (`hasContent`, so a day with only a break is left out) and also gives `sessions`
  (completed ones, `focusOf`), `breaks` (count and time, a running one so far, `breakSeconds`),
  `midDay` (rows added mid-day and how many got ticked) and `typicalDay`: the medians, rounded
  half up, of the rows written and ticked on the days before today with a row written. Today
  is left out because it is still going, and it is null under two such days; Review shows it
  for a Week or a Month. The Days tile's target is `periodTarget`: a Week's is the Work week
  setting, as on the timeclock's week line, and a Month's or a Quarter's is `targetSeconds`,
  the clocked-in days' own lengths added up through `daySettings`. Not done groups the one-off
  rows left open into tasks across days (`addToNotDone`): rows linked to one card are one task
  (`card:<cardUid>`), whatever their text; a row with no card joins the latest task of its
  text, else starts one (`text:<sameText>`); a carded row whose card has no task yet takes over
  the cardless task of its text, in its place in the order. A carded row's tick settles its
  card's task and the cardless task of its text, a cardless tick every task of its text, and a
  tick on a day settles the same task left open beside it. Two cards with one title stay two
  tasks. A recurring priority's rows (`recurringUid`) are priorities in every count (the tiles,
  `midDay`, `typicalDay`, the retro card, the calendar and its stickers) but never a task in Not
  done, which lists one-offs only: `reviewRange` groups them by `recurringUid` into `routines`
  (the days a row had text, how many of them it was ticked, its focus; most days first, then most
  focus, then by title), each day on its own, so a tick never settles another day's miss and a
  same-text one-off stays a task of its own. A routine is titled by its item through
  `recurringTitles` (uid → title; Review passes none yet) while the item exists, else by its
  latest row's text, so a retyped row or a deleted item stays one entry. `reviewDay`'s
  `routines` (`{ done, total }`) is the retro card's "routines 3 of 4". A session's category is
  `sessionCategory(s, rows)`: the category of the written row its `priorityUid` names on its
  day (none included), else its own `categoryUid` (picked in the day log, or copied by the
  server when its row was removed), else that of an emptied row it still names, else none. The
  day log picks one only for a session on no written row, since the row's own chip decides the rest,
  and shows it as a `CategoryDot` named by its `label`, the one dot drawn without its name beside
  it. A pick is the edit `sessionCategoryEdit` gives: a category is set as the session's own, and No
  category also takes a session off an emptied row that has a category (`priorityUid: null`), since
  none of its own goes by the row's. Linking a session to a written row with the log's select drops
  a category of its own (`sessionLinkEdit`): the row decides from then on, and the server copies a
  removed row's category only onto sessions with none.
- **History opens on the route's date** (`route.date ?? today`), with that day picked. The
  calendar holds its month by its first day (`startOfMonth`) and Review its period by `from`,
  so neither moves at midnight. "Open day" first records the picked day (and the Review period,
  `route.review`) on the History entry with `replace` and then pushes the sheet, so Back
  reopens it there (`openDay` in `App.tsx`). Its cells count days by `hasContent` and its panel
  uses `dayTimeclock`, the sheet's math.
- **The `retro` alarm target is the clock-out instant** ("warn before" = minutes before the
  end of the day) and is **not** silenced by overtime approval; marking the day reviewed
  (`days.retro_at`), or hiding the retrospective card under Customize (`alarmTargets` reads
  `settings.layout`), disarms it. Its banner button jumps to the card (`jumpTo` in `App.tsx`).
- **Alarm event keys embed the target minute** (`eventKey`), so a moved target re-arms and a
  reload never re-fires. Fired keys live in `localStorage` under `focus:alarms:<date>` and are
  pruned to today.
- **Today's alarms wait while a punch is being typed.** Today's punches are held while a punch
  time field on today's sheet has focus (`Timeclock`'s `onEditingChange`; Now, × and the pair
  buttons save at once and never hold), for at most five minutes after the last change or move
  to another time field, and settle for 3 s after (`useSettled(value, ms)`, wired in
  `useTodayAlarms` on `punchesKey`) before evaluation. The hold ends when focus leaves a time
  field or the field goes with focus inside (the card unmounts, its pair is removed or moves
  across lunch): `TimeField` reports both, since a removed field gets no blur. The punches are
  compared by their times, so a refresh with the same times neither stops the alarms nor
  restarts the wait.
- **Per-date card drafts reset by remounting**: `Sheet.tsx` keys `Timeclock`, `Priorities` and
  `Retro` by date, so none needs a "date changed" effect. For `Timeclock` the remount is also
  what keeps a day already done from reading as one becoming done: `useBecameTrue` compares
  with the last render, and moving between two days the store already holds would otherwise
  leave the card mounted. Local drafts that mirror a prop use the "adjust state while
  rendering" form (see `DurationField`), not a `useEffect` + `setState`, unless the draft is
  gated by a dirty flag: a ref can't be read during render, so there the effect form is the
  one the react-hooks rules allow. A typed draft that saves on a timer is
  `useDebouncedDraft(stored, save, ms)` (`Priorities`, `Retro`): it saves after the wait, at
  once on `flush()` or an edit made now, and on unmount, so a day left mid-sentence still
  saves. `save(value, base)` gets as `base` what the edits were made on: the value it last
  saved, or the `stored` value the draft last took up once that has rendered, whichever came
  later. `Priorities` hands it to the store for the merge, and `Retro` ignores it. `save` says
  whether the draft can be let go: `Retro` passes the store's answer, so a note whose save
  fails stays in its box, unsaved, though the store has dropped the change, and goes again on
  the next edit, blur or unmount; `Priorities` lets its list go once sent, because a list held
  after a failure would stop the card following the stored list (rows and ticks saved
  elsewhere) until a save went through. Callbacks that must read the latest value use
  `useLatest()`, never a ref written in render (the react-hooks lint enforces both).
- Static assets are public; **all data is behind `/api/*`**. `/assets/*` is fingerprinted and
  cached immutable. The SPA fallback serves `index.html` for any other non-API path; a miss
  under `/assets` is a 404 (a page from before an upgrade asking for an old chunk).
- **History, the board, the settings dialog and drag and drop are lazy chunks** (`lazy()` in
  `App.tsx` for `History`, `Board` and `SettingsDialog`, in `Sheet.tsx` for `SortableCards`;
  `SortableCards` and `components/board/` hold every `@dnd-kit` import). A static import of one
  of them from the first screen folds it back into the main chunk. Everything under
  `components/board/` loads only through `Board`'s chunk; what other views share with it
  (`lib/board.ts` and `hooks/useBoard.tsx` with the sheet and the settings, `Folded` with
  History's Review, and the category pieces, `CategoryChip`, `CategoryDot` and
  `lib/popover.ts`) stays out of that folder and imports no dnd-kit. The sheet renders plain
  `CardFrame`s until the first Customize and stays on `SortableCards` after it, since swapping
  lists remounts the cards. A chunk that fails to load (an upgrade while the page was open)
  reloads the page once a minute at most (`vite:preloadError` in `main.tsx`, `lib/reload.ts`);
  the `ErrorBoundary` card shows until the reload lands, and stays when no reload is made.
- **A wide window shows the sheet in two columns, chosen when the sheet mounts.** Each layout
  entry has a `side` (`'left' | 'right'`), which `normalizeLayout` keeps or sets to the card's
  `DEFAULT_SIDE` (`shared/settings.ts`), so a layout saved before the columns needs no
  migration. `Sheet.tsx` asks `matchMedia(SPLIT_QUERY)` (`lib/layout.ts`) once, in its first
  render, and keeps the answer until it mounts again (another view, a reload): switching
  between one list and two remounts every card, like the lazy-chunk swap above, so it never
  follows a resize. A split renders `.sheet--split` with one `.sheet-col` per side
  (`splitColumns`, null while a side has no visible card, which keeps one list), so the tab
  order is the order seen. One column shows the whole layout in its order, which a move to the
  other column (`setCardSide`) leaves alone. ↑/↓ and drag and drop stay inside a column
  (`moveCard(…, side)`); moving across is Customize's arrow button, offered while the sheet
  was mounted wide. The moved card mounts again in its new column (and every card does when
  the move empties a side or fills an empty one), so the sheet puts the focus on its arrow
  there.
- **Migrations are append-only** in `server/db.ts` (`MIGRATIONS[]`, `PRAGMA user_version`).
  Every FK to `users` or `days` is `ON DELETE CASCADE`. A column nothing uses stays in the
  table rather than a migration dropping it: `sessions.notes` is one (never shown or edited;
  the API no longer reads or writes it).

## How to add…

- **A card**: add the id to `CARD_IDS` in `shared/settings.ts`, its column on a wide screen to
  `DEFAULT_SIDE` there and to `TEST_SIDES` in `client/src/test/fixtures.ts`, and its title to
  `CARD_TITLES` in `client/src/lib/layout.ts` (the types make a missing entry an error) → write
  the component → add a `case` in `Sheet.tsx`'s `render()`. Existing users get it automatically
  because every layout goes through `normalizeLayout` (`shared/settings.ts`; `mergeSettings`
  runs it on the server, `useSettings` on the client), which appends a missing card, shown, in
  its default column.
  Removing a card is the reverse (drop the id everywhere; the merge discards it from saved
  layouts), and if the card recorded a choice worth keeping, `mergeSettings` can read it off the
  old layout entry the way the sticker chart's `stickers` setting does.
- **A view** (a page shown in place of the sheet, like History): add its id to `VIEWS` in
  `hooks/useRoute.ts`, which reads it from `?view=` and writes it back (the sheet is the
  default and the one view the URL leaves out; `review` is kept on History only) → a `case` in
  the `switch (view)` in `App.tsx`'s `Shell` (the `switch-exhaustiveness-check` lint refuses a
  missing one) that renders the page through `lazy()` inside a `Suspense`, as History is, with
  the page named in the lazy-chunk rule under "Architecture rules" and in the comment above
  `App.tsx`'s `lazy` consts → a toggle in `Header.tsx` that goes to the view, and back to the
  sheet from it, pressed only there (`aria-pressed={view === '<id>'}`). A view behind a setting,
  as the board is, also needs: the `view` const in `Shell` showing the sheet while the setting
  is off (a link opened then, or the setting switched off on another device), its `case`
  showing the loading block until the settings have loaded, and its Header toggle rendered only
  with the setting on (a prop, as `board` is). `useRoute.test.ts` reads and writes every id in
  `VIEWS`, and `Header.test.tsx` checks History's toggle on each view; the new toggle gets its
  own case there.
- **A per-user setting**: add it to the `Settings` type and `DEFAULT_SETTINGS` in
  `shared/settings.ts`, and a number's bounds to `SETTING_LIMITS` there → validate it in
  `mergeSettings()` (`server/settings.ts`; `flag(key)` takes a switch, `limited(key)` checks a
  number against its bounds) → add the control to its tab in `client/src/components/settings/`
  (`TimeclockTab`, `AlarmsTab`, `SheetTab`, `DataTab`, and `BoardTab`, shown while the board is
  on, which takes only the dialog's `save`, for its board writes, so a setting added there gives
  it `TabProps` (`settings`, `set`) as well; the Sheet tab's "History" section holds the
  calendar's switches, and its "Board" section the board's): a `DurationField`
  (`components/DurationField.tsx`) for hours and minutes or a `NumberField`
  (`settings/controls.tsx`) for one number, whose `unit` suffix is "min" unless given, each
  with `{...SETTING_LIMITS.<key>}` for `min` and `max`; a `SelectField`
  (`settings/controls.tsx`) for one choice from a fixed list; a `Toggle` for a switch.
  `NumberInput` on its own puts several numbers on one row, like the timer's start buttons. The
  new setting also goes in `TEST_SETTINGS` (`client/src/test/fixtures.ts`), and the type makes a
  missing one an error. A setting that is an object edited a field at a time is merged field by
  field in `mergeSettings` (as `mergeRetention` does), and gets a partial entry in
  `SettingsPatch` (`client/src/api.ts`) and a merge in `applySettingsPatch`
  (`client/src/lib/settings.ts`). Nothing else to mirror.
- **A category colour** (the palette is eight on purpose, and colours repeat past that): add the
  id to `CATEGORY_COLORS` in `shared/api.ts` (the server's `isOneOf` check, `nextColor` and the
  swatches read it) → its `--cat-<id>` token in all three token blocks of `styles.css`, at 3:1 or
  more on `--surface` and `--surface-2` in both themes, and its `[data-color='<id>']` rule beside
  the others → its name in `COLOR_NAMES` (`settings/BoardTab.tsx`; the type makes a missing one an
  error). `theme-css.test.ts` fails on a missing token, one under 3:1 or a missing rule.
- **A sound**: drop the clip in as `client/src/sounds/<id>.mp3` (CC0 only, MP3 so Safari can
  decode it, a couple of seconds at most) → add `{ id, label, kind: 'clip' }` to `SOUNDS` in
  `shared/sounds.ts` → add its title, author and source line to `client/src/sounds/README.md`.
  Nothing else: the settings selects, the validator (`mergeSounds`), the `SoundId` type and the
  Test buttons read the catalog, and `client/src/lib/sounds.test.ts` fails if the folder and
  the catalog disagree. A synthesized pattern is an entry with `kind: 'synth'` plus its
  `beep()` sequence in the `SYNTH` map in `alerts.ts` (the type makes a missing one an error).
  A new event that can make a noise is an id in `SOUND_EVENTS`, a default in
  `DEFAULT_SETTINGS.sounds` and a label in `SOUND_EVENT_LABELS` (`lib/sounds.ts`; the types
  make a missing default or label an error); its sound also goes in `TEST_SETTINGS.sounds`
  (`client/src/test/fixtures.ts`), and the type makes a missing one an error. It plays through
  `alert({ chime: settings.sounds.<event>, sound: settings.sound, notifications: settings.notifications, … })`
  from `lib/alerts.ts`, raised only once `useSettings().loaded` is true (see "Nothing alerts
  before the settings have loaded"), or through a `useCelebration(moment, '<event>')` for a
  moment worth a burst; never through a bare `playSound`.
- **An alarm target** (existing: `lunchBy`, `clockOut`, `secondMeal`, `retro`): expose the
  instant from `computeTimeclock` → add a target to `alarmTargets()` in `lib/alarms.ts`, with
  an `armed` rule and a test case (a rule the card also needs goes in a pure helper like
  `secondMealApplies`) → add its id to `ALARM_IDS` and its default under `alarms` in
  `shared/settings.ts` (`mergeSettings` and `applySettingsPatch` loop over `ALARM_IDS`, so
  neither needs a line); its settings also go in `TEST_SETTINGS.alarms`
  (`client/src/test/fixtures.ts`), and the type makes a missing one an error → add an
  `AlarmEditor` in `settings/AlarmsTab.tsx` → its name in `ALARM_NAMES` and a `case` in
  `describeEvent()`'s `switch (e.id)` (both in `lib/alarms.ts`; the type makes a missing name an
  error, and typecheck and the `switch-exhaustiveness-check` lint refuse a missing case): the
  kicker ("X alarm · 15 min warning") is built from the name above the switch, and the case
  gives a title and a body for each kind (lead, due, overdue) that say where the deadline came
  from (it gets an `EventContext`, a `Pick` of the timeclock settings plus the clock-in,
  `hour12` and `now`; widen the `Pick` if the new target needs another setting). A banner can
  carry one `action` button (see the clock-out alarm's "Overtime approved" and the retro alarm's
  "Open retrospective", chosen in `useAlarms` from the `AlarmDayState` callbacks).
- **A per-day field** (like `overtimeApproved`, `retroNote`/`retroAt`): append a migration
  adding the column to `days` → add the column to `DAY_COLUMNS` and to the `DayRow` interface
  beside it (`routes/shared.ts`; `findDay` and `daysInRange` in `routes/days.ts` both read
  them) and return it from `dayJson` (a per-day list in a table of its own, like `breaks`, is
  instead one more grouped query in `rangeRows` and a field in `dayJson`, both in
  `routes/days.ts`; `daysInRange` loads `GET /days/:date` and `/days/range` alike) → add a
  `PUT /days/:date/<field>` route (on the days router) and its client call as "An API route"
  says → `Day` and its default in `emptyDay` (`shared/api.ts`) → a setter in `useDay.tsx` that
  calls `putDayFields(date, apply, send)`: the change shows at once, goes out on the day's
  `day:<date>` queue, and the route's answer (a `Pick<Day, …>` in `shared/api.ts`) is laid on
  the stored copy (mirror `setOvertimeApproved`; a failure drops the change, raises the "Change
  not saved" banner and reloads the day, so the setter resolves false and never rejects) → pass
  it from `Sheet.tsx` to the card, and from `useTodayAlarms` into `useAlarms` if alarms depend
  on it. The seed's manifest types (`SeededDay` and the aliases beside it in
  `server/dev/seed.ts`) are built from `Day`, `Session`, `Priority` and `Break`, so `typecheck`
  fails there on a new field until the templates set it, or it is added to the type's `Omit`
  list if the server derives it (like `durationSeconds`). Write its column in `insertDay` too;
  typecheck does not check that.
- **A priority field** (like `categoryUid`): append a migration adding the column to
  `priorities` → the field on `Priority` (`shared/api.ts`) and the column on `PriorityRow`
  (`routes/shared.ts`) → read it in `priorityJson` and write it in the PUT's INSERT
  (`routes/days.ts`) → its `MERGED` entry (`shared/priorities.ts`, which typecheck asks for):
  `'merge'` if a device may change it, `'fixed'` if the stored value stands once stored → its
  rule in `parsePriorityRows` for a value of the wrong kind and for one left out (a missing
  `'merge'` field must read as unchanged, as `withCategories` does for the category, or an old
  tab's save would clear it) → its default in `emptyRow` (`client/src/lib/priorities.ts`) and
  in `addPriority`'s row (`useDay.tsx`) → if carry-over keeps it, `PrioritySeed`, `textSeed`
  and `planNext`'s row (`lib/plan.ts`) → if it is a link a list holds once, `LINKS`
  (`shared/priorities.ts`), which `repeatedLink`, `dedupeLinks`, `dropShadowedLinks` and
  `sharesLink` read (`placePriority` and `planNext` match through `sharesLink`) → if the row's
  card carries it too (as it does `categoryUid`), a `board_cards` column, the field on
  `BoardCard` (`shared/api.ts`) and `CardRow` (`routes/shared.ts`), `boardJson`, and the copy in
  `mirrorCards` (`server/board.ts`): a card the save makes, or whose row gains text, takes the
  row's value, and otherwise only a change the save made is copied; the column also goes in the
  card INSERTs of `createCard` and `mirrorCards`' `make` and in the seed's `insertBoard`, which
  typecheck doesn't check → the seed (`server/dev/seed.ts`: its rows, typecheck asks;
  `insertDay`'s INSERT, it doesn't) → `makePriority` (`client/src/test/fixtures.ts`) → the
  padded-rows case in `server/routes/days.test.ts` ("takes the web app's rows as it pads and
  sends them").
- **An API route**: put it on the `api` router in `app.ts` (behind `requireAuth`), scope by
  `currentUser(req).id` (a `/:date` route goes on the days router, whose param handler checks
  the date; a `/:id` route on the sessions or breaks router, or a `/:uid` route on the board's
  cards, categories or recurring router, is checked by the router itself and reads its row with
  `owned(res)`; a new table addressed by id gets its entry in `OwnedRows` and `NOT_FOUND` and a
  router from `ownedRouter()`, and a new table of the user's addressed by uid its entry in
  `UidRows` and `UID_NOT_FOUND` and a router from `uidRouter()`, all in `routes/shared.ts`),
  validate input (`app.ts` makes a missing or non-JSON body `{}`, so a route reads fields
  straight off `req.body as { field?: unknown }`, with no `?? {}` or `?.`, and checks each one;
  the `no-unsafe-*` lint refuses reading it as `any`), refuse with
  `return refuse(res, status, message)` → add the call to `client/src/api.ts` (a request
  body the client builds in more than one place gets its type there, at the head of the section
  whose calls send it, as `RetroPatch` and `SessionEdit` do: the server reads every body as `unknown`), with a
  row in `client/src/api.test.ts`'s `ROUTES` table for its method, path and body (the coverage
  gate needs it), and the response type to `shared/api.ts` (the route's
  `res.json(… satisfies <Type>)` and the client's `request<Type>` both name it) → cover it in
  that router's `*.test.ts`: happy path, each 400, and that another user gets a 404/empty
  result (the scoping test is not optional). A new `/:date` route also gets a row in the
  bad-date table at the end of `server/routes/days.test.ts`.
- **A schema change**: append a migration string to `MIGRATIONS` in `db.ts`. Never edit an
  existing entry. A new table with a `user_id` also joins the README's script under "Switching
  modes later"; `server/db.test.ts` fails until it does. A new column on a day, session,
  priority or break also needs the seed note under "A per-day field". A new `Priority` field
  follows "A priority field".
- **A security header, CSP source or request guard**: `server/security.ts` only (tests in
  `server/app.test.ts`), then the `prod` config check.
- **A config env var**: parse and validate it in `server/config.ts` (throw with a clear
  message on a bad value; an on/off variable goes through `parseSwitch`, which logs and keeps
  the default instead) → cover it in `server/config.test.ts` → document it in
  `.env.example` (commented out with a typical value, the comment saying what unset means;
  `AUTH_MODE` is the one line left on) and the README's variables table → add a
  `Config` field for it to `unraid/clockspan.xml` (`config.test.ts` fails otherwise).
  `.env.example` is the only place the container is configured; `docker-compose.yml` never
  lists variables, it only passes `.env` through (`env_file`). `loadConfig` drops empty values
  before parsing (Unraid passes every template field, blank or not), so an empty variable
  already means its default; don't test for `''` in the parser.

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. Named exports. `_`-prefixed names are the
  only allowed unused vars.
- CSS: tokens on `:root` in `client/src/styles.css`, dark mode via `prefers-color-scheme`
  unless the `theme` setting forces one (`data-theme` on `<html>`, set by `lib/theme.ts`; the
  two dark token blocks must match, `index.html`'s theme-color metas repeat `--bg` for each
  scheme and the manifest's `background_color` the light one: `theme-css.test.ts` checks all
  three), built **phone-base** (the base rules are the phone; `@media (min-width: 640px)`
  and wider queries enhance; that is how the stylesheet is built, not who it is for). The
  sheet's two columns start at `SPLIT_QUERY` (`lib/layout.ts`), which `styles.css` writes out
  as its `@media` line (`theme-css.test.ts` checks it is there). Every width rule is a window
  query, so a card in a column gets the wide-window rules at about half the width: a rule
  that needs the room (the timeclock's four tiles in a row) is undone under `.sheet--split`. Tap
  targets are 44 px on a touch screen: `.btn` and `.input` set `min-height: 44px`, and a
  compact control (chip, segment, running-bar button, banner close/action, log delete) keeps
  its drawn size and gets the rest from the `@media (pointer: coarse)` block at the end of
  `styles.css`, an empty `::after` reaching past its edge (a control that clips its overflow
  grows its padding instead). Where two controls sit closer than that, each reaches half the
  gap. A new compact control joins that block.
  A toggle's on state is styled from its ARIA attribute
  (`[aria-pressed='true']`, `[aria-selected='true']`), never a parallel `is-on` / `is-active`
  class. Inputs are 16 px so iOS doesn't zoom. No external
  fonts or assets (the CSP would block them anyway). Safe-area insets via `--safe-top`,
  `--safe-bottom`, `--safe-left` and `--safe-right` (a phone held sideways puts the notch on a
  side). Words in a tone's colour use its `-ink` token (`--accent-ink`, `--ok-ink`,
  `--warn-ink`, `--danger-ink`), which keeps light-mode text at 4.5:1 and up; the tone itself is
  for fills, borders, icons and bars. A category's colour (`--cat-<id>`, picked by `data-color`)
  is a fill only, in all three token blocks at 3:1 and up on both surfaces (`theme-css.test.ts`
  checks); a category's name is never drawn in it, and its dot always sits beside the name, since
  the eight colours repeat (`nextColor`); the one exception is the day log's dot, named by its
  `label`. `CategoryChip` is the one category picker: its list is `position: fixed` inside the
  chip's wrapper, placed by `placePopover` (`lib/popover.ts`) and scrolling inside, so no card or
  dialog clips it and New category stays in view. A sheet row's empty chip (a priority row's, a Plan
  tomorrow row's) is quiet: with a mouse it shows on the row's hover or focus only, from the
  `(hover: hover)` rule beside the chip's. `.category-chip` and `.swatch` are in the coarse block.
- Numeric settings inputs commit on blur or Enter, never on every keystroke (`NumberInput`);
  `DurationField` commits when focus leaves its hours / minutes pair or on Enter, so moving from
  hours to minutes saves nothing. A blank or non-numeric box puts the stored value back and
  saves nothing; zero is typed as 0. Priorities debounce 400 ms; punches and checkboxes save
  immediately.
- A form that sends a request submits through `useSubmit()` (`hooks/useSubmit.ts`), and a
  button that sends one calls its `run`: one send at a time with the button disabled, and one
  error line (`ErrorLine`), cleared when a send starts and filled with what it throws (a
  mismatched confirmation throws too). A store write that shows at once (the board's capture
  box, a card's Move to) is not a form send: it goes through its store, and a failure is the
  banner.
- Comments explain *why* (browser quirks, math), not what.
- No new dependency (a server one or a client library the bundle carries) without stating the
  reason in the PR body, which becomes the squash commit's message on `main`.
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

1. Logic (`shared/`, `client/src/lib`): a unit test beside the file (a lib test takes
   its fixtures from `client/src/test/fixtures.ts`). A hook (`client/src/hooks`): a test beside
   it with the API mocked (`vi.mock('../api')`), fake timers for polls, retries and races, and
   the fixtures and provider stack from `client/src/test/hooks.tsx`. `client/src/api.ts`:
   `client/src/api.test.ts` checks every call's method, path and body against a stubbed
   `fetch`. A component's own logic (when a draft saves, what a click sends, which page shows):
   a test beside it with `@testing-library/react` and the same fixtures and providers. Its
   looks stay a browser matter.
   - The client's lib, hook and component tests build their settings from `TEST_SETTINGS`
     (`makeSettings(patch)` in hook and component tests), never `DEFAULT_SETTINGS`, so a
     changed default moves no expectation. Only a test of the defaults themselves reads
     `DEFAULT_SETTINGS`: `useSettings`' fallback before the first answer,
     `shared/settings.test.ts`, and the server's tests, where a user with no settings row gets
     the defaults. Minutes and hours are `MINUTE_MS` and `HOUR_MS` from `shared/dates.js`.
   - A test that needs a DOM (hooks, components, `api.ts`) starts with
     `// @vitest-environment happy-dom`; the rest of the suite runs under `node`.
   - The suite runs in America/Los_Angeles (`test.env.TZ` in `vite.config.ts`), so a US DST
     case uses that zone's change days (2026-03-08, 2026-11-01). A case that needs another
     zone stubs it with `vi.stubEnv('TZ', …)` inside `try` / `finally`, with
     `vi.unstubAllEnvs()` in the `finally`, as `shared/dates.test.ts` does for Santiago's
     midnight change.
2. Anything in `server/`: a test beside it, never a click.
   - Routes (behavior, validation, scoping, headers, persistence) are harness tests in the
     router's `*.test.ts`. `startTestApp()` (`server/dev/harness.ts`) boots the real app on an
     in-memory DB, and the test calls it over HTTP (`app.api`, a `fetch` client). `seed: true`
     adds the sample days and their manifest (`app.seeded`). `app.db` sets up what the API
     can't, such as an expired login. One app per test. To move time, fake only `Date`
     (`vi.useFakeTimers({ toFake: ['Date'] })`, so HTTP keeps its real timers) and step it with
     `vi.setSystemTime`.
   - Code with no route (`mergeSettings`, config, passwords, the limiter) is unit-tested
     directly.
   - Migrations are tested in `server/db.test.ts`, where `migrate(db, upTo)` stops early so a
     backfill can be tested.
   - The database is `openDatabase(':memory:')`, never a file. The static-file tests write a
     stand-in `dist/client` with `tempClientBuild()` and remove it afterwards.
3. One-off looks at live data: `curl` against the seeded dev DB (see "Dev data is disposable").
4. The browser, only for what tests cannot show: how a card renders, drag/drop, banners, the
   timer bar, light/dark, the desktop and phone widths. Seed first (`--running` for timer work),
   scope it to the surface you touched, and make one pass at desktop width, then one at the
   375 px mobile preset, each in light and dark. Do not re-walk flows a test already covers.

The gate, which a change passes before it is reported done or a PR is opened:
`npm run test:coverage` green and `typecheck`, `lint` and `format:check` clean. Every file under
`server/`, `shared/`, `client/src/lib/` and `client/src/hooks/`, and `client/src/api.ts` (minus
the two process entrypoints and `server/dev/`) must be 100% covered on statements, branches,
functions and lines, so new code there ships with the tests that reach it. A branch that cannot
be reached is deleted, never hidden behind a `v8 ignore` comment; `alerts.ts` shows how a
browser-only module is tested (stub the globals).

The browser pass for each surface (the logic under it is already tested):

- **CSS or a component**: the touched surface at desktop width, then at the 375 px mobile
  preset, each in light and dark. A sheet card's desktop pass is two widths, since the split
  starts at 1100 px: 1280 (the card in its column) and 1000 (one column, the widest a card
  gets). Resize, then reload: the sheet picks its columns when it mounts.
- **The sheet's columns** (the layout, `Sheet.tsx`, `CardFrame`): at 1280, Customize moves a
  card to the other column and back, ↑/↓ and the grip stay inside a column, and with a timer
  running (`--running`) the bar's contents line up with the wider page; at 1000 and at the
  375 px preset, one column in the layout's order and no column buttons.
- **`security.ts`, `index.html` or how assets load**: the `prod` config, with the console free
  of CSP violations; `curl -sI localhost:8090/api/health` shows the headers.
- **The timer**: make the seeded session run out (PATCH `plannedSeconds` to
  `ceil((elapsed + 30) / 60) * 60`, since plans are whole minutes, then reload so the client
  has the new plan). The bar and the card count below zero, the "Time's up" banner offers
  **Add 5 min**, and a minute or more over, **Finish** opens "How much to log?". Pause and
  resume: the countdown holds and the log row's pill follows.
- **Alarms**: after `npm run seed`, clear Clock in (×) on today's sheet. Set Lunch must start
  within 3 min, Lunch length 0, Work day 10 min and Second meal due after 6 min, in Settings →
  Timeclock or with
  `curl -X PUT localhost:3000/api/settings -H 'content-type: application/json' -d '{"lunchDeadlineMinutes":3,"lunchMinutes":0,"workMinutes":10,"secondMealAfterMinutes":6}'`
  and a reload. Press Now on Clock in: lunch is due at +3 min, the second meal at +6 and
  clock-out at +10. The work day must be longer than the lunch window, or lunch reads "Not
  needed today" and never rings, and longer than the second-meal threshold, or that alarm
  waits for the day to run over or for overtime approval. At the mobile preset each target's
  banner shows at once. "Overtime approved" (on the card or the clock-out banner) stops the
  clock-out alarm, while the lunch and second-meal banners still fire. When done,
  `npm run seed -- --fresh` or `curl -X DELETE localhost:3000/api/settings` puts the default
  settings back.
- **Sounds**: Settings → Alarms → Sounds. Test on a clip row fetches the file once (the network
  list); a second Test fetches nothing. A clock-out set today plays the day-complete sound once,
  and not again on reload.
- **Punches**: a pair added before lunch, an early Clock out (done, celebration), "Add extra
  out / in" after it (the old Clock out becomes Out N) and removing that pair. In the time
  field: clear Clock in and press `0` `7` `3` `0` (the hour advances, the period fills, the
  tiles move with no further key), `p` flips the period, ↑/↓ on a segment saves each step, and
  a half-typed row reverts when focus leaves, and on Escape with focus left on the hour. In the
  browser pane send single `key` presses; the `type` action pastes the whole string into one
  segment.
- **Priorities or the timer card**: tick one row and press Add priority (the notice lists the
  ticked row); tap a chip, start, and the log row shows the number; "Also add to today's
  priorities" fills the first row never written in, never a cleared one; a log row's select
  reassigns it. Clear a row with focus logged on it: the note under it says the time stays, and
  Add priority goes past it. With the board on: pick a category on a row (an empty chip shows only
  on the row's hover or focus with a mouse, always on a phone; a long name ends in an ellipsis; at
  375 the chip sits under the field, nearer it than the next row's, and the field keeps the row's
  width, beside the × past Rows per day; from 640 it sits beside the field, which ends in the same
  place written or empty), tick Also add and pick one for the new row (the chip beside it wraps
  under it at 375), give an unplanned log session one (its dot before the label) and a Plan
  tomorrow row one, then the same at 1280 in the split's columns.
- **Retro or review**: one seeded day's retro card and History → Review → Week (`--quarter` for
  Month / Quarter).
- **The board**: after `npm run seed`, turn it on (`PUT /api/settings {"board":true}`, see "Dev
  data is disposable") and press Board. At 1440: the four columns, capture with Enter and
  Shift+Enter, Move to from each column (a done item to Next shows the notice, and Add a new card
  lands in Next), a pull past three rows asks first, Delete's confirm names the days. At 1000,
  where the columns are narrowest: titles clamp to two lines, meta lines wrap, the Move to select
  fits. At 375: the switch shows one column, the notice wraps, and with sign-in on
  (`web-local`) the sheet's five header buttons fit with the brand's name gone. Light and dark.
  The drag pass: at 1440, drag with the mouse between each pair of columns (Later and Next take
  the card where it is dropped), a done row onto Later (the notice, and Add a new card lands
  there), then by keyboard (Tab to a grip, Space, arrows, Space) with a screen reader, which
  hears where the card is and the done-item line, and Escape puts it back; with reduced motion
  on, nothing glides. At 1000 the copy under the pointer isn't clipped; at 375 a card sorts
  within the column shown, In progress and Done show no grip, and Move to still moves.
  Categories (with about 30 added by `curl` to `/api/board/categories` for a long list): the
  capture chip (a pick, New category, kept after a reload), a card editor's chip by keyboard
  (the arrows, Home/End, Enter, Escape) with its list scrolling inside and the box in view, the
  cards' dot and name (a long name at 1000), and Settings → Board (a rename, a name in use,
  the swatches wrapping at 375, Remove, the touch areas).
- **The History calendar**: one month at the mobile preset: ◀ to a seeded month, tap a day,
  **Open day**, browser Back lands on that month with the day picked, and back through the
  header, **Review this week** lands on that week. Review → Month → ◀ → a row → Back lands on
  that month's review; ◀ on Days, tap a day, Review, Days keeps the month and the pick. With
  the sticker chart on (`PUT /api/settings {"stickers":true}`), a chip narrows the grid to one
  sticker and a second tap clears it; with Show weekends off, five columns.
- **Retention**: one look at Settings → Data (count line, toggle saves); drive the delete with
  curl (`POST /api/days/prune`) because of the confirm dialog.
- **Auth**: no browser pass; the tests in `server/auth/` (`*.test.ts`) cover local and OIDC
  sign-in, cookie sessions, passwords, the limiter, user management and the reset-password
  command.
- **Anything a README screenshot or the Unraid listing shows** (sheet, retro, history, review,
  settings, the board): `npm run screenshots`, then CONTRIBUTING's screenshot step. The board's
  shot comes last and turns the board on first, so every other shot is taken with it off.

## Gotchas

- `npm ci --ignore-scripts` is deliberate (the Dockerfile says why). There is no Docker on the
  dev machine, so `image-smoke` (`scripts/smoke-image.sh`) on each PR is the image's first run.
- The preview harness exports `PORT=5173`, which is why `dev:server` pins `PORT=3000` and the
  `prod` config `PORT=8090`.
- `client/public/sw.js` caches nothing, on purpose. It holds the `notificationclick` handler
  for the notifications `alerts.ts` shows through it (Chrome on Android refuses
  `new Notification()`). It has no fetch handler, because Chrome needs none to offer Install
  and warns that an empty one is a no-op. It is registered only in a production build. No
  caching without a versioning strategy, or users see stale assets.
- OIDC: `loadConfig` normalizes `APP_URL` (only its scheme and host are kept, lowercased; a
  path is dropped with a warning), and `${APP_URL}/auth/callback` in that form must match the
  redirect URI registered with the provider exactly. The callback builds its URL from
  `APP_URL`, not from request headers, so it works behind proxies. `OIDC_ISSUER` must be
  `https://` (openid-client refuses plain http) and is checked but kept as written, since the
  provider's tokens must match it.
- `TRUST_PROXY` is a hop count (`1`), never `true`: `true` trusts the leftmost
  `X-Forwarded-For`, which the client controls, and the login limiter keys on `req.ip`. Left
  unset behind a proxy, every sign-in is the proxy's address; under `AUTH_MODE=local`,
  `warnUntrustedProxy` (`auth/limiter.ts`) logs that once, the first time `X-Forwarded-For`
  reaches `/api/auth`.
- `window` `focus` events fire on ordinary clicks in some embedded browsers, so the periodic
  and come-back refreshes (today's day, the settings, the timer's sync, the board) go through
  `useRefreshLoop`, which listens for `visibilitychange` and never `focus`; a new one goes
  through it too, and nothing in the app listens for the window's `focus`. Reads tied to what
  is shown (a held day read again when a view shows it, a range asked again after a prune,
  `AuthGate`'s `/me` after a 401, the board read as its page opens and after a prune) are not
  refreshes and stay outside the loop.
- The board's refresh lives in `BoardRefresh` (`hooks/useBoard.tsx`), a child the provider
  mounts only while the board is on: switching it on reads at once (StrictMode's second mount
  lands inside the loop's throttle), and nothing ticks while it is off. So the test files that
  render `AppProviders` with `api` automocked need nothing for the board: `TEST_SETTINGS.board`
  is false, and the provider sends nothing.
- Prettier leaves `*.md` alone: wrap docs by hand.
- A workflow step that must trigger CI needs a GitHub App or personal token.
- The Node floor (`engines` and `devEngines` in `package.json`) has no upper bound, and `.npmrc`
  has no `engine-strict`, on purpose: Dependabot's updater reads both files and runs its own
  Node. A cap it outgrows, or a package whose `engines` leaves its Node out under
  `engine-strict`, stops its npm updates without failing any check: the PRs just stop coming. A
  new Node major moves `.nvmrc`, both fields, the Dockerfile's two `FROM` lines and the
  `@types/node` major together (Dependabot skips the majors of the last two), plus the docs that
  name the version; CI and `.claude/launch.json` read `.nvmrc`.
