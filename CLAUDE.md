@AGENTS.md
@CONTRIBUTING.md

## Claude Code notes

- Browser passes run in the built-in browser, in the order AGENTS.md's Verification step 4
  gives: `preview_start` the `web` config from `.claude/launch.json` (AGENTS.md's Commands
  section lists the others), `resize_window` to each width a pass names (the `mobile` preset for
  375; the `desktop` preset only clears the emulation, leaving the pane's own width), reload,
  and `colorScheme: light` / `dark` for the themes.
- A step behind `window.confirm`: stub it in the page (`window.confirm = () => true`) or send
  the request with curl.
- Never type a password into the pane, not even the dev one. For a signed-in check under
  local or OIDC auth, `preview_start` `web-local` / `web-oidc`, run
  `npm run seed -- --auth local --sessions` (or `--auth oidc`), and set the cookie it prints.
- After opening a PR, watch its checks in the app's PR pane. "Release" or "cut a version"
  means CONTRIBUTING.md's release checklist; watch the `main` run it starts and report the
  release URL.
