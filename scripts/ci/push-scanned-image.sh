#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# The one hardened path for a container-registry write. Each tag is read back with
# imagetools inspect, because `docker push` exiting 0 is not the same fact as "this
# tag resolves" — GHCR can log every layer as Pushed and then answer unknown blob.
# The per-commit tag is emitted last, so its absence is the honest signal. An empty
# IMAGE_TAGS is refused: a loop over zero tags exits 0 and reads like a publish.
set -euo pipefail

attempts="${PUSH_SCANNED_IMAGE_ATTEMPTS:-5}"
sleep_unit="${PUSH_SCANNED_IMAGE_SLEEP_UNIT:-5}"

if [ -z "${IMAGE_TAGS:-}" ]; then
  echo "::error::twin image push: IMAGE_TAGS is empty, so there is nothing to publish. This is refused rather than treated as a successful push of zero tags — docker/metadata-action producing no tags is a misconfiguration, and a green publish that published nothing is the failure this whole path exists to prevent." >&2
  exit 1
fi

landed_tags=""
landed_count=0

fail_out() {
  local tag="$1" registry="$2" reason="$3" leftover
  if [ "${landed_count}" -eq 0 ]; then
    leftover="Nothing was published, so the per-commit tag resolves to nothing and pome-cloud's resolve-image-digest.ts reports \`not found\` — the honest answer, not a partial manifest."
  else
    leftover="Already published and NOT signed, because the sign/attest step never runs after this failure: $(printf '%s' "${landed_tags}" | tr '\n' ' ' | sed 's/ *$//')."
  fi
  echo "::error::twin image push: could not publish ${tag} to ${registry} after ${attempts} attempts — ${reason}. The registry is degraded; this is not a failure of the twin, the build or the scan. Failing closed on purpose, and no later tag was pushed. ${leftover}" >&2
  exit 1
}

while IFS= read -r tag || [ -n "$tag" ]; do
  tag="${tag#"${tag%%[![:space:]]*}"}"
  tag="${tag%"${tag##*[![:space:]]}"}"
  [ -n "$tag" ] || continue

  registry="${tag%%/*}"

  landed=false
  reason="no attempt was made"
  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if docker push "$tag"; then
      digest="$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
      if [ -n "${digest}" ]; then
        landed=true
        break
      fi
      reason="the push exited 0 but ${tag} still resolves to nothing, so the registry accepted the layers and committed no manifest"
    else
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
