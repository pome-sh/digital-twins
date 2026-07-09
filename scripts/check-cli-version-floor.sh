#!/usr/bin/env bash
# Fails (exit 1) if cli/package.json version is BEHIND the published npm
# `latest` of pome-sh. npm accepts any never-published version, so a publish
# from a regressed base (e.g. 0.1.0 while latest is 0.7.0) would ship 0.2.0
# and retag `latest` backwards — users on `npx pome-sh` would silently
# downgrade. See F-724: PR #85 reset the version field to 0.1.0.
#
# local == latest is fine (no-op release; npm rejects an exact republish
# anyway). Only local < latest fails.
#
# Usage:
#   scripts/check-cli-version-floor.sh

set -euo pipefail

local_version="$(node -p "require('./cli/package.json').version")"

published_version="$(npm view pome-sh version 2>/dev/null || echo "")"
if [[ -z "$published_version" ]]; then
  echo "❌ Could not resolve published pome-sh version from the npm registry." >&2
  echo "   Refusing to pass the floor check without a baseline." >&2
  exit 2
fi

# Plain x.y.z numeric compare — pome-sh has never published prerelease tags.
# Fail closed on anything that isn't plain x.y.z (a prerelease suffix would
# turn segments into NaN and slip past a naive compare).
behind="$(node -e "
  const parse = v => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) { console.error('unparseable version: ' + v); process.exit(2); }
    return m.slice(1).map(Number);
  };
  const [l, p] = [parse('$local_version'), parse('$published_version')];
  for (let i = 0; i < 3; i++) {
    if (l[i] > p[i]) { console.log('no'); process.exit(0); }
    if (l[i] < p[i]) { console.log('yes'); process.exit(0); }
  }
  console.log('no');
")" || {
  echo "❌ Refusing to certify: version is not plain x.y.z (local $local_version, npm $published_version)." >&2
  exit 2
}

if [[ "$behind" == "yes" ]]; then
  cat >&2 <<EOF
❌ CLI version floor check failed.

  cli/package.json:  $local_version
  npm latest:        $published_version

The local version is BEHIND the published latest. Publishing from this base
would move npm's \`latest\` dist-tag backwards (npm accepts any never-published
version). Restore cli/package.json to at least $published_version first.

Why: PR #85 reset the version to 0.1.0 while npm latest was 0.7.0; a publish
would have shipped 0.2.0 and downgraded every \`npx pome-sh\` user. See F-724.
EOF
  exit 1
fi

echo "✅ CLI version floor OK: local $local_version ≥ npm latest $published_version"
