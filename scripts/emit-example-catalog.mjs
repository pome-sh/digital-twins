// SPDX-License-Identifier: Apache-2.0
//
// Derives `cli/src/cli/example-catalog.ts` from the example directories
// themselves, following the emit-route-inputs / emit-manifest-schema pattern:
// default mode writes the file, `--check` reds if the committed one is stale.
//
// WHY DERIVED AND NOT TYPED. `pome init --example <id>` needs three things about
// an example, and every one of them already exists in the tree:
//
//   the id           the directory name under a root in `EXAMPLE_ROOTS`
//   the description  the example's own package.json `description`
//   the file list    what git tracks under that directory
//
// Restating any of them in a table here would make a deleted example keep its
// id, and a renamed one answer to the old name — the exact failure the ticket
// this file comes from measured on the docs site (three hand-typed GitHub URLs
// 404ing after `examples/` became `agent-examples/`). Derived, a directory that
// disappears takes its id with it and this gate is what says so out loud.
//
// WHY `git ls-files` AND NOT readdir. The catalog's file list is the list
// `pome init --example` fetches from raw.githubusercontent.com, and that host
// serves exactly what git tracks. A readdir walk would also see `node_modules/`,
// `dist/` and a contributor's scratch files — every one of which would become a
// 404 at scaffold time. Asking git is asking the same question the CDN answers.
//
// Runs in ci.yml's always-on block, NOT the heavy one: the diff that drifts this
// file is a diff that adds or deletes an example, and a `agent-examples/`-only
// PR is exactly the shape the scope step could classify as not needing the
// heavy suite. Imports node:fs, node:path and node:child_process only, so it
// runs before `npm ci`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXAMPLE_ROOTS, listExamples } from "./lib/example-roots.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = "cli/src/cli/example-catalog.ts";

/** Files git tracks under `rel`, repo-relative, in git's own sorted order. */
export function defaultListTrackedFiles(repoRoot, rel) {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", rel], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

/**
 * One catalog entry per example across every root.
 *
 * Throws rather than emitting a thin catalog on any of the three ways this can
 * go quietly wrong: no examples at all (a scan that found nothing reads exactly
 * like a repo with nothing to find), two roots claiming one id (`--example x`
 * would resolve to whichever sorted first), and an example git tracks no files
 * under (its id would resolve and then scaffold an empty directory).
 */
export function buildCatalog(repoRoot, listTrackedFiles = defaultListTrackedFiles) {
  const examples = listExamples(repoRoot);
  if (examples.length === 0) {
    throw new Error(
      `no examples found under ${EXAMPLE_ROOTS.join(", ")} in ${repoRoot} — refusing to emit an empty ` +
        "catalog, which would make `pome init --example` report that this repo has no examples at all.",
    );
  }

  const byId = new Map();
  const entries = [];
  for (const { root, name, rel, dir } of examples) {
    const collision = byId.get(name);
    if (collision) {
      throw new Error(
        `example id "${name}" is claimed by both ${collision} and ${rel}. Ids are directory names and ` +
          "`pome init --example` takes one, so two roots cannot both answer to it — rename one directory.",
      );
    }
    byId.set(name, rel);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const description = typeof pkg.description === "string" ? pkg.description.trim() : "";
    if (description === "") {
      throw new Error(
        `${rel}/package.json has no \`description\`. It is what \`pome init --example\` prints beside the id ` +
          "when it lists what is available, so an example without one is an id a reader cannot choose between.",
      );
    }

    // `homepage` is optional and means: a docs page walks THIS example end to
    // end, and `pome init --example` should name it in the next steps. It must
    // be an absolute https URL — a relative docs path printed in a terminal is
    // a link nobody can follow.
    const homepage = typeof pkg.homepage === "string" ? pkg.homepage.trim() : "";
    if (homepage !== "" && !homepage.startsWith("https://")) {
      throw new Error(
        `${rel}/package.json has homepage "${homepage}", which is not an absolute https URL. ` +
          "`pome init --example` prints it as a next step, so it has to be followable as printed.",
      );
    }

    const prefix = `${rel}/`;
    const files = listTrackedFiles(repoRoot, rel)
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .sort();
    if (files.length === 0) {
      throw new Error(
        `git tracks no files under ${rel}, so \`pome init --example ${name}\` would scaffold an empty ` +
          "directory. Either commit the example or delete it.",
      );
    }

    entries.push({ id: name, root, rel, description, homepage: homepage || undefined, files });
  }
  return entries;
}

/** The generated module. Hand-editing it is what `--check` exists to catch. */
export function renderCatalog(entries) {
  const body = entries
    .map((entry) => {
      const files = entry.files.map((file) => `      ${JSON.stringify(file)},`).join("\n");
      return [
        "  {",
        `    id: ${JSON.stringify(entry.id)},`,
        `    root: ${JSON.stringify(entry.root)},`,
        `    rel: ${JSON.stringify(entry.rel)},`,
        `    description:`,
        `      ${JSON.stringify(entry.description)},`,
        ...(entry.homepage ? [`    homepage: ${JSON.stringify(entry.homepage)},`] : []),
        "    files: [",
        files,
        "    ],",
        "  },",
      ].join("\n");
    })
    .join("\n");

  return `// SPDX-License-Identifier: Apache-2.0
//
// GENERATED by scripts/emit-example-catalog.mjs — do not edit.
// Run \`npm run emit:example-catalog\` after adding, renaming or deleting an
// example, or after changing which files one tracks. \`npm run
// gate:example-catalog\` reds on a stale copy.
//
// The id set is the directory names under the roots in
// scripts/lib/example-roots.mjs, so an example that leaves the repo takes its
// \`pome init --example\` id with it rather than 404ing later.

/** One bundled example, addressable by \`pome init --example <id>\`. */
export interface CatalogExample {
  /** The id \`--example\` takes. The directory name, unique across roots. */
  id: string;
  /** Which root holds it — decides what \`pome init\` prints as the next step. */
  root: string;
  /** Repo-relative directory, e.g. \`agent-examples/minimal-viktor\`. */
  rel: string;
  /** The example's own package.json \`description\`. */
  description: string;
  /** The example's own package.json \`homepage\`, set when a docs page walks it
   *  end to end — \`pome init --example\` names it in the next steps. */
  homepage?: string;
  /** Every file git tracks, relative to \`rel\`, sorted. */
  files: string[];
}

export const CATALOG_EXAMPLES: CatalogExample[] = [
${body}
];
`;
}

export function emitExampleCatalog({
  repoRoot = REPO_ROOT,
  check = false,
  listTrackedFiles = defaultListTrackedFiles,
} = {}) {
  const outPath = join(repoRoot, OUT_REL);
  const body = renderCatalog(buildCatalog(repoRoot, listTrackedFiles));

  if (!check) {
    writeFileSync(outPath, body);
    return { path: OUT_REL, wrote: true };
  }
  if (!existsSync(outPath)) {
    throw new Error(`${OUT_REL} does not exist. Run \`npm run emit:example-catalog\`.`);
  }
  if (readFileSync(outPath, "utf8") !== body) {
    throw new Error(
      `${OUT_REL} is stale — the example directories and the catalog disagree. ` +
        "Run `npm run emit:example-catalog` and commit the result.",
    );
  }
  return { path: OUT_REL, wrote: false };
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("emit-example-catalog.mjs")) {
  throw new Error(`emit-example-catalog.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  const result = emitExampleCatalog({ check: process.argv.includes("--check") });
  console.log(`${relative(REPO_ROOT, join(REPO_ROOT, result.path))}${result.wrote ? "" : " (up to date)"}`);
}
