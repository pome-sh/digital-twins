#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# The ONE hardened path for a cosign interaction in
# `.github/workflows/**`. Signs and SPDX-attests every tag in `IMAGE_TAGS`,
# verifies each back out of the registry, and refuses to report success on
# anything it could not verify.
#
# WHY THE RETRY EXISTS. A degraded GHCR can push both tags, sign them, attest
# them, and then fail `verify-attestation`'s registry READ with `DENIED:
# denied`. That is a red job over an artifact that is correct and already
# public, which is the property that makes this script's failure mode different
# from the push
# script's and drives every choice below.
#
# Properties, all four load-bearing:
#
#   1. EVERY GHCR INTERACTION IS RETRIED, READS INCLUDED. `sign` and `attest`
#      write to the registry; `verify` and `verify-attestation` read from it;
#      the `imagetools inspect` that resolves a tag to its digest reads too, and
#      is the FIRST call here, so leaving it bare would fail the leg before the
#      ladder below it was ever reached. A `DENIED`, 403 or 5xx from any of them
#      is a fact about the registry, not a verdict about the artifact. Shape
#      (d) of assert-hardened-cdn-fetches.mjs is why reads are in scope here
#      when shape (c) exempts them: a failed read during the PUSH publishes
#      nothing, while a failed read here happens after publication.
#
#   2. THE RETRY IS PER OPERATION, NOT AROUND THE PER-TAG BODY. Wrapping the
#      whole body would re-run `sign` and `attest` because `verify` could not
#      READ — wasted work, and a second signature layer over a digest that
#      already had a good one. It would also destroy the one thing the failure
#      message has to say: which operation ran out, and therefore what state the
#      published tag is in.
#
#      Retrying `sign`/`attest` is safe. cosign stores each under the digest's
#      own `sha256-<digest>.sig` / `.att` tag and APPENDS, and verification
#      passes when any attached signature matches — so an attempt that uploaded
#      and then lost the connection costs a duplicate layer, never a wrong
#      verdict.
#
#   3. SAME BUDGET AS THE PUSH. Five attempts, sleeping 5s/10s/15s/20s, the
#      same numbers as push-scanned-image.sh and fetch-pinned-release.sh, so
#      the publish path has one budget to reason about rather than three. An
#      explicit loop with a literal `sleep`: a retry budget that looks handled
#      and is not is worse than none.
#
#   4. FAIL CLOSED, NAMING WHAT IS ALREADY PUBLIC. An image that cannot be
#      signed, attested or verified must stop the job — pome-cloud's deploy gate
#      hard-gates the signature, so shipping past this would ship something that
#      cannot deploy. But by the time ANY of this runs, push-scanned-image.sh has
#      already published and read back every tag in `IMAGE_TAGS`. So exhaustion
#      prints an `::error::` naming the operation that ran out, the ref, the
#      registry, the attempts spent, the exact state that ref is now in
#      (published-and-unsigned is a different re-run decision from
#      published-signed-attested-but-unverified), and which refs ARE fully
#      verified. Without that, a degraded registry reads as a broken twin.
#
# Env knobs exist ONLY for scripts/ci/assert-hardened-cdn-fetches.test.mjs,
# which drives this script against a fake `cosign` that reproduces the GHCR
# answer above on demand, per subcommand; nothing in `.github/workflows/**` sets
# them, and the defaults are the production values asserted by that test.
#
# Usage: IMAGE_TAGS=$'tag\ntag' sign-image-digests.sh <summary-title> <sbom-file>
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

# State for the fail-closed message below. Plain strings rather than arrays:
# bash 3.2 (a developer's macOS) errors on an empty array under `set -u`.
verified_refs=""
verified_count=0
registry=""
digest=""
# What is TRUE of the ref in flight, in words, updated as it passes each stage.
# This is the difference between "re-run it" and "read the code", and the whole
# reason the retry is per operation.
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

# One GHCR interaction, retried with backoff. `$@` is the command; `$1` is how
# the run log names it. Invoked as `registry_attempt ... || fail_out ...`, which
# is also what keeps `set -e` from killing the job on the first attempt.
registry_attempt() {
  local what="$1"
  shift
  local attempt=1 delay
  while [ "$attempt" -le "$attempts" ]; do
    if "$@"; then
      if [ "$attempt" -gt 1 ]; then
        # A flaky-but-passing run has to say so, or the degradation is invisible
        # until the day it is total.
        echo "::warning::twin image sign: ${what} landed only on attempt ${attempt}/${attempts} — ${registry} is degraded right now" >&2
      fi
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      delay=$((attempt * sleep_unit))
      # Deliberately does NOT name a specific registry error. One observed was
      # `DENIED: denied` off the token endpoint; the same run answered
      # `error parsing HTTP 403 response body` two legs over. They are one fault
      # from here, and cosign's own output is directly above.
      echo "::warning::twin image sign: attempt ${attempt}/${attempts} of ${what} failed — the registry's own answer is in the output above; retrying in ${delay}s" >&2
      sleep "${delay}"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

# Sets the global `digest`. A separate function rather than an inline
# assignment, because `registry_attempt` needs a command it can re-run and a
# command substitution cannot carry a value out of one.
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
  # The same trim scripts/ci/push-scanned-image.sh does, and for a sharper
  # reason here: an untrimmed `\r` off a CRLF value is not a tag any registry
  # knows, so every ladder below would spend its full backoff on a fault that is
  # ours before failing closed with a message blaming GHCR.
  tag="${tag#"${tag%%[![:space:]]*}"}"
  tag="${tag%"${tag##*[![:space:]]}"}"
  [ -n "$tag" ] || continue

  # `ghcr.io/pome-sh/twins:stripe-bbf27bf` -> `ghcr.io`. Used in every message so
  # the run log names the registry, not just the exit code.
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

  # Build-time self-check that the pushed digest is signed + carries the SPDX
  # attestation, under the same keyless identity. No --use-signed-timestamps:
  # the pome-cloud control-plane deploy gate owns timestamp/expiry handling and
  # hard-gates only the signature (SPDX attestation best-effort, ADR-016
  # decision #4); requiring a timestamp here just breaks the build (cosign
  # emits none for attestations).
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
