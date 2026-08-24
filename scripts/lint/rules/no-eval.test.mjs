#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table, for the rule whose whole job is
// keeping evaluation out of the OSS repo. All three arms are asserted (path,
// name, import), plus the two documented narrownesses — a prose mention is not
// an import, and a `fixtures/` directory is deliberately unscanned — because a
// rule that reds on prose gets deleted and a rule that reds on its own fixtures
// gets allowlisted into uselessness.
//
// Folded in from `cli/test/unit/no-eval-in-oss.test.ts`, a vitest suite that
// asserted the same predicate from a third place.

import { defineCases } from "../harness.mjs";

const SRC = "packages/twin-x/src/thing.ts";

// Assembled rather than written out. `scripts/lint-no-cloud-imports.sh` greps
// this directory for the same specifier and cannot tell a fixture from a real
// import, and `no-eval` itself scans `scripts/` — weakening either of them to
// make room for a fixture is the wrong trade. The rule sees the real string at
// runtime, which is what the case is about.
const CLOUD_JUDGE = ["@pome", "cloud/judge"].join("-");

defineCases("no-eval", [
  {
    name: "a capture-only tree passes",
    files: { [SRC]: `export const capture = () => ({ recorded: true });\n` },
    expect: "green",
  },
  {
    name: "PATH: a deleted local-eval tree reappearing is a violation",
    files: { "cli/src/evaluator/index.ts": `export const evaluate = () => 1;\n` },
    expect: "red",
    contains: "deleted local-eval path reappeared: cli/src/evaluator",
  },
  {
    name: "NAME: a new module named for an eval role is a violation",
    files: { "packages/twin-x/src/score.ts": `export const total = 1;\n` },
    expect: "red",
    contains: 'denied eval-role stem "score*"',
  },
  {
    name: "NAME: the match is a prefix, so `scoreRun.ts` is caught too",
    files: { "packages/twin-x/src/scoreRun.ts": `export const total = 1;\n` },
    expect: "red",
    contains: "scoreRun.ts",
  },
  {
    name: "IMPORT: a @pome-cloud/* dependency is a violation",
    files: { [SRC]: `import { judge } from "${CLOUD_JUDGE}";\nexport const j = judge;\n` },
    expect: "red",
    contains: CLOUD_JUDGE,
  },
  {
    name: "IMPORT: every module-loading form is matched, including require()",
    files: { [SRC]: `const { judge } = require("${CLOUD_JUDGE}");\nmodule.exports = judge;\n` },
    expect: "red",
    contains: CLOUD_JUDGE,
  },
  {
    // A false positive on prose is how this rule gets deleted.
    name: "prose naming a forbidden specifier is not an import",
    files: {
      [SRC]: `// The old design imported "@pome-sh/correlator" here; it lives in pome-cloud now.\nexport const a = 1;\n`,
    },
    expect: "green",
  },
  {
    // Documented narrowness: fixture directories legitimately embed the strings.
    name: "a fixtures/ directory is deliberately unscanned",
    files: { "packages/twin-x/src/fixtures/score.ts": `import "${CLOUD_JUDGE}";\n` },
    expect: "green",
  },
  {
    name: "IMPORT: a reintroduced local LLM judge is a violation",
    files: { [SRC]: `import { judge } from "./probabilistic/judge.js";\nexport const j = judge;\n` },
    expect: "red",
    contains: "the deleted local LLM judge",
  },
  {
    name: "IMPORT: a reintroduced deterministic matcher is a violation",
    files: { [SRC]: `import { match } from "./deterministic/match.js";\nexport const m = match;\n` },
    expect: "red",
    contains: "the deleted deterministic matchers",
  },
  {
    name: "IMPORT: a reintroduced correlator package is a violation",
    files: { [SRC]: `import { correlate } from "@pome-sh/correlator";\nexport const c = correlate;\n` },
    expect: "red",
    contains: "no local correlation in the OSS CLI",
  },
  {
    name: "IMPORT: a bare side-effect import of a forbidden module is a violation",
    files: { [SRC]: `import "@pome-sh/correlator";\nexport const a = 1;\n` },
    expect: "red",
    contains: "@pome-sh/correlator",
  },
  {
    // `cli/src/**` is not the whole OSS surface: eval logic reintroduced beside
    // the build scripts is the same violation.
    name: "SCOPE: cli/scripts/ is walked too",
    files: { "cli/scripts/thing.mjs": `import "@pome-sh/correlator";\n` },
    expect: "red",
    contains: "cli/scripts/thing.mjs",
  },
  {
    // The NAME rule is a PREFIX match, so `judge-local.mjs` trips it and
    // `local-judge.mjs` does not — the documented narrowness, asserted from both
    // sides so nobody has to guess which way it goes.
    name: "SCOPE: repo-root scripts/ is walked too, by name and by import",
    files: {
      "scripts/judge-local.mjs": `export const x = 1;\n`,
      "scripts/sneaky.mjs": `import { callJudge } from "../cli/src/evaluator/probabilistic/client.js";\n`,
    },
    expect: "red",
    contains: ["scripts/judge-local.mjs", "scripts/sneaky.mjs"],
  },
  {
    name: "NAME: the prefix match does not reach an infix, which the import rule covers",
    files: { "packages/twin-x/src/local-judge.ts": `export const x = 1;\n` },
    expect: "green",
  },
  {
    name: "PATH: a reappeared packages/correlator directory is a violation",
    files: { "packages/correlator/package.json": JSON.stringify({ name: "@pome-sh/correlator" }) },
    expect: "red",
    contains: "packages/correlator",
  },
  {
    name: "NAME: every denied stem is enforced, not just the first",
    files: {
      "packages/twin-x/src/correlateHeuristic.ts": `export const a = 1;\n`,
      "packages/twin-x/src/judgeOutput.ts": `export const b = 1;\n`,
      "packages/twin-x/src/verdictSummary.ts": `export const c = 1;\n`,
    },
    expect: "red",
    contains: ["correlateHeuristic.ts", "judgeOutput.ts", "verdictSummary.ts"],
  },
  {
    name: "a package's test tree is deliberately unscanned",
    files: { "packages/twin-x/test/score.ts": `import "@pome-sh/correlator";\n` },
    expect: "green",
  },
]);
