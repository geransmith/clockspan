@AGENTS.md
@CONTRIBUTING.md

## Claude Code notes

- Verify UI changes in the built-in browser: `preview_start` the `web` config from
  `.claude/launch.json` (nvm + `npm run dev`), then `resize_window` to the `mobile` preset for
  the phone pass and `colorScheme: light` for the light-mode check. The `prod` config builds
  and serves the real bundle on :8090 with the real response headers; use it for anything that
  touches `server/security.ts`, `index.html` or how assets load, and read the console for CSP
  violations.
- `window.confirm` dialogs (cancel timer, delete session/user, delete old days) are awkward to
  drive in the pane; hit the API with curl for those steps.
- Run `npm run test:coverage`, `npm run typecheck`, `npm run lint` and `npm run format:check`
  before reporting a change as done (`npm run format` fixes formatting; the coverage run fails
  unless every covered file is at 100%).
- A change in `server/` or `shared/` is verified by a test next to the code (harness tests for
  routes, see `server/dev/harness.ts`), not by driving the browser. Browser passes are for
  visible UI changes only, scoped to what changed; see "Verification expectations" in AGENTS.md.
- Run `npm run seed` (`--running` for timer work, `--quarter` for Month / Quarter review)
  before any browser check. The dev DB is disposable and migrates itself; see "Dev data is
  disposable" in AGENTS.md.
- Never type a password into the pane, not even the dev one. For a signed-in check under
  local or OIDC auth, `preview_start` `web-local` / `web-oidc`, run
  `npm run seed -- --auth local --sessions` (or `--auth oidc`), and set the cookie it prints.
  `window.confirm` can be stubbed in the page (`window.confirm = () => true`) when a step sits
  behind a confirm.
- To exercise alarms quickly: Settings → Work day and Second meal due after = a few minutes
  each, then clock in. "Overtime approved" on the card or on the clock-out banner
  is the quick way to silence the clock-out alarm mid-test; lunch must keep counting down.
- `npm run screenshots` regenerates the README images on its own. Run it after a UI change the
  README shows.
- Never commit on `main`. Every change goes through the PR flow in CONTRIBUTING.md (branch →
  `gh pr create` with one label → checks → squash merge). After opening a PR, use the app's PR
  pane to watch checks. "Release" or "cut a version" means the release checklist there: the
  version-bump PR, whose merge makes CI tag and publish; watch that `main` run and report the
  release URL when done.
- Never commit `data/` or `.env`.
- If you change layout defaults, settings defaults, alarm definitions, or response headers,
  update the "How to add…" checklists in AGENTS.md so they stay true.
