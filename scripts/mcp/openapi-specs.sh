#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${POME_OPENAPI_MCP_REPO_URL:-git@github.com:pome-sh/openapi-spec-mcp.git}"
CACHE_DIR="${POME_OPENAPI_MCP_CACHE_DIR:-$HOME/.cache/pome/openapi-spec-mcp}"

fail() {
  {
    echo "openapi-specs MCP server: FAILED TO START"
    echo
    echo "  $1"
    echo
    echo "  pome-sh/openapi-spec-mcp is a private repo. This launcher clones"
    echo "  and refreshes it into: $CACHE_DIR"
    echo "  Confirm you can run: git clone $REPO_URL"
    echo "  with your current git credentials (SSH key or PAT with access to"
    echo "  pome-sh/openapi-spec-mcp), then retry."
    echo
    echo "  This is a hard failure, not a silent no-tool session -- the"
    echo "  openapi-specs MCP server will stay unavailable until this is fixed."
  } >&2
  exit 1
}

needs_install=0

if [ ! -d "$CACHE_DIR/.git" ]; then
  mkdir -p "$(dirname "$CACHE_DIR")"
  clone_log="$(mktemp)"
  if ! git clone --quiet --depth 1 "$REPO_URL" "$CACHE_DIR" >"$clone_log" 2>&1; then
    fail "git clone of $REPO_URL failed: $(tail -n 5 "$clone_log")"
  fi
  rm -f "$clone_log"
  needs_install=1
else
  before="$(git -C "$CACHE_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  git -C "$CACHE_DIR" pull --quiet --ff-only >/dev/null 2>&1 || true
  after="$(git -C "$CACHE_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  [ "$before" != "$after" ] && needs_install=1
fi

cli="$CACHE_DIR/server/dist/cli.mjs"
specs="$CACHE_DIR/specs"

if [ ! -f "$cli" ]; then
  fail "expected $cli to exist after clone/refresh, but it's missing -- the upstream repo layout may have changed."
fi

if [ "$needs_install" -eq 1 ] || [ ! -d "$CACHE_DIR/node_modules" ]; then
  install_log="$(mktemp)"
  if ! (cd "$CACHE_DIR" && npm install --no-audit --no-fund --quiet) >"$install_log" 2>&1; then
    fail "npm install in $CACHE_DIR failed: $(tail -n 5 "$install_log")"
  fi
  rm -f "$install_log"
fi

exec node "$cli" --dir "$specs"
