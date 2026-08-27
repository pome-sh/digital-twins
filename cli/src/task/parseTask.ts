// file-size: the criterion marker grammar and the two guards that refuse a line reaching for it (retired markers, near-misses) belong with the parser that applies them — and pome-cloud's scripts/check-criterion-grammar.ts reads CRITERION_LINE_RE as its registered authority by THIS path and binding, so splitting the grammar out would move the authority the cross-repo gate is pinned to.
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
// The `/seed` SUBPATH, never the package root. What this module wants
// from a twin is its zod seed schema and its default world — pure data. The root
// export additionally carries the domain, the SQLite schema, the Hono app and
// (for linear) a GraphQL executor, and `main.ts` reaches this module on every
// invocation, so importing the root here made `pome --version` parse three twins'
// entire server. `seed.ts` in each twin imports nothing but `zod`, so the
// subpath is a leaf. See `cli/src/twin/registry.ts` for the lazy boot path.
import { defaultSeedState, seedSchema } from "@pome-sh/twin-github/seed";
import {
  defaultSeedState as defaultGmailSeedState,
  gmailSeedSchema,
} from "@pome-sh/twin-gmail/seed";
import {
  defaultSeedState as defaultLinearSeedState,
  linearSeedSchema as linearSeedStateSchema,
} from "@pome-sh/twin-linear/seed";
import { parseGitHubSeedState } from "./githubSeedCompat.js";
import {
  taskCriterionSchema,
  taskConfigSchema,
  taskSchema,
  slackSeedStateSchema,
  stripeSeedStateSchema,
  type Criterion,
  type Task,
  type TaskConfig,
  type SeedEnvelope,
  type SeedState
} from "./taskSchema.js";

export async function parseTaskFile(path: string): Promise<Task> {
  const markdown = await readFile(path, "utf8");
  const sidecarSeed = await readSidecarSeed(path);
  return parseTask(markdown, slugFromPath(path), sidecarSeed, path);
}

/** The task's declared twins, read WITHOUT requiring criteria.
 *  `taskSchema` demands at least one criterion, and `pome checks add` needs the
 *  twin list BEFORE it has written one. Reuses this module's own section
 *  splitter and config schema, so it is not a second parser. */
export function readConfigTwins(markdown: string): string[] {
  const configText = splitSections(markdown).get("config") ?? "";
  const config = configText.trim()
    ? taskConfigSchema.parse(parseFencedYaml(configText))
    : taskConfigSchema.parse({});
  return config.twins;
}

/** Which heading holds the criteria. ONE definition, shared by `parseTask` and
 *  `readCodeCriteria`: a reader that knew fewer spellings than the parser
 *  would find zero criteria in a task that has several, and zero criteria reads as
 *  a clean bill. Blessing a file whose criteria were never looked at is the exact
 *  failure the binding check exists to remove. */
function criteriaSection(sections: Map<string, string>): string {
  return sections.get("success criteria") ?? sections.get("checks") ?? "";
}

/** One `[code]` criterion as an authoring surface sees it: the sentence, the twin
 *  whose declared vocabulary is supposed to grade it, and the human-facing marker
 *  reconstructed the way `parseCriteria` reconstructs it for error messages — so
 *  a report can echo a line the author can find by searching the file. */
export interface CodeCriterion {
  marker: string;
  twin: string;
  text: string;
}

/** The task's `[code]` criteria with each one's attributed twin, read WITHOUT the
 *  full task schema. Same reason `readConfigTwins` exists, one step
 *  further along: `pome checks add` and `pome checks lint` audit files that are
 *  mid-edit, and `taskSchema` refuses one carrying no criteria or no resolvable
 *  seed. Reuses this module's own section splitter and criterion grammar, so it
 *  is not a second parser.
 *
 *  TOLERANT BY DESIGN. `parseCriteria` throws on a retired marker or a tag naming
 *  no declared twin, and it is right to — it gates a run. This reader only warns,
 *  so a line it cannot understand is skipped instead: turning an author's
 *  half-finished file into a crash is how a warning surface stops being used. */
export function readCodeCriteria(markdown: string): CodeCriterion[] {
  const criteriaText = criteriaSection(splitSections(markdown));
  // A malformed ## Config block is `parseTask`'s error to report, not this
  // reader's — fall back to the schema default so an audit still runs.
  let twins: string[];
  try {
    twins = readConfigTwins(markdown);
  } catch {
    twins = taskConfigSchema.parse({}).twins;
  }
  const primary = twins[0];
  if (primary === undefined) return [];

  const found: CodeCriterion[] = [];
  for (const rawLine of criteriaText.split("\n")) {
    const match = rawLine.trim().match(CRITERION_LINE_RE);
    if (!match || match[1] !== "code") continue;
    const tag = match[2];
    // Group 3 is the always-scored keyword, text moved to group 4.
    // Reconstructing the marker WITH the keyword keeps the echoed line
    // findable by search, same reason the twin tag is reconstructed into it.
    const alwaysScored = match[3] !== undefined;
    found.push({
      marker: `[code${tag ? `:${tag}` : ""}${alwaysScored ? " always-scored" : ""}]`,
      twin: tag ?? primary,
      text: match[4]!.trim(),
    });
  }
  return found;
}

export function parseTask(markdown: string, slug = "scenario", sidecarSeed?: unknown, taskPath?: string): Task {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  const sections = splitSections(markdown);
  const prompt = sections.get("prompt") ?? sections.get("task") ?? "";
  const criteriaText = criteriaSection(sections);
  const configText = sections.get("config") ?? "";
  const seedText = sections.get("seed state") ?? "";

  const config = configText.trim() ? taskConfigSchema.parse(parseFencedYaml(configText)) : taskConfigSchema.parse({});
  const criteria = parseCriteria(criteriaText, config.twins);
  const seedState = resolveSeedState({ sidecarSeed, seedText, config, taskPath });

  return taskSchema.parse({
    slug,
    title,
    setup: sections.get("setup") ?? "",
    prompt,
    expectedBehavior: sections.get("expected behavior") ?? "",
    criteria,
    config,
    seedState
  });
}

function resolveSeedState(args: { sidecarSeed: unknown; seedText: string; config: TaskConfig; taskPath?: string }): SeedState | SeedEnvelope {
  // Multi-twin (M3): the seed is a per-twin envelope, decided from `config.twins`
  // alone (envelope-iff-multi-twin — never by sniffing the seed shape).
  if (args.config.twins.length > 1) {
    return resolveMultiTwinSeedState(args);
  }
  // ── Single-twin: unchanged (byte-identical flat path). ──
  // Sidecar wins when present — it's the compile-seeds output, already
  // validated against the in-memory twin. The `_meta` key (source hash,
  // model, etc.) is stripped before schema parsing.
  if (args.sidecarSeed !== undefined) {
    return parseSeedStateForTask(stripSidecarMeta(args.sidecarSeed), args.config);
  }
  if (args.seedText.trim()) {
    const raw = stripFence(args.seedText);
    // Prose ## Seed State sections are the post-2026-05-22 contract; they're
    // meant to be compiled to <name>.seed.json via `pome compile-seeds`. If we
    // got here, the sidecar is missing — tell the user what to do instead of
    // letting JSON.parse surface "Unexpected token 'A'".
    if (!/^[\[{]/.test(raw)) {
      throw new Error(missingSidecarMessage(args.taskPath));
    }
    try {
      return parseSeedStateForTask(JSON.parse(raw), args.config);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Inline JSON seed in ## Seed State is malformed: ${err.message}`);
      }
      throw err;
    }
  }
  return defaultSeedStateForConfig(args.config.twins);
}

// Multi-twin (M3): the seed (sidecar OR inline) MUST be the per-twin envelope
// `{ <twin>: <flat seed> }`. Envelope keys are a subset of the scenario's twins;
// each present value is parsed with THAT twin's own flat schema, and a twin with
// no envelope key falls back to its default seed. A key that is not one of the
// scenario's twins is a loud error. When no seed is provided at all, every twin
// gets its default.
function resolveMultiTwinSeedState(args: {
  sidecarSeed: unknown;
  seedText: string;
  config: TaskConfig;
  taskPath?: string;
}): SeedEnvelope {
  const twins = args.config.twins;
  let raw: unknown | undefined;
  if (args.sidecarSeed !== undefined) {
    raw = stripSidecarMeta(args.sidecarSeed);
  } else if (args.seedText.trim()) {
    const text = stripFence(args.seedText);
    if (!/^[\[{]/.test(text)) {
      throw new Error(missingSidecarMessage(args.taskPath));
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Inline JSON seed in ## Seed State is malformed: ${err.message}`);
      }
      throw err;
    }
  } else {
    raw = undefined;
  }
  return buildSeedEnvelope(raw, twins);
}

function buildSeedEnvelope(raw: unknown | undefined, twins: string[]): SeedEnvelope {
  const envelope: SeedEnvelope = {};
  if (raw === undefined) {
    for (const twin of twins) envelope[twin] = defaultSeedForTwin(twin);
    return envelope;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Multi-twin tasks need a per-twin seed envelope { <twin>: <seed> } for twins [${twins.join(", ")}], not a bare seed object.`,
    );
  }
  const allowed = new Set(twins);
  const provided = raw as Record<string, unknown>;
  for (const key of Object.keys(provided)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Seed envelope key "${key}" is not one of the task's twins [${twins.join(", ")}].`,
      );
    }
  }
  for (const twin of twins) {
    envelope[twin] =
      twin in provided ? parseSeedForTwin(twin, provided[twin]) : defaultSeedForTwin(twin);
  }
  return envelope;
}

// Parse one twin's flat seed with its own schema — the same schemas the
// single-twin flat path uses, keyed by twin id. Unknown twins fall back to the
// GitHub parse (mirrors the single-twin default).
function parseSeedForTwin(twin: string, input: unknown): SeedState {
  if (twin === "stripe") return stripeSeedStateSchema.parse(input);
  if (twin === "slack") return slackSeedStateSchema.parse(input);
  if (twin === "gmail") return gmailSeedSchema.parse(input);
  if (twin === "linear") return linearSeedStateSchema.parse(input);
  return parseGitHubSeedState(input);
}

function defaultSeedForTwin(twin: string): SeedState {
  if (twin === "stripe") {
    return stripeSeedStateSchema.parse({
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }]
    });
  }
  if (twin === "slack") {
    return slackSeedStateSchema.parse({});
  }
  if (twin === "gmail") {
    return gmailSeedSchema.parse(defaultGmailSeedState());
  }
  if (twin === "linear") {
    return linearSeedStateSchema.parse(defaultLinearSeedState());
  }
  return seedSchema.parse(defaultSeedState());
}

function missingSidecarMessage(taskPath: string | undefined): string {
  const pathLabel = taskPath ?? "<task>.md";
  const sidecarLabel = taskPath
    ? taskPath.replace(/\.md$/i, ".seed.json")
    : "<task>.seed.json";
  return [
    `Task has a prose ## Seed State section but no compiled sidecar (${sidecarLabel}). Run:`,
    "",
    `    pome compile-seeds ${pathLabel}`,
    "",
    "then re-run the task. (See `pome docs scenarios-github`.)",
  ].join("\n");
}

function stripSidecarMeta(seed: unknown): unknown {
  if (seed && typeof seed === "object" && !Array.isArray(seed)) {
    const { _meta, ...rest } = seed as Record<string, unknown>;
    return rest;
  }
  return seed;
}

async function readSidecarSeed(taskPath: string): Promise<unknown | undefined> {
  const sidecarPath = taskPath.replace(/\.md$/i, ".seed.json");
  if (sidecarPath === taskPath || !existsSync(sidecarPath)) return undefined;
  const raw = await readFile(sidecarPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Sidecar seed ${sidecarPath} is not valid JSON: ${(err as Error).message}`);
  }
}

function splitSections(markdown: string) {
  const sections = new Map<string, string>();
  const headingPattern = /^##\s+(.+)$/gm;
  const headings = [...markdown.matchAll(headingPattern)].map((match) => ({
    title: match[1]!.trim().toLowerCase(),
    start: match.index! + match[0].length
  }));

  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]!;
    const next = headings[i + 1]?.start;
    const contentStart = heading.start;
    const contentEnd = next ? markdown.lastIndexOf("##", next - 1) : markdown.length;
    sections.set(heading.title, markdown.slice(contentStart, contentEnd).trim());
  }

  return sections;
}

// Criterion marker grammar: `[code]` / `[model]` optionally carrying a
// twin tag, `[code:<twin>]` / `[model:<twin>]`, where <twin> is
// `[a-z][a-z0-9_-]*`. The marker spells the canonical criterion kind directly.
// The tag lands on `criterion.twin`; a bare marker leaves it undefined
// (attributes to the session's primary twin, `twins[0]`).
//
// A third, optional part was added: the keyword
// `always-scored`, after the kind and any tag — `- [code:slack always-scored]
// No message was posted to …`. It marks a criterion graded even when the seed
// already satisfies it (see `taskCriterionSchema.alwaysScored` in
// `./taskSchema.ts`), and it lives IN THE MARKER because that is the only part
// of the line an author can annotate without changing the graded sentence.
//
// Must stay byte-for-byte identical to the hosted mirror's
// (`apps/mcp/src/task/parseTask.ts`, pome-cloud). If the two disagree, a task
// parses on one side and silently loses a criterion on the other.
const CRITERION_LINE_RE =
  /^[-*]\s+\[(code|model)(?::([a-z][a-z0-9_-]*))?(\s+always-scored)?\]\s+(.+)$/;
// A line that REACHES for a criterion marker and misses. The grammar
// above is exact and `parseCriteria` skips anything it does not match as prose,
// so `- [code always-scored ] …`, `- [code:slack always-scored extra] …` and
// `- [code alwaysscored] …` each loaded the task with one fewer criterion and no
// error at all. A line visibly trying to be a criterion is worth an error, not
// a shrug.
//
// DELIBERATELY NARROW. It fires only on a bullet the grammar itself knows
// (`-`/`*`) whose bracket names `code` or `model` AS A WORD, so ordinary
// markdown stays prose: `- [ ] todo`, `- [x] done`, `- [note] …`, `- [checks] …`,
// `- [codex] …` and `- [modeling] …` are all untouched, and so is any line with
// no bullet. A greedier rule would turn plain markdown into a parse error — a
// louder failure than the silent drop it replaces, and a far more disruptive one.
//
// Checked ONLY once CRITERION_LINE_RE has already refused the line, so by
// construction it can never refuse a line the grammar accepts.
//
// NOT REGISTERED in pome-cloud's `scripts/check-criterion-grammar.ts`, and must
// not be: that gate compares the accepted LANGUAGE of CRITERION_LINE_RE across
// its five copies, and the accepted language is unchanged here. This sits beside
// the grammar exactly the way LEGACY_CRITERION_LINE_RE already does.
//
// Must stay identical to the hosted parser's (`apps/mcp/src/task/parseTask.ts`,
// pome-cloud), refusal message included. A guard in only one of the two repos
// re-opens the cross-parser disagreement, with the sign flipped: a
// typo would parse hosted and throw here.
const NEAR_MISS_CRITERION_LINE_RE = /^[-*]\s*\[\s*(code|model)\b[^\]]*\]/;

/** The one wording for a near-miss refusal, shared with the hosted parser word
 *  for word. It quotes the line so an author can find it by searching the file,
 *  and names the grammar it failed by reading CRITERION_LINE_RE itself — so the
 *  message cannot drift from the rule it is reporting. */
function nearMissCriterionMessage(line: string): string {
  return (
    `Criterion line "${line}" reaches for a [code]/[model] marker but does not match the ` +
    `criterion grammar ${CRITERION_LINE_RE.source} — fix the marker (e.g. "[code]", ` +
    `"[code:slack]", "[code:slack always-scored]"); a line this close to a criterion is ` +
    `refused rather than silently dropped as prose.`
  );
}

function parseCriteria(input: string, twins: string[]): Criterion[] {
  const multiTwin = twins.length > 1;
  const allowed = new Set(twins);
  const primary = twins[0]!;
  const criteria: Criterion[] = [];

  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(CRITERION_LINE_RE);
    if (!match) {
      // A near-miss is refused here rather than skipped. Reached only
      // after the grammar has said no, so an accepted line never lands here.
      if (NEAR_MISS_CRITERION_LINE_RE.test(line)) {
        throw new Error(nearMissCriterionMessage(line));
      }
      continue;
    }
    const kind = match[1]!; // "code" | "model"
    const tag = match[2]; // twin tag or undefined
    const alwaysScored = match[3] !== undefined; // `always-scored` keyword
    const text = match[4]!.trim();
    // Reconstruct the human-facing marker for error messages.
    const marker = `[${kind}${tag ? `:${tag}` : ""}${alwaysScored ? " always-scored" : ""}]`;

    // `always-scored` only means anything to the deterministic scorer: the
    // judge never takes a seed reading, so a [model] criterion has nothing to
    // exclude and nothing to honour the flag.
    if (alwaysScored && kind !== "code") {
      throw new Error(
        `Criterion "${marker} ${text}" is marked always-scored, which only applies to [code] criteria — a [model] criterion is judged from the run, never against the seed.`,
      );
    }

    if (tag !== undefined) {
      if (!multiTwin) {
        // Single-twin: an explicit tag is allowed but must equal the sole twin.
        if (tag !== primary) {
          throw new Error(
            `Criterion "${marker} ${text}" tags twin "${tag}", but this single-twin task runs "${primary}". Drop the tag or set config.twins to include "${tag}".`,
          );
        }
      } else if (!allowed.has(tag)) {
        // Multi-twin: an explicit tag must name one of the scenario's twins.
        throw new Error(
          `Criterion "${marker} ${text}" tags twin "${tag}", which is not in the task's twins [${twins.join(", ")}].`,
        );
      }
    } else if (multiTwin && kind === "code") {
      // Multi-twin: every [code] criterion MUST carry a tag so the cloud knows
      // which twin's state to check it against. [model] may stay bare
      // (attributes to the primary twin).
      throw new Error(
        `Criterion "${marker} ${text}" needs a twin tag ([code:<twin>]) in a multi-twin task (twins [${twins.join(", ")}]).`,
      );
    }

    // The marker spells the canonical kind; `criterionSchema` keeps accepting
    // the legacy `D`/`P` values only for 0.3.0-era artifacts, never markdown.
    // `twin` and `alwaysScored` ride through untouched, both ABSENT (never
    // `false`) when the line carries no tag / no keyword.
    criteria.push(
      taskCriterionSchema.parse({
        type: kind,
        text,
        ...(tag !== undefined ? { twin: tag } : {}),
        ...(alwaysScored ? { alwaysScored: true } : {}),
      }),
    );
  }

  return criteria;
}

/** The flat seed a single twin boots from. Single-twin scenarios return the
 *  flat `seedState` as-is; multi-twin scenarios return that twin's slice of the
 *  per-twin envelope (decided from `config.twins`, per the envelope-iff-multi-twin
 *  rule). Used by the local runner to seed each twin harness. */
export function seedStateForTwin(scenario: Task, twin: string): unknown {
  if (scenario.config.twins.length > 1) {
    return (scenario.seedState as SeedEnvelope)[twin];
  }
  return scenario.seedState;
}

function parseFencedYaml(input: string) {
  return parseYaml(stripFence(input));
}

// Scenario seed shape is FLAT per twin, disambiguated by config.twins.
// Stripe-only scenarios parse with the Stripe schema; everything else (default
// `["github"]`, or explicit github) parses with the GitHub schema.
function parseSeedStateForTask(input: unknown, config: TaskConfig): SeedState {
  if (isStripeOnly(config.twins)) return stripeSeedStateSchema.parse(input);
  if (isSlackOnly(config.twins)) return slackSeedStateSchema.parse(input);
  if (isGmailOnly(config.twins)) return gmailSeedSchema.parse(input);
  if (isLinearOnly(config.twins)) return linearSeedStateSchema.parse(input);
  return parseGitHubSeedState(input);
}

function defaultSeedStateForConfig(twins: string[]): SeedState {
  if (isStripeOnly(twins)) {
    return stripeSeedStateSchema.parse({
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }]
    });
  }
  if (isSlackOnly(twins)) {
    // Empty Slack seed — the twin's own `parseSeed`/`defaultSeedState` fills the
    // world at boot. Tasks always ship a sidecar, so this is just the
    // schema-valid floor.
    return slackSeedStateSchema.parse({});
  }
  if (isGmailOnly(twins)) {
    return gmailSeedSchema.parse(defaultGmailSeedState());
  }
  if (isLinearOnly(twins)) {
    return linearSeedStateSchema.parse(defaultLinearSeedState());
  }
  return seedSchema.parse(defaultSeedState());
}

function isStripeOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "stripe";
}

function isSlackOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "slack";
}

function isGmailOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "gmail";
}

function isLinearOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "linear";
}

function stripFence(input: string) {
  const fence = input.match(/```(?:json|yaml)?\s*([\s\S]*?)```/i);
  return (fence?.[1] ?? input).trim();
}

function slugFromPath(path: string) {
  return basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatTaskError(error: unknown, filePath: string) {
  if (error instanceof z.ZodError) {
    return `Invalid task ${filePath}: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }
  if (error instanceof Error) {
    return `Invalid task ${filePath}: ${error.message}`;
  }
  return `Invalid task ${filePath}`;
}
