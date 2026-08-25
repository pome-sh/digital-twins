#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Does this package need publishing? Local version vs what the registry serves.
#
# Behind the registry's latest is a hard fail, not a skip: publishing from it
# retags `latest` backwards. A non-404 read error is a hard fail for the same
# reason — a 401 read as "unpublished" bypasses that floor.

set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 <package-name> <manifest-path> <output-key> [registry]" >&2
  exit 2
fi

name="$1"
manifest="$2"
output="$3"
registry="${4:-}"

view=(npm view "${name}" version)
if [ -n "${registry}" ]; then
  view+=(--registry "${registry}")
fi

local_version="$(node -p "require('./${manifest}').version")"

npm_view_err="$(mktemp)"
if registry_version="$("${view[@]}" 2>"${npm_view_err}")"; then
  :
elif grep -q "E404" "${npm_view_err}"; then
  registry_version="0.0.0"
else
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
