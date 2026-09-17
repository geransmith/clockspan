# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
# better-sqlite3 ships prebuilt binaries for alpine; these let it compile if none match.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache su-exec wget
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
