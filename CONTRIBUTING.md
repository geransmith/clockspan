# Contributing and releasing

The rules below are enforced by GitHub where they can be (a ruleset on `main`, required CI)
and expected everywhere else. They apply to the maintainer and to Claude Code alike.

## How changes land

`main` is protected: no direct pushes, no force pushes, no deletion. Every change is a pull
request, squash-merged, with the `check` job green. Only collaborators can push branches or
merge. Outsiders can open a PR from a fork; its CI run waits for a collaborator to approve it,
and a fork PR can never publish an image or a release.

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
patch, not re-tagged.

**Checklist, in order.** The tag has to point at the squash commit on `main`, which is why
the bump is a PR first and the tag comes second.

1. Bump the version in a PR:

   ```bash
   git switch -c release/vX.Y.Z
   npm version <minor|patch> --no-git-tag-version   # prints the new version
   git commit -am "Release vX.Y.Z"
   git push -u origin HEAD
   gh pr create --fill --label skip-changelog
   gh pr checks --watch
   gh pr merge --squash --delete-branch
   ```

2. Tag `main`:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. Watch and check:

   ```bash
   gh run watch
   gh release view vX.Y.Z --web
   ```

   The notes list the PRs merged since the last release, grouped by label, with a
   `docker pull` line on top. Reword a line on GitHub if it reads badly.

**What the tag does.** `check` runs first and fails if `package.json` does not match the tag.
Then the image is built and pushed as `ghcr.io/geransmith/clockspan:X.Y.Z`, `:X.Y` and
`:latest`, and the GitHub Release is created with generated notes.

**If the run fails.** Nothing has been published. Fix the cause through a normal PR, then
drop the tag and tag again:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

## What CI does

| Event | Jobs | Result |
| --- | --- | --- |
| Pull request | `check` | typecheck, lint, test, build |
| Push to `main` | `check`, `image` | `ghcr.io/geransmith/clockspan:edge` |
| Push tag `vX.Y.Z` | `check`, `image`, `release` | `:X.Y.Z`, `:X.Y`, `:latest` and the GitHub Release |

Image tags: `latest` is the newest release, `X.Y.Z` and `X.Y` pin a release, `edge` is the
latest commit on `main` and has only passed CI.
