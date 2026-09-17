#!/bin/sh
# Own /data as PUID:PGID (image default 1000/1000, Unraid convention 99/100) and drop
# privileges before starting node. 0/0 or empty values keep the process as root.
set -e
if [ -n "$PUID" ] && [ -n "$PGID" ] && [ "$PUID" != "0" ]; then
  # A passwd entry is nice-to-have only; su-exec works with numeric ids regardless.
  addgroup -g "$PGID" app 2>/dev/null || true
  adduser -D -H -u "$PUID" -G "$(awk -F: -v g="$PGID" '$3==g{print $1; exit}' /etc/group)" app 2>/dev/null || true
  chown -R "$PUID:$PGID" "${DATA_DIR:-/data}"
  export HOME=/tmp
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
