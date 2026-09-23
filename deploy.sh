#!/usr/bin/env bash
# deploy.sh — rsync the app to a shared host subdirectory.
#
# The source is the artifact: this pushes exactly the files that ship —
# the app shell — nothing else. Docs, tooling, and git internals never
# leave the repo.
#
# Configuration comes from the environment, never the repo:
#   DEPLOY_HOST   e.g. user@example.com
#   DEPLOY_DIR    target subdirectory, e.g. ~/www/noted
#
# Usage: pnpm deploy   (or: DEPLOY_HOST=user@host DEPLOY_DIR=~/www/noted bash deploy.sh)
set -euo pipefail

HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. user@host}"
REMOTE_DIR="${DEPLOY_DIR:?set DEPLOY_DIR, the target subdirectory, e.g. ~/www/noted}"

# Deployed exactly: index.html, manifest.json, sw.js, icon.svg,
# css/, js/, icons/. New shell files must be added here AND to the
# SHELL_FILES precache list in sw.js.
rsync -avz --delete \
  index.html \
  manifest.json \
  sw.js \
  icon.svg \
  css/ \
  js/ \
  icons/ \
  "$HOST:$REMOTE_DIR/"

echo "Deployed to $HOST:$REMOTE_DIR/"
echo "Release step check: did you bump CACHE_VERSION in sw.js? (docs/deployment.md)"