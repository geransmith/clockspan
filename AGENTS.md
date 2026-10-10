# Clockspan — agent guide

## What this is

A self-hosted, single-day **focus sheet** for working through a workday with ADHD: a punch-style
timeclock (lunch deadline, end of day, celebration), top priorities (default three, with a
nudge when the list grows), a focus timer that logs what was done and for which priority, a
retrospective card (plan vs. log, a "why" note, a nudge before clock-out), a week / month /
quarter review, alarms for lunch, clock-out and the second meal period, and an optional Board
page for tasks that aren't for today (off by default; its In progress column is today's Top
priorities, and tasks carry categories, made from a chip or in Settings → Board; the same switch
brings recurring priorities, set up in Settings → Board and offered on Top priorities on their
weekdays). Each task (a priority, a board card, a recurring priority) is stored once, with one
name, one category and one note; a day's list names the tasks on it.
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
                        open lanes (OPEN_LANES, OpenLane), how far back a task left open is offered and
                        shown (LOOKBACK_DAYS), the server's caps on the board (BOARD_LIMITS), the category
                        colours (CATEGORY_COLORS) and the header naming the server's version (VERSION_HEADER)
  sounds.ts             the sound catalog (SOUNDS, SOUND_EVENTS)
  dates.ts, timer.ts    date keys, the time spans (MINUTE_MS, HOUR_MS, DAY_MS) and cutoffKey (the server's
                        own date bounds); pause-aware session timing (activeMs, plannedEndAt,
                        pausedSecondsAfter, PLANNED_SECONDS)
  punches.ts            kindForPosition: a punch row's kind is its position's parity; punchesKey: a list's
                        rows and times as one string; samePunches compares two lists by it;
                        mergePunches: a punch save laid onto the stored list as the times changed since
                        its base; MAX_PUNCHES (the server's row cap; the card hides Add extra out / in at it)
  priorities.ts         hasText; isFree (a row no task is on: the client pads a list with these, and a new
                        priority goes into one); mergePriorities: a priorities save laid onto the stored
                        list as the changes made since its base, rows matched by their task's uid, field by
                        field as MERGED lists
  text.ts               sameText: the key a task typed again by hand is matched by (Plan tomorrow's typed
                        rows, Review's Not done), and category names are compared by; categoryName,
                        taskTitle and taskNote: a category's name, and a task's name and note, as the
                        server stores them; cutText: text cut to a limit with no half character left (a
                        lone surrogate becomes U+FFFD, as SQLite stores it), which every cut of a name,
                        label or note goes through
  backoff.ts            nextBackoff: the wait between retries of a request that must answer
server/                 Express API → dist/server
  app.ts                createApp(): headers, /api/health, /api/auth/me for every mode, auth routers,
                        data routers behind requireAuth (each answer naming the server's version),
                        static files and the SPA fallback;
                        startBackgroundJobs() (the login purge, the retention schedule and, under
                        OIDC, warming the `Discovery` index.ts passes in; started by index.ts only)
  security.ts           every security header, rejectCrossSiteWrites and rejectUnknownHosts
  config.ts, db.ts      env parsing (throws on bad config); pragmas, MIGRATIONS and migrate, the default user
  migrations/           the migrations that need code, frozen: oneItem.ts (13: each task stored once,
                        items backfilled from the cards, recurring priorities and per-day rows)
  settings.ts           mergeSettings (defaults + validation on every read and write), loadSettings
  board.ts              tasks as the board sees them: boardJson (listDate and listDone read from the entries,
                        listed and logged from itemCounts; the categories and the recurring priorities)
                        and the window of tasks it sends (LIST_WINDOW_DAYS, PLANNED_WINDOW_DAYS),
                        weekdayMask (a recurring priority's weekdays as the table's mask), placing and
                        renumbering a lane, the one lane rule a save follows (nextFromLater), collectItems
                        and deleteItem
  retention.ts          old-day pruning (pruneDays, runRetention, the RETENTION_DAYS cap)
  validate.ts           isWholeNumber: the one check for every bounded whole number the server takes;
                        isOneOf: a value from a fixed list (a setting's choices, a category's colour);
                        parseId: a route's numeric id
  refuse.ts             refuse(): sends an ErrorResponse; every API refusal but the timer-start 409 goes through it;
                        STALE_CLIENT, the 409's message to a page loaded before tasks were stored once
  auth/                 session cookie, scrypt passwords, the login limiter, publicUser, logName and the
                        local-account queries (users.ts), middleware (currentUser), local + OIDC routes,
                        resetPassword (reset.ts: what the reset-password command does)
  routes/               the days, sessions, breaks, settings, items (a task's own create, edit and delete)
                        and board (GET /board and the categories) routers; shared.ts has findDay,
                        ownedRouter (rows of a day, by id), uidRouter (rows of a user, by uid: categories
                        and tasks), parseUidField (an optional uid field) and the session and break row →
                        JSON builders (dayJson is in days.ts)
  dev/                  seed.ts + seed-cli.ts (`npm run seed`), harness.ts (startTestApp for route tests)
  index.ts, cli.ts      the process entrypoints: the server (warns under AUTH_MODE=none), reset-password
                        (reads the arguments and prints resetPassword's answer)
client/                 Vite root → dist/client
  public/               manifest, sw.js, icons/icon.svg (the icon's one source; `npm run icons` renders
                        the PNGs next to it)
  src/App.tsx           Shell (route, settings dialog) inside AppProviders (hooks/AppProviders.tsx); today's
                        alarms are hooks/useTodayAlarms.ts
  src/api.ts            fetch wrapper (30 s timeout; UNAUTHENTICATED_EVENT on a 401 from anything but login and
                        /me; the reload banner when an answer names another version; throws
                        lib/apiError.ts's ApiError, which a caller checks with instanceof, and beside
                        it unlessGone counts a delete answered 404 as done);
                        src/types.ts re-exports the shared types (types only)
  src/lib/              logic with no React, a test beside each file (the browser-facing ones stub the
                        globals, as alerts.ts does; apiError is covered through api.test)
    optimistic.ts       a server copy plus pending changes, which the stores are built on, and `serial()`,
                        their write queue
    alerts.ts           the one place that plays sound, shows notifications and pushes banners
    copy.ts             every line the app raises at the user; no logic
    storage.ts          localStorage that never throws (private mode, quota); readDaySet / addToDaySet, a
                        set kept for one date under one key; the per-user keys (USER_KEYS:
                        fired alarms, Start fresh, the break-over mark, the board boxes' category, the
                        morning offer's answers) and adoptUser, which records who the app is open for
                        under AUTH_USER_KEY and drops the last user's keys
    board.ts            the board's columns from the tasks and today's rows (boardColumns), what a move
                        does and which store it writes (planMove, moveTargets, MoveRefused), the cap
                        the store checks before it sends a lane (boardFull, addsToLanes), where a drop
                        lands and what a drag says (dropTarget, withDrag, overAnnouncement,
                        moveAnnouncement), the left-open rows the offer brings back (offeredLeftovers),
                        the category chip's data (CategoryPick) and what New category makes of a name
                        (categoryForName, nextColor, categoryNameTaken), and the board as a write shows
                        it (withItem, withItemPatch, withoutItem, withCategory, withCategoryPatch,
                        withoutCategory)
    popover.ts          placePopover: where the category chip's list goes on screen (under the chip or
                        above it, inside the viewport)
    recurring.ts        the morning offer's routines: which are due (dueRecurring, notOnList), which
                        it ticks (offerPicks, recurringCount), the list after Add to today
                        (acceptOffer; recurringRow, the recurring priority itself as a new row)
    shortcuts.ts        the single-key shortcuts: the one key list (SHORTCUTS) and the guard that
                        leaves a key to a field, a dialog or a drag (shortcutFor)
  src/hooks/            state and effects (useDay, useTimer, useSettings, useBoard, useAlarms, …), each
                        with a happy-dom test beside it (useLatest is covered through the hooks that use
                        it, and AppProviders through the tests that render it).
                        useClock is the app's one 1-second clock; useSaveStatus
                        (Saving… / Saved / Not saved) serves the settings dialog; useBoard is the
                        board's store (BoardProvider and its refresh; its deleteItem is also the sheet's
                        Delete everywhere) and useCategoryPick, the category chip's data and inline
                        create; useMediaQuery follows a media query for behaviour; useFollowedDraft is a
                        text box's draft that follows the stored name; useRecurringAnswered keeps the
                        recurring priorities the morning offer was answered for today on this device;
                        useShortcuts binds a key beside its button (useShortcut) and is the one
                        keydown listener (useShortcutListener).
                        src/test/fixtures.ts has the plain factories and TEST_SETTINGS (no React);
                        src/test/hooks.tsx re-exports fixtures.ts and AppProviders and has
                        SettingsAndDays, serveRange (a mocked getRange that answers from a list of
                        days), ShortcutKeys and pressKey (the key listener, and a key pressed where
                        the focus is) and the act() helpers
  src/components/       the cards, History (Calendar + Review), Banners, FinishChoice, RemoveTask (×'s Off
                        this day / Delete everywhere), TodayOffer (Top priorities' morning notice),
                        Shortcuts (the key listener, and ? for the list of keys), and
                        the pieces several of them share (Folded: a long list's Show all; CategoryChip
                        and CategoryDot; RepeatMark, a recurring row's mark, and RunningMark, the
                        running session's pill, kept here so the sheet can show them; Note, a task's
                        note button and box, on a priority row and a board card; TimerLengths,
                        the timer's length buttons and their tap, on the timer card and a board
                        item's editor); settings/ holds SettingsDialog (the shell and tabs), a file per
                        tab (BoardTab: the categories and recurring priorities, shown while the
                        board is on), and controls.tsx; board/ holds the Board page (Board,
                        BoardCard, Capture: a column's box, opened by the + in its head, ClockBar:
                        today's times above the columns, and dnd.ts: its collision and keyboard
                        settings for dnd-kit), its own lazy chunk
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

## Questions and suggestions

Ask and push back as a product manager would. When a request leaves a gap (what an edge case
should do, how it fits what is already there) and the answer changes what gets built, ask
before building. Suggest features, or a better or simpler way to build what was asked, freely
in the reply. Build only what was asked: a suggestion stays out of the diff until the owner
takes it up. A lean-code rule limits the diff, not the questions.

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

Start from `npm run seed`, not an empty DB (`server/dev/seed.ts`, whose comments say what each
template writes). A run deletes every day, task (recurring priorities and deleted tasks'
tombstones included, since the sample's uids are fixed) and category of the user it seeds,
hand-made ones included, then writes the last 10 weekdays and today. The last weekday has an extra
out/in pair and "Reply to the recruiter" added mid-day, in no category; then come a normal, an
overtime, an unreviewed and a half day, recurring further back (`kindForDistance`). Today is
clocked in two hours before *now*, with the last weekday's first open one-off carried to row 1 (the
same task), row 2 ticked, and a log of sessions and breaks. One-off tasks on a list have no lane;
four were captured on the board, three in Later and "Follow up on the Acme SLA" in Next. Two tasks
have a note (`NOTE_OF`): "Write a KB for the SSO reset", in Later, and today's row 3, "Answer the
two open support threads", on two lines. The board has four categories (`SEEDED_CATEGORIES`) and
two recurring priorities (`SEEDED_RECURRING`: "Monitor the queue" Monday to Friday, "Follow-ups"
Monday, Wednesday and Friday), listed on each past weekday they are due and never today. With the
board on, today's sheet offers them on a weekday (`--today` a weekday if needed); today's seeded
one-off rows hide "Still open from …", so for both groups take those rows off today's list and
reload: × on today's sheet (Off this day where it asks), or, since today lists no routine,
`curl -X PUT localhost:3000/api/days/<today>/priorities -H 'content-type: application/json' -d '{"priorities":[]}'`.
A reseed leaves this device's answers to the offer, so if it was answered today, first run
`localStorage.removeItem('focus:recurring-answered'); localStorage.removeItem('focus:left-open-dismissed')`
in the page. The carried task stays on the last weekday's list, open (the board shows it in Next
as left open), so "Still open from …" offers it. The seed writes no settings, so the board is off
on a new dev DB or after `--fresh`; this turns it on:
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
  (`auth/limiter.ts`). `Clockspan-Version`, which guards nothing, is set in `app.ts` on the data
  router (see "A page left open across an update asks to be reloaded").
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
- **The server stores epoch milliseconds and never decides what "today" is.** The client sends the
  local date key `YYYY-MM-DD` (`shared/dates.ts: todayKey`). The container's TZ is irrelevant, and
  no user zone is known server-side. The server's own date keys are bounds only, from `cutoffKey`
  (`shared/dates.ts`: the UTC key N days from now), each far enough from now that a day of zone slop
  changes nothing: the prune's cutoff ("keep the last N days", 30 at least), `GET /board`'s window
  (`LIST_WINDOW_DAYS` back, `PLANNED_WINDOW_DAYS` ahead, in `server/board.ts`) and how far ahead a
  day may be written (the days router's `date` param handler refuses a write past
  `WRITE_AHEAD_DAYS`, a year and a month of slack, since a list saved there would only grow the
  tables).
- **Old-day deletion goes through `pruneDays` (`server/retention.ts`)**, whether from the Data tab's
  button (`POST /days/prune`) or the scheduled `runRetention`. It deletes `days` rows before a date
  key (cascades take punches, entries, the old per-day rows in `priorities_v1`, sessions, breaks),
  never a day with a running session, and never settings, categories or recurring priorities in use.
  The Data tab sends it through the day store's `pruneBefore`, which reads the held days before the
  cutoff again and moves `generation`, so the ranges on screen ask again. The per-user setting
  `retention { enabled, days }` is capped by `RETENTION_DAYS` (`config.retentionDays`) via
  `effectiveKeepDays`; a user with no settings row still gets the cap. The same prune, in its
  transaction, also deletes the tasks it leaves done and named by nothing, the tombstones of tasks
  deleted before the cutoff and at least `RETENTION_LIMITS.min` (30) days ago, whatever the cutoff,
  so a page that still holds a deleted task can't make it again, and any task nothing names
  (`collectItems`, which takes an archived task only here); never an open task in a lane or a
  recurring priority in use (`pruneDays`' doc has the steps). With retention off and no
  `RETENTION_DAYS` cap only Delete old days now prunes, so tombstones and removed recurring
  priorities stay until then. It answers both counts (`Pruned`: days and tasks, tombstones
  included), and `POST /days/prune` reports the days; the Data tab reads the board again after its
  delete while the board is on. `reclaimSpace` (VACUUM + WAL checkpoint) runs after a prune that
  deleted a day or a task and after an admin deletes a user (`DELETE /api/auth/users/:id`), so the
  file shrinks and deleted text does not stay in free pages; it must not run inside a transaction.
- **Every data query is scoped by `req.user.id`** (`currentUser(req)`). In `AUTH_MODE=none` that is
  the single `kind='default'` user. Never add a data route outside the `requireAuth` router in
  `app.ts`. Every `/:date` route sits on the days router (`routes/days.ts`), whose `date` param
  handler (`router.param`) answers 400 for anything but a real `YYYY-MM-DD`, so a route added there
  is checked with nothing to list. Register a literal path under `/days` (like `/range`, `/prune`)
  before `/:date`. The session and break starts are registered there with handlers from their own
  files. The `/sessions/:id` and `/breaks/:id` routes sit on a router made by `ownedRouter()` in
  `routes/shared.ts`, which is where the ownership check lives: it is that router's `id` param
  handler (`router.param`), so every route on it with an `:id` is checked, one added later included,
  with nothing to list on the route. It answers 404 for another user's row or none, and the handler
  reads the row with `owned(res)`. A table whose rows hang off the user rather than a day and are
  named by a uid (categories, `/board/categories/:uid`, and tasks, `/items/:uid`) gets the same from
  `uidRouter()` beside it, as the router's `uid` param handler: the uid's shape is checked, it is
  matched lowercased, and anyone else's, none, or a deleted task's tombstone (`UID_GONE`) is a 404.
  `getOwnedByUid` still returns a tombstone, so `POST /items` sees that its uid is taken.
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
  Components and hooks never re-derive these. A stored day, today's included, goes through
  `dayTimeclock`: its own length through `daySettings`, then `clampToDay`
  (`now = min(now, endOfDay)`) and `{ frozen: true }` once past.
- **Times are written through `useTimeFormat()`** (components) or `formatTime(ms, hour12)` with
  an explicit `hour12` (pure libs: `describeEvent` takes it on `EventContext`). The setting is
  `timeFormat: 'auto' | '12h' | '24h'`; `resolveHour12('auto')` asks the browser locale, so the
  default changes nothing for anyone. `TimeField` shows its AM/PM segment from the same answer.
- **All user-facing alerts go through `client/src/lib/alerts.ts`** (`alert()`, `playSound()`,
  banners). Never call `new Notification(...)` or `showNotification()` (its fallback where the
  constructor is refused, Chrome on Android), create an `AudioContext` or fetch a clip anywhere
  else. `unlockAudio()` must be called from a user gesture (the timer's length buttons,
  `TimerLengths`, on the timer card and a board item's editor, `useBreak`'s `start`, every
  punch commit and the shortcut listener, for a timer key, do this) for iOS. What plays is
  `settings.sounds[event]`, an id from the catalog in `shared/sounds.ts`; `settings.sound` is the
  master switch over all of them, and `none` is the per-event off. A celebration (day complete and
  work week reached in `Timeclock.tsx`, a priority ticked in `Priorities.tsx` or on the board (its
  checkbox, Move to Done, or a drop into Done), the next day planned in `PlanNext.tsx`) is a
  `useCelebration(moment, event)` (`hooks/useCelebration.ts`): the sound under `settings.sound`, the
  burst under `settings.celebrations`. A state's moment comes from `useBecameTrue`, so it is the day
  *becoming* done while the card is mounted, never a done day opening. A moment raised before the
  settings have loaded is dropped, and the work-week moment is null until `loaded`, because its
  target is a setting. The day-complete moment counts only when this card set the Clock out, or the
  clock reaches one typed ahead: another device's punches arriving by a refresh are not a moment.
  The sound plays after the render, so a moment set by a tap calls `unlockAudio()` in that handler
  first.
- **Timer remaining time is derived from the server's `startedAt`, `plannedSeconds` and pauses** on
  every tick (`timerView()` in `client/src/lib/timer.ts`, on `shared/timer.ts`) — never a
  client-side counter. A paused session is still `status = 'running'` with `pausedAt` set;
  `pausedSeconds` holds the pauses that have ended, and the planned end moves forward while paused.
  A finish while paused ends the session where the pause began, and a pause left for
  `PAUSE_LIMIT_SECONDS` (an hour) is finished by the client with a quiet banner. **A timer that runs
  out is not finished at once**: it is `due`, announced once per (session, planned end) — `dueKey`,
  kept in the page and in `localStorage['focus:timer-due']` so a reload shows the banner again
  without a second chime — and waits `DUE_GRACE_SECONDS` (10 min) for an answer before the
  auto-finish (which chimes only if nothing has for that end). The auto-finish and the banner wait
  while a come-back sync is out (`syncing`), as the alarms do, and the auto-finish sends the plan
  and pause it judged by: the server refuses (409) a session another device has changed since, and
  the timer syncs, as it does when the finish finds the session deleted there (404). The banner goes
  while a press that took it away is on its way, and comes back, quietly, if that press fails. Plans
  are whole minutes: `adjust` rounds the new plan up to one and stops at `PLANNED_SECONDS.max`
  (8 h), where `canAdd` turns false, + is disabled and the "Time's up" banner is raised again,
  quietly, without its Add button. The banner names the session (`useTimer().name`) as it was when
  raised, as its notification does: a rename while it is up shows in the bar, the timer card and the
  tab title, and never raises it again, which would bring a closed banner back. The Finish buttons
  call `requestFinish()`: it finishes unless the timer is due and the planned and worked lengths
  differ in their whole minutes (a minute or more over), where `finishChoice` opens the
  `FinishChoice` sheet (Planned · Nm / Worked · Mm / Back). A finish goes out behind any press still
  on its way. The choice belongs to the due end it was asked for (`finishChoiceFor`, a `dueKey`):
  once the timer is no longer due at that end (time added or a pause, here or on another device, or
  the session ending however it ends), the sheet goes and stays gone. `useTimer` keeps the running
  session the way the day store keeps a day: a press (adjust, edit, pause, resume) shows at once, a
  failure drops only that press, and a sync's answer never hides a press still on its way. Keep that
  pattern for new mutations.
- **One running session per user is a schema invariant** (a unique partial index), and another
  device may own it: a 409 on start is adopted with a banner, a sync whose answer differs from the
  session shown refreshes that day if the store holds it so the log catches up (a day it doesn't
  hold loads with the row when it is opened), a 404/409 on any press on the running session re-syncs
  at once (`runNow`), and so does a refused break start, and the completion chime only plays when
  the server says `completed`.
- **Nothing alerts before the settings have loaded.** The timer's two alerting effects and the
  break-over alert (`useBreak`) wait for `useSettings().loaded`, or an alert raised on load
  would use the default sound and switch; the alarms (`useTodayAlarms`) wait for it the same
  way (the punches they judge stay null until `loaded`), or a longer work day than the default
  would ring the clock-out alarm on load. So `loaded` only turns true on a real answer: a
  failed `GET /settings` is retried (`nextBackoff` in `shared/backoff.ts`: 2 s doubling to a
  minute), never settled with the defaults. After the first answer the settings are fetched
  again on `useRefreshLoop`, like today's day, since another device may change them.
- **Today's day is kept in step with the server** (`useRefreshDay` in `useDay.tsx`, on
  `useRefreshLoop`: every minute and when the tab comes back, throttled to 5 s per caller), so the
  alarms in `useTodayAlarms` judge the server's copy of the punches, not one from hours ago; they
  wait while a come-back refresh is out. Break's over waits the same way on `useBreak`'s own loop,
  which reads the day the break is on (yesterday's for a break from before midnight, while it can
  still ring). A today whose first load failed is loaded again on the same ticks (no second banner),
  so its alarms come back with the server. Any day the store holds is also read again each time a
  view shows it (`useDay`; one whose first load failed is asked for again then, quietly), and a
  range read (`store.readRange`) lands on the held days in it under the same `version` rule.
- **The day store keeps the server's copy and this device's changes apart** (`lib/optimistic.ts`):
  each day is its confirmed copy plus the changes not confirmed yet, and the sheet shows the one
  laid over the other. The confirmed copy is the server's answers in the order they arrived (a
  read's copy with each save's answer laid on it), so it is not always what the server holds now: a
  save's answer can be older than a read that landed first. A failed write just drops its change, so
  the screen is back on the confirmed copy at once (with the "Change not saved" banner), and the day
  is asked for again. A writer off the Priorities card (the board) changes a list through
  `editPriorities(date, fn)`: `fn` gets the rows the store shows now (`current()`), padded, and it
  answers `'saved'`, `'notLoaded'`, `'skipped'` (`fn` gave null) or `'failed'`, never rejecting. It
  saves through `setPriorities`, and `addPriority` goes through it. A delete or a break's end the
  server answers 404 for counts as done: another device removed the row already. A read's answer
  replaces the confirmed copy and never a change still on its way. It is stale when the server
  confirmed a change after the read went out (`version`): a day read then drops it (a day never
  loaded takes it anyway) and asks for the day again, whoever sent the read, while a range read's
  stale day is left to the next read. An answer the same as the confirmed copy changes nothing, so a
  day that didn't change keeps its identity. A day not loaded yet keeps its changes until the
  server's copy arrives, so nothing made up stands in for it. `pruneBefore` is the one store write
  sent on no queue (the queues are keyed by day, session and breaks), so a change still on its way
  for a day before the cutoff can land after the prune and re-create that day, which the re-read
  after the prune shows. After a full delete (the board store's `deleteItem`), a new name,
  category or note (its `editItem`), or a priorities save whose row renamed, filed or noted a task
  another day lists or logged time on, `taskChanged(uid)` reads again every held day whose list or
  log names the task, as a change the server confirmed (a read already out may have left before it,
  so its answer is dropped and the day asked for again), and moves `generation` as `pruneBefore`
  does, so no range on screen (the board's Done, History, Review) shows the task from an older
  answer. A priorities save that puts a task on its list or takes one off (Plan tomorrow, a carry,
  ×) reads again, the same way, the other held days whose lists hold that task, since their
  `listed` and `earlier` moved and × asks from them. The day store, `useSettings`, `useTimer` and
  `useBoard` are all built on `useTracked` (`hooks/useTracked.ts`); a board write rejects when it
  fails, like a settings save, and the board is read again. `apply` and commit functions are pure:
  read the clock outside them.
- **Suggested break lengths come only from `client/src/lib/breaks.ts`** (`suggestBreak`, pure, over
  a day's sessions); with Suggest breaks off the Break button runs `settings.breakMinutes`. With
  `suggestBreaks` on, `useBreak` offers today's suggestion on the Break button and as a quiet banner
  off `useTimer().finished`, which only a finish by hand sets (Finish, the finish choice, − past the
  time worked), never the auto-finish or another device.
- **A break is a row in the day's log** (`breaks` table, `Day.breaks`), never device state.
  `ended_at` is the planned end from the start and moves back when the break is ended early
  (`POST /breaks/:id/end`), so nothing finishes a break that runs out: it is running while `endedAt`
  is ahead of now (`runningBreak`), and one that ended before its planned end was cut short, which
  is why only a full-length break rings "Break's over" (once per break, keyed by its start in
  `localStorage['focus:break-over']`, since SQLite gives a new break the id of a deleted newest
  one), and never while a timer runs. The server keeps breaks from overlapping sessions: a break
  start ends a running break and is refused (409) while a focus timer runs, and a session start ends
  a running break (`endRunningBreak`, `routes/shared.ts`). However a break ends, one that ran under
  `MIN_BREAK_MS` is deleted, not logged (`POST /breaks/:id/end` answers `{ break: null }`). End
  break goes through `endRunningBreak` too, so the server has one copy of that rule. The client
  mirrors both rules with `endBreaksAt` (in `useDay`'s break writes and `applySession`, which ends a
  running break on any loaded day, since one started before midnight sits on the day before), so it
  never sends an end after a session start: the break may already be gone. The timer card disables
  its start and break buttons while a timer or break start is out (one `useSubmit`, and
  `useTimer().starting` for a start from the board, whose Start holds on it too; R, the Break
  button's key, goes through the same `run`), since a break write goes out on the day store's
  queue, not the timer's, and the two could reach the server in either order; for the same reason
  a session start takes the break banners down in its tap (`dismissByTag('break')`, in
  `TimerLengths`), whose Start break those buttons don't cover.
- **Saves reach the server in the order they were made**, each store's on its own queue (`serial()`
  in `lib/optimistic.ts`, made by `useTracked`). In the day store, `setPunches` and `setPriorities`
  send a whole list, so one PUT per list and day is in flight and only the newest waiting list
  follows it (`sendLatest` in `useDay.tsx`); a failed list save also drops the lists waiting behind
  it, which were built on the one refused. Each list goes with its `base`, the list it was built on,
  and the server merges it with what it holds (`mergePunches`, `mergePriorities`); the newest list
  goes with the base of the oldest list not sent yet, so it carries every change since. That needs
  every list that takes a waiting one's place to be built on `current()`: the Priorities card
  flushes its draft and a row's note on blur, before any other sheet control acts, and
  `setPunches` and `editPriorities` (which `addPriority` and a row's note go through) build on
  `current()`. The day's other fields (`day:<date>`), each session (`session:<id>`) and the breaks
  (`breaks`) queue their writes one after another (`inOrder`). `useTimer` sends the running
  session's writes one at a time on its own queue: start, adjust, edit, pause, resume, finish and
  cancel, the log's edits of the running row included. That queue is not ordered against the day
  store's `session:<id>` queue, which carries the other rows' edits and deletes. Three jobs wait
  across queues: a session start or edit that names a priority's uid first waits, inside its own
  queue's job, for that day's priorities save still out (`prioritiesSaved`), since the server
  refuses a task that day's list doesn't hold yet; a board job that changes a day's list waits for
  that save (below); and a timer start whose uid is a promise awaits it first inside its job (the
  timer card's Also add hands it the new row's save, a board item's Start its pull), so it names the
  task once today's list holds it. `useSettings` sends its PUTs and resets one at a time. The board
  (`useBoard`) sends each write as one job on its own queue, its change to the tasks shown from the
  moment it is made; a job that changes today's list (a pull, a row typed in In progress's box, a
  tick, a rename, category or note of today's row, Remove from today, which leaves a free row as ×
  does, `takeOffRow`) goes through `editPriorities`, and so on the day store's list sends, and
  awaits that save inside the job. A park waits for today's save still out, PATCHes the task's
  lane, then takes its row off today's list and reads the board again; Delete (`deleteItem`, the
  board's and the sheet's) waits for today's save, then sends `DELETE /items/:uid`, which takes
  every day's entry and leaves the tombstone. `useBoard.tsx` says why each goes in that order. A
  board PATCH of a task off today's list needs no wait: the board read that task from the server.
  A new edit of a day's rows, the settings, the timer or the board goes through one of these, never
  straight to `api`. Reads are not queued, and in every store a read's answer never replaces a
  change still on its way.
- **Punch positions are fixed**: 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in pairs,
  and **the last row is always the Clock out** (an odd position ≥ 3; `normalizePunches` enforces
  it). Kind is parity (`kindForPosition`, `shared/punches.ts`). The math evaluates *set* punches
  chronologically; `extraPairs()` only decides where the card *shows* a pair. Today a time typed
  ahead of now counts once the clock reaches it (its order is checked at once); a past day counts
  every time it has. Today ends only at the Clock out, when it is the latest punch reached, with the
  target met or not; an extra pair's Out is a break, the second meal included, and never ends it. A
  past day ends once it is off the clock. "Add extra out / in" appends two rows, so the old Clock
  out becomes the new pair's Out. Removing the pair an Add just made, before any punch changes,
  undoes the Add and gives the Clock out its time back (`Timeclock` keeps the rows from before it in
  its state, so a remount ends the undo; see the comment there); removing any other pair drops its
  two rows (`removePunchPair`). Lunch semantics come only from positions 1 and 2. A punch save is
  merged with what another device saved since (`mergePunches`): each row takes the time sent where
  it differs from the save's base and the stored one otherwise, and a pair added or removed on
  either side sends the list as it is. Punches out of order (`outOfOrder`, from `orderSlip` in
  `lib/timeclock.ts`: the first punch out of place and the one it should come after) are named by
  the sheet's notice (`PUNCH_ORDER`), which describes that row's field; such a day counts in no
  hours total (the week line, Review's worked time and target) and shows a dash and `CHECK_PUNCHES`
  wherever its own hours would show (the sheet's tiles, the board's clock bar, History's cell and
  day panel).
- **A punch row saves only complete times.** `TimeField` (React Aria segments) commits the moment
  hour, minute and period are all filled, and throws a half-typed draft away when focus leaves the
  field or on Escape, which keeps focus in the field, so the row never shows a time the server
  doesn't have. In 12-hour mode the period is filled in as the hour is typed (`guessPeriod` in
  `lib/timefield.ts`), and left alone once the user has touched that segment, until the row is
  cleared. Clearing is the row's × button only. Punch PUTs are queued per day (see "Saves reach the
  server in the order they were made").
- **Overtime approval (`days.overtime_approved`) silences only the `clockOut` alarm target.**
  Lunch and the second meal period stay armed: California Labor Code §512 still requires them
  on an overtime day. Approval also arms the second meal on a day whose work day doesn't pass
  its threshold: `secondMealApplies` counts an approved day as one that will pass it, so the
  alarm and the card's note start when the switch is set, not when the day runs over. The
  setting `overtimeApproval` shows/hides the switch and banner button, and with it off the
  Clock out tile (and the board's clock bar, which takes its words) reads time past the day as
  "past your day" rather than a red "Over by"; a flagged day counts only while the setting is
  on: `overtimeOn` (`lib/timeclock.ts`) decides, which `Timeclock` (the tiles get the flag from
  it), `ClockBar` and `useTodayAlarms` call.
- **`mealRules: false` turns the meal periods off in the math, not in the components.**
  `computeTimeclock` then never needs a lunch (`not-needed`, so no lunch alarm and no lunch added to
  the clock-out time) and `secondMealApplies` is false; a lunch that was punched still counts. The
  card drops the Lunch by tile (the Focused tile shows either way), and the board's clock bar its
  Lunch by (`clockBarItems` reads `mealRules`, since a punched lunch is still `taken`). With
  `lunchPunches: false` too the card hides the Lunch out / in rows, which stay in the data at
  positions 1 and 2: `lunchRowsShown` decides (never on a day with a lunch punched).
  `stickerReasons` and `lunchInPunchOrder` follow the same switches. `trackHours: false` only
  hides hours outside the day's own tiles (the week line, History's hours, the Clocked out sticker
  via `stickerReasons`); the timeclock and the clock bar still run.
- **A task is stored once** (`items`, `server/board.ts`): a one-off typed on a sheet or made on the
  board, or a recurring priority (`weekdays` set), each with one name, one category and one note
  that every day it is on shows, past days included. A day's list only names its tasks (below). A
  note is plain text up to `LIMITS.itemNote`, stored as `taskNote` (`shared/text.ts`) gives it
  (control characters but line breaks and tabs dropped, never trimmed), and `''` is none;
  `POST /items` makes a task with none, and the list PUT's create stores the row's; only the
  sheet's rows and the board's cards edit it (see "A task's note"). A task's lane (`later`,
  `next`, or none) is the board's alone: the + of Later or Next, a park, a Move to or drop into
  Later or Next, and the done notice's Add a new card give one, and a task typed on a list has
  none. Done is never stored: the server answers each task's `listDate` (its latest entry's day)
  and `listDone` (that entry's tick), so the board and the days can't disagree. One lane rule
  follows a save: a task in Later added open to its latest list (no entry on a later day) goes to
  the top of Next (`nextFromLater`). A write sets the fields it changed and the last write wins:
  the list PUT writes a task's name (trimmed), category and note only where this
  device's row differs from its base row, reads a row sent without a category or a note (a page from
  before notes, curl) as keeping them (`unsaid`), makes a task for a uid new to the user (no lane),
  and writes nothing for a task new to that list (a carry, a pull, the offer), so a stale name never
  renames it; `PATCH /items/:uid` sets only the fields sent, and sets or clears one weekday at a
  time (`weekday: { day, on }`), so two devices' toggles both land. `POST /items` makes a task on
  the board (`lane`: Later's or Next's +, or a done item's new task) or a recurring priority
  (`weekdays`), never both; a uid that exists answers the board as it is (a retry), and an archived
  or deleted task's is a 404. The cap of 300 (`BOARD_LIMITS.openCards`) counts the tasks in Later or
  Next whose latest entry isn't ticked; only board writes reach it (`POST /items` with a lane, a
  PATCH giving a lane to a task in none), refused with a 400 (`FULL`, `routes/items.ts`), and the
  board checks it first (`BOARD.full`). A task's row is deleted in two places only: `collectItems`,
  which deletes the tasks no entry or session names that are a one-off in no lane, or, in the prune
  alone, archived (the list PUT runs it on the tasks it took off, a session delete, cancel or relink
  on the task the session left, the prune over everything), and the prune's tombstone step. So a
  task typed and taken off again leaves nothing, a task in a lane stays, and a task carried to a new
  day and taken off there keeps its earlier day. A cancel takes its session off the task too, since
  a cancelled session counts nowhere. Archived (`archived_at`) is a recurring priority removed in
  Settings, or a task the migration archived: it still shows wherever an entry or session names it
  (`Priority.archived`), is never in a lane or offered, and nothing unarchives it. A lane or an edit
  on it is a 404, and so is a second Remove of an archived routine; a full delete of an archived
  one-off still goes through. It stays until the prune, so a stale offer that adds it finds it
  archived and can't make a one-off under its uid.
- **A deleted task is a tombstone until the prune.** Delete, the board's and the sheet's × → Delete
  everywhere, is `DELETE /items/:uid` on a one-off task, `deleteItem` in one transaction: every
  session on it stays on its day as unplanned time, with the task's name (cut to
  `LIMITS.sessionLabel`) as its label and its category as its own (a running one runs on), every
  day's entry of it goes, and the row stays with `deleted_at` set, in no lane, named by nothing,
  keeping only its uid (which becomes its title; its category and note are cleared). Nothing brings
  it back: the list PUT drops a row naming it from the sent list and from `base` before the merge
  and stores the rest (no banner: the answer is the list as it stands), the uid router answers 404
  for it (see the scoping rule), `POST /items` with its uid is a 404, a session start or PATCH
  naming it is refused (it has no entry), `collectItems` skips it, and no read shows it. It stays
  until a prune deletes it (see "Old-day deletion"). `DELETE /items/:uid` on a recurring priority is
  Settings' Remove instead: a routine has no full delete. The board's Delete asks first with
  `CONFIRM.deleteTask(days, logged)`, the days the task is on and the time logged on it: for an item
  on today's list, today's row's counts plus the day's log (a timer running on it included, on the
  minute clock `App` passes), as × counts them; else the board's (`BoardCard.listed`, `logged`).
- **Priorities are entries of tasks, merged with what other devices saved.** A day's list is its
  entries (`priorities`: day, task, position, tick, `addedAt`; for the old per-day rows see
  "Migrations"), so a row's `uid`, `text`, `categoryUid` and `note` are its task's, and the rest is
  read only: `recurring` and `archived` from the task, and from `itemCounts` `listed` (the days
  whose lists hold the task), `earlier` (those before this one) and `logged` (its completed focus
  on other days; the day's own is in its log). A day never edited has none. The client pads a list
  to `settings.priorityCount` with free rows (`isFree`: no uid, no text) and saves the rows it
  shows, free ones included; the server stores each row with a uid at its place in the list and
  skips the free ones, so positions can have gaps where free rows sat (`padPriorities` fills them by
  position): the morning offer's routines stay after the padded rows, and a row typed under empty
  ones stays where it was typed. Add priority and the timer's Also add (`placePriority`, `hasRoom`)
  use the first free row or a new one at the end; a row Add priority puts past the stored list stays
  on the card while it is free (`added`: the card pads the stored list to it until a stored task
  reaches it, × takes it, or the card mounts again), and `planNext` (Plan tomorrow, the left-open
  Add) drops only free rows. The nudge (`nudgeFor`) never asks while the padded list has a free
  row, which the new row takes, and counts the one-off rows with text (`isOneOff`), while the
  warning's kind still counts every written row. Every reader of a list skips free rows with
  `hasText` (`shared/priorities.ts`). `PUT /days/:date/priorities` takes the list and its
  `base`, the list it was built on (the card's draft sends what its edits were made on, `PlanNext`
  and `addPriority` the day's shown copy), and stores `mergePriorities(stored, base, list)`, which
  the day store also shows while the save is out. Rows match by uid. Each field in `MERGED` (`text`,
  `done`, `addedAt`, `categoryUid`, `note`) takes this device's value where it differs from `base`,
  else the stored one. A row this device removed goes; one another device removed stays gone unless
  this device changed it (a rename or a tick brings it back). A row another device added since
  `base` stays, in this device's first free row or at the end. Two devices putting one task on a
  list send its one uid, so it is one entry, the stored one: the first save wins, so a copy that is
  behind can't undo a tick made since; the same text typed new on each is two tasks. Order is this
  device's, and removing a row is sending the list without it. A merged list longer than
  `MAX_PRIORITIES` is refused (409), never cut. A uid repeated in one list and a row with a uid and
  a blank name are 400s. With no base (curl) the stored list stands in for it.
- **A row's identity is its task's `uid`, never its position.** An entry is (day, task), and the key
  `(day_id, item_id)` allows one per task a day. The client mints a uid (`newUid()`) the first time
  a row gets text and stamps `addedAt`; the save that first names it makes the task.
  `sessions.item_id` points at the task (on the wire `Session.priorityUid` is its uid; null is
  unplanned), and `POST/PATCH` sessions check the task has an entry on that day. Carry-over (the
  left-open Add, Plan tomorrow, the morning offer, through `planNext`'s seeds) and a board pull put
  the same task on the new day with its own `addedAt`, never a copy, so time logged on it counts
  there too, and taking a task off a day and putting it back puts that day's time back on the plan;
  a seed typed new (`textSeed`, `uid: null`) gets a new uid. `placePriority`, `planNext` and
  `notOnList` match a task's row by uid alone, whatever its draft text (a seed typed new matches by
  its text, `sameItem`), so a task is never placed twice and a row whose box is blank still stands
  for its task. A recurring row, or an archived one-off, is never carried: `leftOpen` and Plan
  tomorrow skip it (`carriesOver`). A row the client builds before the server answers takes the
  read-only fields from its source (a carried row its source row's counts, a pull the board's
  `listed` and `logged`, a routine `recurring: true`), else the defaults (`emptyRow`, `newTaskRow`),
  and the save's answer replaces them.
- **A blank name is never saved, and × takes a task off a day** (`Priorities.tsx`). Emptying a box
  doesn't remove its task: while blank and focused the hint under it reads `BLANK_HINT(name)`,
  the list goes out with that row's name as it was (`named`; ticks and the other rows still save),
  its checkbox is disabled and its tick kept (`editPriority` clears `done` only on a free row), it
  still counts in "N of M done", and leaving the box or Escape puts the stored name back (a row
  typed and emptied before it was ever saved becomes a free row again). The server refuses a row
  with a uid and a blank name. Typing over a written row renames its task on every day; while the
  box's text differs from the name it had when it took the focus and earlier days' lists hold the
  task (`p.earlier > 0`), the hint reads `RENAME_HINT(earlier)`, an indicator rather than a
  question. × shows on every row with a task and every row past Rows per day: within Rows per day
  the row stays, free, with the focus in its box (`takeOffRow`), and past it the row goes. A
  recurring row, or a one-off on no other day with no time logged and no note, comes off at once; a
  one-off on other days (`p.listed > 1`), with time logged (`p.logged`, the other days', plus the
  day's log, `loggedByUid`, which counts a timer running on it) or with a note (`hasNote`; asked
  for the note alone, Off this day deletes the task too, `collectItems`, unless it has a lane, as
  `REMOVE_TASK.body` says) asks first in `RemoveTask` (built like `FinishChoice`:
  `useModalDialog`, the focus on the frame; `REMOVE_TASK`): Off this day (the × path), Delete
  everywhere (the × path, then the board store's `deleteItem`, which works with the board off; its
  failure raises the "Change not saved" banner and leaves the task off that day only), or Cancel,
  which puts the focus back on ×.
- **A task's note shows only when its button opens it** (`components/Note.tsx`). `NoteToggle` is
  the one sign a note is there: drawn filled with one, and quiet with none (see Conventions), with
  `aria-expanded` and `aria-controls`, named "Note for …" or "Add a note to …", so a screen reader
  hears both. Pressing it opens `NoteField` with the focus in it; Escape closes it with the text
  kept and the focus back on the button, and nothing is open on a load. The box grows to eight
  lines and then scrolls, Enter adds a line, and a ticked row's isn't struck through. `NoteField`
  stays mounted while closed, so a note whose save failed stays in its box, open or not, and goes
  again on the next edit, blur or unmount; where the title can't be edited the note is plain text.
  On the sheet (`Priorities`) the button sits in a written row's end cell before the chip (with
  the board off the cell holds it alone) and the box under the row, after its hint; each row's
  note is a draft of its own, keyed by the task, apart from the list's, and saves 400 ms after the
  last key through `onNote`, the day store's `editPriorities` (`Sheet.tsx`), whose `'failed'`
  keeps it. On the board (`BoardCard`) the button ends the title row of every card the board
  edits, or that has a note, and the box opens under the card's text, apart from the editor, saving
  800 ms after the last key; `onNote` takes the path `onRename` does (`editRow` for today's row,
  `editItem` for any other the board edits, none for an earlier day's row of a recurring priority
  removed in Settings), and `saved` (`lib/board.ts`) raises the banner and answers false. A routine's
  note is one on every day it is on. Nothing else shows a note: not Retro, Review, Plan tomorrow,
  the morning notice, the timer, the day log or History. A note of spaces and line breaks alone,
  stored untrimmed, counts as none (`hasNote`, `shared/text.ts`): its button is quiet and × doesn't
  ask for it. On the sheet, a row gone from the list before its note's save (another device took it
  off, or × did before the box saved) sends the note to the task through the board store's
  `editItem`, as `editRow` does: a 404 (the task went with the row) counts as done
  (`unlessGone`), and any other failure is the banner (`saved`).
- **A category is a row of its own, named by its uid** (`categories`, routes in `routes/board.ts`,
  answered in `Board.categories`). Tasks and sessions point at one by `categoryUid`, a soft link
  checked for shape only, so a category made on this device can reach the server after the row that
  names it. Removing one archives it (`archived_at`), never deletes it, so the time logged under it
  keeps its name; a `POST` of its uid brings it back with the name and colour sent. Names are unique
  among a user's categories in use, whatever their case or spacing (`sameText`), checked by the
  routes (the table has no UNIQUE on the name, which would stop the README's handover script), and a
  new uid can't take a removed one's name either: the client brings that one back. The server caps
  them at 100 in use and 1000 stored (`BOARD_LIMITS`), sanity caps with no product limit behind
  them; colours (`CATEGORY_COLORS`, checked with `isOneOf`) repeat. A session with a task counts
  under the task's category: the server answers `Session.categoryUid` worked out (the task's, else
  the session's own), so its own `category_uid` is read only while it has no task: one picked in the
  log (a pick for a session with a task takes it off the task too), or the task's, copied by a full
  delete. A `PATCH /sessions/:id` that links a session to a task drops a category of its own, and a
  category sent for a session that keeps its task is refused (400); the day store and the timer show
  an edit as the server will store it while it is out (`editedSession`). On the client
  `CategoryChip` is the one way a category is picked, fed by `useCategoryPick` (null while the board
  is off or before its first read, and then no chip shows), which the board page, the sheet and
  Settings → Board each call once and pass down as `pick`: the sheet's goes to Top priorities (a
  written row's chip, which saves at once), the timer (the row Also add makes,
  `addPriority(date, text, categoryUid)`), the day log (a session on no written row, in the edit's
  one PATCH) and, through the retrospective, Plan tomorrow (a row typed in; `disabled` while its
  save is out); Settings → Board's goes to its recurring priorities' rows, with `report` going to
  the dialog's `save`. A press on the chip
  keeps the focus where it is until the list takes it, so the day log's edit doesn't end (the
  browser reasons are in `CategoryChip`'s comments). Its New category box runs `categoryForName`
  (`lib/board.ts`): the category in use by that name, else a removed one brought back under its own
  uid, else a new one in `nextColor` (the colour the fewest categories in use have, so the eight
  repeat evenly). The chip sets that uid at once and the create goes out as an optimistic board
  write; opening the list reads the board again, and a create the server refuses (another device
  took the name, a cap) is taken off with the "Change not saved" banner (in Settings → Board, the
  header's Not saved), so what picked it reads as no category. The board columns' boxes share one
  category, the last picked on the device (`USER_KEYS.captureCategory`; a removed or unknown one
  reads as none). Settings → Board (`BoardTab`, shown while the board is on) adds (`categoryForName`
  again), renames (refusing a name in use, `categoryNameTaken`), recolours and removes categories,
  each through the dialog's `save`; a category's Remove archives it and doesn't ask.
- **A recurring priority is a task with weekdays** (`items.weekdays`, made and edited through
  `/items` from Settings → Board, answered in `Board.recurring` in the order they were made,
  archived ones left out): a title, a category and the weekdays it is offered on, ISO 1 (Monday) to
  7 on the wire and a mask in the table (bit 0 for Monday; `weekdayMask` in `server/board.ts`). The
  rows it adds are entries of it (`Priority.recurring`), so a rename or a category, in Settings or
  on its row on the sheet, reaches every day it is on, and the held days that name it are read again
  (`taskChanged`, see the day store rule). It is never in a lane (a `lane` sent for one is a 400).
  Settings → Board adds one (on Monday to Friday, no category), renames it, gives it a category,
  sets its weekdays (the last day on stays on) and removes it, through the board store's `addItem`
  with `weekdays`, `editItem` and `removeRecurring` and the dialog's `save`. It has no full delete:
  Remove asks first (`CONFIRM.deleteRecurring`, which says the days it was on keep it), since
  nothing in the app brings one back, then archives it, so it is no longer offered, listed in
  Settings or counted toward the cap, and the days it was on keep it; a 404 on that delete counts as
  done (an archived routine is one), and only the prune deletes it, once nothing names it. The
  server caps them at 100 in use (`BOARD_LIMITS`), a sanity cap with no product limit behind it, and
  the prune never takes one in use.
- **Today's sheet offers what the last planned day left open and, with the board on, the recurring
  priorities due** (`client/src/lib/recurring.ts`, `components/TodayOffer.tsx`), in one morning
  notice on Top priorities, worked out on the client, board on or off. "Still open from …" (the
  leftovers: `leftOpen`'s rows, over the same `LOOKBACK_DAYS` the board's left-open group reads)
  shows while no one-off row has text (`useLeftOpen`'s `wanted`, which a routine on the list doesn't
  count). With the board on they are `offeredLeftovers`', which drops one whose task the board's
  copy has in Later or done (`listDone`) and offers one the copy doesn't hold (a read behind), so
  nothing is offered until the board has loaded; a leftover in no lane shows in Next as left open
  too until it is brought back. "Repeats today", with the board on, lists the items due
  (`dueRecurring`: the date's ISO weekday, `isoWeekday` in `shared/dates.ts`, computed in UTC from
  the key; no row of the list is its task, `notOnList`, a row whose box is blank included; not
  answered on this device today), in Settings order, taken from the recurring priorities the server
  has confirmed (`useBoardState().confirmedRecurring`), never one whose create is still on its way,
  which a list save would make a one-off. Both groups are judged on the stored list by the sheet and
  again on the card's draft (`isOneOff`, `notOnList`), so a row typed or a save already sent counts
  at once. Each group is a `role="group"` named by its heading, and each item a box: the leftovers
  start ticked, the routines up to `recurringPerDay` less the routines already on the list
  (`offerPicks`), the rest unticked, and a box pressed keeps its answer while the groups change.
  Ticking past the number says so (`TODAY_OFFER.over`, a live region always there under the group),
  and Add to today adds them all the same. Add runs `acceptOffer` through the card's draft, so what
  is typed goes out in the same save: each leftover through `placePriority`, in the first free row,
  then each routine through `placePriority` with `end`, after every row of the padded list, so the
  free rows stay for one-offs and no written row moves, and one that doesn't fit is skipped. Once
  Add's save goes through, and at once for Not today (Start fresh while no routine shows), the
  notice records every routine shown, ticked or not, under `USER_KEYS.recurringAnswered`
  (`useRecurringAnswered`: per item, day and device, so another device still offers it and a new day
  starts with none; an answer joins what is stored when it is given, so another tab's answers stay),
  and leftovers shown hold Start fresh (`leftOpenDismissed`), so removing a row the notice added
  brings nothing back.
- **In progress is today's list** (`client/src/lib/board.ts`, `hooks/useBoard.tsx`). The board (on
  with the `board` setting, off by default) shows the tasks `GET /board` sends (`boardJson`: the
  one-off tasks in Later or Next that aren't done, then every other one whose latest entry is from
  `LIST_WINDOW_DAYS` back to `PLANNED_WINDOW_DAYS` ahead; archived and deleted ones left out) and
  today's rows from the day store, matched by uid. Nothing about In progress or Done is stored, so
  the board and the sheet show one list, and turning the board on shows today's list and the tasks
  left open at once. Which column an item is in comes only from `boardColumns` (its doc has the
  rules in order); a one-off's item id is `item:<uid>` in every column and a recurring row's
  `row:<date>:<uid>`. Every Move to and every drop goes through `planMove`, which says what it
  writes: a task's lane or place (`editItem`, a PATCH), today's list through the day store's
  `editPriorities` (a pull of the task itself, or a tick), a park of today's open row to Later or
  Next (see "Saves reach the server in the order they were made"), or nothing: a done item moved to
  Later or Next stays done and the notice offers a new task in its place, and a recurring row, a
  planned task, a park to Later of a row planned later, and In progress for an earlier day's row of
  a removed recurring priority are refused. A lane given on a full board is refused before it is
  sent (`boardFull`, `addsToLanes`, `BOARD.full`), the server's 400 being the backstop. A task
  ticked on an earlier day, off today's list, has no checkbox, since the board would rewrite a past
  day (its editor says `BOARD.doneOn(when)`), and Move to In progress puts it on today's list to
  work on again; taken off today again (a park included), it is done again. The editor's title and
  category chip rename or file the task on every day: today's row through the row (`editRow`), any
  other task through a PATCH (`editItem`). Delete is the full delete (`deleteItem`) on every one-off
  task, and today's recurring row has Remove from today (`removeFromToday`) in its place. The
  editor's Start timer (`TimerLengths`) is on today's open rows, recurring ones included, and on
  the unplanned cards of Later and Next, left-open ones included: none in Done, on a planned task or
  an item whose move is on its way, or while any timer runs, and held while a start is out
  (`starting`). `Board` takes `running`, `start` and `starting` from `Shell` as props, since the
  timer's context changes every second. A row's Start closes the editor, the focus on the title,
  and starts on its task; a card's is a pull first (`run` with `minutes`: the nudge asks as Move
  to's does, Add anyway pulls and starts, Keep it short does neither), whose promise of the task's
  uid the start awaits, so a refused pull starts nothing and shows one banner. A start the server
  refuses (the task taken off the list meanwhile) is the save banner, and a 409 is adopted
  (`TIMER_ELSEWHERE`). The item the running session is on, on its day (a card, which has none, by
  its task), starts its meta line with the day log's pill (`RunningMark`), which its title is
  `aria-describedby`. The + at the end of Later's, Next's and In progress's head opens that
  column's box (`Capture`: a field and the category chip; `openAdd`, which also shows the column on
  a phone). Enter adds and keeps the box open; an empty Enter or Escape closes it with the focus
  back on the +, Escape dropping the text; leaving it closes it only while it is empty. Later's
  card goes at the top and Next's at the end (`laneStart`, `addItem`). In progress's text is a new
  task on today's list, a `place` move of `newTaskRow` through `move`, so on the board's queue,
  where it shows once its job starts (it has no item for `moving` to show); past the nudge it asks
  as Add priority does (this nudge and a pull's count the rows still waiting on the board's queue,
  as the sheet counts its draft), the text staying in the box until Add anyway, which closes the box
  and focuses the new row. An edit of the box's text or category drops the question, and the next
  Enter asks again. Later's and Next's + is `aria-disabled` at the cap (`boardFull`, `BOARD.full`
  under it), and In progress's only on a full list (`hasRoom`, `ADD_PRIORITY_FAILED.full`), since
  its task has no lane; a box open as its + shuts closes. A Delete that empties a column puts the
  focus on its +, or on Done's heading. One `role="status"` slot above the columns holds the board
  notice (a pull's or a typed row's nudge, the done-item notice or a refusal): its first button
  takes the focus, and an Enter or Space still held from the press that raised it presses nothing.
  What the store refuses once a move is under way (`MoveRefused`) is a banner. A drag (`Board.tsx`,
  with dnd-kit's settings in `components/board/dnd.ts`) starts at an item's grip; a planned task and
  a recurring row have none, and an item whose move is on its way can't be picked up until the move
  lands. Where a drop lands is `dropTarget`'s (see its doc), and what a screen reader hears comes
  from `BOARD_DRAG`, `overAnnouncement` and `moveAnnouncement`. dnd-kit's own focus return is off,
  since it would take the focus from the notice a drop brings: a keyboard drag puts it back on the
  item's grip, and so does closing the notice (on the title where the grip is hidden or missing; for
  a row typed in In progress's box, back in that box, which still holds the text).
- **Plan-vs-actual math lives only in `client/src/lib/retro.ts` and `review.ts`** (pure, with
  tests). "Added mid-day" means `addedAt` is after the day's first completed session started — one
  rule, no clock-in fallback. `GET /days/range` returns full days and the client does the rollup
  (through `useRange`). `reviewRange` walks the period's days up to today that have content
  (`hasContent`, so a day with only a break is left out) and also gives `sessions` (completed ones,
  `focusOf`), `breaks` (count and time, a running one so far, `breakSeconds`), `midDay` (rows added
  mid-day, how many got ticked, and `categoryUid`: the category more than half of them had, else
  null) and `typicalDay`: the medians, rounded half up, of the rows written and ticked on the days
  before today with a row written. Today is left out because it is still going, and it is null under
  two such days; Review shows it for a Week or a Month. The Days tile's target is `periodTarget`: a
  Week's is the Work week setting, as on the timeclock's week line, and a Month's or a Quarter's is
  `targetSeconds`, the clocked-in days' own lengths added up through `daySettings`. Not done groups
  the one-off rows left open by their task (`addToNotDone`; `OpenPriority.key` is the uid of the
  task that opened the entry): a tick settles that task's earlier open days. A one-off typed again
  by hand on a later day is a new task, so a narrow text fallback keeps such rows together: a task
  the board holds in no lane (`laned`), on its first day (`earlier === 0`), joins the latest open
  entry of its text (`sameText`) whose last day is 1 to `LOOKBACK_DAYS` days before; a tick ends
  that entry, and such a tick also settles an open row of its text on the same day. Its later days
  follow the entry it joined, so carrying it on doesn't regroup a past period. A task with a lane
  groups by uid only, so two board tasks of one name stay two entries. An entry shows its latest
  task's name. A recurring priority's rows (`Priority.recurring`) are priorities in every count (the
  tiles, `midDay`, `typicalDay`, the retro card, the calendar and its stickers) but never a task in
  Not done, which lists one-offs only: `reviewRange` groups them by uid into `routines` (the days a
  row had text, how many of them it was ticked, its focus; most days first, then most focus, then by
  title), each day on its own, so a tick never settles another day's miss; a routine is titled by
  its rows' text, its current name on every day. `reviewDay`'s `routines` (`{ done, total }`) is the
  retro card's "routines 3 of 4". `byCategory` (`CategoryTime`) is the focus and the ticks by
  category: each written row's focus (`seconds`) and tick (`done`) under its task's category, and
  each session off a written row under `sessionCategory`, in `seconds` and in its `offPlanSeconds`
  part, so a task's time on a day that no longer lists it counts off the plan under the task's
  category. A row's category is its task's current one, so a category change moves the task's past
  time. A uid outside `known` (the board's categories, removed ones included) counts as none, there
  and in `midDay`. Most time first, then most ticks, none last; a category with neither is left out.
  Review shows By category only while a listed bucket has a category. Review passes `known` and
  `laned` (the uids of the tasks the board holds in Later or Next) from `useBoardState()` while the
  board is on and has loaded, and empty ones otherwise, so with the board off nothing is grouped by
  category and no task counts as laned in Not done.
- **A session is named and filed by its task.** `sessionName(s, rows)` and
  `sessionCategory(s, rows)` (`lib/retro.ts`) read the written row its task is on its day
  (`sessionRow`), so a rename or a chip changed on the sheet shows at once, else the server's
  `Session.title` (the task's current name, once the task has left that day; null with no task, so
  the name is its `label`) and `Session.categoryUid` (the task's, else the session's own). Every
  surface names a session through them or `useTimer().name`: the day log, the timer card, the
  running bar, the tab title, the timer's alerts as they are raised (a "Time's up" banner already up
  keeps its name: see the timer rule), the retro's Not on the plan and Review's Off the plan
  (grouped by task, else by label). A label typed at Start with an open row's text (`sameText`)
  starts linked to that row, as its chip does. A session with a task has no name or category of its
  own to edit until it is set to Unplanned, and `editedSession` shows an edit as the server will
  store it while it is out; the day log picks a category only for a session not on a written row of
  its day (`sessionCategoryEdit`), and shows it as a `CategoryDot` named by its `label`, the one dot
  drawn without its name beside it. The functions' docs and `SessionLog`'s comments have the UI
  details.
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
- **Alarm event keys embed the target minute** (`eventKey`), so a moved target re-arms and a reload
  never re-fires. Today's fired keys live in `localStorage` under `focus:alarms`, one set for one
  date (`readDaySet`, `addToDaySet` in `lib/storage.ts`), so a new day starts with none.
- **Today's alarms wait while a punch is being typed.** Today's punches are held while a punch time
  field on today's sheet has focus (`Timeclock`'s `onEditingChange`; Now, × and the pair buttons
  save at once and never hold), for at most five minutes after the last change or move to another
  time field, and settle for 3 s after (`useSettled(value, ms)`, wired in `useTodayAlarms` on
  `punchesKey`) before evaluation. The hold ends when focus leaves a time field or the field goes
  with focus inside (the card unmounts or its pair is removed): `TimeField` reports both, since a
  removed field gets no blur. A pair keeps the block it had (before or after lunch) while the focus
  is inside it, so a time on its way never moves it. The punches are compared by their times, so a
  refresh with the same times neither stops the alarms nor restarts the wait.
- **Per-date card drafts reset by remounting**: `Sheet.tsx` keys `Timeclock`, `Priorities` and
  `Retro` by date, so none needs a "date changed" effect. For `Timeclock` the remount is also what
  keeps a day already done from reading as one becoming done: `useBecameTrue` compares with the last
  render, and moving between two days the store already holds would otherwise leave the card
  mounted. Local drafts that mirror a prop use the "adjust state while rendering" form
  (`useFollowedDraft` for a text box's name; `DurationField` for a draft mapped from its value), not
  a `useEffect` + `setState`, unless the draft is gated by a dirty flag: a ref can't be read during
  render, so there the effect form is the one the react-hooks rules allow. A typed draft that saves
  on a timer is `useDebouncedDraft(stored, save, ms)` (`Priorities`, `Retro`, `NoteField`): it saves
  after the wait, at once on `flush()` or an edit made now, and on unmount, so a day left
  mid-sentence still saves. `save(value, base)` gets as `base` what the edits were made on: the
  value it last saved, or the `stored` value the draft last took up once that has rendered,
  whichever came later. `Priorities` hands it to the store for the merge, and `Retro` and
  `NoteField` ignore it. `save` says whether the draft can be let go: `Retro` and `NoteField` pass
  the store's answer, so a note whose save fails stays in its box, unsaved, though the store has
  dropped the change, and goes again on the next edit, blur or unmount; `Priorities` lets its list
  go once sent, because a list held after a failure would stop the card following the stored list
  (rows and ticks saved elsewhere) until a save went through, and holds it only while a box is
  blank (see "A blank name is never saved"), so a stored change doesn't put the name back while
  that box has the focus. Callbacks that must read the latest value use `useLatest()`, never a ref
  written in render (the react-hooks lint enforces both).
- Static assets are public; **all data is behind `/api/*`**. `/assets/*` is fingerprinted and
  cached immutable. The SPA fallback serves `index.html` for any other non-API path; a miss
  under `/assets` is a 404 (a page from before an upgrade asking for an old chunk).
- **A keyboard shortcut is bound where its button is.** `SHORTCUTS` (`lib/shortcuts.ts`) is the
  one list of keys: N is Add priority on the sheet and Later's + on the board; S, B and H are the
  header's brand, Board and History; ? opens the list; P, + and F are the running timer's Pause or
  Resume, + and Finish; R is the timer card's Break. Each is bound by the component that renders
  its button, with `useShortcut(id, run)` called before any early return, and `run` is null
  whenever that button is hidden or wouldn't act (F before time's up, + at the longest plan, N
  with Later's + shut, R while a start is out or off today's sheet), so a key never acts where its
  button wouldn't, and R holds the start buttons as a tap on Break does. S, B and H put the focus
  on their header button first, where a click leaves it, since the control it was on may go with
  the page. The hook answers the button's `aria-keyshortcuts` while the key is bound and the
  `shortcuts` setting is on. Two mounted bindings of one key (the bar's and the card's timer
  buttons) run the newer, and a binding keeps its place while its `run` comes and goes.
  `useShortcutListener`, mounted once by `Shortcuts` beside `FinishChoice` in `App.tsx`, is the
  one keydown listener on the window (nothing else in the app listens for keys there or on the
  document), attached once the settings have loaded and while `shortcuts` is on. Its guard,
  `shortcutFor`, leaves a key alone when it was handled already, held down, composing or pressed
  with Ctrl, Cmd or Alt, when it is typed into a field (a text box, a text area, a select, a time
  segment, the category list), and while a dialog is open or an item is dragged. A key that acts
  calls `preventDefault()`, so the letter isn't typed into the row it focused, and a timer key
  calls `unlockAudio()` first. Letters match in either case, and + is matched on
  `KeyboardEvent.key`. The list is a static dialog in `Shortcuts.tsx`, its labels beside it, not
  a lazy chunk. The setting is on by default and turns every key off (WCAG 2.1.4).
- **History, the board, the settings dialog and drag and drop are lazy chunks** (`lazy()` in
  `App.tsx` for `History`, `Board` and `SettingsDialog`, in `Sheet.tsx` for `SortableCards`;
  `SortableCards` and `components/board/` hold every `@dnd-kit` import). A static import of one
  of them from the first screen folds it back into the main chunk. Everything under
  `components/board/` loads only through `Board`'s chunk; what other views share with it
  (`lib/board.ts` and `hooks/useBoard.tsx` with the sheet, the settings and History's Review,
  `Folded` with Review, the category pieces (`CategoryChip`, `CategoryDot`, which Review uses
  too, and `lib/popover.ts`), `RepeatMark`, `RunningMark`, `Note` and `TimerLengths`, kept out so
  the sheet can show them) stays out of that folder and imports no dnd-kit. The sheet renders plain
  `CardFrame`s until the first Customize and stays on `SortableCards` after it, since swapping lists
  remounts the cards. A chunk that fails to load (an upgrade while the page was open) reloads the
  page once a minute at most (`vite:preloadError` in `main.tsx`, `lib/reload.ts`); the
  `ErrorBoundary` card shows until the reload lands, and stays when no reload is made.
- **A page left open across an update asks to be reloaded.** Every answer of the data routes, a
  refusal included, names the server's version in `Clockspan-Version` (`VERSION_HEADER`,
  `shared/api.ts`), set in `app.ts` on the `api` router after `requireAuth` and
  `requireOwnPassword`, so no answer to someone not signed in (`/api/health`, `/api/auth/*`, a 401)
  says which version runs. The server reads its version from the nearest `package.json`
  (`findPackageJSON`: the repo's in dev and tests, and in the image the one copied beside `dist/`,
  which also makes `dist/server` an ES module); the client's build carries its own as
  `__APP_VERSION__` (`define` in `vite.config.ts`). `request()` (`client/src/api.ts`) compares the
  two on every answer that has the header, and on a mismatch raises the `UPDATED` banner through
  `alerts.ts`: info, sticky, no chime and no notification, with a Reload button. It is raised once
  per server version heard, never on each answer, so a closed one stays closed until the server
  moves again. An `edge` image carries the last release's number, so only a release asks. A page
  loaded before tasks were stored once sends shapes the server no longer takes, and is refused by
  their presence, never their values, with 409 and `STALE_CLIENT` (`server/refuse.ts`): a priorities
  PUT carrying `cards` or `touched`, or a row carrying `cardUid` or `recurringUid` (`staleShape`),
  and any request under `/board/cards` or `/board/recurring`. Its saves fail until it is reloaded,
  which the banner asks for, and none is read as done or applied in part.
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
- **Migrations are append-only** in `server/db.ts` (`MIGRATIONS[]`, `PRAGMA user_version`). A
  migration may be a function: an entry is SQL, or, when the change needs code (a backfill), a
  function of the database in a file of its own under `server/migrations/`, which `migrate()` runs
  inside the same transaction as its version bump, so a failure leaves the database as it was. A
  function is frozen like SQL: it keeps its own copies of the helpers it uses (`oneItem.ts` copies
  `sameText`, `hasText` and the 14-day window), so a later change to `shared/` can't change how an
  old database migrates. Every FK to `users` or `days` is `ON DELETE CASCADE`; `priorities.item_id`
  and `sessions.item_id` are NO ACTION, so a task a day or a session names can't be deleted, while a
  user delete still passes. A value nothing reads any more stays rather than a migration dropping
  it, so a minor release loses no stored value: `sessions.notes` (never shown or edited),
  `sessions.priority_uid`, the old per-day rows in `priorities_v1` (still deleted with their days),
  and `items.legacy_untouched` and `legacy_uid`, which only migrated rows fill.
  `items.legacy_done_at` is read by the prune (`collectItems`). A table whose rows a migration moved
  whole may go: 13 dropped `board_cards` and `recurring` once `items` held them.

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
  sheet from it, pressed only there (`aria-pressed={view === '<id>'}`), its name fixed; then
  revisit Header's `crowded` (the 375 px header holds five buttons) and check the header at
  375. A view behind a setting,
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
  on, which takes `TabProps` and the dialog's `save`, for its board writes; the Sheet tab's
  "History" section holds the calendar's switches, and its "Board" section the board's, but for
  Times on the board (`clockBar`), which sits with the timeclock's switches after Overtime and
  shows while the board is on): a `DurationField` (`components/DurationField.tsx`) for hours and
  minutes or a `NumberField` (`settings/controls.tsx`) for one number, each with
  `{...SETTING_LIMITS.<key>}` for `min` and `max`; a `SelectField` (`settings/controls.tsx`) for
  one choice from a fixed list; a `Toggle` for a switch.
  `NumberInput` on its own puts several numbers on one row, like the timer's start buttons. The
  new setting also goes in `TEST_SETTINGS` (`client/src/test/fixtures.ts`), and the type makes a
  missing one an error. A setting that is an object edited a field at a time is merged field by
  field in `mergeSettings` (as `mergeRetention` does), and gets a partial entry in
  `SettingsPatch` (`client/src/api.ts`) and a merge in `applySettingsPatch`
  (`client/src/lib/settings.ts`). Nothing else to mirror.
- **A keyboard shortcut**: add its id to `ShortcutId` and its key and group to `SHORTCUTS`
  (`lib/shortcuts.ts`): the group is its heading in the ? list, and a key whose action can make a
  sound goes in `timer`, the one group the listener unlocks audio for; a test checks that no two
  share a key → its label in `Shortcuts.tsx`'s list (the type makes a missing one an error) →
  `useShortcut(id, run)` in the component that renders its button, before any early return, with
  `run` null whenever the button wouldn't act, and the hook's answer on the button's
  `aria-keyshortcuts` → a case in that component's test, with `ShortcutKeys` in its wrapper and
  `pressKey` (`test/hooks.tsx`) → the key in the README's Keyboard bullet.
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
- **An alarm target**: expose the instant from `computeTimeclock` → add a target to
  `alarmTargets()` in `lib/alarms.ts`, with an `armed` rule and a test case (a rule the card also
  needs goes in a pure helper like `secondMealApplies`) → add its id to `ALARM_IDS` and its
  default under `alarms` in `shared/settings.ts` (`mergeSettings` and `applySettingsPatch` loop
  over `ALARM_IDS`, so neither needs a line); its settings also go in `TEST_SETTINGS.alarms`
  (`client/src/test/fixtures.ts`), and the type makes a missing one an error → add an
  `AlarmEditor` in `settings/AlarmsTab.tsx`, and its name in that Alarms section's hint (both
  variants) → its name in `ALARM_NAMES` and a `case` in `describeEvent()` (both in
  `lib/alarms.ts`; the type makes a missing name an error, and typecheck and the
  `switch-exhaustiveness-check` lint refuse a missing case), with a title and a body for each kind
  that say where the deadline came from (widen `EventContext`'s `Pick` if it needs another
  setting). A banner can
  carry one `action` button (see the clock-out alarm's "Overtime approved" and the retro alarm's
  "Open retrospective", chosen in `useAlarms` from the `AlarmDayState` callbacks).
- **A per-day field** (like `overtimeApproved`, `retroNote`/`retroAt`): append a migration
  adding the column to `days` → add the column to `DAY_COLUMNS` and to the `DayRow` interface
  beside it (`routes/shared.ts`, read by `findDay` beside it and `daysInRange` in
  `routes/days.ts`) and return it from `dayJson` (a per-day list in a table of its own, like
  `breaks`, is instead one more grouped query in `rangeRows` and a field in `dayJson`, both in
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
- **A task field** (like the name, `categoryUid` or `note`: one value for the task, which every
  day it is on shows): append a migration adding the column to `items`, and stop the existing
  migration cases in `server/db.test.ts` that read `items` at their own version
  (`migrate(db, n)`) → `ItemRow` (`routes/shared.ts`) → the field on `Priority` (`shared/api.ts`;
  the column in `ENTRIES`' join and `EntryRow`, read in `priorityJson`, `routes/days.ts`), on
  `BoardCard` (`boardJson`, `server/board.ts`) and on `Recurring` (`recurringJson` there), where
  each reader needs it, and on `BoardItem` (`lib/board.ts`: `rowItem`, `cardItem`, and the
  earlier day's routine row in `boardColumns`, which takes its recurring priority's) → if the
  user wrote it, `deleteItem`'s tombstone UPDATE (`server/board.ts`) clears it → if the sheet
  edits it, its `MERGED` entry (`shared/priorities.ts`; typecheck asks for it there or in
  `ReadOnlyField`), its rule in `parsePriorityRows` for a value of the wrong kind and for one left
  out (read as unchanged: its uids in `unsaid`, filled from the base), its write in the PUT beside
  the rename: on the task a uid new to the user makes, and otherwise only where this device's row
  differs from its base row, and `setPriorities`' `taskChanged` condition (`hooks/useDay.tsx`) →
  if the board or Settings edits it, `NewItem` and `ItemPatch` (`client/src/api.ts`), the `POST`
  and `PATCH` routes in `routes/items.ts`, `withItem`, `withItemPatch`, `RowPatch` and
  `itemPatchOf` (`lib/board.ts`: a row's edit on the board, and that edit as the task's PATCH), and
  in `hooks/useBoard.tsx` `patchItem`'s `taskChanged` condition and `setRow`'s patch type, so the
  held days that show it are read again → its value on every row the client builds:
  `emptyRow` and `newTaskRow` (`lib/priorities.ts`), and, taken from the source,
  `planNext`'s row and `PrioritySeed` (`lib/plan.ts`), `recurringRow` (`lib/recurring.ts`) and
  `planMove`'s pull (`lib/board.ts`) → the seed (its rows and `SEEDED_RECURRING`, which typecheck
  asks for; `insertItems`' INSERT, which it doesn't) → `makePriority`, `makeCard` and
  `makeRecurring` (`client/src/test/fixtures.ts`). A field the server works out (like `recurring`
  or `listed`) is read only: it goes in `ReadOnlyField` (`shared/priorities.ts`), never in `MERGED`
  or `parsePriorityRows`, which neither reads nor refuses it; in the seed the row builders set it
  (`recurring` in `oneOff` and `routineRows`, `archived` in `UNCOUNTED`), or `withCounts` fills it
  once the days are built (`listed`, `earlier`, `logged`).
- **An entry field** (like `done` or `addedAt`: a fact of one day's list): append a migration
  adding the column to `priorities` → the column in `ENTRIES` and `EntryRow`, read in
  `priorityJson` and written in the PUT's INSERT (`routes/days.ts`) → the field on `Priority`
  (`shared/api.ts`) and its `MERGED` entry (`shared/priorities.ts`, which typecheck asks for) →
  its rule in `parsePriorityRows` for a value of the wrong kind and for one left out → its
  default in `emptyRow` and `newTaskRow` (`lib/priorities.ts`; `planNext`'s row and
  `recurringRow` start from `newTaskRow`) and `planMove`'s pull (`lib/board.ts`) → the seed
  (`server/dev/seed.ts`: its rows, typecheck asks; `insertDay`'s INSERT, it doesn't) →
  `makePriority` (`client/src/test/fixtures.ts`) → the padded-rows case in
  `server/routes/days.test.ts` ("takes the web app's rows as it pads and sends them").
- **An API route**: put it on the `api` router in `app.ts` (behind `requireAuth`), scope by
  `currentUser(req).id` (a `/:date` route goes on the days router, whose param handler checks
  the date; a `/:id` route on the sessions or breaks router, or a `/:uid` route on the
  categories or items router, is checked by the router itself and reads its row with
  `owned(res)`; a new table addressed by id gets its entry in `OwnedRows`, `NOT_FOUND` and
  `OWNED_SELECT` (how its rows are read, with their date) and a router from `ownedRouter()`, and
  a new table of the user's addressed by uid its entry in `UidRows`, `UID_NOT_FOUND` and
  `UID_GONE` (a row that counts as none, like a task's tombstone) and a router from
  `uidRouter()`, all in `routes/shared.ts`),
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
  bad-date table near the end of `server/routes/days.test.ts`, and a write route one in the
  distance table after it.
- **A schema change**: append to `MIGRATIONS` in `db.ts` and never edit an entry (see
  "Migrations are append-only"); a function migration's `db.test.ts` cases call
  `migrate(db, upTo)` to stop at the version before it, write the old rows, then run it. A new
  table with a `user_id` also joins the README's script under "Switching modes later";
  `server/db.test.ts` fails until it does. A new column on a day, session, entry or break also
  needs the seed note under "A per-day field". A new `Priority` field follows "A task field" or
  "An entry field".
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
  scheme and the manifest's `background_color` and `theme_color` the light one:
  `theme-css.test.ts` checks them all), built **phone-base** (the base rules are the phone;
  `@media (min-width: 640px)` and wider queries enhance; that is how the stylesheet is built, not
  who it is for). The sheet's two columns start at `SPLIT_QUERY` (`lib/layout.ts`), which
  `styles.css` writes out as its `@media` line (`theme-css.test.ts` checks it is there). Every width
  rule is a window query, so a card in a column gets the wide-window rules at about half the width:
  a rule that needs the room (the timeclock's four tiles in a row) is undone under `.sheet--split`.
  Tap targets are 44 px on a touch screen: `.btn` and `.input` set `min-height: 44px`, and a compact
  control (chip, segment, running-bar button, banner close/action, log delete, a board column's +)
  keeps its drawn size and gets the rest from the `@media (pointer: coarse)` block at the end of
  `styles.css`, an empty `::after` reaching past its edge (a control that clips its overflow grows
  its padding instead). Where two controls sit closer than that, each reaches half the gap. A new
  compact control joins that block. A toggle's on state is styled from its ARIA attribute
  (`[aria-pressed='true']`, `[aria-selected='true']`), never a parallel `is-on` / `is-active` class.
  Inputs are 16 px so iOS doesn't zoom. No external fonts or assets (the CSP would block them
  anyway). Safe-area insets via `--safe-top`, `--safe-bottom`, `--safe-left` and `--safe-right` (a
  phone held sideways puts the notch on a side). Words in a tone's colour use its `-ink` token
  (`--accent-ink`, `--ok-ink`, `--warn-ink`, `--danger-ink`), which keeps light-mode text at 4.5:1
  and up; the tone itself is for fills, borders, icons and bars. A category's colour (`--cat-<id>`,
  picked by `data-color`) is a fill only (see "A category colour" for its contrast): a dot, and
  Review's By category bars, solid for the time on a priority and striped in the same colour for the
  time off the plan (No category's bar is `--text-2`, not in the test). A category's name is never
  drawn in it, and its dot always sits beside the name, since the eight colours repeat
  (`nextColor`); the one exception is the day log's dot, named by its `label`. `CategoryChip` is the
  one category picker: its list is `position: fixed` inside the chip's wrapper, placed by
  `placePopover` (`lib/popover.ts`) and scrolling inside, so no card or dialog clips it and New
  category stays in view. A sheet row's empty chip (a priority row's, a Plan tomorrow row's) is
  quiet: with a mouse it shows on the row's hover or focus only, from the `(hover: hover)` rule
  beside the chip's. So is a note button with no note (`.note-toggle--empty`), on a sheet row and
  a board card, unless its box is open. `.category-chip`, `.note-toggle` and `.swatch` are in the
  coarse block.
- Numeric settings inputs commit on blur or Enter, never on every keystroke (`NumberInput`);
  `DurationField` commits when focus leaves its hours / minutes pair or on Enter, so moving from
  hours to minutes saves nothing. A blank or non-numeric box puts the stored value back and
  saves nothing; zero is typed as 0. Priorities and a row's note debounce 400 ms, a card's note
  800 ms; punches and checkboxes save immediately.
- A form that sends a request submits through `useSubmit()` (`hooks/useSubmit.ts`), and a
  button that sends one calls its `run`: one send at a time with the button disabled, and one
  error line (`ErrorLine`), cleared when a send starts and filled with what it throws (a
  mismatched confirmation throws too). A store write that shows at once (a lane's box, a card's
  Move to), or a board item's Start timer, whose editor closes, is not a form send: it goes
  through its store, and a failure is the banner.
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
     the defaults.
   - A test that needs a DOM (hooks, components, `api.ts`) starts with
     `// @vitest-environment happy-dom`; the rest of the suite runs under `node`.
   - The suite runs in America/Los_Angeles (`test.env.TZ` in `vite.config.ts`), so a US DST
     case uses that zone's change days (2026-03-08, 2026-11-01). A case that needs another
     zone stubs it with `vi.stubEnv('TZ', …)`, as `shared/dates.test.ts` does for Santiago's
     midnight change; the config's `unstubEnvs` puts it back before the next test.
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
   - The database is `openDatabase(':memory:')`, never a file. The static-file tests write a
     stand-in `dist/client` with `tempClientBuild()` and remove it afterwards.
3. One-off looks at live data: `curl` against the seeded dev DB (see "Dev data is disposable").
4. The browser, only for what tests cannot show: how a card renders, drag/drop, banners, the
   timer bar, light/dark, the desktop and phone widths. Seed first (`--running` for timer work),
   scope it to the surface you touched, and make one pass at 1280 px (or the desktop widths the
   surface's line below names), then one at the 375 px mobile preset, each in light and dark. Do not
   re-walk flows a test already covers.

Every test, client or server, writes time spans with `MINUTE_MS`, `HOUR_MS` and `DAY_MS` from
`shared/dates.js`.

The gate, which a change passes before it is reported done or a PR is opened, is CONTRIBUTING.md's
"Before opening" list. Its coverage run measures every file under `server/`, `shared/`,
`client/src/lib/` and `client/src/hooks/`, and `client/src/api.ts` (minus the two process
entrypoints and `server/dev/`), each of which must be 100% covered on statements, branches,
functions and lines, so new code there ships with the tests that reach it. A branch that cannot
be reached is deleted, never hidden behind a `v8 ignore` comment; `alerts.ts` shows how a
browser-only module is tested (stub the globals).

The browser pass for each surface (the logic under it is already tested):

- **CSS or a component**: the touched surface, in the widths and themes of step 4. A sheet
  card's desktop pass is two widths, since the split starts at 1100 px: 1280 (the card in its
  column) and 1000 (one column, the widest a card gets). Resize, then reload: the sheet picks its
  columns when it mounts.
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
  banner shows at once, the clock-out banner with its "Overtime approved" button. When done,
  `npm run seed -- --fresh` or `curl -X DELETE localhost:3000/api/settings` puts the default
  settings back.
- **Sounds**: Settings → Alarms → Sounds. Test on a clip row plays the clip.
- **The update banner**: in the page, wrap `window.fetch` so each answer that has a
  `Clockspan-Version` header names another version (a new `Response` over the same body, with
  that header changed), then switch views, and look at the info banner with its Reload button.
  That it shows once, stays, stays closed and reloads is `api.test.ts`'s.
- **Punches**: a pair added before lunch, an early Clock out (done, celebration), "Add extra
  out / in" after it (the old Clock out becomes Out N) and removing that pair. In the time
  field: clear Clock in and press `0` `7` `3` `0` (the hour advances, the period fills, the
  tiles move with no further key), `p` flips the period and ↑/↓ on a segment saves each step. In
  the browser pane send single `key` presses; the `type` action pastes the whole string into one
  segment.
- **Priorities or the timer card**: tick one row and press Add priority (the notice lists the
  ticked row); tap a chip, start, and the log row shows the number; the log row's edit of a session
  on a written row shows its name as text, with no hover. Empty a written row's box and retype the
  carried row's name: where the hints under them sit (at 375 with the board on, under the row's own
  chip, nearer it than the next row). × on the carried row: how "Remove …" renders, a long name
  included. Notes, board off and on: row 3's note button drawn filled and the others' quiet (shown
  on the row's hover or focus with a mouse, always on a phone); open row 3's note under the row,
  after any hint, lined up with the field; type past eight lines (it grows, then scrolls); a ticked
  row's note isn't struck through; with the board off at 375 the button's line under the field,
  and from 640 its column beside the field. With the board on: pick a category on a row (an empty
  chip shows only on the row's hover or focus with a mouse, always on a phone; a long name ends in
  an ellipsis; at 375 the chip sits under the field, nearer it than the next row's, and the field
  keeps the row's width, beside the ×; from 640 it sits beside the field, which ends in the same
  place written or empty), tick Also add and pick one for the new row (the chip beside it wraps
  under it at 375), give an unplanned log session one (its dot before the label) and a Plan tomorrow
  row one, then the same at 1280 in the split's columns.
- **Recurring priorities**: with the board on, Settings → Board → Recurring priorities: Recurring
  rows per day with its hint beside the box; Add recurring priority; a rename; a category from
  the row's chip, where Escape closes only the list and the dialog stays open; the days (on a
  touch screen each takes 44 × 44 px). At 375 the rows wrap and the seven days fit on one line.
  On the board, a recurring row's meta line has the Repeats mark. On the sheet, with a routine due
  today (see "Dev data is disposable" for both groups): the morning notice with "Still open from …",
  "Repeats today" and the line once more routines are ticked than Recurring rows per day; after Add
  to today, the mark before the chip on a routine's row; at 1280 and 1000 the mark and a long
  category in the chip's column, and at 375 the mark before the chip under the field.
- **Retro or review**: one seeded day's retro card and History → Review → Week (`--quarter` for
  Month / Quarter). With the board on (`PUT /api/settings {"board":true}`), By category in
  Review → Week and Month (solid and striped bars, No category last), in light and dark. For
  Added mid-day's "mostly …", give the last weekday's "Reply to the recruiter" row a category
  with its chip (the seed files that task under none) and open the Week that holds that day (◀
  on a Monday): it is one task on every day the seed adds it mid-day, so the category reaches
  each of them, and any period holding one of those days names it.
- **The board**: after `npm run seed`, turn it on (`PUT /api/settings {"board":true}`, see "Dev
  data is disposable") and press Board. At 1440: the four columns; each +'s box (Later's card at the
  top, Next's at the end, In progress's row on today's sheet and asking past three rows; Enter keeps
  the box, an empty Enter or Escape closes it, one with text stays open when left); a left-open
  task's "Left open from …" in Next, Move to from each column (a done item's notice), a park of a
  task typed seconds ago, a done-earlier task's editor, and this week's routine ticks in Done. At
  1000, where the columns are narrowest: titles clamp to two lines, meta lines wrap, the Move to
  select fits. At 375: the switch shows one column, the notice wraps, and with sign-in on
  (`web-local`, `npm run seed -- --auth local --sessions`, the printed cookie set and the board
  turned on in Settings → Sheet) the sheet's five header buttons fit with the brand's name gone.
  Light and dark. The drag pass: at 1440, drag with the mouse between each pair of columns (Later
  and Next take the card where it is dropped), a done row onto Later (the notice), then by keyboard
  (Tab to a grip, Space, arrows, Space) with a screen reader, which hears where the card is and the
  done-item line, and Escape puts it back; with reduced motion on, nothing glides. At 1000 the copy
  under the pointer isn't clipped; at 375 a card sorts within the column shown, In progress and Done
  show no grip, and Move to still moves. The clock bar, at 1440, 1000 and 375: above the notice
  and the columns with the seeded times and the time left, one line from 640 px and label over
  time over line on a phone; Overtime approved, Overtime off and the meal periods off (no Lunch
  by, and the switch's hint drops the lunch deadline) change it as they change the sheet's tiles;
  Settings → Timeclock → Times on the board off hides it, and with the board off the switch isn't
  there. Start timer, at 1440, 1000 (the lengths wrap under their label) and 375: a row's Start (the
  bar shows the timer, the row's meta line `running`, then `paused`), a Next card's with three rows
  open (the nudge, then Add anyway pulls and starts), and with a timer running no editor offers it.
  Notes, at 1440, 1000 and 375: the SSO card's note button drawn filled at the end of its title
  row, the others' quiet until the card is hovered or focused; its note opens under the card's
  text with the editor closed, and the note button and Start timer both work on one card; Escape
  closes it with the focus on its button; with a screen reader, the button says whether a note is
  there and whether it is open; an earlier day's tick of a recurring priority removed in Settings
  shows its note as text. A key typed into a note does nothing.
  Categories (with about 30 added by `curl` to `/api/board/categories` for a long list): a
  box's chip (a pick, New category, kept after a reload and in the other boxes), a card editor's
  chip with its list scrolling inside and the box in view, the cards' dot and name (a long name at
  1000), and Settings → Board (a rename, a name in use, the swatches wrapping at 375, Remove, the
  touch areas).
- **Keyboard shortcuts**: after `npm run seed -- --running` with the board on, at 1280: ? opens
  the list with the focus on it, ? again does nothing and Escape gives the focus back; P pauses
  and resumes, + adds the step, and once the timer is a minute or more past its end (see "The
  timer") F opens "How much to log?", where keys do nothing; after the finish, R starts a break and
  R again does nothing; N puts the focus in a free row with no n typed, and with three written rows
  leaves it on Add priority beside the nudge; H and B there and back, S from History, each leaving
  the focus on its header button. An h typed into a day log label (the Inbox row's edit), a
  priority, Clock in's hour, the date picker and an open category list, or pressed with Settings
  open, does nothing, and Option+B, Cmd+H and Ctrl+F do only what the browser does. On
  the board at 1440, N opens Later's box (with a box already open too), R does nothing, and a key
  pressed during a keyboard drag does nothing. With Settings → Sheet → Keyboard off no key acts.
  The list at 1000 and 375, light and dark; a screen reader reads its title and keys, and a
  button's key.
- **The History calendar**: one month at the mobile preset: ◀ to a seeded month, tap a day,
  **Open day**, browser Back lands on that month with the day picked, and back through the
  header, **Review this week** lands on that week. Review → Month → ◀ → a row → Back lands on that
  month's review. With the sticker chart on (`PUT /api/settings {"stickers":true}`), a chip narrows
  the grid to one sticker and a second tap clears it; with Show weekends off, five columns.
- **Retention**: one look at Settings → Data (count line, toggle saves); drive the delete with
  curl (`POST /api/days/prune` with `{"before":"YYYY-MM-DD"}`) because of the confirm dialog.
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
  through it too, and nothing in the app listens for the window's `focus`. A read tied to what
  is shown or to a change just made (a view showing a held day, a re-read after a write) is not
  a refresh and stays outside the loop.
- The board's refresh lives in `BoardRefresh` (`hooks/useBoard.tsx`), a child the provider
  mounts only while the board is on: switching it on reads at once (StrictMode's second mount
  lands inside the loop's throttle), and nothing ticks while it is off. So the test files that
  render `AppProviders` with `api` automocked need nothing for the board: `TEST_SETTINGS.board`
  is false, and the provider sends nothing.
- A keydown inside a native modal `<dialog>` still bubbles to `window`, so the shortcut guard
  checks for `dialog[open]` itself. Its drag check reads the `aria-pressed` dnd-kit sets on a grip
  (beside `aria-roledescription`) while it drags; a dnd-kit upgrade that drops it lets keys
  through mid-drag, which `Board.test.tsx`'s keyboard-drag case catches. A page key (S, B, H)
  drops text left in a board box, as a click on the header does.
- Prettier leaves `*.md` alone: wrap docs by hand.
- A workflow step that must trigger CI needs a GitHub App or personal token.
- The Node floor (`engines` and `devEngines` in `package.json`) has no upper bound, and `.npmrc`
  has no `engine-strict`, on purpose: Dependabot's updater reads both files and runs its own
  Node. A cap it outgrows, or a package whose `engines` leaves its Node out under
  `engine-strict`, stops its npm updates without failing any check: the PRs just stop coming. A
  new Node major moves `.nvmrc`, both fields, the Dockerfile's two `FROM` lines and the
  `@types/node` major together (Dependabot skips the majors of the last two), plus the docs that
  name the version; CI and `.claude/launch.json` read `.nvmrc`.
