#!/usr/bin/env sh
# Provision the root filesystems the gVisor sandbox driver runs verification profiles in.
#
# The worker never pulls images or talks to a container daemon: an operator (or the deploy
# pipeline) runs this once per image version on the execution host. Each image's filesystem is
# exported to <rootfs-dir>/<image with non [A-Za-z0-9._-] characters replaced by _>, matching
# GvisorSandboxDriver.rootfsFor(). Re-running replaces a directory atomically.
#
# Usage: prepare-rootfs.sh <rootfs-dir> <image>...
#   e.g. prepare-rootfs.sh /var/lib/anvaya/rootfs python:3.12-slim node:22-alpine
# Requires: docker (or podman via DOCKER=podman) and tar. Pin images by digest in production.
set -eu

[ "$#" -ge 2 ] || { echo "usage: $0 <rootfs-dir> <image>..." >&2; exit 2; }
DOCKER="${DOCKER:-docker}"
ROOTFS_DIR="$1"
shift
mkdir -p "$ROOTFS_DIR"

for image in "$@"; do
  name=$(printf '%s' "$image" | sed 's/[^A-Za-z0-9._-]/_/g')
  target="$ROOTFS_DIR/$name"
  staging="$ROOTFS_DIR/.staging-$name-$$"
  echo "provisioning $image -> $target"
  "$DOCKER" pull --quiet "$image" >/dev/null
  cid=$("$DOCKER" create "$image" /bin/true)
  trap '"$DOCKER" rm -f "$cid" >/dev/null 2>&1 || true; rm -rf "$staging"' EXIT
  mkdir -p "$staging"
  # --no-same-owner: files stay owned by the operator; the sandbox user is uid 65534 either way.
  "$DOCKER" export "$cid" | tar -x -C "$staging" --no-same-owner --exclude='dev/*'
  "$DOCKER" rm -f "$cid" >/dev/null
  trap - EXIT
  # The sandbox runs as nobody with a read-only root: nothing in it needs to be writable.
  chmod -R a+rX,go-w "$staging"
  rm -rf "$target.old"
  [ -d "$target" ] && mv "$target" "$target.old"
  mv "$staging" "$target"
  rm -rf "$target.old"
done
