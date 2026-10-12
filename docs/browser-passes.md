# Browser passes

What to look at in the browser for each surface, once its tests pass. AGENTS.md's "Verification
expectations" (step 4) says when a change needs a pass at all and the widths and themes each one
takes; CLAUDE.md has the built-in browser's steps, and AGENTS.md's "Dev data is disposable" says
what `npm run seed` writes.

## By surface

- **CSS or a component**: the touched surface, in the widths and themes of step 4. A sheet
  card's desktop pass is two widths, since the split starts at 1100 px: 1280 (the card in its
  column) and 1000 (one column, the widest a card gets). Resize, then reload: the sheet picks its
  columns when it mounts.
- **The sheet's columns** (the layout, `Sheet.tsx`, `CardFrame`): at 1280, Customize moves a
  card to the other column and back, ↑/↓ and the grip stay inside a column, the date row spans
  both columns with Customize at its end, and with a timer running (`--running`) the bar sits
  under the header across the window, its contents lined up with the header's; at 1000 and at the
  375 px preset, one column in the layout's order and no column buttons.
- **`security.ts`, `index.html` or how assets load**: the `prod` config, with the console free
  of CSP violations; `curl -sI localhost:8090/api/health` shows the headers.
- **The timer**: make the seeded session run out (PATCH `plannedSeconds` to
  `ceil((elapsed + 30) / 60) * 60`, since plans are whole minutes, then reload so the client
  has the new plan). The bar and the card count below zero, the "Time's Up" banner offers
  **Add 5 min**, and a minute or more over, **Finish** opens "How Much to Log?". Pause and
  resume: the countdown holds and the log row's pill follows. Done, on the bar (the word from
  640 px; at 375 the label keeps a readable start) and the card, on the seeded session's row 3:
  the bar goes, the burst flies from Done (on the bar, from under it, whole on screen at 1280 and
  375) and row 3 is ticked; a minute over, Done opens "How Much to Log?", and Back ticks nothing.
  The bar sits under the header on the sheet, the board and History, and scrolled it stays at the
  top of the window, cards passing under it; the "Time's Up" banner hangs under it, at rest and
  scrolled, never over its buttons.
- **Alarms**: after `npm run seed`, clear Clock in (×) on today's sheet. That also raises "Not
  Clocked In" (the seed logs sessions), and `localStorage.removeItem('focus:alarms')` in the page
  and a reload show it again. Set Lunch must start
  within 3 min, Lunch length 0, Work day 10 min and Second meal due after 6 min, in Settings →
  Timeclock or with
  `curl -X PUT localhost:3000/api/settings -H 'content-type: application/json' -d '{"lunchDeadlineMinutes":3,"lunchMinutes":0,"workMinutes":10,"secondMealAfterMinutes":6}'`
  and a reload. Press Now on Clock in: lunch is due at +3 min, the second meal at +6 and
  clock-out at +10. The work day must be longer than the lunch window, or lunch reads "Not
  needed today" and never rings, and longer than the second-meal threshold, or that alarm
  waits for the day to run over or for overtime approval. At the mobile preset each target's
  banner shows at once, the clock-out banner with its "Overtime Approved" button. When done,
  `npm run seed -- --fresh` or `curl -X DELETE localhost:3000/api/settings` puts the default
  settings back.
- **Sounds**: Settings → Alarms → Sounds. Test on a clip row plays the clip.
- **The update banner**: in the page, wrap `window.fetch` so each answer that has a
  `Clockspan-Version` header names another version (a new `Response` over the same body, with
  that header changed), then switch views, and look at the info banner with its Reload button.
  That it shows once, stays, stays closed and reloads is `api.test.ts`'s.
- **Live updates**: after `npm run seed`, the sheet at 1280 in two windows side by side (or one
  window and `curl`). A settings save (`curl -X PUT localhost:3000/api/settings -H
  'content-type: application/json' -d '{"theme":"dark"}'`) turns the other window dark within a
  second, and `-d '{"theme":"auto"}'` puts it back; a row ticked, and a timer started and
  finished, in one window show in the other within a second.
  A tick in the page sends its PUT and no GET of `/api/days`, `/settings`, `/sessions/running` or
  `/board` after it, with one `/api/changes` pending in the Network panel. Switching to another tab
  ends its `/api/changes`, and coming back opens exactly one; a row ticked in the other window
  meanwhile shows within a second, however soon it comes back. Under the `prod` config the same
  tick in two windows leaves the console free of CSP violations, and `curl -sN
  localhost:8090/api/changes` prints `data: N` at once and `: ping` within 25 s. No width or theme
  pass: nothing new is drawn.
- **Punches**: a pair added before lunch, an early Clock out (done, celebration), "Add Extra
  Out / In" after it (the old Clock out becomes Out N) and removing that pair. In the time
  field: clear Clock in and press `0` `7` `3` `0` (the hour advances, the period fills, the
  tiles move with no further key), `p` flips the period and ↑/↓ on a segment saves each step. In
  the browser pane send single `key` presses; the `type` action pastes the whole string into one
  segment.
- **Priorities or the timer card**: tick one row and press Add Priority (the notice lists the
  ticked row); in the timer's label box, the list of open rows on a press and on Tab (not on the
  focus Finish hands back), under the box at its width and over the card, whose height stays put as
  it opens and as a break starts; pick one, start, and the log row shows the number; a new name,
  started, lands on today's list and in the board's In Progress; the log row's edit of a session
  on a written row shows its name as text, with no hover. Empty a written row's box and retype the
  carried row's name: where the hints under them sit (at 375, under the row's own chip, nearer it
  than the next row). × on the carried row: how "Remove …" renders, a long name included. Notes: row
  3's note button drawn filled and the others' quiet (shown on the row's hover or focus with a
  mouse, always on a phone); a mouse over row 3's button shows its note's two lines as a tooltip,
  an empty one's shows "Add a note", and row 3's shows none while its box is open; open row 3's
  note under the row, after any hint, lined up with the
  field; type past eight lines (it grows, then scrolls); a ticked row's note isn't struck through.
  Categories: pick a category on a row (an empty chip shows only on the row's hover or focus with a
  mouse, always on a phone; a long name ends in an ellipsis; at 375 the chip sits under the field,
  nearer it than the next row's, and the field keeps the row's width, beside the ×; from 640 it sits
  beside the field, which ends in the same place written or empty), type a new name in the timer's
  label box and pick one in the chip at the end of its row (at 375 the box narrows and the row stays
  one line) and give an unplanned log session one (its dot before the label), then the same at 1280
  in the split's columns.
- **Recurring priorities**: Settings → Board → Recurring Priorities: Recurring rows per day with
  its hint beside the box, and nothing else. On the board at 1440: Later ends with Repeats (the
  seeded "Monitor the queue" ↻ Mon–Fri and "Follow-ups" ↻ Mon, Wed, Fri), counted in Later's number,
  below Later's Show N More once it folds. A Next card's Repeat row: its first day asks first (Cancel
  sends nothing), then the card moves under Repeats with its day, the dialog stays open with the
  focus on that day and Stop Repeating in Delete's place; more days, and the last one staying on.
  Today's one-off row made to repeat stays in In Progress with the mark, and its past day in History
  and Review → Week (Routines) follow. A card of Repeats: Move to In Progress and Done (the burst),
  Start timer, a drag onto In Progress, and one dropped in Next or Later snapping back with the
  notice. Stop Repeating on a card of Repeats (the focus on the next card) and on today's row (the
  row stays, its Repeat row gone). At 1000 the days and the mark wrap on the meta line; at 375, in
  the bottom sheet, the seven days fit on one line, each 44 × 44 px on a touch screen, with Stop
  Repeating under them. A screen reader hears the Repeat group, each day's name and pressed state,
  the last day as unavailable, and a card of Repeats' "Repeats" and its days (check how "Mon–Fri"
  reads). A recurring row's meta line has the Repeats mark, and at 1440 and 1000 a mouse anywhere
  on a recurring card but its tick, the mark included, shows "Repeats" (its note's start once it
  has a note). On the sheet, with a routine due today (see AGENTS.md's "Dev data is disposable"
  for the three groups): the morning notice with "Still Open From …", "Up Next" (ticked to fill
  Rows per day after the leftovers), "Repeats Today" and the line once
  more routines are ticked than Recurring rows per day; after Add to Today, the leftovers then Up
  Next in the first rows and the routines after the padded rows, Up Next's cards in In Progress on
  the board, and the mark before the chip on a routine's row; at 1280 and 1000 the mark and a long
  category in the chip's column, and at 375 the mark before the chip under the field.
- **Retro or review**: one seeded day's retro card and History → Review → Week (`--quarter` for
  Month / Quarter). Today's card folded to its Open button at 1280, 1000 and 375: Open shows it
  with the focus in the note box, Now on Clock out opens it, and with the alarm recipe (see
  "Alarms") the retro alarm's Open Retrospective lands on it opened, the focus in the note box. By
  Category in Review → Week and Month (solid and striped bars, No category last), in light and
  dark. For
  Added mid-day's "mostly …", give the last weekday's "Reply to the recruiter" row a category with
  its chip (the seed files that task under none) and open the Week that holds that day (◀ on a
  Monday): it is one task on every day the seed adds it mid-day, so the category reaches each of
  them, and any period holding one of those days names it.
- **The board**: after `npm run seed`, press Board. At 1440: the four columns; each +'s box (Later's
  card at the top, Next's at the end, In Progress's row on today's sheet and asking past three rows;
  Enter keeps the box, an empty Enter or Escape closes it, one with text stays open when left); a
  left-open task's "Left open from …" in Next, Move to from each column (a done item's notice), a
  park of a task typed seconds ago, a done-earlier task's dialog, this week's routine ticks in Done,
  each with its day ("Done yesterday"), the fold's number gone while nothing is done today, and a
  task ticked on a later day with today's, its dialog naming that day (in a second tab, DevTools →
  Sensors → Location, Timezone ID Pacific/Kiritimati: Move to Done on a Next card, then reload the
  first tab); with the earlier days' read failing (wrap `window.fetch` so `GET /api/days/range`
  rejects, then press Board), Done ends with "Could not load these days" and Try Again, and no
  banner. The dialog: a click on a card's title, its meta line or its padding opens it, and so does
  Enter; the tick ticks and opens nothing. Enter in the title saves and closes, and the dialog stays
  closed; Escape drops the edit; leaving the box saves. Move to from every column, Start timer,
  Delete's confirm (Cancel keeps the dialog) and Remove From Today on a routine's row each leave the
  focus on the card, or the next card after Delete; a Next card's Move to In Progress with three
  rows open closes it with the nudge's first button focused, as a done row's Move to Later does
  with its notice's, and Keep It Short or Leave It puts the focus back on the card. An alarm banner
  with a dialog open. At 1000, where the columns are narrowest: titles clamp to two lines and meta
  lines wrap. At 375: the switch shows one column, the notice wraps, the dialog is a bottom sheet
  whose Move to and Start lengths wrap under their labels (four targets on a left-open task), and
  with sign-in on (`web-local`, `npm run seed -- --auth local --sessions`, the printed cookie set)
  the header's four buttons fit with the brand's name gone, the same as on the sheet.
  Light and dark. The drag pass: at 1440, drag with the mouse from anywhere on a card between each
  pair of columns (Later and Next take the card where it is dropped; a press that moves under 6 px
  opens the dialog, and no click lands after a drag), a done row onto Later (the notice), then by
  keyboard (Tab to a card, Space, arrows, Space; Enter opens its dialog) with a screen reader,
  which hears where the card is, the done-item line and the card's instructions, and Escape puts
  it back. In Chrome, Safari and Firefox: a click or drag from a card's padding and meta line, and
  Space or Enter dropping a card with no dialog opening. With reduced motion on, nothing glides. At
  1000 the copy under the pointer isn't clipped; on a phone (a real iPhone and Android phone) a tap
  opens the bottom sheet, a hold of about a quarter second lifts a card of Later or Next, which
  sorts within the column shown (one of In Progress or Done stays put), a finger that moves first
  scrolls the page and the column, and no text selection or callout shows on a long hold. The
  clock bar, at 1440, 1000 and 375: above the notice and the
  columns with the seeded times and the time left, one line from 640 px and label over time over
  line on a phone; Overtime approved, Overtime off and the meal periods off (no Lunch By, and the
  switch's hint drops the lunch deadline) change it as they change the sheet's tiles; Settings →
  Timeclock → Times on the board off hides it.
  Start timer, at 1440, 1000 and 375 (the lengths wrap under their label): a row's Start (the bar
  shows the timer, the row's meta line `running`, then `paused`), a Next card's with three rows
  open (no nudge: it pulls and starts), and with a timer running no dialog offers it.
  Notes, at 1440, 1000 and 375: the SSO card's "Has a note" mark on its meta line, and none on the
  others; at 1440 and 1000, a mouse over the SSO card's title, padding or mark shows its note as a
  tooltip, and no other card shows a note (a recurring card shows "Repeats"); its dialog's box with
  the note, saved once typing stops (the wait is under AGENTS.md's Conventions) and as the dialog
  closes by Escape, × or a press outside; with a screen reader, the mark is read on the card; an
  earlier day's tick of a recurring priority that stopped repeating shows its note as text. A key
  typed into a note does nothing. Categories (with about 30 added by `curl` to
  `/api/board/categories` for a long list): a box's chip (a pick, New category, kept after a reload
  and in the other boxes), a card dialog's chip with its list opening over the sheet, unclipped,
  scrolling inside with the box in view, its Escape closing only the list, the cards' dot and name
  (a long name at 1000), and Settings → Board (a rename, a name in use, the swatches wrapping at
  375, Remove, the touch areas).
- **Keyboard shortcuts**: after `npm run seed -- --running`, at 1280: ? opens
  the list with the focus on it, ? again does nothing and Escape gives the focus back; P pauses
  and resumes, + adds the step, and once the timer is a minute or more past its end (see "The
  timer") F opens "How Much to Log?", where keys do nothing; after the finish, R starts a break and
  R again does nothing; N puts the focus in a free row with no n typed, and with three written rows
  leaves it on Add Priority beside the nudge; H and B there and back, S from History, each leaving
  the focus on its header button. An h typed into a day log label (the Inbox row's edit), a
  priority, Clock in's hour, the date picker and an open category list, or pressed with Settings
  open, does nothing, and Option+B, Cmd+H and Ctrl+F do only what the browser does. On
  the board at 1440, N opens Later's box (with a box already open too), R does nothing, and a key
  pressed during a keyboard drag does nothing. With Settings → Sheet → Keyboard off no key acts.
  The list at 1000 and 375, light and dark; a screen reader reads its title and keys, and a
  button's key.
- **The History calendar**: one month at the mobile preset: ◀ to a seeded month, tap a day,
  **Open Day**, browser Back lands on that month with the day picked, and back through the
  header, **Review This Week** lands on that week. Review → Month → ◀ → a row → Back lands on that
  month's review. With the sticker chart on (`PUT /api/settings {"stickers":true}`), a chip narrows
  the grid to one sticker and a second tap clears it; with Show weekends off, five columns.
- **Retention**: one look at Settings → Data (count line, toggle saves); drive the delete with
  curl (`POST /api/days/prune` with `{"before":"YYYY-MM-DD"}`) because of the confirm dialog.
- **Auth**: no browser pass; the tests in `server/auth/` (`*.test.ts`) cover local and OIDC
  sign-in, cookie sessions, passwords, the limiter, user management and the reset-password
  command.
- **Anything a README screenshot or the Unraid listing shows** (sheet, retro, history, review,
  settings, the board): `npm run screenshots`, then CONTRIBUTING's screenshot step.
