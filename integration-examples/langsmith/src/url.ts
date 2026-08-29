// SPDX-License-Identifier: Apache-2.0
//
// One URL helper, and it is a loop rather than the obvious regex on purpose.
//
// `.replace(/\/+$/, "")` is what this used to be, and CodeQL's
// `js/polynomial-redos` rule calls that HIGH severity here: the base URL comes
// from a caller-supplied environment variable, and an anchored `+` over a run of
// trailing slashes backtracks quadratically. The same ruling already lives in
// `cli/src/contract/manifest.ts`, whose `deriveAgentSlug` avoids `/^-+|-+$/g` for
// exactly this reason. Do not put the regex back.

const SLASH = "/".charCodeAt(0);

/** Strip every trailing `/`, in one linear pass. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === SLASH) end -= 1;
  return url.slice(0, end);
}
