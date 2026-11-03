#!/usr/bin/env sh
# Build the three deployable images with one immutable tag (default: the current commit).
# Usage: scripts/deploy/build-images.sh [tag]
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
tag="${1:-$(git -C "$root" rev-parse --short=12 HEAD)}"
docker buildx build --load -t "anvaya-api:$tag" "$root/apps/api"
docker buildx build --load -t "anvaya-ai-service:$tag" "$root/services/ai-service"
# Next.js fixes rewrites at build time: the web server proxies /api/v1 to the compose service name.
docker buildx build --load --build-arg ANVAYA_API_ORIGIN=http://api:3001 -t "anvaya-web:$tag" "$root/apps/web"
echo "$tag"
