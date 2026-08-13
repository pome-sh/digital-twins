// SPDX-License-Identifier: Apache-2.0
//
// GitHub — the domain runtime pome-cloud boots in-process.
//
// Re-exports only (`export … from` lines), so there is nothing here that can
// drift from the twin. A pome-cloud import site moves by changing the
// specifier and nothing else.
//
// The domain and the database opener arrive through the twin's package ROOT
// rather than a narrow subpath, because that is the only place they are
// exported — `@pome-sh/twin-github`'s `exports` map offers `.`, `./server`,
// `./checks` and `./seed`, and `GitHubDomain`/`openGitHubCloneDatabase` live
// behind `.`. This is the deliberate inverse of `@pome-sh/checks/github`, which
// reaches the SAME twin through `./checks` + `./seed` precisely to keep the
// engine out of a declarations package.
export { GitHubDomain } from "@pome-sh/twin-github";
export { openGitHubCloneDatabase, resetDatabase } from "@pome-sh/twin-github";
export type {
  FileChange,
  MutatingOptions,
  PageOptions,
  StateDeltaCallback,
} from "@pome-sh/twin-github";
export type { GitHubCloneDatabase, GitHubStateSeed, RecorderEvent } from "@pome-sh/twin-github";

export { defaultSeedState, parseSeed, seedSchema } from "@pome-sh/twin-github/seed";
export type { ParsedGitHubStateSeed } from "@pome-sh/twin-github/seed";

// The declared vocabulary, carried here as well as in `@pome-sh/checks/github`
// on purpose: a consumer that binds a criterion against this runtime should not
// have to install the vocabulary package to read the tuple it binds to. The two
// are cut from the same `main` commit by the same allocator run, which is what
// makes "identical binding surface" a property rather than a hope
// (`checks-package-drift.test.ts` is the assertion).
export { GITHUB_CHECKS } from "@pome-sh/twin-github/checks";
export type { Check } from "@pome-sh/twin-github/checks";
export type {
  GitHubCheckState,
  GitHubCheckStateComment,
  GitHubCheckStateCommitStatus,
  GitHubCheckStateFile,
  GitHubCheckStateIssue,
  GitHubCheckStateLabel,
  GitHubCheckStatePullRequest,
  GitHubCheckStateRepo,
  GitHubCheckStateReview,
} from "@pome-sh/twin-github/checks";
