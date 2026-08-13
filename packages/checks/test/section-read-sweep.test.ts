// SPDX-License-Identifier: Apache-2.0
//
// THE SECTION-READ SWEEP — every section a shipped check's verdict reads, asked
// whether the check's own two worlds have anything to say about it.
//
// ── The hole this fills ──────────────────────────────────────────────────────
//
// pome-cloud's `findVacuousStateSectionReaders` measures vacuity by SWAPPING and
// then DELETING sections, and it derives its candidate sections from what
// DIFFERS between a check's passing and failing worlds. That rule is what keeps
// it from reporting every section a world carries for realism — but it also
// means a section IDENTICAL in both worlds is never a candidate, so it is never
// deleted, so a verdict that reads it vacuously is invisible to that instrument.
// The detector's doc comment has said so since F-1160 rather than folding it
// into a zero, and the review that named it described the shape as "a negative
// check over two lists, only one of which the worlds populate".
//
// The honest fix is not a wider detector. A detector cannot invent the evidence
// a declaration declined to author: with both worlds carrying the same value
// there is no failing value to swap in and therefore no proof the verdict reads
// the section at all. So the reach has to come from the side that KNOWS what the
// predicate touched — here, in the repo where the worlds are written.
//
// ── How this reaches what the detector cannot ────────────────────────────────
//
// The detector INFERS what a verdict reads from what moves it. This file
// OBSERVES it: `evaluate` is handed a recording view of the state tree, and
// every top-level key the predicate asks for is on the record whether or not the
// worlds disagree about its value. That is P2's evidence-dependency trick
// (`p2-evidence-dependency.test.ts` in pome-cloud) applied to a declaration's
// own worlds instead of to a corpus run — no seeds, no twins checkout, no
// SQLite.
//
// Then, for the sections the two worlds AGREE on — precisely the set the
// detector cannot make a candidate of — this runs the detector's own step 3:
// delete the section from the passing world and re-evaluate. Still a bare
// `passed` means the verdict claimed to read something whose absence it cannot
// notice, on evidence the declaration never varied. That is the blind spot,
// measured.
//
// ── Why an agreed-on section is usually FINE, and how that is discharged ─────
//
// Most agreed reads are SELECTORS and NARROWERS, not evidence, and both worlds
// must carry them for the failing world to fail on the assertion rather than
// through the selector — the degenerate arm `probeDiscrimination` rejects.
// `slack.no-reaction-added` is the reviewer's shape exactly (a negative check
// over `channels` and `reactions`, worlds moving only `reactions`), and deleting
// `channels` returns `state_incomplete` because `resolveChannel` refuses. So the
// discharge is MEASURED per check on every run, not asserted once: an agreed
// read whose deletion moves the verdict off a bare pass is proven harmless, and
// nothing has to be written down about it.
//
// What CANNOT be discharged by measurement is a section whose absence the twin
// deliberately reads as a value — `exportBounds` absent means "this export
// predates the cap", which is a statement about meaning that no probe can
// derive. Those are named below with the twin comment that says so, and the
// list is pinned in BOTH directions: an unexplained finding fails, and so does
// an exemption that has stopped being needed.
//
// ── Both trees ──────────────────────────────────────────────────────────────
//
// `seed` as well as `final`, because the detector probes `final` only and a
// `seed+final` check's seed is a section-read like any other. All four shipped
// `seed+final` declarations carry a BYTE-IDENTICAL seed in both worlds, so every
// seed read is an agreed read — and every one of them is discharged by
// measurement today. That zero is measured here rather than assumed.

import { describe, expect, it } from "vitest";

import {
  defineCheck,
  templateSlots,
  type CheckDefinition,
  type CheckOutcome,
  type CheckParamType,
} from "../src/dsl.js";
import { TWIN_CHECKS } from "../src/index.js";

type AnyState = Record<string, unknown>;
type AnyCheck = CheckDefinition<AnyState, Record<string, string>>;

const TREES = ["seed", "final"] as const;
type Tree = (typeof TREES)[number];

/** The args a declaration guarantees its own pattern accepts — each slot's
 *  example, the same input `findVacuousStateSectionReaders` runs on. */
function exampleArgs(def: AnyCheck): Record<string, string> {
  const { params } = templateSlots(def.template);
  const args: Record<string, string> = {};
  for (const name of params) args[name] = (def.params[name] as CheckParamType).example;
  return args;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A stand-in for `root` that remembers every TOP-LEVEL key the predicate asked
 * for, including the ones it asked for and found absent.
 *
 * Only the root is proxied. A section is the unit the detector deletes and the
 * unit a declaration's worlds vary, so anything finer would report a shape that
 * has no repair. `has` is trapped as well as `get` because `"x" in final` reads
 * the section just as surely as `final.x` does.
 *
 * A predicate that spread or `JSON.stringify`-ed the whole tree would record
 * every key and over-report. None does today, and if one starts to, this file
 * goes red with a named section rather than quietly widening — which is the
 * direction a probe should fail in.
 */
function recordingTree(root: AnyState): { view: AnyState; reads: Set<string> } {
  const reads = new Set<string>();
  const view = new Proxy(root, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol") return value;
      if (typeof value === "function") return (value as () => unknown).bind(target);
      reads.add(prop);
      return value;
    },
    has(target, prop) {
      if (typeof prop !== "symbol") reads.add(prop);
      return Reflect.has(target, prop);
    },
  });
  return { view, reads };
}

interface SectionRead {
  /** `<checkId>:<tree>.<section>` — the detector's finding spelling, plus the tree. */
  id: string;
  /** What the verdict became once the section was deleted from the passing world. */
  outcome: string;
  /** True when it stayed a bare `passed` — the blind spot. */
  blind: boolean;
}

const describeOutcome = (outcome: CheckOutcome | null): string =>
  outcome === null
    ? "threw"
    : outcome.status != null
      ? `${outcome.status}(${outcome.reason})`
      : outcome.passed
        ? "passed"
        : "failed";

/**
 * Every section a check's verdict READS but its two worlds AGREE on, with what
 * deleting it from the passing world does to the verdict.
 *
 * Returns data rather than a boolean so the assertions below can pin the whole
 * surface — including the sections that are NOT blind spots and why, because a
 * sweep that only ever reports the current tree's answer is a sweep nobody has
 * checked.
 */
function sweepAgreedSectionReads(checks: readonly AnyCheck[]): SectionRead[] {
  const results: SectionRead[] = [];
  for (const def of checks) {
    if (def.substrate === "tape") continue;
    const args = exampleArgs(def);
    const worlds = def.discriminatingWorlds(args);
    // A declaration that publishes no worlds is `no_discriminating_worlds`, and
    // that finding already has an owner (the detector, and each twin's
    // `HONEST_NULL_WORLDS` ledger). Reporting it twice would be a second seam.
    if (worlds === null) continue;

    const run = (seed: AnyState | null, final: AnyState): CheckOutcome | null => {
      try {
        return def.evaluate(args, { seed, final, tape: worlds.passing.tape ?? null });
      } catch {
        // A throw is a LOUD failure and never the silent pass this hunts for.
        return null;
      }
    };
    const barePass = (outcome: CheckOutcome | null): boolean =>
      outcome !== null && outcome.status == null && outcome.passed;

    const passingSeed = (worlds.passing.seed ?? null) as AnyState | null;
    const passingFinal = (worlds.passing.final ?? {}) as AnyState;
    // A declaration whose passing world does not pass has a different defect
    // with its own owner. There is no passing verdict here to remove evidence
    // from — the same first move the detector makes.
    if (!barePass(run(passingSeed, passingFinal))) continue;

    // ── Observe. Both arms, because a predicate can reach a section on the
    // failing path that the passing path short-circuits past.
    const reads: Record<Tree, Set<string>> = { seed: new Set(), final: new Set() };
    for (const arm of [worlds.passing, worlds.failing]) {
      const seed = arm.seed == null ? null : recordingTree(structuredClone(arm.seed) as AnyState);
      const final = recordingTree(structuredClone(arm.final ?? {}) as AnyState);
      run(seed?.view ?? null, final.view);
      for (const section of final.reads) reads.final.add(section);
      for (const section of seed?.reads ?? []) reads.seed.add(section);
    }

    // ── Probe. Only the sections the two worlds agree on: the ones the detector
    // cannot make a candidate of, and so the ones it never deletes.
    for (const tree of TREES) {
      const passing = tree === "seed" ? passingSeed : passingFinal;
      if (passing === null) continue;
      const failing = ((tree === "seed" ? worlds.failing.seed : worlds.failing.final) ??
        {}) as AnyState;
      const agreed = [...reads[tree]]
        .filter((section) => sameJson(passing[section], failing[section]))
        .sort();
      for (const section of agreed) {
        const pruned = structuredClone(passing) as AnyState;
        delete pruned[section];
        const outcome =
          tree === "seed" ? run(pruned, passingFinal) : run(passingSeed, pruned);
        results.push({
          id: `${def.id}:${tree}.${section}`,
          outcome: describeOutcome(outcome),
          blind: barePass(outcome),
        });
      }
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

const SHIPPED = Object.values(TWIN_CHECKS).flat() as unknown as readonly AnyCheck[];
const SHIPPED_SWEEP = sweepAgreedSectionReads(SHIPPED);
const blindSpots = (sweep: readonly SectionRead[]): string[] =>
  sweep.filter((row) => row.blind).map((row) => row.id);

// ── The declared exceptions, and why measurement cannot discharge them ───────
//
// Each row is a section whose ABSENCE the twin deliberately reads as a VALUE, so
// deleting it is not the removal of evidence that the probe assumes it is. That
// is a claim about meaning; no probe can derive it, so it is written down — and
// pinned in both directions below, so a row that stops being needed is a named
// failure rather than a comment nobody re-reads.
interface DeclaredException {
  /** A check id, or `*` when the reason is a property of the SECTION itself. */
  check: string;
  tree: Tree;
  section: string;
  why: string;
}

const DECLARED_EXCEPTIONS: readonly DeclaredException[] = [
  {
    check: "*",
    tree: "final",
    section: "exportBounds",
    why:
      "Not evidence — a NARROWER. `isTruncated` in twin-gmail's and twin-linear's " +
      "check-state.ts reads an absent `exportBounds` block as `false` on purpose: an " +
      "export that predates the collection cap answers the same thing it would have " +
      "answered honestly, and treating absence as `truncated` would skip every " +
      "criterion on an older snapshot. Deleting it can only make a check more willing " +
      "to answer; every collection its verdict is computed FROM is still there. Keyed " +
      "on the section rather than on a check id because the reason is the section's.",
  },
  {
    check: "gmail.mailbox-label-count",
    tree: "final",
    section: "mailboxes",
    why:
      "Also a narrower, and the check's own `evaluate` says so: a `mailboxes` " +
      "collection that is PRESENT and omits the named mailbox means we cannot attest " +
      "anything about it, while an ABSENT one is a different fact — the count proceeds " +
      "by `mailboxEmail`, which is how the export's own message rows are keyed. The " +
      "evidence (`messages`, `messageLabels`, `labels`) is untouched by the deletion, " +
      "and all three are guarded by name one line above.",
  },
];

/** Does this declared exception cover `<checkId>:<tree>.<section>`? */
const exempts = (id: string, e: DeclaredException): boolean =>
  id === `${e.check}:${e.tree}.${e.section}` ||
  (e.check === "*" && id.endsWith(`:${e.tree}.${e.section}`));

describe("the shipped declarations", () => {
  // The dead-guard check, first: a sweep that has quietly stopped being able to
  // observe anything reports a clean tree, and a clean tree is what it is
  // supposed to report. These floors are what tell the two apart. They are
  // deliberately well under today's numbers (38 state checks, 34 agreed reads)
  // so a new declaration does not have to touch this file, and well over zero so
  // an import that stops resolving cannot pass as good news.
  it("actually examined the vocabulary", () => {
    const stateChecks = SHIPPED.filter((def) => def.substrate !== "tape");
    expect(stateChecks.length).toBeGreaterThanOrEqual(30);
    expect(SHIPPED_SWEEP.length).toBeGreaterThanOrEqual(20);
    expect(SHIPPED_SWEEP.some((row) => row.id.startsWith("slack."))).toBe(true);
    expect(SHIPPED_SWEEP.some((row) => row.id.includes(":seed."))).toBe(true);
  });

  // The property F-1437 asks for, in the form it is actually true in: a section
  // both worlds agree on is fine when the twin refuses (or fails) without it,
  // and that is measured here per check rather than argued once.
  it("reads no agreed-on section vacuously, except where the twin declares absence a value", () => {
    const unexplained = blindSpots(SHIPPED_SWEEP).filter(
      (id) => !DECLARED_EXCEPTIONS.some((e) => exempts(id, e)),
    );
    expect(unexplained).toEqual([]);
  });

  // The other direction. An exemption nothing reaches is a comment claiming to
  // hold something up that is no longer there, which is exactly the rot the
  // engine deleted its `(checkId, section)` tables to avoid. And an exemption
  // with no reason is the finding renamed — the ticket's second alternative is
  // "the exception has a WRITTEN reason", so the field is enforced rather than
  // trusted, which is also what stops a later row being added with a shrug.
  it("carries no exemption that has stopped being needed, or that gives no reason", () => {
    for (const exception of DECLARED_EXCEPTIONS) {
      const where = `${exception.check}:${exception.tree}.${exception.section}`;
      const reached = SHIPPED_SWEEP.filter((row) => row.blind && exempts(row.id, exception));
      expect(reached.length, where).toBeGreaterThan(0);
      expect(exception.why.length, where).toBeGreaterThan(120);
    }
  });

  // Pinned so a pin bump's diff shows the whole surface moving, not just the
  // headline zero — the same reason `declared-pin.test.ts` pins its findings.
  it("pins today's blind spots exactly", () => {
    expect(blindSpots(SHIPPED_SWEEP)).toEqual([
      "gmail.draft-addressed-to:final.exportBounds",
      "gmail.draft-count-at-least:final.exportBounds",
      "gmail.label-exists:final.exportBounds",
      "gmail.mailbox-label-count:final.exportBounds",
      "gmail.mailbox-label-count:final.mailboxes",
      "gmail.message-has-label:final.exportBounds",
      "gmail.one-message-per-recipient:final.exportBounds",
      "linear.issue-exists:final.exportBounds",
    ]);
  });

  // The repair F-1437 actually made, pinned by its measured effect rather than
  // by the fixture's shape. `gmail.message-has-label` built its user label as
  // `userLabel(label, label)` — an id-equals-name shape only a SYSTEM label has —
  // and with it `labelIdsFor`'s bare-display-name fallback answered the join on
  // its own, so deleting `labels` left the verdict a bare pass. The minted id in
  // the world is what puts that read on the record.
  it("proves gmail.message-has-label reads the labels its worlds agree on", () => {
    const row = SHIPPED_SWEEP.find((r) => r.id === "gmail.message-has-label:final.labels");
    expect(row).toBeDefined();
    expect(row!.blind).toBe(false);
    expect(row!.outcome).toBe("failed");
  });

  // The reviewer's own words, re-measured rather than taken on trust: "a
  // negative check over two lists, only one of which the worlds populate".
  // `slack.no-reaction-added` is that shape — the worlds move `reactions` and
  // leave `channels` byte-identical — and `resolveChannel` refuses without the
  // list, so the shape reproduces and the vacuity does not.
  it("reproduces the reviewer's shape and shows the twin already refuses it", () => {
    const row = SHIPPED_SWEEP.find((r) => r.id === "slack.no-reaction-added:final.channels");
    expect(row).toBeDefined();
    expect(row!.blind).toBe(false);
    expect(row!.outcome).toBe("skipped(state_incomplete)");
  });
});

// ── Teeth ───────────────────────────────────────────────────────────────────
//
// A sweep that only ever reports the current tree's answer is untested: it
// cannot tell "nothing is wrong" from "I can no longer see". Every arm below
// plants a declaration and asserts what the sweep does with it.

const anyWord: CheckParamType = {
  name: "needle",
  pattern: "[a-z]+",
  example: "shipped",
  render: (value) => value,
  parse: (raw) => raw,
};

const REFUSAL = { passed: false, status: "skipped" as const, reason: "state_incomplete" };

interface PlantedState {
  alpha?: { text: string }[] | null;
  beta?: { text: string }[] | null;
  gamma?: { text: string }[] | null;
}

/** A world pair over `alpha`/`beta`/`gamma` where only `alpha` moves — so `beta`
 *  and `gamma` are agreed-on sections, and what separates them is whether the
 *  planted verdict reads them. */
function plantedWorlds(needle: string) {
  const world = (alpha: { text: string }[]) => ({
    seed: null,
    final: { alpha, beta: [], gamma: [{ text: "for realism" }] } as PlantedState,
    tape: null,
  });
  return { passing: world([{ text: "all clear" }]), failing: world([{ text: needle }]) };
}

const plant = (
  id: string,
  evaluate: (args: { needle: string }, s: { seed: PlantedState | null; final: PlantedState }) => CheckOutcome,
): AnyCheck =>
  defineCheck<PlantedState, { needle: CheckParamType }>({
    id,
    description: "planted",
    template: 'No message containing "{needle}"',
    params: { needle: anyWord },
    substrate: "final",
    polarity: () => "negative",
    subject: ({ needle }) => needle,
    vacuityMutant: (args) => args,
    discriminatingWorlds: ({ needle }) => plantedWorlds(needle),
    evaluate,
  }) as unknown as AnyCheck;

describe("the sweep itself", () => {
  // THE DEFECT, in the shape F-1160's reviewer described it: a negative verdict
  // over two lists, the worlds populating only one of them, and `?? []` on the
  // other. `beta` is byte-identical in both worlds, so it is not a candidate for
  // `findVacuousStateSectionReaders` and never gets deleted there — while an
  // agent that DID put the needle in `beta` collects the point.
  it("names a section a negative verdict reads over two lists and the worlds agree on", () => {
    const vacuous = plant("plant.negative-two-lists", ({ needle }, { final }) => {
      if (final.alpha == null) return REFUSAL;
      const hit =
        final.alpha.some((row) => row.text.includes(needle)) ||
        (final.beta ?? []).some((row) => row.text.includes(needle));
      return { passed: !hit, reason: hit ? "found" : "clean" };
    });
    expect(blindSpots(sweepAgreedSectionReads([vacuous]))).toEqual([
      "plant.negative-two-lists:final.beta",
    ]);
  });

  // …and it really is the section the ENGINE's rule cannot reach. This is the
  // detector's candidate rule restated: candidates are the sections the two
  // worlds differ on, and `beta` is not one of them.
  it("names a section the detector's candidate rule excludes by construction", () => {
    const worlds = plantedWorlds("shipped");
    const differing = Object.keys(worlds.passing.final).filter(
      (section) =>
        JSON.stringify((worlds.passing.final as Record<string, unknown>)[section]) !==
        JSON.stringify((worlds.failing.final as Record<string, unknown>)[section]),
    );
    expect(differing).toEqual(["alpha"]);
    expect(differing).not.toContain("beta");
  });

  // The guard the finding asks for, and the proof the sweep stops asking once it
  // is there. Same worlds, same agreement, refusal instead of `?? []`.
  it("clears the same declaration once the twin refuses the absent section", () => {
    const guarded = plant("plant.guarded-two-lists", ({ needle }, { final }) => {
      if (final.alpha == null || final.beta == null) return REFUSAL;
      const hit =
        final.alpha.some((row) => row.text.includes(needle)) ||
        final.beta.some((row) => row.text.includes(needle));
      return { passed: !hit, reason: hit ? "found" : "clean" };
    });
    expect(blindSpots(sweepAgreedSectionReads([guarded]))).toEqual([]);
  });

  // The false positive this must never produce, and the reason it observes reads
  // rather than listing keys. `gamma` is carried by both worlds for realism and
  // read by nobody — `gmail.draft-count-at-least`'s `messages` is the shipped
  // instance. Reporting it would press for an absence guard that turns a working
  // check into an abstention.
  it("says nothing about a section both worlds carry and the verdict never reads", () => {
    const clean = plant("plant.realism-section", ({ needle }, { final }) => {
      if (final.alpha == null || final.beta == null) return REFUSAL;
      const hit = final.alpha.some((row) => row.text.includes(needle));
      return { passed: !hit, reason: hit ? "found" : "clean" };
    });
    const swept = sweepAgreedSectionReads([clean]);
    // `beta` is read (and guarded, so it is discharged by measurement); `gamma`
    // is carried by both worlds and never asked for, so it is not here at all.
    expect(swept.map((row) => row.id)).toEqual(["plant.realism-section:final.beta"]);
    expect(blindSpots(swept)).toEqual([]);
  });

  // A section neither world carries at all is the purest form of the blind spot:
  // the verdict asks for it, no world has anything to say about it, and deleting
  // it is a no-op. Silence here would be the sweep agreeing with a declaration
  // that never exercised the read.
  it("names a section the verdict reads and NEITHER world carries", () => {
    const unexercised = plant("plant.never-carried", ({ needle }, { final }) => {
      if (final.alpha == null) return REFUSAL;
      const extra = (final as { delta?: { text: string }[] }).delta ?? [];
      const hit =
        final.alpha.some((row) => row.text.includes(needle)) ||
        extra.some((row) => row.text.includes(needle));
      return { passed: !hit, reason: hit ? "found" : "clean" };
    });
    expect(blindSpots(sweepAgreedSectionReads([unexercised]))).toContain(
      "plant.never-carried:final.delta",
    );
  });

  // The seed tree, which the engine's detector does not probe at all.
  it("probes the seed tree of a seed+final declaration", () => {
    const seedVacuous = defineCheck<PlantedState, { needle: CheckParamType }>({
      id: "plant.seed-read",
      description: "planted",
      template: 'No new message containing "{needle}"',
      params: { needle: anyWord },
      substrate: "seed+final",
      polarity: () => "negative",
      subject: ({ needle }) => needle,
      vacuityMutant: (args) => args,
      discriminatingWorlds: ({ needle }) => {
        const seed: PlantedState = { alpha: [{ text: "seeded" }] };
        return {
          passing: { seed, final: { alpha: [{ text: "seeded" }] }, tape: null },
          failing: { seed, final: { alpha: [{ text: needle }] }, tape: null },
        };
      },
      evaluate({ needle }, { seed, final }) {
        if (final.alpha == null) return REFUSAL;
        const before = new Set((seed?.alpha ?? []).map((row) => row.text));
        const hit = final.alpha.some((row) => row.text.includes(needle) && !before.has(row.text));
        return { passed: !hit, reason: hit ? "found" : "clean" };
      },
    }) as unknown as AnyCheck;
    expect(blindSpots(sweepAgreedSectionReads([seedVacuous]))).toEqual([
      "plant.seed-read:seed.alpha",
    ]);
  });

  // A declaration whose passing world does not pass has a different defect with
  // a different owner, and this must not report over it — the same first move
  // the engine's detector makes.
  it("stays out of a declaration whose passing world does not pass", () => {
    const broken = plant("plant.passing-world-fails", () => ({ passed: false, reason: "no" }));
    expect(sweepAgreedSectionReads([broken])).toEqual([]);
  });

  // Tape declarations have their own instrument (`unrecordedTapeField`), and a
  // state sweep reading a tape world would report a state tree nobody consults.
  it("skips tape declarations", () => {
    const tape = defineCheck<PlantedState, { needle: CheckParamType }>({
      id: "plant.tape",
      description: "planted",
      template: 'No call mentioning "{needle}"',
      params: { needle: anyWord },
      substrate: "tape",
      polarity: () => "negative",
      subject: ({ needle }) => needle,
      vacuityMutant: (args) => args,
      discriminatingWorlds: () => ({
        passing: { seed: null, final: {}, tape: [] },
        failing: { seed: null, final: {}, tape: [{ tool: "x" }] },
      }),
      evaluate: (_args, { tape: rows }) =>
        rows == null ? REFUSAL : { passed: rows.length === 0, reason: "counted" },
    }) as unknown as AnyCheck;
    expect(sweepAgreedSectionReads([tape])).toEqual([]);
  });
});
