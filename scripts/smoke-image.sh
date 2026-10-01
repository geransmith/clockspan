#!/bin/sh
# Boots a built image and checks that it serves. CI runs it on every pull request and, on main,
# before anything is pushed, so every tag that gets published belongs to an image that started.
#
#   scripts/smoke-image.sh <image> [platform]
#
# Needs Docker, curl and a free port 8080 on the host. The container's log is printed and the
# container removed at the end, pass or fail. `platform` (linux/arm64) runs an image built for
# another architecture under QEMU, which CI registers first (docker/setup-qemu-action).
set -eu

image="${1:?usage: smoke-image.sh <image> [platform]}"
platform="${2:-}"
name="clockspan-smoke-$$"

cleanup() {
  echo "--- container log"
  docker logs "$name" 2>&1 || true
  # -v takes the anonymous /data volume with it, or every run would leave one behind.
  docker rm -fv "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() {
  echo "--- $1"
}

# Blank is how Unraid passes a cleared field and Compose a `PUID=` line: the same `${PUID:-1000}` as unset.
docker run -d --name "$name" ${platform:+--platform "$platform"} -e PUID= -e PGID= -p 8080:8080 "$image" >/dev/null

# Emulated, node takes several times as long to start.
step "the server answers (the database opened, so the native module loaded)"
for _ in $(seq 90); do
  curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8080/api/health
echo

step "the built client is in the image and the SPA shell is served"
curl -fsS http://127.0.0.1:8080/ | grep -q '<div id="root">'

step "a blank PUID/PGID takes the default: the entrypoint handed /data to 1000:1000"
test "$(docker exec "$name" stat -c %u:%g /data)" = 1000:1000

step "root was dropped: PID 1 (node) runs as 1000"
test "$(docker exec "$name" stat -c %u /proc/1)" = 1000

step "no package manager ships in the image: npm, npx, corepack and yarn were removed"
docker exec "$name" sh -c '! command -v npm && ! command -v npx && ! command -v corepack && ! command -v yarn' >/dev/null

step "the image's own HEALTHCHECK command passes where Docker runs it"
# Read from the image rather than copied here, so a typo in the Dockerfile's HEALTHCHECK fails
# this step too. The shell form is stored as CMD-SHELL and its command line.
test "$(docker inspect -f '{{index .Config.Healthcheck.Test 0}}' "$image")" = CMD-SHELL
docker exec "$name" sh -c "$(docker inspect -f '{{index .Config.Healthcheck.Test 1}}' "$image")"

echo "--- smoke test passed"
