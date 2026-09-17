@AGENTS.md

## Claude Code notes

- Verify UI changes in the built-in browser: `preview_start` the `web` config from
  `.claude/launch.json` (it sources nvm and runs `npm run dev`), then `resize_window` to the
  `mobile` preset for the phone pass and `colorScheme: light` for the light-mode check.
- `window.confirm` dialogs (cancel timer, delete session/user) are awkward to drive in the
  pane; hit the API with curl for those steps.
- Run `npm test` and `npm run typecheck` before reporting a change as done.
- The dev DB (`data/focus.db`) migrates itself when the server starts; a schema change only
  needs a new entry in `MIGRATIONS` (`server/db.ts`).
- To exercise alarms quickly: Settings → Work day and Second meal due after = a few minutes
  each, then clock in. "Overtime approved" on the card or on the clock-out banner
  is the quick way to silence the clock-out alarm mid-test; lunch must keep counting down.
- Never commit `data/` or `.env`.
- If you change layout defaults, settings defaults, or alarm definitions, update the
  "How to add…" checklists in AGENTS.md so they stay true.
