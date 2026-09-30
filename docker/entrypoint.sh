#!/bin/sh
# Own /data as PUID:PGID and drop root before starting node. Unset or blank takes 1000/1000,
# as for every other variable (Unraid's template sets 99/100); PUID=0 keeps root.
set -e
uid="${PUID:-1000}"
gid="${PGID:-1000}"
if [ "$uid" != 0 ]; then
  chown -R "$uid:$gid" "${DATA_DIR:-/data}"
  exec su-exec "$uid:$gid" "$@"
fi
exec "$@"
