// SPDX-License-Identifier: Apache-2.0
//
// F-786: these six tasks are the hero example, and they have to run on the
// hosted surface. Hosted receives ONE thing — this markdown, base64 in
// `scenario_source` on `POST /v1/sessions`. The `<task>.seed.json` sidecar
// never crosses the wire, so a `## Seed State` written as prose parses locally
// (where the sidecar is on disk and wins) and is refused hosted with
// "scenario source failed to parse". That asymmetry is what this file exists to
// keep closed.
//
// So each task carries its seed BOTH ways, and the two copies must be the same
// bytes:
//   - inline in a fenced ```json block, which is what hosted parses;
//   - as the sidecar, which is what `npm run probe:examples` discovers seeds by
//     (`discoverSeeds` in scripts/probe-example-tools.mjs globs `tasks/*.seed.json`,
//     and `discoverExamplesWithSeeds` uses the same glob to decide an example is
//     probeable at all — deleting the sidecars would drop this example from tool
//     probing without failing anything).
//
// Two copies of one seed is a drift hazard, and the drift is silent in the worst
// direction: edit only the sidecar and local runs change while hosted keeps the
// old world. Hence this test rather than a comment asking people to be careful.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const tasksDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");
const taskFiles = readdirSync(tasksDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

/** The `## Seed State` section body, split the way the parser splits it:
 *  on `^## ` headings over the raw markdown, code fences included. */
function seedSection(markdown: string): string | undefined {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  const index = headings.findIndex((h) => h[1]!.trim().toLowerCase() === "seed state");
  if (index === -1) return undefined;
  const start = headings[index]!.index! + headings[index]![0].length;
  const end = headings[index + 1]?.index ?? markdown.length;
  return markdown.slice(start, end).trim();
}

/** The first fenced block in a section — `stripFence`'s regex, verbatim. */
function fencedJson(section: string): string | undefined {
  return section.match(/```(?:json|yaml)?\s*([\s\S]*?)```/i)?.[1]?.trim();
}

describe("minimal-viktor task seeds", () => {
  it("ships six tasks", () => {
    expect(taskFiles).toHaveLength(6);
  });

  for (const file of taskFiles) {
    describe(file, () => {
      const markdown = readFileSync(join(tasksDir, file), "utf8");
      const sidecarName = file.replace(/\.md$/, ".seed.json");
      const section = seedSection(markdown);

      // The F-786 regression itself: a prose `## Seed State` is refused hosted.
      it("carries its seed inline as fenced JSON, not as prose", () => {
        expect(section, `${file} has no ## Seed State section`).toBeDefined();
        const json = fencedJson(section!);
        expect(json, `${file}'s ## Seed State has no fenced block — hosted cannot parse it`).toBeDefined();
        expect(json!.startsWith("{"), `${file}'s fenced seed is not a JSON object`).toBe(true);
      });

      // Envelope-iff-multi-twin: every one of these declares `twins: [github, slack]`,
      // so the seed must be the per-twin envelope. A top-level `_meta` would be read
      // as a twin key and rejected — inline seeds are NOT `_meta`-stripped the way
      // sidecars are, which is exactly the kind of thing that only bites hosted.
      it("is a per-twin envelope keyed github + slack", () => {
        const seed = JSON.parse(fencedJson(section!)!);
        expect(Object.keys(seed).sort()).toEqual(["github", "slack"]);
      });

      it(`is byte-identical to ${sidecarName}`, () => {
        const sidecar = readFileSync(join(tasksDir, sidecarName), "utf8").trimEnd();
        expect(fencedJson(section!)).toBe(sidecar);
      });
    });
  }
});
