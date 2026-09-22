# check=skip=SecretsUsedInArgOrEnv
# The directive above must be the first line. It silences one build-check rule: the linter
# reads "AUTH" in ENV AUTH_MODE as a secret, but that is a mode switch (none | local | oidc).
# The secrets this app takes (OIDC_CLIENT_SECRET) are passed at run time, never baked in.
# ---- build ----
FROM node:24-alpine AS build
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
FROM node:24-alpine
WORKDIR /app
# su-exec drops root in the entrypoint. The HEALTHCHECK's wget is busybox's, already in the
# base image; CI's image-smoke job runs that exact command inside the container.
RUN apk add --no-cache su-exec
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data

# PUID/PGID: the entrypoint owns /data as this user and drops root before starting node.
# Override to match the host directory's owner (Unraid: 99/100); 0/0 keeps root.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    AUTH_MODE=none \
    PUID=1000 \
    PGID=1000

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
