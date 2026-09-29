# Contributing and releasing

The rules below are enforced by GitHub where they can be (a ruleset on `main`, required CI)
and expected everywhere else. They apply to the maintainer and to Claude Code alike.

## How changes land

`main` is protected: no direct pushes, no force pushes, no deletion. Every change is a pull
request, squash-merged, with the `check` and `image-smoke` jobs green. A release is one such PR: the version bump. Only collaborators can push branches or
merge. Outsiders can open a PR from a fork; its CI run waits for a collaborator to approve it,
and a fork PR can never publish an image or a release.

Dependabot (`.github/dependabot.yml`) opens a few `skip-changelog` PRs a week: npm, GitHub
Actions and the Docker base image. Version updates are only proposed 7 days after the release
(`cooldown`); security updates come at once. They are merged by hand like any other PR, as a
batch once `check` and `image-smoke` are green:

```bash
gh pr list --author app/dependabot
gh pr merge <number> --squash --delete-branch   # for each one that passed
```

Read a major version bump like an outside PR first: what could it break that the tests don't
reach (most components have no automated tests, and none test how they look)? Dependencies are pinned, so a fix only reaches
users in a release: cut a patch release after merging a security update (or one that fixes a
Dependabot alert) or a new Docker base image. Other bumps can wait for the next release.

`package.json`'s `allowScripts` names esbuild at its exact version: it is the one install script
a local `npm install` may run (CI and the image run none). When a bump moves esbuild to another
version, move that entry in the same PR, or a local install leaves the script unapproved.

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
- **One label**: `enhancement` (new behaviour or setting), `bug`, `documentation`,
  `breaking` (a change that needs a major release; see "Version" below, and it wins over the
  others), or `skip-changelog` (housekeeping, release bumps, CI, dependency updates).
  Unlabelled PRs land under "Other changes" in the notes.
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

**Version.** [Semantic Versioning](https://semver.org) from 1.0.0: `MAJOR.MINOR.PATCH`, and a
release takes the largest bump any PR in it needs. What the version promises is what someone
running the image relies on:

- the environment variables, what they mean and their defaults;
- the `/data` volume and its database, which a release migrates forward when it starts (going
  back to an older release after that is not supported);
- the container: port 8080, `PUID`/`PGID`, the platforms (`linux/amd64`, `linux/arm64`) and
  the healthcheck;
- the `reset-password` command.

The JSON under `/api` belongs to the web app that ships in the same image, and can change in
any release.

- **major**: an upgrade that can break a working install or needs the operator to act. A
  variable removed, renamed or given a different default; a platform dropped; stored data
  dropped or rewritten so that something is lost. Its PR carries the `breaking` label (the
  notes list it first, under "Breaking changes") and its body says what to do.
- **minor**: anything new that works without the operator doing anything: a feature, a
  setting, a card, an optional variable, a migration that only adds.
- **patch**: fixes, dependency and base-image updates, and wording.

Versions are plain `X.Y.Z`: no pre-releases. CI refuses a version that isn't `X.Y.Z` or isn't
higher than the one before it. A version is never reused: a bad release is followed by a
patch, not re-published.

**Checklist.** The release is the version-bump PR. Merging it is the last step by hand; CI
does the rest from the squash commit on `main`.

1. Bump the version in a PR:

   ```bash
   git switch -c release/vX.Y.Z
   npm version <major|minor|patch> --no-git-tag-version   # prints the new version
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
commit's and refuses to go on if it isn't a higher `X.Y.Z` or a tag for it already exists.
Then the image is built once and pushed as `ghcr.io/geransmith/clockspan:edge`, `:X.Y.Z`,
`:X.Y`, `:X` and `:latest`, labelled
`org.opencontainers.image.version=X.Y.Z` (any other push to `main` is labelled `edge`), and the
tag `vX.Y.Z` and the GitHub Release are created on that commit with generated notes. No tag is
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
| Pull request | `check`, `image-smoke` (both required) | install without dependency scripts and check registry signatures; `npm audit --audit-level=high` (a new advisory can turn an unchanged PR red: merge the fix first); typecheck, lint, format:check, test:coverage, build; a changed version must be a higher `X.Y.Z` with no tag yet. The image is built for amd64 and for arm64 (under QEMU) and each is booted by `scripts/smoke-image.sh` (health, SPA shell, `/data` owner, root dropped, no package manager, the healthcheck command); nothing is pushed |
| Push to `main` | `check`, `image` | both platforms are built and booted by the same script, and only then pushed as one multi-platform `ghcr.io/geransmith/clockspan:edge` |
| Push to `main` that changes the version | `check`, `image`, `release` | `:edge`, `:X.Y.Z`, `:X.Y`, `:X`, `:latest`, the tag `vX.Y.Z` and the GitHub Release |
| Pull request, push to `main`, weekly | `CodeQL` (not required) | static security analysis of the TypeScript (`security-extended`); alerts land in code scanning, and GitHub fails the PR's CodeQL check on a new high or critical one |
| Pull request or push that touches `.github/` | `zizmor` (not required) | a security audit of the workflows and `dependabot.yml`; findings fail the job |

A newer push to a pull request cancels that PR's older run; runs on `main` are never cancelled.
Actions are pinned to commit SHAs; Dependabot bumps them (SHA and version comment together).

Image tags: `latest` is the newest release; `X` follows a major version through its minor and
patch releases, never across a breaking change; `X.Y` follows a minor version's patches;
`X.Y.Z` is one release; `edge` is built from `main` and has only passed CI (two merges close
together build side by side, so for a few minutes it can be the one before the latest).
