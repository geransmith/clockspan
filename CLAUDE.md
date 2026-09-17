@AGENTS.md

## Claude Code notes

- Verify UI changes in the built-in browser: `preview_start` the `web` config from
  `.claude/launch.json` (it sources nvm and runs `npm run dev`), then `resize_window` to the
  `mobile` preset for the phone pass and `colorScheme: light` for the light-mode check.
- `window.confirm` dialogs (cancel timer, delete session/user) are awkward to drive in the
  pane; hit the API with curl for those steps.
- Run `npm test` and `npm run typecheck` before reporting a change as done.
- A change in `server/` is verified by adding or extending a test in that router's
  `*.test.ts` (see `server/dev/harness.ts`), not by driving the browser. Browser passes are
  for visible UI changes only, scoped to what changed; see "Verification expectations" in
  AGENTS.md.
- Run `npm run seed` (add `--running` for timer work, `--quarter` for Month / Quarter
  review) before any browser check so the page has data. It is safe while the dev server
  is running; reload the page.
- The dev DB (`data/focus.db`) migrates itself when the server starts; a schema change only
  needs a new entry in `MIGRATIONS` (`server/db.ts`).
- The dev DB is disposable. `npm run seed` is the normal way to fill it; insert, change, or
  delete rows with curl or `sqlite3`, or delete the file, without asking. Details under
  "Dev data is disposable" in AGENTS.md.
- To exercise alarms quickly: Settings → Work day and Second meal due after = a few minutes
  each, then clock in. "Overtime approved" on the card or on the clock-out banner
  is the quick way to silence the clock-out alarm mid-test; lunch must keep counting down.
- Never commit `data/` or `.env`.
- If you change layout defaults, settings defaults, or alarm definitions, update the
  "How to add…" checklists in AGENTS.md so they stay true.
