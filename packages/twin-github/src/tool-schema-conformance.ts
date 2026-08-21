// SPDX-License-Identifier: Apache-2.0
//
// Does the twin ACCEPT the arguments GitHub declares? (F-1468)
//
// `@pome-sh/sdk/mcp-tool-fixture` and zod only — same portability constraint as
// `tools.ts`: pome-cloud's fidelity-watch loads twin tool tables under bun,
// which implements no `node:sqlite`, and the sdk root barrel reaches it.
//
// ── WHY ADOPTING GITHUB'S LISTING CREATED THE NEED FOR THIS ──────────────────
//
// Before F-1468 the fixture was a projection of the validators, so the two
// could not disagree: `regenerate-mcp-tool-fixture.ts` derived every
// `inputSchema` with `z.toJSONSchema()` and a test demanded the bytes back.
// That is no longer possible and should not be — the fixture is GitHub's now,
// carrying prose, annotations and keyword choices no zod schema projects.
//
// But the property that byte-pin was buying is real, and losing it silently
// would be the worse trade. What a twin ADVERTISES and what it ACCEPTS are two
// different documents the moment they stop being generated from each other, and
// an examinee only ever collides with the second. So the pin moves from bytes to
// argument surface, exactly as F-1330 moved twin-slack's.
//
// For every tool this reports:
//
//   - a key the validator knows that GitHub does not declare — a parameter the
//     twin invented, or an alias it kept;
//   - a key GitHub declares that the validator does not model — silently
//     ignored today, which is survivable, but not silently;
//   - a required-set disagreement in either direction — the twin refusing a
//     call GitHub accepts, or accepting one GitHub refuses;
//   - a TYPE disagreement on a key both sides declare — the twin validating a
//     string where GitHub declares an array of them (F-1614);
//   - a validator that rejects an unknown key where GitHub's schema declares no
//     `additionalProperties`.
//
// ── WHY THIS RETURNS A RESIDUE AND SLACK'S RETURNS `[]` ─────────────────────
//
// twin-slack's conformance is empty: F-1330 moved its validators onto Slack's
// argument surface in the same change that adopted the fixture. twin-github's
// is NOT, and the reason is that closing an entry here usually TIGHTENS what the
// twin accepts, which breaks every task written against it as it is. Those go
// with a corpus heat reading and their migrations.
//
// That reading ran (F-1468): three tightenings were measured against the corpus,
// the bundled examples, the hosted saved tasks and the hosted runs, and the ones
// with zero heat landed — `query` required on the five search tools, `branch`
// required on the two file writers, `list_issues.state` on GitHub's
// `["OPEN","CLOSED"]` with its one call site migrated. The residue below is what
// is LEFT, and it is still the worklist rather than a backlog of oversights.
//
// So the residue is PINNED, exactly, by `test/mcp-argument-surface.test.ts`. A
// new gap fails; the known ones are visible in a list somebody has to edit. That
// is the same discipline as pome-cloud's `EXPECTED_OPT_OUTS` and for the same
// reason: a count or an allowance would let the next one arrive unread.
import { z } from "zod";
import { typeDisagreements } from "@pome-sh/sdk/mcp-tool-fixture";
import { githubToolFixture, toolArgumentSchemas } from "./tools.js";

export function toolSchemaConformance(): string[] {
  const problems: string[] = [];
  const declared = new Set<string>(githubToolFixture.toolNames);
  const schemas = new Map<string, z.ZodType>(
    toolArgumentSchemas.map((tool) => [tool.name as string, tool.schema as z.ZodType]),
  );

  for (const name of schemas.keys()) {
    if (!declared.has(name)) problems.push(`'${name}' is validated here and absent from the fixture`);
  }

  for (const tool of githubToolFixture.tools) {
    const schema = schemas.get(tool.name);
    if (!schema) {
      problems.push(`'${tool.name}' is declared in the fixture and validated by nothing`);
      continue;
    }
    const upstream = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };
    const projected = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };

    const upstreamKeys = new Set(Object.keys(upstream.properties ?? {}));
    const ourKeys = new Set(Object.keys(projected.properties ?? {}));
    for (const key of ourKeys) {
      if (!upstreamKeys.has(key)) {
        problems.push(`'${tool.name}' validates '${key}', which GitHub's inputSchema does not declare`);
      }
    }
    for (const key of upstreamKeys) {
      if (!ourKeys.has(key)) {
        problems.push(`'${tool.name}' does not model GitHub's parameter '${key}'`);
      }
    }

    // ── AND THE TYPE OF THE KEYS BOTH SIDES HAVE (F-1614) ───────────────────
    //
    // The three checks above are about a key's PRESENCE and its requiredness,
    // and for a year that was the whole comparison. It is not enough, and the
    // gap is not theoretical: `list_issues.labels` was declared
    // `{"type":"array","items":{"type":"string"}}` by GitHub and validated as
    // `z.string()` here. Both sides had the key, neither side required it, so
    // every check above passed and the pinned residue carried nothing about it
    // — while `tools/call` answered 422 `invalid_type` to the exact shape the
    // listing advertises. An examinee that read the schema and obeyed it was
    // refused, and the guard whose job is that disagreement reported green.
    //
    // Only COMPARABLE types are reported. A zod schema projects unions, refines
    // and coercions into shapes the vendor's hand-written JSON Schema has no
    // counterpart for, and a residue line nobody can act on is the failure
    // `EXPECTED_OPT_OUTS` and this list are both built to avoid.
    // `describeSchemaType` returns undefined for anything it cannot state plainly, and an unstatable
    // type is silence rather than a guess.
    problems.push(...typeDisagreements(tool.name, "GitHub", upstream.properties ?? {}, projected.properties ?? {}));

    // ── REQUIRED-NESS IS PROBED, NOT PROJECTED ──────────────────────────────
    //
    // This compared `projected.required` against `upstream.required` until
    // F-1468's tightening, and that comparison could not see the answer. Four of
    // the five search tools take a query under either of two spellings
    // (`query`/`q`), so requiring one is a `.refine()` on the object — and a
    // refine does not appear in `z.toJSONSchema()`'s `required` array at all.
    // The projection went on reporting `requires []` for a validator that
    // refuses an empty call, which is a residue entry that LIES: the next reader
    // "fixes" something already fixed, and the pinned list stops meaning what it
    // says.
    //
    // So ask the validator instead. For each key GitHub requires, omit exactly
    // that one from an otherwise-complete probe and see whether the twin
    // refuses. The alias case answers correctly because omitting `query` leaves
    // `q` absent too — the probe only ever supplies keys GitHub named.
    const complete = knownKeyProbe(upstream);
    for (const key of upstream.required ?? []) {
      const { [key]: _omitted, ...missingOne } = complete;
      if (schema.safeParse(missingOne).success) {
        problems.push(`'${tool.name}' accepts a call with no '${key}', and GitHub requires it`);
      }
    }
    // And the other direction: a key the twin demands that GitHub does not, which
    // makes the twin refuse a call the vendor answers.
    for (const key of projected.required ?? []) {
      if (!(upstream.required ?? []).includes(key)) {
        problems.push(`'${tool.name}' requires '${key}', which GitHub does not`);
      }
    }

    // `z.object()` is STRIP mode: it advertises `additionalProperties: false`
    // and accepts the unknown key at runtime. So a `false` here is only a real
    // rejection when the validator is `z.strictObject`, and this check has to
    // ask the validator rather than read the projection — which is the whole
    // reason the fixture's own `additionalProperties: false` was never evidence
    // of anything before F-1468 removed it.
    if (upstream.additionalProperties === undefined && !schema.safeParse(unknownKeyProbe(upstream)).success) {
      const withoutUnknown = schema.safeParse(knownKeyProbe(upstream));
      if (withoutUnknown.success) {
        problems.push(
          `'${tool.name}' rejects unknown arguments, and GitHub's inputSchema declares no ` +
            `additionalProperties — a live parameter would be hard-rejected here and accepted there`
        );
      }
    }
  }
  return problems;
}

/** The tool's required arguments with plausible values, so a parse failure is
 * attributable to the extra key rather than to a missing one. */
function knownKeyProbe(upstream: { properties?: Record<string, unknown>; required?: string[] }) {
  const probe: Record<string, unknown> = {};
  for (const key of upstream.required ?? []) {
    const spec = (upstream.properties ?? {})[key] as { type?: string } | undefined;
    probe[key] = spec?.type === "number" || spec?.type === "integer" ? 1 : spec?.type === "boolean" ? true : "probe";
  }
  return probe;
}

/** The same probe plus a key no vendor declares. */
function unknownKeyProbe(upstream: { properties?: Record<string, unknown>; required?: string[] }) {
  return { ...knownKeyProbe(upstream), __pome_unknown_argument__: "probe" };
}
