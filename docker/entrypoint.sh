#!/bin/sh
# If PUID/PGID are given (Unraid convention: 99/100), own /data as that user and drop
# privileges. Otherwise run as-is (root), which is the simplest thing on most hosts.
set -e
if [ -n "$PUID" ] && [ -n "$PGID" ]; then
  # A passwd entry is nice-to-have only; su-exec works with numeric ids regardless.
  addgroup -g "$PGID" app 2>/dev/null || true
  adduser -D -H -u "$PUID" -G "$(awk -F: -v g="$PGID" '$3==g{print $1; exit}' /etc/group)" app 2>/dev/null || true
  chown -R "$PUID:$PGID" "${DATA_DIR:-/data}"
  export HOME=/tmp
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
