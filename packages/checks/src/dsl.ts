// SPDX-License-Identifier: Apache-2.0
//
// The check DSL — `defineCheck`, `parseCheck`, `renderCheck`, `checkPattern`,
// `checksDigest`, `templateSlots`, the state-pointer grammar and the vacuity
// sentinels. Re-exported verbatim from `@pome-sh/sdk/checks`, which is already a
// curated module (the sdk keeps the internal split behind that one subpath on
// purpose, so consumers ask the vocabulary module about the vocabulary).
//
// `export *` rather than an enumerated list, deliberately: an enumerated list is
// a second registration seam that drifts silently. A symbol added to
// `@pome-sh/sdk/checks` appears here automatically, and
// `test/dsl-surface.test.ts` pins the symbols pome-cloud actually imports so a
// REMOVAL is still a named failure rather than a `TypeError` in the consumer.
//
// This is the same surface `@pome-sh/sdk/checks` exposes in-repo. It is bundled,
// not depended on — see tsup.config.ts.
export * from "@pome-sh/sdk/checks";
