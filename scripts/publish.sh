#!/usr/bin/env bash
# Publish edgelit to npm.
#
# Usage:  scripts/publish.sh            # dry run: checks, tests, build, `npm pack`
#         scripts/publish.sh --publish  # the real thing (npm prompts for 2FA in the browser)
#
# Run from a real terminal: npm's two-factor step opens a browser page.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISH=0
[[ "${1:-}" == "--publish" ]] && PUBLISH=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "preflight"
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean; commit or stash first"; exit 1; }
git fetch -q origin && [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/master)" ]] || { echo "HEAD is not pushed to origin/master"; exit 1; }
if (( PUBLISH )); then npm whoami >/dev/null 2>&1 || { echo "not logged in to npm (run: npm login)"; exit 1; }; fi

say "tests and build"
npm ci --silent
npm run typecheck
npm test
npm run build
# Browser tests need a Chromium; skip quietly if Playwright's is not installed.
if [[ -d "$HOME/.cache/ms-playwright" ]]; then npm run test:browser; else echo "(playwright browsers not installed; skipping browser tests)"; fi

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
say "$name@$version"
if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "already on npm; bump the version in package.json first"
  exit 1
fi

if (( PUBLISH )); then
  npm publish --access public
  git tag -a "v$version" -m "edgelit $version"
  git push --tags -q
  say "published; tag v$version pushed"
else
  npm pack --dry-run 2>&1 | grep -E "npm notice (name|version|total files|package size)"
  say "dry run only; rerun with --publish"
fi
