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
//   - a validator that rejects an unknown key where GitHub's schema declares no
//     `additionalProperties`.
//
// ── WHY THIS RETURNS A RESIDUE AND SLACK'S RETURNS `[]` ─────────────────────
//
// twin-slack's conformance is empty: F-1330 moved its validators onto Slack's
// argument surface in the same change that adopted the fixture. twin-github's
// is NOT, on purpose. Closing its residue means TIGHTENING what the twin
// accepts — `list_issues` state to `["OPEN","CLOSED"]`, `query` to required on
// the search tools — and a tightening is a breaking change for every task
// written against the twin as it is. Those go with a corpus heat reading and
// their migrations, not with a fixture swap.
//
// So the residue is PINNED, exactly, by `test/mcp-contract.test.ts`. A new gap
// fails; the known ones are visible in a list somebody has to edit. That is the
// same discipline as pome-cloud's `EXPECTED_OPT_OUTS` and for the same reason:
// a count or an allowance would let the next one arrive unread.
import { z } from "zod";
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

    const upstreamRequired = [...(upstream.required ?? [])].sort().join(",");
    const ourRequired = [...(projected.required ?? [])].sort().join(",");
    if (upstreamRequired !== ourRequired) {
      problems.push(`'${tool.name}' requires [${ourRequired}] and GitHub requires [${upstreamRequired}]`);
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
