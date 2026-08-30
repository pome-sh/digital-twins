// SPDX-License-Identifier: Apache-2.0
/**
 * `pome checks` — the assertable vocabulary a twin declares.
 *
 * Discovery is offline, like `pome tasks`: the declaration comes from the twin
 * package this CLI is pinned to. That is a SECOND resolution point (pome-cloud's
 * `resolveDeclaredChecks` is the first), accepted so authoring works without a
 * network, and gated by the digest handshake in `checks-add.ts` — which refuses
 * to write a sentence when the two pins disagree.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { checksDigest, templateSlots, type CheckDefinition } from "@pome-sh/sdk/checks";
import { MOUNTED_TWINS } from "../contract/index.js";
import { GITHUB_CHECKS } from "@pome-sh/twin-github/checks";
import { GMAIL_CHECKS } from "@pome-sh/twin-gmail/checks";
import { LINEAR_CHECKS } from "@pome-sh/twin-linear/checks";
import { SLACK_CHECKS } from "@pome-sh/twin-slack/checks";
import { STRIPE_CHECKS } from "@pome-sh/twin-stripe/checks";

// Args erased, exactly as pome-cloud's registry does it: the declarations are a
// heterogeneous tuple that every consumer here handles uniformly.
export type DeclaredCheck = CheckDefinition<unknown, Record<string, string>>;

const REGISTRIES: Record<string, readonly DeclaredCheck[]> = {
  github: GITHUB_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
  slack: SLACK_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
  stripe: STRIPE_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
  gmail: GMAIL_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
  linear: LINEAR_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
};

// Twins that EXIST but declare nothing yet — DERIVED, not listed.
//
// The distinction is still real: `pome checks <twin>` must answer "not migrated
// yet" for a twin that exists, and "no such twin" for a typo. What is no longer
// real is the hand-maintained literal. Slack, stripe and gmail each came off it
// one at a time, and the next migration would have emptied it — four changes
// each editing one line of a list that `MOUNTED_TWINS` already knows.
//
// So it is a set difference instead. Today it is EMPTY, which is A3's whole
// acceptance criterion. The day a sixth twin mounts, it repopulates itself and
// the "not migrated yet" path comes back live without anyone remembering to add
// a literal — which is the failure this project is named for, one level down.
// Annotated `string[]` on purpose: `MOUNTED_TWINS` is a literal-union tuple, so
// the filtered result keeps that union and `isKnownTwin` cannot ask it about an
// arbitrary string. Widening here is what keeps the caller's question — "is this
// user-typed word a twin?" — expressible.
const TWINS_WITHOUT_CHECKS: string[] = MOUNTED_TWINS.filter((twin) => !(twin in REGISTRIES));

export function twinsWithChecks(): string[] {
  return Object.keys(REGISTRIES).sort();
}

/**
 * Twins that exist but declare nothing yet.
 *
 * Exported because the no-vocabulary PATH is a real behaviour with its own
 * tests, and those tests need a twin on this list to exercise it. Naming one
 * inline is what broke five of them when stripe left the list — a
 * literal there asserts the MEMBERSHIP of the set, where the test means to
 * assert the behaviour, which is the same defect a hard-coded picker index
 * once caused.
 *
 * A3 empties this list, and that raised a question with a clear answer: the PATH
 * stays, the LITERAL goes. It is now `MOUNTED_TWINS` minus the registry, so an
 * empty result is a fact about the world rather than a list nobody updated.
 */
export function twinsWithoutChecks(): string[] {
  return [...TWINS_WITHOUT_CHECKS];
}

export function checksFor(twin: string): readonly DeclaredCheck[] {
  return REGISTRIES[twin] ?? [];
}

export function findCheck(id: string): DeclaredCheck | undefined {
  for (const checks of Object.values(REGISTRIES)) {
    const hit = checks.find((check) => check.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function twinOf(id: string): string | undefined {
  for (const [twin, checks] of Object.entries(REGISTRIES)) {
    if (checks.some((check) => check.id === id)) return twin;
  }
  return undefined;
}

export function isKnownTwin(twin: string): boolean {
  return twinsWithChecks().includes(twin) || TWINS_WITHOUT_CHECKS.includes(twin);
}

/** `` No new labels were created in `<repo>` `` — every slot shown as its own
 *  name. Derived from the template, so no `title` field has to exist. */
export function displaySentence(def: DeclaredCheck): string {
  const { literals, params } = templateSlots(def.template);
  return params.reduce((out, param, i) => `${out}<${param}>${literals[i + 1]!}`, literals[0]!);
}

export function localDigest(twin: string): string {
  return checksDigest(checksFor(twin));
}

// Baked by tsup (`define: { POME_INLINED_PKG_VERSIONS }`): a JSON map from
// package name to the version the bundle inlined. Undeclared under
// `tsx src/cli/main.ts` and vitest, where the workspace fallback below applies
// — the same split `main.ts` uses for PKG_VERSION.
declare const POME_INLINED_PKG_VERSIONS: string | undefined;

function bakedVersions(): Record<string, string> {
  if (typeof POME_INLINED_PKG_VERSIONS !== "string") return {};
  try {
    return JSON.parse(POME_INLINED_PKG_VERSIONS) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The version of an inlined `@pome-sh/*` package, or undefined when nothing
 * can honestly answer.
 *
 * This used to read the CLI's own `dependencies`, which was right when the
 * twins were real runtime dependencies. tsup's `noExternal` inlines them now,
 * so they live in `devDependencies` as workspace `"*"` links, and the old
 * lookup answered "unknown" on every install — including the header of
 * `pome checks <twin>`, the first grading-vocabulary output the docs point a
 * newcomer at (F-1791). The version of the code actually in this process is
 * the one recorded at build time; in the source tree, the workspace link's
 * own manifest says the same thing.
 */
export function pinnedVersion(pkg: string): string | undefined {
  const baked = bakedVersions()[pkg];
  if (baked) return baked;
  try {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), "utf8")) as {
      name?: string;
      version?: string;
    };
    if (manifest.name === pkg && typeof manifest.version === "string") return manifest.version;
  } catch {
    // Neither baked nor installed: callers omit the version rather than print
    // a word that reads like a failure.
  }
  return undefined;
}

/** `@pome-sh/twin-github 0.12.0`, or the bare package name when the version
 *  cannot be resolved. */
export function pinLabel(pkg: string): string {
  const version = pinnedVersion(pkg);
  return version === undefined ? pkg : `${pkg} ${version}`;
}

export const SUBSTRATE_HELP: Record<string, string> = {
  final: "the final state",
  "seed+final": "the seed and the final state",
  tape: "the recorded call tape",
};

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}

export function argFlagsFor(def: DeclaredCheck): string {
  return templateSlots(def.template)
    .params.map((name) => `--arg ${name}=${def.params[name]!.example}`)
    .join(" ");
}

export interface ChecksCommandOptions {
  json?: boolean;
}

/** The `pome checks <twin>` header. Version undefined means the parenthetical
 *  is omitted, not filled with a placeholder (F-1791). Exported for the test
 *  of that branch, which nothing in a source tree can reach naturally. */
export function checksHeader(twin: string, count: number, version: string | undefined): string {
  const label = bold(`${twin} — ${count} declared check${count === 1 ? "" : "s"}`);
  return version === undefined ? label : `${label} ${dim(`(@pome-sh/twin-${twin} ${version})`)}`;
}

function jsonView(twin: string) {
  return {
    twin,
    digest: localDigest(twin),
    checks: checksFor(twin).map((def) => ({
      id: def.id,
      template: def.template,
      description: def.description,
      substrate: def.substrate,
      params: templateSlots(def.template).params.map((name) => ({
        name,
        pattern: def.params[name]!.pattern,
        example: def.params[name]!.example,
      })),
    })),
  };
}

export async function runChecksCommand(
  twinArg: string | undefined,
  opts: ChecksCommandOptions,
): Promise<void> {
  if (!twinArg) {
    if (opts.json) {
      console.log(JSON.stringify({ twins: twinsWithChecks() }, null, 2));
      return;
    }
    console.log(bold("Pome checks"));
    console.log(dim("Twins that declare an assertable vocabulary."));
    console.log("");
    for (const twin of twinsWithChecks()) {
      console.log(`  ${bold(twin)} ${dim(`(${checksFor(twin).length} checks)`)}`);
    }
    console.log("");
    console.log(dim("Run `pome checks <twin>` to list them."));
    return;
  }

  const twin = twinArg.trim();
  if (!isKnownTwin(twin)) {
    console.error(
      `Unknown twin "${twin}". Twins that declare checks: ${twinsWithChecks().join(", ")}.`,
    );
    process.exitCode = 2;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(jsonView(twin), null, 2));
    return;
  }

  const checks = checksFor(twin);
  if (checks.length === 0) {
    console.log(bold(`${twin} — no declared checks yet`));
    console.log(
      dim(`Its vocabulary has not been migrated. Use [model] criteria for ${twin} for now.`),
    );
    return;
  }

  console.log(checksHeader(twin, checks.length, pinnedVersion(`@pome-sh/twin-${twin}`)));
  console.log("");
  for (const def of checks) {
    console.log(`  ${bold(def.id)}`);
    console.log(`    ${displaySentence(def)}`);
    console.log(`    ${dim(def.description)}`);
    console.log(`    ${dim(`needs: ${SUBSTRATE_HELP[def.substrate] ?? def.substrate}`)}`);
    console.log(`    ${dim(`pome checks add <file> --check ${def.id} ${argFlagsFor(def)}`)}`);
    console.log("");
  }
  // The digest, shown rather than only computed.
  //
  // `checks add` already refuses to write a sentence when this disagrees with
  // the control plane's (`checks-add.ts`), and that refusal is correct but
  // opaque: an author who hits it has no way to see WHICH side moved. Printing
  // it here turns "the digest handshake refuses" into something a user can
  // compare against `GET /v1/checks?twin=<twin>` themselves.
  console.log(dim(`digest ${localDigest(twin)}`));
}
