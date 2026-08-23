// SPDX-License-Identifier: Apache-2.0
//
// Does the twin validate the arguments Slack declares?
//
// `@pome-sh/sdk/mcp-tool-fixture` and zod only — same portability constraint as
// `tools.ts`: pome-cloud's fidelity-watch loads twin tool tables under bun,
// which implements no `node:sqlite`, and the sdk root barrel reaches it.
import { z } from "zod";
import { typeDisagreements } from "@pome-sh/sdk/mcp-tool-fixture";
import { slackToolFixture, toolSchemas } from "./tools.js";

/**
 * What replaced the frozen draft-7 projection.
 *
 * While the fixture was a transcription of `tools.ts`, the two could be pinned
 * by BYTES: `z.toJSONSchema()` the validator, demand the fixture back. That
 * stops being possible the moment the fixture is the vendor's, because Slack's
 * `inputSchema` carries prose no zod schema projects to — per-property
 * descriptions, 4KB of canvas markdown rules, its own `title`s.
 *
 * So the pin moves from bytes to argument surface, which is the thing an
 * examinee can actually collide with. For every tool, this reports:
 *
 * - a key the validator knows that Slack does not declare — the
 *     defect in miniature, a parameter the twin invented;
 *   - a key Slack declares that the validator does not model — silently
 *     ignored today, which is survivable, but not silently;
 *   - a required-set disagreement in either direction — the twin refusing a
 *     call Slack accepts, or accepting one Slack refuses;
 *   - a validator that rejects an unknown key when Slack's schema declares no
 *     `additionalProperties`, which is the exact shape of the old
 *     `z.strictObject` hard-rejection.
 */
export function toolSchemaConformance(): string[] {
  const problems: string[] = [];
  const declared = new Set(slackToolFixture.toolNames);
  for (const name of Object.keys(toolSchemas)) {
    if (!declared.has(name)) problems.push(`'${name}' is validated here and absent from the fixture`);
  }
  for (const tool of slackToolFixture.tools) {
    const schema = (toolSchemas as Record<string, z.ZodType | undefined>)[tool.name];
    if (!schema) {
      problems.push(`'${tool.name}' is declared in the fixture and validated by nothing`);
      continue;
    }
    const upstream = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };
    const projected = z.toJSONSchema(schema, { target: "draft-7" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };

    const upstreamKeys = new Set(Object.keys(upstream.properties ?? {}));
    const ourKeys = new Set(Object.keys(projected.properties ?? {}));
    for (const key of ourKeys) {
      if (!upstreamKeys.has(key)) {
        problems.push(`'${tool.name}' validates '${key}', which Slack's inputSchema does not declare`);
      }
    }
    for (const key of upstreamKeys) {
      if (!ourKeys.has(key)) {
        problems.push(`'${tool.name}' does not model Slack's parameter '${key}'`);
      }
    }

    // The TYPE of the keys both sides declare. twin-github shipped a
    // 422 on the array its own listing advertised for a year because the two
    // checks above see a key's PRESENCE and not its shape; this twin's
    // conformance had the same blind spot and asserts `[]`, so the gap would
    // have been indistinguishable from having none. `typeDisagreements` is
    // shared rather than copied — one comparison, two vendors.
    problems.push(...typeDisagreements(tool.name, "Slack", upstream.properties ?? {}, projected.properties ?? {}));

    const upstreamRequired = [...(upstream.required ?? [])].sort().join(",");
    const ourRequired = [...(projected.required ?? [])].sort().join(",");
    if (upstreamRequired !== ourRequired) {
      problems.push(
        `'${tool.name}' requires [${ourRequired}] and Slack requires [${upstreamRequired}]`
      );
    }

    // Slack declares no `additionalProperties` on any tool, so no validator
    // here may reject on one. `z.looseObject` projects it as `{}`; a strict
    // object would project `false`.
    if (upstream.additionalProperties === undefined && projected.additionalProperties === false) {
      problems.push(
        `'${tool.name}' rejects unknown arguments, and Slack's inputSchema declares no ` +
          `additionalProperties — a live parameter would be hard-rejected here and accepted there`
      );
    }
  }
  return problems;
}
