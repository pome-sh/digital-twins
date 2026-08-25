#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# The ONE hardened path for a container-registry WRITE in
# `.github/workflows/**`. Pushes every tag in `IMAGE_TAGS` to its registry and
# refuses to report success on anything it cannot read back.
#
# WHY THIS FILE EXISTS. A bare `docker push` per tag has no retry, and GHCR can
# log every layer as `Pushed` and then answer `unknown blob` — the registry
# failing to see a blob it just accepted — and exit 1. Nothing re-runs the step,
# so the tag simply does not exist, and a consumer resolving it reports
# no-image while production keeps booting an older snapshot. One transient
# registry error stays load-bearing until somebody looks.
#
# Usage: IMAGE_TAGS=$'tag\ntag' push-scanned-image.sh
#
# Properties, all four load-bearing:
#
#   1. RETRY WITH BACKOFF. Five attempts per tag, sleeping 5s/10s/15s/20s, the
#      same budget as fetch-pinned-release.sh so the publish path has one
#      number to reason about. An explicit loop with a literal `sleep`: a retry
#      budget that looks handled and is not is worse than none. Retrying is safe
#      because every tag names the same image already in the local daemon — the
#      layers are uploaded, so a second attempt is a manifest PUT, which is the
#      part that failed.
#
#   2. THE MANIFEST IS READ BACK, PER TAG. `docker push` exiting 0 is not the
#      same fact as "this tag resolves": the whole failure class here is a
#      registry that accepts blobs and does not commit what points at them. So
#      each attempt only counts as landed once
#      `docker buildx imagetools inspect` returns a digest — the exact call
#      pome-cloud's scripts/twin-snapshot/resolve-image-digest.ts makes, and the
#      one scripts/ci/sign-image-digests.sh makes next. A tag that pushes clean
#      and resolves to nothing is retried here rather than failing one step later
#      as a confusing cosign error.
#
#   3. NO TAG IS PUSHED AFTER A FAILED ONE. `docker/metadata-action` emits the
#      rolling `<twin>` tag first and the per-commit `<twin>-<sha>` tag LAST,
#      and that order is load-bearing: the per-commit tag is what a consumer
#      resolves, so its existence is a promise that everything before it
#      landed. Exhausting a tag's attempts exits immediately, leaving the
#      per-commit tag absent so a resolver reports `not found` — the honest
#      answer — rather than a manifest whose siblings are missing and which the
#      sign step never signed. Whatever DID land is named in the error, because
#      those tags are published and unsigned.
#
#   4. FAIL CLOSED, BY NAME. A registry that will not accept the manifest must
#      stop the job — an image that cannot be published cannot be signed,
#      attested or deployed. But not as
#      `##[error]The process '/usr/bin/bash' failed with exit code 1`, which says
#      nothing about whether to re-run or to read the code. Exhaustion prints an
#      `::error::` naming the tag, the registry, the attempts spent and what is
#      left behind. An empty `IMAGE_TAGS` is the same kind of refusal: a loop
#      over zero tags exits 0 and reads exactly like a publish.
#
# Env knobs exist ONLY for scripts/ci/assert-hardened-cdn-fetches.test.mjs,
# which drives this script against a fake `docker` that reproduces the GHCR
# answer above; nothing in `.github/workflows/**` sets them, and the defaults are
# the production values asserted by that test.
set -euo pipefail

attempts="${PUSH_SCANNED_IMAGE_ATTEMPTS:-5}"
sleep_unit="${PUSH_SCANNED_IMAGE_SLEEP_UNIT:-5}"

if [ -z "${IMAGE_TAGS:-}" ]; then
  echo "::error::twin image push: IMAGE_TAGS is empty, so there is nothing to publish. This is refused rather than treated as a successful push of zero tags — docker/metadata-action producing no tags is a misconfiguration, and a green publish that published nothing is the failure this whole path exists to prevent." >&2
  exit 1
fi

# Tags that reached the registry AND read back, newline-separated. Named in the
# error below so a failure says what is now published and unsigned. A plain
# string rather than an array: bash 3.2 (a developer's macOS) errors on an empty
# array under `set -u`.
landed_tags=""
landed_count=0

fail_out() {
  local tag="$1" registry="$2" reason="$3" leftover
  if [ "${landed_count}" -eq 0 ]; then
    leftover="Nothing was published, so the per-commit tag resolves to nothing and pome-cloud's resolve-image-digest.ts reports \`not found\` — the honest answer, not a partial manifest."
  else
    leftover="Already published and NOT signed, because the sign/attest step never runs after this failure: $(printf '%s' "${landed_tags}" | tr '\n' ' ' | sed 's/ *$//')."
  fi
  echo "::error::twin image push: could not publish ${tag} to ${registry} after ${attempts} attempts — ${reason}. The registry is degraded; this is not a failure of the twin, the build or the scan Failing closed on purpose, and no later tag was pushed. ${leftover}" >&2
  exit 1
}

while IFS= read -r tag || [ -n "$tag" ]; do
  # Trim surrounding whitespace before the emptiness test, not after: an image
  # ref contains none, so a line that is only whitespace is not a tag — and
  # `[ -n "$tag" ]` alone reads one as a tag and pushes it. Same for a trailing
  # `\r` off a CRLF value. Parameter expansion rather than `tr`/`sed`, so
  # trimming costs no subprocess per tag.
  tag="${tag#"${tag%%[![:space:]]*}"}"
  tag="${tag%"${tag##*[![:space:]]}"}"
  [ -n "$tag" ] || continue

  # `ghcr.io/pome-sh/twins:stripe-bbf27bf` -> `ghcr.io`. Used in every message so
  # the run log names the registry, not just the exit code.
  registry="${tag%%/*}"

  landed=false
  reason="no attempt was made"
  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if docker push "$tag"; then
      # `|| true` here is the opposite of swallowing the failure: an unresolvable
      # tag is turned into another ATTEMPT, and exhaustion still exits 1 below.
      digest="$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
      if [ -n "${digest}" ]; then
        landed=true
        break
      fi
      reason="the push exited 0 but ${tag} still resolves to nothing, so the registry accepted the layers and committed no manifest"
    else
      # Deliberately does NOT name a specific registry error. The observed one was
      # `unknown blob` after every layer reported `Pushed`; run 32144441622's was
      # `error parsing HTTP 403 response body` on the first tag. They are one
      # fault from here, and a message that asserted either would misdirect a
      # reader on the other — docker's own output is directly above.
      reason="docker push exited non-zero; the registry's own answer is in its output above"
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      delay=$((attempt * sleep_unit))
      echo "::warning::twin image push: attempt ${attempt}/${attempts} for ${tag} failed — ${reason}; retrying in ${delay}s" >&2
      sleep "${delay}"
    fi
    attempt=$((attempt + 1))
  done

  if [ "${landed}" != "true" ]; then
    fail_out "$tag" "$registry" "$reason"
  fi

  if [ "$attempt" -gt 1 ]; then
    # A flaky-but-passing run has to say so, or the degradation is invisible
    # until the day it is total — which is how a partial outage goes unnoticed for
    # days.
    echo "::warning::twin image push: ${tag} landed only on attempt ${attempt}/${attempts} — ${registry} is degraded right now" >&2
  fi

  echo "pushed ${tag} -> ${digest}"
  landed_tags="${landed_tags}${tag}
"
  landed_count=$((landed_count + 1))
done <<< "${IMAGE_TAGS}"

if [ "${landed_count}" -eq 0 ]; then
  echo "::error::twin image push: IMAGE_TAGS held no non-empty tag, so nothing was published. Refused rather than reported as a successful publish of zero tags." >&2
  exit 1
fi

echo "published and verified ${landed_count} tag(s) to ${registry}"
