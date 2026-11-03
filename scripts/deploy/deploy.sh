#!/usr/bin/env sh
# Deploy an image tag to the production-like compose stack, verify it, and roll back on failure.
#
# Usage: scripts/deploy/deploy.sh <tag>
# Images anvaya-{web,api,ai-service}:<tag> must exist (scripts/deploy/build-images.sh <tag>).
# Success criteria: every service healthy (compose --wait), the web app serves /login, and the API is
# ready through the web origin's /api/v1 proxy. On failure the previously deployed tag is redeployed
# and re-verified, and the script exits 1. The deployed tag is recorded in .deploy/current.
set -eu

[ "$#" -eq 1 ] || { echo "usage: $0 <tag>" >&2; exit 2; }
tag="$1"
root=$(cd "$(dirname "$0")/../.." && pwd)
compose_file="$root/infra/compose/docker-compose.prod.yml"
state="$root/.deploy"
web="${ANVAYA_WEB_URL:-http://127.0.0.1:3080}"
mkdir -p "$state"
previous=$(cat "$state/current" 2>/dev/null || true)

up() {
  ANVAYA_TAG="$1" docker compose -f "$compose_file" up -d --wait --wait-timeout "${ANVAYA_DEPLOY_TIMEOUT:-180}" --remove-orphans
}

verify() {
  i=0
  while [ "$i" -lt 30 ]; do
    login=$(curl -s -o /dev/null -w '%{http_code}' "$web/login" || true)
    ready=$(curl -s -o /dev/null -w '%{http_code}' "$web/api/v1/health/ready" || true)
    [ "$login" = 200 ] && [ "$ready" = 200 ] && return 0
    i=$((i + 1))
    sleep 2
  done
  echo "smoke check failed: /login=$login /api/v1/health/ready=$ready" >&2
  return 1
}

running_tag() {
  # ps only needs the file to interpolate; the tag value is irrelevant here.
  id=$(ANVAYA_TAG=any docker compose -f "$compose_file" ps -q api 2>/dev/null | head -1)
  [ -n "$id" ] && docker inspect --format '{{.Config.Image}}' "$id" | sed 's/.*://'
}

echo "deploying $tag (previous: ${previous:-none})"
if up "$tag" && verify; then
  echo "$tag" > "$state/current"
  echo "deployed $tag"
  exit 0
fi

echo "deploy of $tag FAILED" >&2
if [ -z "$previous" ]; then
  echo "no previous release to roll back to" >&2
  exit 1
fi
echo "rolling back to $previous" >&2
if up "$previous" && verify; then
  echo "rolled back to $previous (running: $(running_tag))" >&2
else
  echo "ROLLBACK FAILED: manual intervention required (docs/runbooks/deploy-and-rollback.md)" >&2
fi
exit 1
