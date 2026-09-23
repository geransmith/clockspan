# Contributing and releasing

The rules below are enforced by GitHub where they can be (a ruleset on `main`, required CI)
and expected everywhere else. They apply to the maintainer and to Claude Code alike.

## How changes land

`main` is protected: no direct pushes, no force pushes, no deletion. Every change is a pull
request, squash-merged, with the `check` and `image-smoke` jobs green. A release is one such PR: the version bump. Only collaborators can push branches or
merge. Outsiders can open a PR from a fork; its CI run waits for a collaborator to approve it,
and a fork PR can never publish an image or a release.

Dependabot's PRs merge themselves (`.github/workflows/dependabot-automerge.yml`): once the
required checks pass, each is squash-merged, except a major version bump, which waits for a
review. Version updates are only proposed 7 days after the release (`cooldown` in
`.github/dependabot.yml`); security updates come at once.

The merge is queued with a token from the repository's own GitHub App, not with
`GITHUB_TOKEN`: GitHub starts no workflow for a merge that token caused, so `main` would get no
CI run and no new `edge` image. The app is set up once and has nothing to renew:

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (your account). Any name
   (e.g. `clockspan-automerge`), homepage the repository URL, **Webhook → Active** unticked.
   Repository permissions: **Contents**, **Pull requests** and **Workflows**, all *Read and
   write*. "Only on this account". Create it.
2. On the app's page, note the **Client ID**, then **Generate a private key** (a `.pem` file
   downloads).
3. **Install App** → your account → **Only select repositories** → `clockspan`.
4. In the repository, **Settings → Secrets and variables → Dependabot** (not Actions: a
   Dependabot run only sees these): `AUTOMERGE_APP_CLIENT_ID` = the client ID,
   `AUTOMERGE_APP_PRIVATE_KEY` = the whole `.pem` file. Delete the downloaded file afterwards.

Without those two secrets the workflow falls back to `GITHUB_TOKEN`: the PR still merges, and
`main` catches up at the next merge that isn't Dependabot's.

```bash
git switch -c <topic>            # never work on main
# edit, commit
git push -u origin HEAD
gh pr create --fill --label <label>
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch main && git pull
```

## Pull request requirements

- **Title**: imperative and specific. "Add second meal alarm", "Fix lunch tile after
  midnight". No prefixes or ticket numbers. The title becomes the commit message on `main`
  and a line in the release notes, so write it for a reader who will not open the PR.
- **One label**: `enhancement` (new behaviour or setting), `bug`, `documentation`, or
  `skip-changelog` (housekeeping, release bumps, CI, dependency updates). Unlabelled PRs land
  under "Other changes" in the notes.
- **Body**: what changed, why, and how it was verified. A few lines is enough.
- **Before opening**:
  - `npm run test:coverage`, `npm run typecheck`, `npm run lint` and `npm run format:check`
    pass locally. CI runs the same plus `npm run build`. The coverage run fails unless every
    file it measures is fully covered; `npm run format` fixes formatting.
  - `npm run screenshots` has been re-run if a README image changed, and the PNGs are in the diff.
  - The "How to add…" checklists in `AGENTS.md` still hold if defaults, alarms, settings or
    response headers changed.
  - Nothing from `data/` or `.env` is in the diff.
- **One topic per PR.** A release bump is its own PR.

## Releases

**When.** After any merged change a user would notice: a feature, a fix, a new setting, a
migration. Several PRs can share one release. Docs-only changes need no release.

**Version.** `0.x` until the author calls it `1.0.0`. `patch` for fixes, `minor` for new
behaviour, settings or migrations. A version is never reused: a bad release is followed by a
patch, not re-published.

**Checklist.** The release is the version-bump PR. Merging it is the last step by hand; CI
does the rest from the squash commit on `main`.

1. Bump the version in a PR:

   ```bash
   git switch -c release/vX.Y.Z
   npm version <minor|patch> --no-git-tag-version   # prints the new version
   git commit -am "Release vX.Y.Z"
   git push -u origin HEAD
   gh pr create --fill --label skip-changelog
   gh pr checks --watch
   gh pr merge --squash --delete-branch
   git switch main && git pull
   ```

2. Watch and check:

   ```bash
   gh run watch
   gh release view vX.Y.Z --web
   ```

   The notes list the PRs merged since the last release, grouped by label, with a
   `docker pull` line on top. Reword a line on GitHub if it reads badly.

**What the merge does.** `check` sees that `package.json`'s version differs from the previous
commit's and refuses to go on if a tag for it already exists. Then the image is built once and
pushed as `ghcr.io/geransmith/clockspan:edge`, `:X.Y.Z`, `:X.Y` and `:latest`, and the tag
`vX.Y.Z` and the GitHub Release are created on that commit with generated notes. No tag is
pushed by hand, and the tag CI creates starts no second run.

**If the run fails.** `check` failed: nothing was published; fix the cause through a normal PR
and bump again (the skipped version stays unused). `image` or `release` failed: re-run the
failed jobs, which is safe to repeat:

```bash
gh run rerun <run-id> --failed
```

## What CI does

| Event | Jobs | Result |
| --- | --- | --- |
| Pull request | `check`, `image-smoke` (both required) | install without dependency scripts and check registry signatures; typecheck, lint, test, build; a version that already has a tag fails. The image is built and booted (health, SPA shell, `/data` owner, the healthcheck command) and never pushed |
| Push to `main` | `check`, `image` | `ghcr.io/geransmith/clockspan:edge` |
| Push to `main` that changes the version | `check`, `image`, `release` | `:edge`, `:X.Y.Z`, `:X.Y`, `:latest`, the tag `vX.Y.Z` and the GitHub Release |
| Pull request or push that touches `.github/` | `zizmor` (not required) | a security audit of the workflows and `dependabot.yml`; findings fail the job |
| Dependabot's pull request | `automerge` | squash auto-merge once the required checks pass, except a major version bump |

A newer push to a pull request cancels that PR's older run; runs on `main` are never cancelled.
Actions are pinned to commit SHAs; Dependabot bumps them (SHA and version comment together).

Image tags: `latest` is the newest release, `X.Y.Z` and `X.Y` pin a release, `edge` is the
latest commit on `main` and has only passed CI.
