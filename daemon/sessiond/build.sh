#!/usr/bin/env bash
# Build the static binaries and the two per-arch scratch images.
# Usage: build.sh [bin|image|all]  (default: all)
set -euo pipefail
cd "$(dirname "$0")"

GO="${GO:-$HOME/.local/share/mise/installs/go/1.27.1/bin/go}"
IMAGE="${IMAGE:-bundant/sessiond:0.1.0}"
TARGET="${1:-all}"

build_bin() {
  mkdir -p out
  for arch in amd64 arm64; do
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "$GO" build \
      -trimpath -ldflags="-s -w" -o "out/sessiond-linux-$arch" .
    echo "built out/sessiond-linux-$arch"
  done
}

build_image() {
  for arch in amd64 arm64; do
    podman build --platform "linux/$arch" \
      --build-arg TARGETARCH="$arch" \
      -t "$IMAGE-$arch" -f Dockerfile .
    echo "built $IMAGE-$arch"
  done
  # The host runs one arch; tag the native one as the default ref.
  native="$(go env GOARCH 2>/dev/null || true)"
  if [ -z "$native" ]; then native=arm64; fi
  podman tag "$IMAGE-$native" "$IMAGE"
  echo "tagged $IMAGE -> $IMAGE-$native"
}

case "$TARGET" in
  bin) build_bin ;;
  image) build_image ;;
  all) build_bin; build_image ;;
  *) echo "usage: build.sh [bin|image|all]" >&2; exit 2 ;;
esac
