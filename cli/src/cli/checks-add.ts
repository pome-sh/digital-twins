// SPDX-License-Identifier: Apache-2.0
/**
 * `pome checks add <file>` — pick a declared check, fill its typed parameters,
 * and let pome write the English into the task file. The author never types the
 * sentence, so it cannot fail to bind.
 *
 * The digest handshake: this CLI resolves declarations from its own npm pin and
 * the cloud resolves them from a different one. Before writing, ask the cloud
 * for the vocabulary it GRADES against and compare digests.
 *   equal        → write, silently
 *   different    → REFUSE, and name which check moved
 *   unreachable  → write from the local pin with a named note on stderr
 * Offline authoring is real, and the degraded path's worst case is bounded: a
 * stale sentence that keeps a template's literal segments fails at finalize as
 * `corrupted_check_instance:<id>` — named, not a silent unmatched.
 */
import { readFile, writeFile } from "node:fs/promises";

import { renderCheck, templateSlots } from "@pome-sh/sdk/checks";

import {
  DuplicateCriterionError,
  MissingCriteriaSectionError,
  insertCriterion,
} from "../task/insertCriterion.js";
import { readConfigTwins } from "../task/parseTask.js";
import { resolveSeams, type InteractiveSeams } from "./agent-resolver.js";
import {
  SUBSTRATE_HELP,
  checksFor,
  displaySentence,
  findCheck,
  localDigest,
  pinnedVersion,
  twinOf,
  type DeclaredCheck,
} from "./checks.js";
import { resolveCredentials, type ResolvedCredentials } from "./credentials.js";
import { auditCodeCriteria, formatBindingReport } from "./criterion-binding.js";

export interface RemoteChecks {
  twin: string;
  digest: string;
  checks: Array<{ id: string; template: string; substrate: string }>;
}

export type HandshakeResult =
  | { kind: "match" }
  | { kind: "skew"; message: string }
  | { kind: "unverified"; note: string };

export function parseArgFlags(pairs: string[]): Record<string, string> | { error: string } {
  const args: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { error: `--arg must be key=value, got ${JSON.stringify(pair)}` };
    args[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return args;
}

export async function handshake(
  twin: string,
  fetchRemote: (twin: string) => Promise<RemoteChecks>,
): Promise<HandshakeResult> {
  const pin = pinnedVersion(`@pome-sh/twin-${twin}`);
  let remote: RemoteChecks;
  try {
    remote = await fetchRemote(twin);
  } catch (err) {
    return {
      kind: "unverified",
      note:
        `Not verified against the cloud (${err instanceof Error ? err.message : "unreachable"}). ` +
        `Writing from the local pin: @pome-sh/twin-${twin} ${pin}.`,
    };
  }

  if (localDigest(twin) === remote.digest) return { kind: "match" };

  const here = new Map(checksFor(twin).map((check) => [check.id, check.template]));
  const there = new Map(remote.checks.map((check) => [check.id, check.template]));
  const moved: string[] = [];
  for (const [id, template] of here) {
    if (!there.has(id)) moved.push(`${id} — this CLI has it, the cloud does not`);
    else if (there.get(id) !== template) {
      moved.push(
        `${id} — the sentence differs\n        here:  ${template}\n        cloud: ${there.get(id)}`,
      );
    }
  }
  for (const id of there.keys()) {
    if (!here.has(id)) moved.push(`${id} — the cloud has it, this CLI does not`);
  }

  return {
    kind: "skew",
    message:
      `Refusing to write: this CLI and the cloud disagree about ${twin}'s vocabulary, so a ` +
      `sentence written here might not be graded there.\n` +
      moved.map((line) => `      - ${line}`).join("\n") +
      `\n\n  local @pome-sh/twin-${twin} ${pin}` +
      `\n  Update with \`npm i -g @pome-sh/cli@latest\`. If this CLI is already current, the ` +
      `cloud is behind — that is a deploy, not something you can fix here.`,
  };
}

async function liveFetch(creds: ResolvedCredentials, twin: string): Promise<RemoteChecks> {
  const res = await fetch(`${creds.apiBaseUrl}/v1/checks?twin=${encodeURIComponent(twin)}`, {
    headers: { "x-api-key": creds.apiKey },
  });
  if (!res.ok) throw new Error(`GET /v1/checks returned ${res.status}`);
  return (await res.json()) as RemoteChecks;
}

export interface ChecksAddOptions extends InteractiveSeams {
  check?: string;
  arg: string[];
  apiBaseUrl?: string;
  /** Test seam — defaults to the live GET /v1/checks handshake. */
  fetchRemote?: (twin: string) => Promise<RemoteChecks>;
  credentialsPath?: string;
}

async function pickInteractively(
  source: string,
  seams: Required<InteractiveSeams>,
): Promise<DeclaredCheck | undefined> {
  // CI is not interactive even when stdin happens to be a TTY — the same guard
  // as agent-resolver's, so a pipeline gets a named refusal, never a hang.
  if (!seams.stdinIsTTY || process.env.CI) {
    console.error(
      "Not an interactive terminal. Pass `--check <id> --arg key=value` " +
        "(run `pome checks <twin>` to see both).",
    );
    process.exitCode = 2;
    return undefined;
  }

  const twins = readConfigTwins(source);
  const available = twins.flatMap((twin) => [...checksFor(twin)]);
  if (available.length === 0) {
    console.error(
      `No declared checks for this task's twins (${twins.join(", ")}). ` +
        `Use a [model] criterion, or run \`pome checks\` to see which twins declare one.`,
    );
    process.exitCode = 2;
    return undefined;
  }

  console.log("Which check?");
  available.forEach((def, i) => {
    console.log(`  ${i + 1}) ${displaySentence(def)}`);
    console.log(`     ${def.description}`);
    console.log(`     needs: ${SUBSTRATE_HELP[def.substrate] ?? def.substrate}`);
    console.log("");
  });

  const answer = await seams.ask("> ");
  const index = Number.parseInt(answer, 10);
  const picked = Number.isInteger(index) ? available[index - 1] : undefined;
  if (!picked) {
    console.error(`"${answer}" is not one of 1-${available.length}.`);
    process.exitCode = 2;
    return undefined;
  }
  return picked;
}

async function promptArgs(
  def: DeclaredCheck,
  seams: Required<InteractiveSeams>,
): Promise<Record<string, string> | { error: string }> {
  const args: Record<string, string> = {};
  for (const name of templateSlots(def.template).params) {
    const type = def.params[name]!;
    // The example, never the pattern. A regex source is not a prompt.
    const valid = new RegExp(`^${type.pattern}$`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = await seams.ask(`${name}  (e.g. ${type.example})\n> `);
      if (valid.test(value)) {
        args[name] = value;
        break;
      }
      console.error(`  not a valid ${name} — it should look like ${type.example}`);
    }
    if (args[name] === undefined) return { error: `Gave up on \`${name}\` after three tries.` };
  }
  return args;
}

export async function runChecksAddCommand(file: string, opts: ChecksAddOptions): Promise<void> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    console.error(`Could not read ${file}.`);
    process.exitCode = 2;
    return;
  }

  const seams = resolveSeams(opts);

  let picked: DeclaredCheck | undefined;
  if (opts.check) {
    picked = findCheck(opts.check);
    if (!picked) {
      console.error(
        `Unknown check "${opts.check}". Run \`pome checks <twin>\` to see the declared set; ` +
          `github declares: ${checksFor("github")
            .map((c) => c.id)
            .join(", ")}.`,
      );
      process.exitCode = 2;
      return;
    }
  } else {
    picked = await pickInteractively(source, seams);
    if (!picked) return; // already reported why
  }

  const parsed = opts.check ? parseArgFlags(opts.arg) : await promptArgs(picked, seams);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const args = parsed as Record<string, string>;

  const slots = templateSlots(picked.template).params;
  for (const name of slots) {
    const type = picked.params[name]!;
    const value = args[name];
    if (value === undefined) {
      console.error(`${picked.id} needs a \`${name}\` — add \`--arg ${name}=${type.example}\`.`);
      process.exitCode = 2;
      return;
    }
    if (!new RegExp(`^${type.pattern}$`).test(value)) {
      console.error(
        `\`${name}\` = ${JSON.stringify(value)} is not valid for ${picked.id}. ` +
          `Example: ${type.example}`,
      );
      process.exitCode = 2;
      return;
    }
  }
  const extra = Object.keys(args).filter((key) => !slots.includes(key));
  if (extra.length > 0) {
    console.error(
      `${picked.id} does not declare: ${extra.join(", ")}. It takes: ${slots.join(", ")}.`,
    );
    process.exitCode = 2;
    return;
  }

  const twin = twinOf(picked.id)!;
  const fetchRemote =
    opts.fetchRemote ??
    (async (t: string) =>
      liveFetch(
        await resolveCredentials({
          apiBaseUrl: opts.apiBaseUrl,
          credentialsPath: opts.credentialsPath,
        }),
        t,
      ));
  const gate = await handshake(twin, fetchRemote);
  if (gate.kind === "skew") {
    console.error(gate.message);
    process.exitCode = 2;
    return;
  }
  if (gate.kind === "unverified") console.error(gate.note);

  const tagged = readConfigTwins(source).length > 1;
  const line = `- [code${tagged ? `:${twin}` : ""}] ${renderCheck(picked, args)}`;

  if (!opts.check) {
    console.log("");
    console.log("Appending to ## Success Criteria:");
    console.log("");
    console.log(`  ${line}`);
    console.log("");
    if (!(await seams.confirm(`Write it? ${line} [Y/n] `))) {
      console.log("Nothing written.");
      return;
    }
  }

  let next: string;
  try {
    next = insertCriterion(source, line, file);
  } catch (err) {
    if (err instanceof MissingCriteriaSectionError || err instanceof DuplicateCriterionError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  await writeFile(file, next, "utf8");
  console.log(`Wrote ${file}:`);
  console.log(`  ${line}`);
  console.log(
    picked.polarity(args) === "negative"
      ? "  negative — this should PASS on an untouched seed; only the examinee can break it."
      : "  positive — this should FAIL on an untouched seed; the examinee has to make it true.",
  );

  // F-1134 — audit the WHOLE block, not just the line just appended. A
  // hand-edited criterion binds nothing and leaves the score denominator in
  // silence, and this is the one moment a local-only author is looking at the
  // file. Audits `next`, so the sentence just written is included and has to come
  // back bound — it was rendered from a declaration, so it always does.
  //
  // WARN, never refuse, and after the summary rather than before it: declining to
  // append because of an unrelated pre-existing line would be obnoxious and would
  // tempt authors back to typing sentences by hand, which is the defect. Deliberately
  // does not touch `process.exitCode` — `pome checks lint` is the surface that fails.
  const { findings } = auditCodeCriteria(next);
  if (findings.length > 0) {
    console.error("");
    console.error(formatBindingReport(findings, file));
  }
}
