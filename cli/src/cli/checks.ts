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
import { join } from "node:path";

import { checksDigest, templateSlots, type CheckDefinition } from "@pome-sh/sdk/checks";
import { GITHUB_CHECKS } from "@pome-sh/twin-github/checks";
import { SLACK_CHECKS } from "@pome-sh/twin-slack/checks";

import { resolvePackageRoot } from "./resolve-package-root.js";

// Args erased, exactly as pome-cloud's registry does it: the declarations are a
// heterogeneous tuple that every consumer here handles uniformly.
export type DeclaredCheck = CheckDefinition<unknown, Record<string, string>>;

const REGISTRIES: Record<string, readonly DeclaredCheck[]> = {
  github: GITHUB_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
  slack: SLACK_CHECKS as readonly unknown[] as readonly DeclaredCheck[],
};

// Twins that EXIST but declare nothing yet. Listed separately so `pome checks
// stripe` answers "not migrated yet" instead of "no such twin" — a typo and an
// empty vocabulary are different facts. F-1126 removed slack.
const TWINS_WITHOUT_CHECKS = ["stripe", "gmail", "linear"];

export function twinsWithChecks(): string[] {
  return Object.keys(REGISTRIES).sort();
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

/** Read the pin from OUR OWN manifest. The twin's exports map sends
 *  `./package.json` through its `"./*"` wildcard and fails to resolve — and the
 *  pin we control is the one that matters anyway. */
export function pinnedVersion(pkg: string): string {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) return "unknown";
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return manifest.dependencies?.[pkg] ?? "unknown";
  } catch {
    return "unknown";
  }
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

  console.log(
    `${bold(`${twin} — ${checks.length} declared check${checks.length === 1 ? "" : "s"}`)} ` +
      dim(`(@pome-sh/twin-${twin} ${pinnedVersion(`@pome-sh/twin-${twin}`)})`),
  );
  console.log("");
  for (const def of checks) {
    console.log(`  ${bold(def.id)}`);
    console.log(`    ${displaySentence(def)}`);
    console.log(`    ${dim(def.description)}`);
    console.log(`    ${dim(`needs: ${SUBSTRATE_HELP[def.substrate] ?? def.substrate}`)}`);
    console.log(`    ${dim(`pome checks add <file> --check ${def.id} ${argFlagsFor(def)}`)}`);
    console.log("");
  }
  // F-1126 — the digest, shown rather than only computed.
  //
  // `checks add` already refuses to write a sentence when this disagrees with
  // the control plane's (`checks-add.ts`), and that refusal is correct but
  // opaque: an author who hits it has no way to see WHICH side moved. Printing
  // it here turns "the digest handshake refuses" into something a user can
  // compare against `GET /v1/checks?twin=<twin>` themselves.
  console.log(dim(`digest ${localDigest(twin)}`));
}
