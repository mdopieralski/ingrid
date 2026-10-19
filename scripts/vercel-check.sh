#!/usr/bin/env bash
# Runs Vercel's own build locally (no Vercel account or token needed), checks the
# function it produces, then starts that function and calls it. This catches
# what the normal build cannot see: Vercel's stricter TypeScript check, which
# file it picks as the entry, and which files it leaves out of the bundle.
set -euo pipefail

VERCEL_CLI=vercel@64.3.1
PORT=${PORT:-3999}
export VERCEL_TELEMETRY_DISABLED=1

# `vercel build` needs project settings. Keep real ones from `vercel link`.
# Start from a clean output, so nothing from an earlier run can hide a gap.
mkdir -p .vercel
rm -rf .vercel/output
if [ ! -f .vercel/project.json ]; then
  echo '{"projectId":"local","orgId":"local","settings":{"framework":"express","nodeVersion":"22.x"}}' \
    > .vercel/project.json
fi

pnpm dlx "$VERCEL_CLI" build --yes

FUNC=.vercel/output/functions/index.func
fail() { echo "vercel:check failed: $*" >&2; exit 1; }

handler=$(node -p "require('./$FUNC/.vc-config.json').handler")
[ "$handler" = "src/index.js" ] || fail "Vercel picked $handler as the entry, expected src/index.js"
[ -f "$FUNC/src/docs/openapi.yaml" ] || fail "openapi.yaml is missing from the function bundle"

PORT=$PORT node "$FUNC/src/index.js" > .vercel/check-server.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  if curl -fsS "http://localhost:$PORT/health" > /dev/null 2>&1; then
    curl -fsS -o /dev/null "http://localhost:$PORT/openapi.json" || fail "/openapi.json does not answer"
    docs=$(curl -fsS "http://localhost:$PORT/docs") || fail "/docs does not answer"
    # Every file the docs page loads must come from the bundled function.
    assets=$(grep -oE '(href|src)="/[^"]+"' <<< "$docs" | sed -E 's/^(href|src)="//; s/"$//')
    [ -n "$assets" ] || fail "/docs references no assets"
    for path in $assets; do
      curl -fsS -o /dev/null "http://localhost:$PORT$path" || fail "$path, loaded by /docs, is not served"
    done
    echo "vercel:check passed: entry $handler, bundle complete, function and docs assets answer"
    exit 0
  fi
  sleep 0.5
done
cat .vercel/check-server.log >&2
fail "the bundled function did not answer on /health"
