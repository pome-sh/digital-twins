#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# The one hardened path for a release-CDN fetch: retry with backoff and an
# unconditional sha256 check. An explicit loop with a literal sleep, because a retry
# budget that looks handled and is not is worse than none.
set -euo pipefail

tool="${1:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"
url="${2:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"
sha256="${3:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"
dest="${4:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"

attempts="${FETCH_PINNED_RELEASE_ATTEMPTS:-5}"
sleep_unit="${FETCH_PINNED_RELEASE_SLEEP_UNIT:-5}"

host="${url#*://}"
host="${host%%/*}"

fetched=false
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  if curl -sSfL --connect-timeout 10 --max-time 120 "$url" -o "$dest"; then
    fetched=true
    if [ "$attempt" -gt 1 ]; then
      echo "::warning::${tool}: fetched from ${host} only on attempt ${attempt}/${attempts} — that release CDN is degraded right now (${url})"
    fi
    break
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    delay=$((attempt * sleep_unit))
    echo "::warning::${tool}: fetch attempt ${attempt}/${attempts} from ${host} failed; retrying in ${delay}s (${url})" >&2
    sleep "${delay}"
  fi
  attempt=$((attempt + 1))
done

if [ "${fetched}" != "true" ]; then
  echo "::error::${tool}: could not be fetched from ${host} after ${attempts} attempts — ${url}. The release CDN (${host}) is unavailable; this is not a failure of the code under test. Failing closed on purpose: nothing unverified is installed, so nothing unsigned or unattested can ship." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${dest}" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "${dest}" | cut -d' ' -f1)"
fi

if [ "${actual}" != "${sha256}" ]; then
  echo "::error::${tool}: sha256 mismatch on the artifact fetched from ${host} — expected ${sha256}, got ${actual} (${url}). Refusing to install an unverified binary." >&2
  exit 1
fi

echo "${tool}: fetched from ${host} and verified sha256 ${sha256}"
