// SPDX-License-Identifier: Apache-2.0
// The properties every declared check must hold, carried across from twin-slack when
// Linear's vocabulary moved out of pome-cloud.

import {
  checkNearMissPattern,
  checkPattern,
  parseCheck,
  probeDiscrimination,
  probeRedactionSurvival,
  probeStateCitation,
  renderCheck,
  VACUITY_SENTINEL,
  VACUITY_SENTINEL_NUMBER,
  type CheckDefinition,
  type CheckSubstrateKind,
  type RedactionGuard,
} from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import { LINEAR_CHECKS } from "../src/checks.js";
import { resolveIssue, type LinearCheckState } from "../src/check-state.js";

// The declarations are a heterogeneous tuple, so iterating them yields a union
// whose args type differs per check, while the fixtures below are looked up by
// id at run time. That tie cannot be made statically — erase it once here
// rather than casting at a dozen call sites.
type OpenCheck = CheckDefinition<LinearCheckState, Record<string, string>>;
const CHECKS = LINEAR_CHECKS as readonly unknown[] as readonly OpenCheck[];

// Representative args per check, used to exercise render/parse/mutant/worlds.
// The coverage arm below makes this table impossible to forget: a check with no
// fixture FAILS rather than silently skipping every property here.
const FIXTURES: Record<string, Record<string, string>> = {
  "linear.issue-exists": { title: "Orders 500 after deploy", team: "ENG" },
  "linear.issue-state": { title: "Orders 500 after deploy", team: "ENG", state: "In Progress" },
  "linear.issue-has-label": { title: "Orders 500 after deploy", team: "ENG", label: "Agent" },
  "linear.issue-estimate": { title: "Orders 500 after deploy", team: "ENG", estimate: "2" },
  "linear.issue-assignee": {
    title: "Orders 500 after deploy",
    team: "ENG",
    user: "dev@pome-twin.test",
  },
  "linear.issue-comment-contains": {
    title: "Orders 500 after deploy",
    team: "ENG",
    needle: "#1",
  },
  "linear.issue-threaded-reply": { title: "Needs comment and label triage", team: "ENG" },
  "linear.no-unsupported-endpoint": {},
};

// Every check whose `vacuityMutant` returns null, WITH the reason. A null
// mutant is an admitted blind spot; admitting it in a ledger is what keeps it
// from becoming a habit.
//
// Exactly two arguments earn a line here:
//   1. THE PARAMETER ONLY SELECTS. Falsifying it moves the verdict for a reason
//      that never reaches the assertion — a clean bill the check did not earn.
//   2. THE PARAMETER IS A CLOSED SET. Typing a slot as `oneOf` means no member
//      is guaranteed false, so a mutant could assert a different state that
//      happens to be true as well.
const HONEST_NULL_MUTANTS: Record<string, string> = {
  "linear.issue-threaded-reply":
    "both slots only SELECT the issue; the trigger is a parentId relation between the seed and " +
    "the final state, which no mutation of the criterion text can reach",
  // The sharpest form of the argument, and the reason `discriminatingWorlds`
  // exists: with no slots there is no sentence to falsify, so the vacuity probe
  // is STRUCTURALLY blind to this check and its declared failing world is the
  // only evidence it can fail at all.
  "linear.no-unsupported-endpoint":
    "the sentence has no slots; the trigger is a fidelity stamp on the tape, which lives in the " +
    "recording and not in the criterion text",
};

// twin-github ledgers REPO_FREE_CHECKS; this is Linear's analogue, and unlike
// twin-slack Linear does NOT argue the rule away — `seed.ts:319-325` validates
// issue-title uniqueness per team, so the ambiguity a scope slot closes is real
// here. Only a check that reads no state at all may be ledgered, and the second
// assertion below enforces that by requiring `substrate: "tape"`.
const TEAM_FREE_CHECKS: Record<string, string> = {
  "linear.no-unsupported-endpoint":
    "reads the tape and no state at all, so there is no issue to disambiguate between teams",
};

// Ships EMPTY and stays empty. Unlike `vacuityMutant` there is no structural
// excuse — a closed set genuinely has no guaranteed-false member, but every
// field of `CheckSubstrate<LinearCheckState>` is hand-fillable.
const HONEST_NULL_WORLDS: Record<string, string> = {};

const SUBSTRATES: CheckSubstrateKind[] = ["final", "seed+final", "tape"];

describe("declared check identity", () => {
  it("gives every check a fixture, and carries no stale fixture", () => {
    for (const check of CHECKS) {
      expect(FIXTURES[check.id], `${check.id} has no FIXTURES entry`).toBeDefined();
    }
    for (const id of Object.keys(FIXTURES)) {
      expect(
        CHECKS.some((c) => c.id === id),
        `stale FIXTURES entry: ${id}`,
      ).toBe(true);
    }
  });

  it("declares a non-empty, twin-prefixed, unique id", () => {
    const seen = new Set<string>();
    for (const check of CHECKS) {
      expect(check.id, "every check needs an id").toBeTruthy();
      expect(check.id.startsWith("linear."), `${check.id} is not twin-prefixed`).toBe(true);
      expect(seen.has(check.id), `duplicate id ${check.id}`).toBe(false);
      seen.add(check.id);
    }
  });

  it("declares a description that is not just the template", () => {
    // Shankar et al., UIST '24 §7.3.3: a picker can only show what is declared,
    // and a description that restates the sentence teaches an author nothing.
    for (const check of CHECKS) {
      expect(check.description, `${check.id} has no description`).toBeTruthy();
      expect(check.description).not.toBe(check.template);
    }
  });

  it("declares a known substrate and function-valued polarity/vacuityMutant", () => {
    for (const check of CHECKS) {
      expect(SUBSTRATES, `${check.id} declares an unknown substrate`).toContain(check.substrate);
      expect(typeof check.polarity).toBe("function");
      expect(typeof check.vacuityMutant).toBe("function");
      expect(typeof check.discriminatingWorlds).toBe("function");
    }
  });

  it("names its team unless ledgered, and a ledgered check reads no state", () => {
    for (const check of CHECKS) {
      if (TEAM_FREE_CHECKS[check.id] !== undefined) {
        expect(check.substrate, `${check.id} is team-free but reads state`).toBe("tape");
        continue;
      }
      expect(
        Object.keys(check.params),
        `${check.id} does not name its team — a title-keyed selector is ambiguous across teams`,
      ).toContain("team");
    }
    for (const id of Object.keys(TEAM_FREE_CHECKS)) {
      expect(
        CHECKS.some((c) => c.id === id),
        `stale TEAM_FREE_CHECKS entry: ${id}`,
      ).toBe(true);
    }
  });
});

describe("declared check grammar", () => {
  it("round-trips render -> parse -> render byte-identically", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const parsed = parseCheck(check, rendered);
      expect(parsed, `${check.id}: its own sentence did not parse`).not.toBeNull();
      expect(renderCheck(check, parsed!)).toBe(rendered);
    }
  });

  it("binds its own sentence and is anchored", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkPattern(check).test(rendered), `${check.id} does not bind itself`).toBe(true);
      expect(
        checkPattern(check).test(`${rendered} and also something else`),
        `${check.id} is not anchored — a terminal free-text slot swallows the suffix`,
      ).toBe(false);
    }
  });

  it("binds no OTHER check's valid sentence", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      for (const other of CHECKS) {
        if (other.id === check.id) continue;
        expect(
          checkPattern(other).test(rendered),
          `${other.id} claims ${check.id}'s sentence`,
        ).toBe(false);
      }
    }
  });

  it("near-misses only its own template", () => {
    // A near-miss pattern opens every slot to `.+?` while keeping the literals,
    // so two templates whose literal skeletons overlap would report a corrupted
    // instance under a check the author never picked. This is the arm that
    // makes `is in state "{state}"` the wording rather than `is {state}`.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      for (const other of CHECKS) {
        if (other.id === check.id) continue;
        expect(
          checkNearMissPattern(other).test(rendered),
          `${other.id} near-misses ${check.id}'s sentence`,
        ).toBe(false);
      }
    }
  });
});

describe("declared vacuity mutants", () => {
  it("produces a sentinel-bearing mutant that re-binds to the same check, or is ledgered", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const mutant = check.vacuityMutant(args);
      if (mutant === null) {
        expect(
          HONEST_NULL_MUTANTS[check.id],
          `${check.id} declared a null mutant with no ledger entry`,
        ).toBeTruthy();
        continue;
      }
      const rendered = renderCheck(check, mutant);
      // A "mutation" to a value that could actually exist proves nothing.
      expect(rendered, `${check.id}: mutant is identical to the original`).not.toBe(
        renderCheck(check, args),
      );
      expect(
        rendered.includes(VACUITY_SENTINEL) || rendered.includes(String(VACUITY_SENTINEL_NUMBER)),
        `${check.id}: mutant "${rendered}" carries no sentinel`,
      ).toBe(true);
      // The load-bearing one: a mutant that stops matching evaluates to
      // `unmatched`, which differs from `passed`, which reads as "the verdict
      // moved -> healthy". It must re-bind.
      expect(
        checkPattern(check).test(rendered),
        `${check.id}: mutant "${rendered}" does not re-bind`,
      ).toBe(true);
      // Re-binding is necessary but not sufficient: a mutant may not silently
      // change a slot it never set out to falsify.
      for (const [slot, value] of Object.entries(mutant)) {
        if (value === args[slot]) continue;
        expect(
          value.includes(VACUITY_SENTINEL) || value === String(VACUITY_SENTINEL_NUMBER),
          `${check.id}: mutant changed slot "${slot}" from ${JSON.stringify(
            args[slot],
          )} to ${JSON.stringify(value)} without falsifying it`,
        ).toBe(true);
      }
    }
    for (const id of Object.keys(HONEST_NULL_MUTANTS)) {
      expect(
        CHECKS.some((c) => c.id === id),
        `stale HONEST_NULL_MUTANTS entry: ${id}`,
      ).toBe(true);
    }
  });

  it("carries the NUMERIC sentinel only where the number is the scanned value (D10)", () => {
    // In these patterns a numeric capture is a SELECTOR unless you can argue
    // the number IS what the predicate scans for. `linear.issue-estimate` can:
    // the estimate is compared to the column, and the title is the selector —
    // stripe's `payment-intent-amount` argument, unchanged.
    const NUMERIC_ALLOWED = new Set(["linear.issue-estimate"]);
    for (const check of CHECKS) {
      const mutant = check.vacuityMutant(FIXTURES[check.id]!);
      if (mutant === null) continue;
      if (!renderCheck(check, mutant).includes(String(VACUITY_SENTINEL_NUMBER))) continue;
      expect(
        NUMERIC_ALLOWED.has(check.id),
        `${check.id}: mutant carries the NUMERIC sentinel. Falsifying a selector moves the ` +
          `verdict on every seed for a reason that never reaches the trigger clause, so the ` +
          `criterion always reads as "discriminates" and can never be flagged vacuous. Point ` +
          `the mutant at the literal the predicate SCANS for instead.`,
      ).toBe(true);
    }
  });
});

describe("declared discriminating worlds", () => {
  it("names a passing and a failing world for every check, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const verdict = probeDiscrimination(check, FIXTURES[check.id]!);
      if (verdict.kind === "declined") {
        expect(
          HONEST_NULL_WORLDS[check.id],
          `${check.id} declined to declare worlds with no ledger entry`,
        ).toBeTruthy();
        continue;
      }
      expect(
        verdict.kind === "broken"
          ? `${check.id}: ${verdict.arm} — ${verdict.detail}`
          : "discriminates",
      ).toBe("discriminates");
    }
    for (const id of Object.keys(HONEST_NULL_WORLDS)) {
      expect(
        CHECKS.some((c) => c.id === id),
        `stale HONEST_NULL_WORLDS entry: ${id}`,
      ).toBe(true);
    }
  });

  it("ships an EMPTY null-worlds ledger", () => {
    // A failing world is a hand-written fixture and every field of
    // CheckSubstrate is hand-fillable, so unlike a vacuity mutant there is no
    // structural excuse for absence.
    expect(Object.keys(HONEST_NULL_WORLDS)).toEqual([]);
  });

  it("puts each world on the substrate the check declared", () => {
    // A `final` check handed a seed, or a `tape` check handed none, would pass
    // the arms above while testing a substrate the engine will never give it.
    for (const check of CHECKS) {
      const worlds = check.discriminatingWorlds(FIXTURES[check.id]!);
      if (worlds === null) continue;
      for (const [arm, world] of [
        ["passing", worlds.passing],
        ["failing", worlds.failing],
      ] as const) {
        if (check.substrate === "tape") {
          expect(world.tape, `${check.id} ${arm}: a tape check was handed no tape`).not.toBeNull();
        } else {
          expect(world.tape, `${check.id} ${arm}: a state check was handed a tape`).toBeNull();
        }
        if (check.substrate === "seed+final") {
          expect(world.seed, `${check.id} ${arm}: a delta check was handed no seed`).not.toBeNull();
        } else {
          expect(world.seed, `${check.id} ${arm}: a final-only check was handed a seed`).toBeNull();
        }
      }
    }
  });
});

describe("state-shape parity", () => {
  // `LinearCheckState` is a HAND-WRITTEN reader of raw SQLite rows, so nothing
  // but this arm stops it drifting from what `exportLinearState` actually
  // emits. twin-slack put its equivalent in `fidelity-contract.test.ts`; Linear
  // has no such vitest suite — its parity harness is a standalone tsx script —
  // so the arm goes in the file that already runs, and the repo gains one test
  // file rather than a second drift gate.
  async function realExport(): Promise<LinearCheckState> {
    const { LinearDomain, defaultSeedState, openLinearTwinDatabase, parseSeed } = await import(
      "../src/index.js"
    );
    const db = openLinearTwinDatabase(":memory:");
    try {
      const domain = new LinearDomain(db);
      domain.seed(parseSeed(defaultSeedState()));
      return domain.exportState() as unknown as LinearCheckState;
    } finally {
      db.close();
    }
  }

  it("emits every collection the check state model reads", async () => {
    const state = await realExport();
    for (const key of ["teams", "workflowStates", "labels", "issues", "comments", "users"] as const) {
      expect(Array.isArray(state[key]), `export has no ${key} array`).toBe(true);
    }
    expect(Array.isArray(state.exportBounds?.truncatedCollections)).toBe(true);
  });

  it("emits every issue field the model reads, with the types it assumes", async () => {
    const issue = (await realExport()).issues!.find((i) => i.title === "Triage inbox for agent eval");
    expect(issue, "the default seed no longer carries that issue").toBeDefined();
    expect(typeof issue!.id).toBe("string");
    expect(typeof issue!.teamId).toBe("string");
    expect(typeof issue!.title).toBe("string");
    // stateId, NOT a state name — trap 1, and the reason
    // `resolveWorkflowStateName` exists at all.
    expect(typeof issue!.stateId).toBe("string");
    expect("state" in issue!, "the export gained a state NAME; the join may be redundant").toBe(
      false,
    );
    // labelIds, NOT label objects and NOT names — trap 2.
    expect(Array.isArray(issue!.labelIds)).toBe(true);
    // Trap 3: resolution filters on this, so it must be a declared column.
    expect("archivedAt" in issue!).toBe(true);
    expect("estimate" in issue!).toBe(true);
  });

  it("scopes workflow states and labels by teamId", async () => {
    const state = await realExport();
    expect(typeof state.workflowStates![0]!.teamId).toBe("string");
    expect(typeof state.workflowStates![0]!.name).toBe("string");
    expect(typeof state.labels![0]!.teamId).toBe("string");
    expect(typeof state.labels![0]!.name).toBe("string");
  });

  it("exports comment threading", async () => {
    const comments = (await realExport()).comments!;
    expect(Array.isArray(comments)).toBe(true);
    // `parentId` must be a declared column even when every seeded comment is a
    // root, or `linear.issue-threaded-reply` is unanswerable.
    if (comments.length > 0) expect("parentId" in comments[0]!).toBe(true);
  });

  it("resolves a real seeded issue end to end", async () => {
    const state = await realExport();
    const r = resolveIssue(state, "ENG", "Triage inbox for agent eval");
    expect(
      "found" in r,
      `resolveIssue failed on a REAL export: ${JSON.stringify(r)}`,
    ).toBe(true);
  });
});

// Every state-reading check that cites no path, WITH the reason.
const HONEST_UNCITED_CHECKS: Record<string, string> = {};

describe("declared state citations", () => {
  it("cites a resolvable state path from every check that reads state", () => {
    for (const check of CHECKS) {
      // A tape check cites `evidenceEventIds` and is not this gate's business.
      if (check.substrate === "tape") continue;
      const verdict = probeStateCitation(check, FIXTURES[check.id]!);

      if (verdict.kind === "cites") {
        expect(
          HONEST_UNCITED_CHECKS[check.id],
          `${check.id} cites its state path but is still listed in HONEST_UNCITED_CHECKS — stale entry`,
        ).toBeUndefined();
        continue;
      }

      expect(
        HONEST_UNCITED_CHECKS[check.id],
        `${check.id} reads state but ${
          verdict.kind === "declined"
            ? "names no worlds, so its citation cannot be probed"
            : verdict.kind === "uncited"
              ? `its ${verdict.arm} world produced no evidenceStatePaths`
              : verdict.kind === "unresolvable"
                ? `its ${verdict.arm} world cites ${verdict.pointer}, which resolves to nothing in that world`
                : `its ${verdict.arm} world cited malformed evidence — ${verdict.detail}`
        }. A state verdict that cites nothing renders as an inert row.`,
      ).toBeTruthy();
    }
  });

  it("ships an EMPTY uncited ledger", () => {
    expect(Object.keys(HONEST_UNCITED_CHECKS)).toEqual([]);
  });

  it("leaves the state-path field absent on every tape check", () => {
    // The converse. A tape check has no state tree to point into — the engine
    // hands it a deliberately barren `final` so it cannot read one — so a pointer
    // from here would address a world the check never saw.
    for (const check of CHECKS) {
      if (check.substrate !== "tape") continue;
      const worlds = check.discriminatingWorlds(FIXTURES[check.id]!);
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        expect(
          check.evaluate(FIXTURES[check.id]!, world).evidenceStatePaths,
          `${check.id}.${side} reads the tape but cites a state path`,
        ).toBeUndefined();
      }
    }
  });
});

// Which door stands between a redactor that eats a slot's literal and a wrong verdict
// — one row per declared slot, MEASURED rather than argued.
const REDACTION_GUARDS: Record<string, RedactionGuard> = {
  "linear.issue-exists · title": "declared_subject",
  "linear.issue-exists · team": "false_fail",
  "linear.issue-state · title": "false_fail",
  "linear.issue-state · team": "false_fail",
  "linear.issue-state · state": "declared_subject",
  "linear.issue-has-label · title": "false_fail",
  "linear.issue-has-label · team": "false_fail",
  "linear.issue-has-label · label": "declared_subject",
  "linear.issue-estimate · title": "false_fail",
  "linear.issue-estimate · team": "false_fail",
  // A number compared against a number, never a string in the tree.
  "linear.issue-estimate · estimate": "absent_from_world",
  "linear.issue-assignee · title": "false_fail",
  "linear.issue-assignee · team": "false_fail",
  "linear.issue-assignee · user": "declared_subject",
  "linear.issue-comment-contains · title": "false_fail",
  "linear.issue-comment-contains · team": "false_fail",
  "linear.issue-comment-contains · needle": "declared_subject",
  "linear.issue-threaded-reply · title": "false_fail",
  "linear.issue-threaded-reply · team": "false_fail",
};

describe("declared redaction survival", () => {
  it("never turns a failing world into a passing one by destroying a literal", () => {
    for (const check of CHECKS) {
      const verdict = probeRedactionSurvival(check, FIXTURES[check.id]!);
      // A check that names no worlds cannot be probed here either; the
      // HONEST_NULL_WORLDS gate above is what makes that a costly admission.
      if (verdict.kind === "declined") continue;
      for (const row of verdict.rows) {
        expect(
          row.guard,
          `${check.id}'s {${row.param}}: ${row.detail}. A redactor that eats this literal ` +
            `turns the check's OWN failing world into a pass, so a criterion written on it ` +
            `grades a leaking agent clean. Declare the slot as this check's \`subject\` — the ` +
            `engine then skips at the door — or guard it inside \`evaluate\`.`,
        ).not.toBe("vacuous_pass");
        expect(
          row.guard,
          `${check.id}'s {${row.param}} crashed the evaluator: ${row.detail}. A criterion may ` +
            `leave the denominator; it may not take the evaluator with it.`,
        ).not.toBe("throws");
      }
    }
  });

  it("classifies every slot exactly as REDACTION_GUARDS records", () => {
    // The count, held as a value so it cannot quietly change. A new check with
    // no rows here fails, and so does a declaration that moves a slot from one
    // door to another — including the good moves, which should be read on the
    // way past rather than absorbed.
    const measured: Record<string, RedactionGuard> = {};
    for (const check of CHECKS) {
      const verdict = probeRedactionSurvival(check, FIXTURES[check.id]!);
      if (verdict.kind === "declined") continue;
      for (const row of verdict.rows) measured[`${check.id} · ${row.param}`] = row.guard;
    }
    expect(measured).toEqual(REDACTION_GUARDS);
  });
});
