// SPDX-License-Identifier: Apache-2.0
//
// `pome init --example <id>` — name an example by id, not by typed path.
//
// The docs used to reach an example by writing its GitHub URL or an
// `npx degit pome-sh/digital-twins/agent-examples/support-triage` line. Both
// carry a path, and a path in prose survives a rename by going 404: when
// `examples/` became `agent-examples/`, three published links broke and nothing
// said so. An id cannot rot the same way — `example-catalog.ts` is derived from
// the directories, so a renamed example stops answering to the old id loudly,
// on the next command, with the valid ids printed underneath.
//
// WHY FETCH RATHER THAN BUNDLE. The alternative is shipping the ten example
// trees inside the tarball. That is ~1.5 MB of a second copy of the most
// actively-edited part of the repo, re-committed on every example edit, and the
// examples are already built to be fetched: each carries its own lockfile, sits
// outside the root npm workspace, and pins PUBLISHED `@pome-sh/*` versions
// precisely so a fetched subtree installs standalone
// (`check-example-pins-published.mjs` is the gate that keeps that true). A user
// who scaffolds one runs `npm install` next, so the network is not a new
// dependency — it is the one they already had.
//
// What the tarball does carry is the id set, so an unknown id is answered
// offline and instantly. Only the content crosses the wire.
//
// PINNED TO THE COMMIT THAT BUILT THIS CLI. `PKG_GIT_SHA` is baked in by tsup
// from the same build that stamped `dist/build-info.json`, so `pome init
// --example` on 0.34.3 fetches the example as it stood at 0.34.3 rather than as
// `main` has it today. Without that pin an old CLI silently scaffolds an example
// written against a newer one. Source-tree runs (`tsx src/cli/main.ts`) have no
// define and fall back to `main`, which is the right answer there.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { CATALOG_EXAMPLES, type CatalogExample } from "./example-catalog.js";

/** Injected by tsup (`define`). Undeclared under `tsx src/cli/main.ts`. */
declare const PKG_GIT_SHA: string | undefined;

export const EXAMPLE_REPO = "pome-sh/digital-twins";
export const EXAMPLE_RAW_HOST = "https://raw.githubusercontent.com";

/** How many files are in flight at once. Bounded so a 29-file example does not
 *  open 29 sockets and read as a burst to raw.githubusercontent.com. */
const FETCH_CONCURRENCY = 8;

const FULL_SHA = /^[0-9a-f]{40}$/;

export class ExampleScaffoldError extends Error {}

export function exampleIds(): string[] {
  return CATALOG_EXAMPLES.map((example) => example.id);
}

export function findExample(id: string): CatalogExample | undefined {
  return CATALOG_EXAMPLES.find((example) => example.id === id.trim());
}

/**
 * What an unknown id prints. Lists every valid id with the example's own
 * package.json description, because the ids alone ("merge-agent",
 * "pr-summary-review") do not tell a reader which one to pick.
 */
export function unknownExampleMessage(id: string): string {
  const width = Math.max(...CATALOG_EXAMPLES.map((example) => example.id.length));
  const lines = CATALOG_EXAMPLES.map(
    (example) => `  ${example.id.padEnd(width)}  ${firstSentence(example.description)}`,
  );
  return [
    `Unknown example "${id}". Available examples:`,
    "",
    ...lines,
    "",
    `Run \`pome init --example ${CATALOG_EXAMPLES[0]?.id ?? "<id>"}\` to scaffold one.`,
  ].join("\n");
}

/** Descriptions are a sentence of what it is plus a sentence of what it
 *  teaches; the list only has room for the first. The `Bundled Pome example:`
 *  lead-in every one carries says nothing here — the reader is looking at a
 *  list of bundled Pome examples. */
function firstSentence(description: string): string {
  const stripped = description.replace(/^Bundled Pome example:\s*/i, "");
  const end = stripped.indexOf(". ");
  const sentence = (end === -1 ? stripped : stripped.slice(0, end + 1)).trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The git ref to fetch from.
 *
 * `POME_EXAMPLE_REF` first so a contributor can scaffold from the branch they
 * are editing — the same escape hatch `npx degit#branch` gave, and what makes
 * this testable before a publish.
 */
export function resolveExampleRef(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POME_EXAMPLE_REF?.trim();
  if (override) return override;
  const baked = typeof PKG_GIT_SHA === "string" ? PKG_GIT_SHA.trim() : "";
  return FULL_SHA.test(baked) ? baked : "main";
}

export function rawUrlFor(example: CatalogExample, file: string, ref: string): string {
  const path = `${example.rel}/${file}`
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${EXAMPLE_RAW_HOST}/${EXAMPLE_REPO}/${encodeURIComponent(ref)}/${path}`;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Every file of an example, in memory, before anything touches disk.
 *
 * Fetch-then-write rather than fetch-and-write: a 404 on the 20th of 26 files
 * would otherwise leave a directory that looks scaffolded, installs, and fails
 * somewhere unrelated. Whole example or nothing.
 */
export async function fetchExampleFiles(
  example: CatalogExample,
  ref: string,
  fetchImpl: FetchLike,
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const queue = [...example.files];

  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const url = rawUrlFor(example, file, ref);
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url);
      } catch (err) {
        throw new ExampleScaffoldError(
          `Could not reach ${url} (${err instanceof Error ? err.message : String(err)}). ` +
            "`pome init --example` downloads the example from GitHub; check your network or proxy and retry.",
        );
      }
      if (!response.ok) {
        throw new ExampleScaffoldError(
          `${url} returned HTTP ${response.status}. The example catalog in this CLI (${ref}) and the ` +
            "repository disagree about what files it has — upgrade with `npm i -g @pome-sh/cli@latest`.",
        );
      }
      out.set(file, Buffer.from(await response.arrayBuffer()));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, () => worker()),
  );
  return out;
}

/** Refuses a target that already holds anything. Overwriting a directory the
 *  user named is not this command's call to make. */
async function assertEmptyTarget(target: string, id: string): Promise<void> {
  if (!existsSync(target)) return;
  const entries = await readdir(target);
  if (entries.length === 0) return;
  throw new ExampleScaffoldError(
    `${target} already exists and is not empty. Move it aside, or run \`pome init --example ${id}\` ` +
      "from a directory that does not have one.",
  );
}

export interface ScaffoldResult {
  /** Directory created, relative to the cwd it was created in. */
  dir: string;
  example: CatalogExample;
  ref: string;
  fileCount: number;
}

export async function scaffoldExample(options: {
  id: string;
  cwd: string;
  ref?: string;
  fetchImpl?: FetchLike;
}): Promise<ScaffoldResult> {
  const example = findExample(options.id);
  if (!example) throw new ExampleScaffoldError(unknownExampleMessage(options.id));

  const ref = options.ref ?? resolveExampleRef();
  const target = join(options.cwd, example.id);
  await assertEmptyTarget(target, example.id);

  const files = await fetchExampleFiles(example, ref, options.fetchImpl ?? (globalThis.fetch as FetchLike));

  for (const [file, contents] of files) {
    const destination = join(target, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }

  return { dir: example.id, example, ref, fileCount: files.size };
}

/** The first runnable task the example ships, for the next-steps line. */
export function firstTaskFile(example: CatalogExample): string | undefined {
  return example.files.find((file) => file.startsWith("tasks/") && file.endsWith(".md"));
}

export function scaffoldSummary(result: ScaffoldResult): string {
  const { example, dir, fileCount } = result;
  const header = `Scaffolded ${example.rel} into ./${dir} (${fileCount} files, from ${result.ref}).`;

  // An integration example is a HARNESS, not an examinee: its pome.json carries
  // no `command` because Braintrust's `Eval()` / LangSmith's `evaluate()` owns
  // the loop and mints the sandboxes itself. Telling a reader to `pome run` it
  // would point them at a sandbox nothing ever calls.
  if (example.root === "integration-examples") {
    return (
      `${header}\n` +
      "Next steps:\n" +
      `  1. cd ${dir}\n` +
      "  2. npm install\n" +
      `  3. Read ${dir}/README.md — this example is driven by its own eval runner, not by \`pome run\`.`
    );
  }

  const task = firstTaskFile(example);
  const run = `pome run ${task ?? "<task>.md"}`;

  // An example a docs page walks end to end (its package.json `homepage`,
  // carried into the catalog) names that page first. The capstone reader
  // arrives here MID-WALK — coach skills → MCP → paste-prompt — and a
  // next-steps that says only `pome login` + `pome run` forks them onto the
  // other route at the exact moment they are following the documented one.
  // Both routes are real, so print both.
  if (example.homepage) {
    return (
      `${header}\n` +
      "Next steps:\n" +
      `  1. cd ${dir}\n` +
      "  2. npm install\n" +
      `  3. Follow the documented walk: ${example.homepage}\n` +
      `  4. Or from the CLI: pome login, then ${run}`
    );
  }

  return (
    `${header}\n` +
    "Next steps:\n" +
    `  1. cd ${dir}\n` +
    "  2. npm install\n" +
    "  3. pome login                    # one-time, opens the dashboard to sign in\n" +
    `  4. ${run}`
  );
}
