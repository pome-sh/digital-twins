#!/usr/bin/env bash
# Fails (exit 1) if a PR touches `cli/src/**` or `cli/vendor/**` without either:
#   (a) a new changeset file under `cli/.changeset/*.md` (excluding README), OR
#   (b) a bump to `cli/package.json` version vs the base branch.
#
# Purpose: prevent the failure mode behind PR #93, where behavior changes
# shipped without a version bump so downstream users couldn't tell via
# `pome --version` whether their install picked up the new code. See FDRS-396.
#
# The gate also fires on a "twin swap" — a change that ships to users while
# touching no file under `cli/src/**`. That used to mean `cli/vendor/**`
# (vendored tarballs, FDRS-593), but that directory no longer exists, so the
# coverage had gone quietly false. The mechanism today is `cli/package.json`'s
# `@pome-sh/*` pins: they are `bundleDependencies`, baked into the tarball at
# publish time rather than resolved at install, so moving one changes what
# users install as surely as editing src does. F-1135 restores that half —
# without it a re-pin can land, read as fixed, and never publish. That silence
# is what made F-1132 last six hours.
#
# Usage:
#   BASE_REF=origin/main scripts/check-cli-version-bump.sh
#
# In GitHub Actions, BASE_REF should be the PR's base SHA so the diff window
# matches the PR exactly.

set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "❌ BASE_REF '$BASE_REF' is not resolvable. Fetch it first." >&2
  exit 2
fi

# Was anything in cli/src/ or cli/vendor/ touched? Include deletions (D): dropping
# a vendored tarball (a bundleDependencies entry) is a shipping behavior change too.
# Capture to a variable first so that under `set -o pipefail` a grep-closed-pipe
# SIGPIPE on `git diff` can't be misread as "no changes" and silently skip the gate.
changed_files="$(git diff --name-only --diff-filter=ACMRTD "$BASE_REF"...HEAD)"
src_touched=0
if grep -qE '^cli/(src|vendor)/' <<<"$changed_files"; then
  src_touched=1
fi

# F-1135 — did a bundled `@pome-sh/*` pin move? Compared value-by-value rather
# than by file, because `cli/package.json` also changes for reasons that are not
# shipping changes (the Version PR's own `version` bump, script edits).
pins_moved=""
if grep -qE '^cli/package\.json$' <<<"$changed_files"; then
  pins_moved="$(BASE_REF="$BASE_REF" node -e '
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const head = JSON.parse(fs.readFileSync("cli/package.json", "utf8"));
let base;
try {
  base = JSON.parse(
    execFileSync("git", ["show", process.env.BASE_REF + ":cli/package.json"], { encoding: "utf8" }),
  );
} catch {
  process.exit(0); // no manifest on the base side — nothing to compare.
}
const pins = (m) =>
  Object.fromEntries(
    Object.entries({ ...(m.dependencies || {}), ...(m.devDependencies || {}) }).filter(([n]) =>
      n.startsWith("@pome-sh/"),
    ),
  );
const [a, b] = [pins(base), pins(head)];
const moved = [];
for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (a[n] !== b[n]) moved.push("  " + n + ": " + (a[n] ?? "(absent)") + " → " + (b[n] ?? "(absent)"));
}
if (moved.length) console.log(moved.join("\n"));
')"
fi

if [[ "$src_touched" -eq 0 && -z "$pins_moved" ]]; then
  echo "✅ No changes under cli/src/, and no bundled @pome-sh/* pin moved; CLI version-bump gate skipped."
  exit 0
fi

# First publish: while the package has never been published (E404), every
# change ships in the first publish by definition — there is no released
# behavior to drift from, and a changeset would wrongly bump the first
# version past its intended base. Same E404-only pattern as
# check-cli-version-floor.sh; any other registry failure falls through to
# the normal gate (fail closed). See F-727.
pkg_name="$(node -p "require('./cli/package.json').name")"
view_stderr_file="$(mktemp)"
trap 'rm -f "$view_stderr_file"' EXIT
set +e
npm view "$pkg_name" version >/dev/null 2>"$view_stderr_file"
view_status=$?
set -e
if [[ $view_status -ne 0 ]] && grep -q "E404" "$view_stderr_file"; then
  echo "✅ $pkg_name is not on npm yet (E404) — every change ships in the first publish; version-bump gate skipped."
  exit 0
fi

# (a) Was a new changeset file added under cli/.changeset/?
# Excludes README.md. Only counts ADDED files (not edits to existing ones).
new_changeset=0
if git diff --name-only --diff-filter=A "$BASE_REF"...HEAD \
   | grep -E '^cli/\.changeset/.+\.md$' \
   | grep -vE '^cli/\.changeset/README\.md$' \
   | grep -q .; then
  new_changeset=1
fi

# (b) Was cli/package.json version bumped vs BASE_REF?
version_bumped=0
head_version="$(node -p "require('./cli/package.json').version" 2>/dev/null || echo "")"
base_version="$(git show "$BASE_REF:cli/package.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo "")"

if [[ -n "$head_version" && -n "$base_version" && "$head_version" != "$base_version" ]]; then
  version_bumped=1
fi

if [[ "$new_changeset" -eq 1 || "$version_bumped" -eq 1 ]]; then
  if [[ "$new_changeset" -eq 1 ]]; then
    echo "✅ Changeset entry found under cli/.changeset/."
  fi
  if [[ "$version_bumped" -eq 1 ]]; then
    echo "✅ cli/package.json version bumped: $base_version → $head_version"
  fi
  exit 0
fi

if [[ "$src_touched" -eq 1 ]]; then
  trigger="touches cli/src/**"
else
  trigger="moves a bundled @pome-sh/* pin"
fi

moved_note=""
if [[ -n "$pins_moved" ]]; then
  moved_note="
Bundled @pome-sh/* pin(s) moved in this PR:
$pins_moved

These are bundleDependencies — frozen into the published tarball at publish
time, not resolved at install — so the re-pin only reaches users if the CLI
version moves with it. F-1132: a pin sat correct in the repo while every
\`pome checks add\` kept failing against the version users actually had.
"
fi

cat >&2 <<EOF
❌ CLI version-bump gate failed.

This PR $trigger but neither:
  (a) added a changeset file under cli/.changeset/, NOR
  (b) bumped cli/package.json version (still $head_version on both sides).
$moved_note
Pick one before merging:

  # (preferred) record a changeset:
  cd cli && npm run changeset
  # ...write a one-line summary, pick patch/minor/major, commit the new file.

  # OR bump the version directly in cli/package.json:
  cd cli && npm version patch --no-git-tag-version

Why: PR #93 shipped 5 behavior changes without a bump and a downstream user
lost ~1h debugging whether their install picked up the fixes (pome --version
still reported the old version). Per FDRS-396, every behavior change to the
CLI must be reflected in the published version.
EOF
exit 1
