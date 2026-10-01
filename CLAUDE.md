@AGENTS.md
@CONTRIBUTING.md

## Claude Code notes

- Verify UI changes in the built-in browser: `preview_start` the `web` config from
  `.claude/launch.json` (AGENTS.md's Commands section lists the others), then `resize_window`
  to the `mobile` preset for the phone pass and `colorScheme: light` for the light check.
- A step behind `window.confirm`: stub it in the page (`window.confirm = () => true`) or send
  the request with curl.
- Never type a password into the pane, not even the dev one. For a signed-in check under
  local or OIDC auth, `preview_start` `web-local` / `web-oidc`, run
  `npm run seed -- --auth local --sessions` (or `--auth oidc`), and set the cookie it prints.
- After opening a PR, watch its checks in the app's PR pane. "Release" or "cut a version"
  means CONTRIBUTING.md's release checklist; watch the `main` run it starts and report the
  release URL.
