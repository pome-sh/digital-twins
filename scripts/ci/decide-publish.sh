#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# "Does this package need publishing?" — the version-diff decision behind
# release.yml's publish jobs. Compares a package's local package.json version
# against what its registry currently serves and writes `<output>=true|false`
# to $GITHUB_OUTPUT.
#
# Folded in from the deleted scripts/check-cli-version-floor.sh (F-724): never
# publish from a version base BEHIND the registry's published latest — that
# retags `latest` backwards for every existing consumer. A version that differs
# but does not sort above the registry's is a hard fail, not a skip.
#
# Extracted from an inline `decide()` in release.yml by F-949, when
# @pome-sh/wire became a third publish target on a DIFFERENT registry
# (npm.pkg.github.com). Two callers now need identical semantics against
# different registries and with different auth, and the wire decision must be
# able to fail without taking the two npmjs publishes down with it — so this
# lives in one tested file instead of being copy-pasted into a second job.
# Regression suite: scripts/ci/decide-publish.test.mjs.
#
# Usage: decide-publish.sh <package-name> <manifest-path> <output-key> [registry]
#
#   registry — optional. Omitted ⇒ npm's default (registry.npmjs.org). Passed
#   explicitly for GitHub Packages. Deliberately an ARGUMENT rather than an
#   `@scope:registry=` line in .npmrc: a scope mapping would redirect EVERY
#   @pome-sh/* read, including @pome-sh/cli's and the adapter's, to a registry
#   where they do not exist — and every release would then look like a
#   brand-new package with a 0.0.0 baseline, silently disabling the floor check.

set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 <package-name> <manifest-path> <output-key> [registry]" >&2
  exit 2
fi

name="$1"
manifest="$2"
output="$3"
registry="${4:-}"

# Never empty, so "${view[@]}" cannot trip `set -u` on an empty-array expansion.
view=(npm view "${name}" version)
if [ -n "${registry}" ]; then
  view+=(--registry "${registry}")
fi

local_version="$(node -p "require('./${manifest}').version")"

npm_view_err="$(mktemp)"
if registry_version="$("${view[@]}" 2>"${npm_view_err}")"; then
  :
elif grep -q "E404" "${npm_view_err}"; then
  # Genuinely unpublished (brand-new package) — 0.0.0 is the correct baseline.
  # This is the path a first-ever publish takes. GitHub Packages answers 404
  # for a name that has never been published under the owner, exactly as npmjs
  # does, so the first release needs no special case.
  registry_version="0.0.0"
else
  # A registry/network/auth error is NOT "unpublished". Treating it as 0.0.0
  # would make any local version look publishable and bypass the floor check
  # below, which exists specifically to stop retagging `latest` backwards.
  #
  # This matters MORE for GitHub Packages: an absent or under-scoped token
  # answers 401 for a package that exists, and a 401 must never be mistaken
  # for "nothing published yet".
  echo "::error::npm view ${name} failed for a reason other than 'not found':"
  cat "${npm_view_err}" >&2
  rm -f "${npm_view_err}"
  exit 1
fi
rm -f "${npm_view_err}"

echo "${name} — local: ${local_version}, registry (${registry:-registry.npmjs.org}): ${registry_version}"

if [ "${local_version}" = "${registry_version}" ]; then
  echo "${output}=false" >> "${GITHUB_OUTPUT}"
  echo "  ↳ unchanged; nothing to publish."
  exit 0
fi

highest="$(printf '%s\n%s\n' "${local_version}" "${registry_version}" | sort -V | tail -n1)"
if [ "${highest}" != "${local_version}" ]; then
  echo "::error::${name} local version ${local_version} is BEHIND the registry's published latest ${registry_version}. Publishing would retag latest backwards."
  exit 1
fi

echo "${output}=true" >> "${GITHUB_OUTPUT}"
echo "  ↳ will publish ${local_version}."
