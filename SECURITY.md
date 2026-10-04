# Security policy

## Supported versions

The newest release is supported. A fix ships as a patch release of it, so
`ghcr.io/geransmith/clockspan:latest`, its major tag (`:X`, e.g. `:2`) and its minor tag
(`:X.Y`, e.g. `:2.1`) all pick it up; a pinned `X.Y.Z` tag, or the tag of an older major or
minor version (`:1` once 2.0 is out, `:2.0` once 2.1 is), needs updating by hand. The README's
Docker section has the commands.

## Reporting a vulnerability

Please don't open a public issue. Report it privately instead: this repository's **Security**
tab → **Report a vulnerability**. Only the maintainer sees the report.

Include what you can:

- the version (the image tag or the commit)
- the sign-in mode (`AUTH_MODE`) and whether the app sits behind a reverse proxy
- the steps to reproduce it, and what someone could do with it

Clockspan has one maintainer who works on it in spare time, so there is no promised response
time. You'll get an answer in the report's thread, and the advisory credits you unless you'd
rather not be named.

## Scope

In scope: the server, the web app and the Docker image built from this repository.

Out of scope: a deployment that skips the README's
[Exposing it to the internet](README.md#exposing-it-to-the-internet) steps (for example
`AUTH_MODE=none` on a public port, or `TRUST_PROXY=true`), a host name the operator listed in
`ALLOWED_HOSTS` or `APP_URL` that someone else controls, and problems in the reverse proxy or
identity provider in front of the app.
