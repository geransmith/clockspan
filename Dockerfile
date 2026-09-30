# check=skip=SecretsUsedInArgOrEnv
# The directive above must be the first line. It silences one build-check rule: the linter
# reads "AUTH" in ENV AUTH_MODE as a secret, but that is a mode switch (none | local | oidc).
# The secrets this app takes (OIDC_CLIENT_SECRET) are passed at run time, never baked in.
# Both stages name the same base by digest, not just the tag: a tag moves when Node or Alpine
# ships a fix, and an unpinned build would change under a release without anything in git
# saying so. Dependabot opens a PR when the tag moves, and CI's image-smoke boots it first.
# ---- build ----
# On the builder's own platform whatever the target: what comes out (the bundle, dist/server,
# and node_modules, where better-sqlite3 carries a prebuild for every platform and picks one at
# run time) is the same for amd64 and arm64, so an arm64 image emulates only the stage below.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilds (including linux-musl) and loads them when
# no build/ dir exists, but its binding.gyp makes npm run `node-gyp rebuild` by default, and
# whether the allowScripts policy blocks that differs between npm 11 and 12 (npm 12 in this
# image ran it and failed for lack of python). esbuild's postinstall is only an optimisation.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
# su-exec drops root in the entrypoint. The HEALTHCHECK's wget is busybox's, already in the
# base image; CI's image-smoke job runs that exact command inside the container. The app runs
# on `node` alone (reset-password too: `node dist/server/cli.js`), so the package managers the
# base image ships are removed: npm, npx, corepack and yarn, with the packages they bundle,
# which scanners would otherwise report against this image.
RUN apk add --no-cache su-exec \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The entrypoint owns /data as PUID:PGID (default 1000/1000) and drops root; PUID=0 keeps root.
COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh
# A runtime that ignores VOLUME would not make /data, and the entrypoint's `chown -R` needs it.
RUN mkdir -p /data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    AUTH_MODE=none

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
