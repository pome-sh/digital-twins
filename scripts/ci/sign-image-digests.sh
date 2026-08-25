#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# The one hardened path for cosign. Retries per OPERATION, not around the per-tag
# body, so a verify that could not READ does not re-sign a good digest. Reads are
# retried too: by the time this runs, every tag is already published.
set -euo pipefail

summary_title="${1:?usage: sign-image-digests.sh <summary-title> <sbom-file>}"
sbom_file="${2:?usage: sign-image-digests.sh <summary-title> <sbom-file>}"

attempts="${SIGN_IMAGE_DIGESTS_ATTEMPTS:-5}"
sleep_unit="${SIGN_IMAGE_DIGESTS_SLEEP_UNIT:-5}"

if [ ! -f "$sbom_file" ]; then
  echo "SBOM predicate not found: $sbom_file" >&2
  exit 1
fi

if [ -z "${IMAGE_TAGS:-}" ]; then
  echo "IMAGE_TAGS is required" >&2
  exit 1
fi

issuer="https://token.actions.githubusercontent.com"
identity_regexp="^https://github.com/${GITHUB_REPOSITORY:?}/\\.github/workflows/.*@refs/(heads|tags)/.*$"
signed_refs="$(mktemp)"
trap 'rm -f "$signed_refs"' EXIT

verified_refs=""
verified_count=0
registry=""
digest=""
progress="published by the push step and NOT signed"

fail_out() {
  local ref="$1" operation="$2" landed
  if [ "${verified_count}" -eq 0 ]; then
    landed="No ref in this leg completed verification."
  else
    landed="Signed, attested and verified: $(printf '%s' "${verified_refs}" | tr '\n' ' ' | sed 's/ *$//')."
  fi
  echo "::error::twin image sign: ${operation} did not succeed for ${ref} after ${attempts} attempts against ${registry}. The registry is degraded; this is not a failure of the twin, the build or the signature. Failing closed on purpose — pome-cloud's deploy gate hard-gates the image signature, so an unverified image must not read as published-and-good. Note the tags are ALREADY PUBLISHED: scripts/ci/push-scanned-image.sh pushed and read back every tag in IMAGE_TAGS before this step ran. ${ref} is ${progress}. ${landed} Re-running this job re-signs and re-verifies; it needs no rebuild." >&2
  exit 1
}

registry_attempt() {
  local what="$1"
  shift
  local attempt=1 delay
  while [ "$attempt" -le "$attempts" ]; do
    if "$@"; then
      if [ "$attempt" -gt 1 ]; then
        echo "::warning::twin image sign: ${what} landed only on attempt ${attempt}/${attempts} — ${registry} is degraded right now" >&2
      fi
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      delay=$((attempt * sleep_unit))
      echo "::warning::twin image sign: attempt ${attempt}/${attempts} of ${what} failed — the registry's own answer is in the output above; retrying in ${delay}s" >&2
      sleep "${delay}"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

resolve_digest() {
  local out
  if ! out="$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}')"; then
    digest=""
    return 1
  fi
  digest="$out"
  [ -n "$digest" ]
}

{
  echo "### $summary_title"
  echo
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

while IFS= read -r tag || [ -n "$tag" ]; do
  tag="${tag#"${tag%%[![:space:]]*}"}"
  tag="${tag%"${tag##*[![:space:]]}"}"
  [ -n "$tag" ] || continue

  registry="${tag%%/*}"
  progress="published by the push step and NOT signed"

  registry_attempt "the digest read of ${tag}" resolve_digest "$tag" ||
    fail_out "$tag" "the manifest read that resolves the digest"
  ref="${tag}@${digest}"

  echo "signing $ref"
  registry_attempt "cosign sign of ${ref}" \
    cosign sign --yes "$ref" ||
    fail_out "$ref" "cosign sign"
  progress="published and signed, but carries NO SPDX attestation"

  registry_attempt "cosign attest of ${ref}" \
    cosign attest --yes --predicate "$sbom_file" --type spdx "$ref" ||
    fail_out "$ref" "cosign attest"
  progress="published, signed and attested, but was NOT verified by this build"

  echo "verifying $ref"
  registry_attempt "cosign verify of ${ref}" \
    cosign verify \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$issuer" \
    "$ref" >/dev/null ||
    fail_out "$ref" "cosign verify"
  registry_attempt "cosign verify-attestation of ${ref}" \
    cosign verify-attestation \
    --type spdx \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$issuer" \
    "$ref" >/dev/null ||
    fail_out "$ref" "cosign verify-attestation"

  echo "- \`$ref\`" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "$ref" >> "$signed_refs"
  verified_refs="${verified_refs}${ref}
"
  verified_count=$((verified_count + 1))
done <<< "$IMAGE_TAGS"

if [ ! -s "$signed_refs" ]; then
  echo "No image refs were signed" >&2
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "signed_digests<<EOF"
    cat "$signed_refs"
    echo "EOF"
  } >> "$GITHUB_OUTPUT"
fi
