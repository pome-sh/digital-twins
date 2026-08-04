#!/usr/bin/env node
/**
 * Regression coverage for scripts/emit-trace-contract.mjs (F-1201).
 *
 * The gate's whole job is to make "a new event kind ships with no fixture" fail
 * loudly, so the cases below are written from that scenario. Case 2 IS the
 * ticket's Done-when observable, expressed at the seam: a kind list with a
 * member the corpus does not cover must throw, naming the kind and the fixture
 * path that would satisfy it.
 *
 * The pure helpers are exercised directly (a synthetic union member cannot be
 * declared in a fixture tree — the union is real source), and the CLI is
 * exercised by spawning it against throwaway package roots via `--root`. The
 * last case asserts the gate is actually wired into ci.yml: a gate nothing runs
 * is the failure mode this ticket exists to prevent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_SCHEMAS,
  assertCanonicalSchemas,
  auditEventFixtures,
  collectEventFixtures,
  unionKinds,
} from "./emit-trace-contract.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE_ROOT, "../..");
const SCRIPT = join(PACKAGE_ROOT, "scripts/emit-trace-contract.mjs");

// Importing the script above registered its `.js` → `.ts` resolve hook, so the
// barrel loads here the same way it loads inside the gate.
const api = await import("../src/index.ts");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function expectThrows(fn, ...needles) {
  let message = null;
  try {
    fn();
  } catch (error) {
    message = error.message;
  }
  assert(message !== null, `expected a throw, got none (looking for: ${needles.join(", ")})`);
  for (const needle of needles) {
    assert(message.includes(needle), `error must mention "${needle}":\n${message}`);
  }
  return message;
}

/** A throwaway package root holding one bare fixture per named kind. */
function fixtureRoot(kinds) {
  const dir = mkdtempSync(join(tmpdir(), "trace-contract-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "@pome-sh/shared-types", version: "0.0.0", peerDependencies: { zod: "^4.1.13" } },
      null,
      2,
    ),
  );
  for (const kind of kinds) {
    const kindDir = join(dir, "test/fixtures/v1/event", kind);
    mkdirSync(kindDir, { recursive: true });
    writeFileSync(join(kindDir, "row.json"), `${JSON.stringify({ kind }, null, 2)}\n`);
  }
  return dir;
}

function run(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

function main() {
  const kinds = unionKinds(api.otelEventSchema);
  const fixtures = collectEventFixtures(
    join(PACKAGE_ROOT, "test/fixtures/v1/event"),
    PACKAGE_ROOT,
  );

  // 1 — the union really is enumerated from zod, not typed out. The eight
  // members below are the ones on `main` at F-1201; the assertion that matters
  // is that they arrive from `otelEventSchema` and include BOTH arms of it —
  // the seven legacy kinds and the OTel one.
  {
    assert(kinds.length >= 8, `expected the full union, got ${kinds.length}: ${kinds}`);
    for (const kind of ["TwinHttpEvent", "LlmTurnEvent", "OtelSpanEvent"]) {
      assert(kinds.includes(kind), `unionKinds must find ${kind}: ${kinds}`);
    }
  }

  // 2 — THE DONE-WHEN OBSERVABLE. A member of the union with no fixture fails,
  // naming the kind and the path that would satisfy it. This is the case that
  // was impossible before F-1201: the old script never read the union, so the
  // emitted JSON did not move and `--check` was green by construction.
  {
    const message = expectThrows(
      () => auditEventFixtures([...kinds, "GhostEvent"], fixtures),
      "GhostEvent",
      "test/fixtures/v1/event/GhostEvent/",
    );
    for (const covered of kinds) {
      assert(
        !message.includes(`event/${covered}/\n`),
        `only the uncovered kind should be named:\n${message}`,
      );
    }
  }

  // 3 — a fixture whose kind is not a union member. This is the RENAME half:
  // rename a kind in the schema and its old fixture directory stops describing
  // anything, which must be as loud as having no fixture at all.
  {
    expectThrows(
      () =>
        auditEventFixtures(kinds, [
          ...fixtures,
          { path: "test/fixtures/v1/event/HookEventV2/row.json", dir: "HookEventV2", row: { kind: "HookEventV2" } },
        ]),
      "HookEventV2",
      "not a member of the event union",
    );
  }

  // 4 — a fixture filed under the wrong kind. Without this, one variant copied
  // into eight directories would report full coverage.
  {
    expectThrows(
      () =>
        auditEventFixtures(kinds, [
          { path: "test/fixtures/v1/event/HookEvent/row.json", dir: "HookEvent", row: { kind: "LlmTurnEvent" } },
        ]),
      "declares kind \"LlmTurnEvent\" but sits under \"HookEvent/\"",
    );
  }

  // 5 — a fixture that is not a tagged row at all.
  {
    expectThrows(
      () =>
        auditEventFixtures(kinds, [
          { path: "test/fixtures/v1/event/HookEvent/row.json", dir: "HookEvent", row: [1, 2, 3] },
        ]),
      "has no string \"kind\"",
    );
  }

  // 6 — `unionKinds` must FAIL on a schema node it does not understand rather
  // than returning the kinds it did recognize. A short list is a gate that
  // quietly stops requiring fixtures for whatever it walked past.
  {
    expectThrows(() => unionKinds(api.planTierSchema, "planTierSchema"), "unhandled zod node");
    expectThrows(() => unionKinds({ def: { type: "object", shape: {} } }, "noKind"), "no literal");
  }

  // 7 — `canonicalSchemas` is still a curated list, but no longer an unchecked
  // one: a name the barrel does not export fails instead of shipping dangling.
  {
    assertCanonicalSchemas(api, CANONICAL_SCHEMAS);
    expectThrows(
      () => assertCanonicalSchemas(api, ["eventSchema", "retiredSchema"]),
      "retiredSchema",
    );
  }

  // 8 — end to end, red: a corpus missing one kind. `--check` AND the default
  // emit mode both fail, so the gate cannot be silenced by re-running the
  // generator — the failure mode of every emit-and-compare gate.
  {
    const root = fixtureRoot(kinds.filter((kind) => kind !== "LlmTurnEvent"));
    const out = join(root, "out.json");
    const emitted = run(["--root", root, "--out", out]);
    const checked = run(["--root", root, "--out", out, "--check"]);
    rmSync(root, { recursive: true, force: true });

    for (const [mode, result] of [["emit", emitted], ["--check", checked]]) {
      const text = `${result.stdout}\n${result.stderr}`;
      assert(result.status === 1, `${mode} must exit 1, got ${result.status}: ${text}`);
      assert(text.includes("LlmTurnEvent"), `${mode} must name the missing kind: ${text}`);
    }
  }

  // 9 — end to end, green: a corpus covering every kind emits a contract whose
  // `eventKinds` has an entry per member.
  {
    const root = fixtureRoot(kinds);
    const out = join(root, "out.json");
    const result = run(["--root", root, "--out", out]);
    const contract = result.status === 0 ? JSON.parse(readFileSync(out, "utf8")) : null;
    rmSync(root, { recursive: true, force: true });

    assert(result.status === 0, `full corpus must pass: ${result.stdout}${result.stderr}`);
    assert(
      JSON.stringify(Object.keys(contract.eventKinds)) === JSON.stringify(kinds),
      `eventKinds must mirror the union, in order: ${Object.keys(contract.eventKinds)}`,
    );
  }

  // 10 — this repo, right now. The committed trace-contract.json must be in
  // sync, or landing this blocks every PR.
  {
    const result = run(["--check"]);
    assert(result.status === 0, `gate must pass on this repo: ${result.stdout}${result.stderr}`);
  }

  // 11 — a gate nothing runs is not a gate.
  {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    assert(/check:trace-contract/.test(ci), "ci.yml must run the trace-contract gate");
    assert(/emit-trace-contract\.test\.mjs/.test(ci), "ci.yml must run this test file");
  }

  console.log("✅ trace-contract event-kind gate regression tests passed");
}

main();
