#!/bin/sh
# Boots a built image and checks that it serves. CI runs it on every pull request and, on main,
# before anything is pushed, so every tag that gets published belongs to an image that started.
#
#   scripts/smoke-image.sh <image>
#
# Needs Docker, curl and a free port 8080 on the host. The container's log is printed and the
# container removed at the end, pass or fail.
set -eu

image="${1:?usage: smoke-image.sh <image>}"
name="clockspan-smoke-$$"

cleanup() {
  echo "--- container log"
  docker logs "$name" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() {
  echo "--- $1"
}

docker run -d --name "$name" -p 8080:8080 "$image" >/dev/null

step "the server answers (the database opened, so the native module loaded)"
for _ in $(seq 30); do
  curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8080/api/health
echo

step "the built client is in the image and the SPA shell is served"
curl -fsS http://127.0.0.1:8080/ | grep -q '<div id="root">'

step "the entrypoint handed /data to PUID 1000"
test "$(docker exec "$name" stat -c %u /data)" = 1000

step "root was dropped: PID 1 (node) runs as 1000"
test "$(docker exec "$name" stat -c %u /proc/1)" = 1000

step "the HEALTHCHECK's own command passes where Docker runs it"
docker exec "$name" sh -c 'wget -qO- "http://127.0.0.1:$PORT/api/health"' >/dev/null

echo "--- smoke test passed"
