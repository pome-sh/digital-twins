#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# F-1489 — the ONE hardened path every release-CDN fetch in
# `.github/workflows/**` goes through. Before this file there were two
# hand-copied variants of the same loop, each with its own retry budget, its
# own message and its own chance of getting the verification wrong; the same
# degradation that produced them also killed a twin-image syft install, which
# had no retry at all.
#
# Usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>
#
# Properties, all three load-bearing:
#
#   1. RETRY WITH BACKOFF. Five attempts, sleeping 5s/10s/15s/20s between them.
#      An explicit loop rather than curl's `--retry` flags, because those were
#      measured doing two different things: locally `--retry-delay 0` backed
#      off 1s/2s/4s as documented, while on the runner the same flags burned
#      five attempts in 0.8s against a `curl: (56) Connection died`
#      (run 31620014945). A retry budget that looks handled and is not is worse
#      than none, and a loop with a literal `sleep` cannot be version-dependent.
#      (F-1471 got this wrong twice before landing it.)
#
#   2. UNCONDITIONAL VERIFICATION. The sha256 comparison is not `|| true`, not
#      `if [ -n "$sha" ]`, and not skippable by a cache hit — a hash checked
#      conditionally is decoration. Fetching a pinned, checksummed binary
#      instead of trusting a third-party Action is the whole reason these steps
#      exist, so the check is the last thing this script does and its failure is
#      the script's failure. Comparison is spelled out rather than piped into
#      `sha256sum -c -` so the mismatch message can name both hashes, and so it
#      works on a developer's macOS (`shasum -a 256`) as well as the runner.
#
#   3. FAIL CLOSED, BY NAME. A genuinely unavailable CDN must stop the job —
#      on the publish path in twin-image.yml that means an unsigned, unattested
#      image never ships. But it must not stop it as
#      `##[error]The process '/usr/bin/sh' failed with exit code 1`, which says
#      nothing about whether to retry or to read the code. Exhaustion prints an
#      `::error::` naming the tool, the host that would not answer, and the URL.
#
# Env knobs exist ONLY for scripts/ci/assert-hardened-cdn-fetches.test.mjs,
# which drives this script against a local server that 503s on demand; nothing
# in `.github/workflows/**` sets them, and the defaults are the production
# values asserted by that test.
set -euo pipefail

tool="${1:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"
url="${2:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"
sha256="${3:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"
dest="${4:?usage: fetch-pinned-release.sh <tool> <url> <sha256> <dest>}"

attempts="${FETCH_PINNED_RELEASE_ATTEMPTS:-5}"
sleep_unit="${FETCH_PINNED_RELEASE_SLEEP_UNIT:-5}"

# `https://github.com/rhysd/actionlint/releases/...` -> `github.com`. Used in
# every message so the run log names the CDN, not just the exit code.
host="${url#*://}"
host="${host%%/*}"

fetched=false
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  if curl -sSfL --connect-timeout 10 --max-time 120 "$url" -o "$dest"; then
    fetched=true
    if [ "$attempt" -gt 1 ]; then
      # A flaky-but-passing run has to say so, or the degradation is invisible
      # until the day it is total.
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
