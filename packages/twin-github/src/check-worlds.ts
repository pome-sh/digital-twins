// SPDX-License-Identifier: Apache-2.0
//
// The fixture worlds GitHub's declarations name (F-1126).
//
// Fixtures only — no assertions live here. They sit in `src/` rather than
// `test/` because `discriminatingWorlds` is a DECLARED field: pome-cloud and the
// CLI both read the declaration from npm, and a builder that shipped only in the
// test tree would make the field unusable outside this repo.
//
// `repoState` always names `acme/api` because every FIXTURES entry in
// `checks-contract.test.ts` does. A world whose repo does not match the args
// resolves to "repo not found", which is exactly the degenerate failure arm 3
// rejects — so the coupling is load-bearing, not cosmetic.

import type { CheckSubstrate, CheckTapeEvent } from "@pome-sh/sdk/checks";
import type { GitHubCheckState, GitHubCheckStateRepo } from "./check-state.js";

/** A `final`-only world. `seed`/`tape` are null because the engine gives a
 *  `final` check neither, and a fixture richer than the runtime is a fixture
 *  that tests a world the check will never see. */
export function finalWorld(final: GitHubCheckState): CheckSubstrate<GitHubCheckState> {
  return { seed: null, final, tape: null };
}

export function deltaWorld(
  seed: GitHubCheckState,
  final: GitHubCheckState,
): CheckSubstrate<GitHubCheckState> {
  return { seed, final, tape: null };
}

/** A `tape` world. `final` is an empty repo list rather than `{}`: a tape check
 *  must not read state, and handing it a shape that would satisfy a state check
 *  hides the difference. */
export function tapeWorld(tape: readonly CheckTapeEvent[]): CheckSubstrate<GitHubCheckState> {
  return { seed: null, final: { repositories: [] }, tape };
}

/** One repository, `acme/api`, with whatever the check under test reads. */
export function repoState(repo: Partial<GitHubCheckStateRepo> = {}): GitHubCheckState {
  return { repositories: [{ owner: "acme", name: "api", full_name: "acme/api", ...repo }] };
}
