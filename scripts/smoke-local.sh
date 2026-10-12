#!/bin/sh
# `npm run smoke`: CI's image-smoke on this machine. Builds the image for amd64 and arm64 and boots
# each with smoke-image.sh, then removes both images.
#
# With no `docker` command it says so and passes: Docker is recommended, not required, and
# image-smoke runs on the pull request anyway. A `docker` that doesn't answer fails, since the
# check was meant to run. The platform that isn't this machine's runs emulated: Docker Desktop and
# OrbStack do that as installed; plain Docker on Linux needs QEMU registered once
# (docker run --privileged --rm tonistiigi/binfmt --install all).
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "No Docker here, so the image was not built. image-smoke builds and boots it on the pull request."
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not answering: start it and run npm run smoke again." >&2
  exit 1
fi

trap 'docker rmi -f clockspan:smoke-amd64 clockspan:smoke-arm64 >/dev/null 2>&1 || true' EXIT
for arch in amd64 arm64; do
  echo "--- build linux/$arch"
  docker build -q --platform "linux/$arch" -t "clockspan:smoke-$arch" . >/dev/null
  sh scripts/smoke-image.sh "clockspan:smoke-$arch" "linux/$arch"
done
