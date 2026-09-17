@AGENTS.md

## Claude Code notes

- Verify UI changes in the built-in browser: `preview_start` the `web` config from
  `.claude/launch.json` (it sources nvm and runs `npm run dev`), then `resize_window` to the
  `mobile` preset for the phone pass and `colorScheme: light` for the light-mode check.
- `window.confirm` dialogs (cancel timer, delete session/user) are awkward to drive in the
  pane; hit the API with curl for those steps.
- Run `npm test` and `npm run typecheck` before reporting a change as done.
- Never commit `data/` or `.env`.
- If you change layout defaults, settings defaults, or alarm definitions, update the
  "How to add…" checklists in AGENTS.md so they stay true.
