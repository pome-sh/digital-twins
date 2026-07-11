#!/usr/bin/env bash
# Regression fixtures for scripts/lint-no-cloud-imports.sh (F-696).
# Proves forbidden import forms fail and clean trees pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINT="${ROOT}/scripts/lint-no-cloud-imports.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "❌ $1" >&2
  exit 1
}

# Clean tree must pass.
bash "$LINT" >/dev/null || fail "clean tree unexpectedly failed"

# Fixture: each forbidden form must fail the lint when dropped into a scan dir.
FIXTURE_DIR="${TMP}/packages/fixture-cloud-import"
mkdir -p "$FIXTURE_DIR"

assert_forbidden() {
  local label="$1"
  local source="$2"
  local file="${FIXTURE_DIR}/bad.ts"
  printf '%s\n' "$source" >"$file"

  # Run lint with ROOT overridden by copying the script's expected layout:
  # invoke from a fake repo root that includes only the fixture + the script.
  local fake_root="${TMP}/fake-repo-${label}"
  mkdir -p "${fake_root}/packages" "${fake_root}/scripts"
  cp "$LINT" "${fake_root}/scripts/lint-no-cloud-imports.sh"
  cp "$file" "${fake_root}/packages/bad.ts"

  if bash "${fake_root}/scripts/lint-no-cloud-imports.sh" >/dev/null 2>&1; then
    fail "expected failure for ${label}"
  fi
  echo "✅ forbidden form rejected: ${label}"
  rm -rf "$fake_root"
}

assert_forbidden "named-from-at-scope" "import { x } from '@pome-cloud/auth';"
assert_forbidden "named-from-bare" "import { x } from 'pome-cloud/apps/control-plane';"
assert_forbidden "side-effect-import" "import 'pome-cloud/secret';"
assert_forbidden "dynamic-import" "const m = await import('@pome-cloud/billing');"
assert_forbidden "require" "const m = require('pome-cloud/foo');"

# Comments / strings must still pass.
COMMENT_ROOT="${TMP}/fake-repo-comments"
mkdir -p "${COMMENT_ROOT}/packages" "${COMMENT_ROOT}/scripts"
cp "$LINT" "${COMMENT_ROOT}/scripts/lint-no-cloud-imports.sh"
cat >"${COMMENT_ROOT}/packages/ok.ts" <<'EOF'
// See pome-cloud for hosted evaluation.
const url = "https://github.com/pome-sh/pome-cloud";
export const note = 'do not import pome-cloud';
EOF
bash "${COMMENT_ROOT}/scripts/lint-no-cloud-imports.sh" >/dev/null \
  || fail "comments/strings unexpectedly failed"

echo "✅ lint-no-cloud-imports fixtures passed"
