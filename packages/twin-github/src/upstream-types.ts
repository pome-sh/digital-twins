// SPDX-License-Identifier: Apache-2.0
//
// Spec contract for shape fidelity.
//
// This shim anchors the twin's response serializers to GitHub's
// official OpenAPI types (`@octokit/openapi-types`). The serializers are
// expected to emit a FAITHFUL SUBSET of the upstream schema: omitting fields
// stays legal (DeepPartial makes every field optional), but emitting a
// wrong-named or mistyped field becomes a COMPILE error. This is the
// type-level guard rail — runtime behavior is unchanged.
import type { components } from "@octokit/openapi-types";

export type PullRequestStack = components["schemas"]["pull-request-stack"];
export type PullRequest = components["schemas"]["pull-request"];
export type Repository = components["schemas"]["repository"];
export type SimpleUser = components["schemas"]["simple-user"];

// Group A (issues + meta) and Group B (PR sub-resources) anchors.
export type Issue = components["schemas"]["issue"];
export type IssueComment = components["schemas"]["issue-comment"];
export type Label = components["schemas"]["label"];
export type Milestone = components["schemas"]["milestone"];
export type PullRequestReview = components["schemas"]["pull-request-review"];
export type DiffEntry = components["schemas"]["diff-entry"];
export type ReviewComment = components["schemas"]["review-comment"];
export type CommitComparison = components["schemas"]["commit-comparison"];

// Group C (commits + content + tags) anchors.
export type Commit = components["schemas"]["commit"];
export type ShortBranch = components["schemas"]["short-branch"];
export type ContentFile = components["schemas"]["content-file"];
export type ContentDirectoryEntry = components["schemas"]["content-directory"];
export type Tag = components["schemas"]["tag"];

// commitWithFilesJson emits the same upstream `commit` schema (it spreads
// commitJson and adds the stats/files fields, which are themselves part of the
// commit schema), so it anchors against the same alias.
export type CommitWithFiles = Commit;

// Group D (statuses + checks + releases + viewer) anchors.
export type Status = components["schemas"]["status"];
export type CombinedStatus = components["schemas"]["combined-commit-status"];
export type CheckRun = components["schemas"]["check-run"];
export type Release = components["schemas"]["release"];
export type AuthenticatedUser = components["schemas"]["private-user"];

export type PullRequestSimple = components["schemas"]["pull-request-simple"];

// Recursive deep-partial: every object property becomes optional and is itself
// deep-partial'd; arrays become Array<DeepPartial<element>>; primitives (and
// function types) pass through unchanged. This is what encodes "faithful
// subset": a serializer may OMIT any field, but a field it DOES emit must
// match the upstream name and (deep-partial) type.
export type DeepPartial<T> = T extends (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// Upstream-added-field guard.
// Uncovered = upstream keys the serializer neither emits nor registers as a
// deliberate omission. When that set is empty the assertion is `true`; when it
// is non-empty the type becomes an error-carrying object whose member type
// NAMES the offending field(s), so a post-@octokit-bump addition fails tsc by name.
export type AssertNoUncovered<Upstream, Emitted, Allow extends PropertyKey> =
  Exclude<keyof Upstream, keyof Emitted | Allow> extends never
    ? true
    : { __UNCOVERED_UPSTREAM_FIELDS__: Exclude<keyof Upstream, keyof Emitted | Allow> };
