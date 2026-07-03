// SPDX-License-Identifier: Apache-2.0
//
// `pome eval [run-dir]` — upload an EXISTING raw trace directory to Pome
// cloud for authoritative evaluation and print the score (FDRS-656; the
// capture/eval split contract: CLI captures, cloud evaluates). No local
// scoring happens anywhere in this command (ADR-013) — the printed verdict
// is whatever POST /v1/sessions/:id/finalize returns.
//
// Server contract (FDRS-655, pome-cloud — must land + deploy first):
//   POST /v1/eval-sessions  { agent, task_name } → 201 { session_id, expires_at }
// After that the EXISTING presigned upload-url routes and /finalize work
// unchanged on the minted session.
//
// Idempotent re-runs: the minted session id is persisted to
// `<run-dir>/eval-session.json`. Re-running `pome eval` on the same dir
// reuses that session, so /finalize's idempotent fast-path returns the
// already-judged run instead of re-judging (and instead of erroring). If
// the stored session has been reaped server-side, we mint a fresh session
// and retry once.

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createHostedClient,
  type HostedClient,
} from "../hosted/client.js";
import {
  HostedOrchError,
  HostedUsageError,
  exitCodeFor,
} from "../hosted/errors.js";
import {
  redactJsonl,
  scoreFromFinalizeResponse,
  uploadRunBlobs,
  type UploadClient,
} from "../hosted/uploadAndFinalize.js";
import { readLatestRun, writeScoreJson } from "../recorder/artifacts.js";
import { redactSecrets } from "../recorder/redaction.js";
import { outcomeOf, scoreStatus, type Score } from "../evaluator/score.js";
import { resolveCredentials } from "./credentials.js";
import {
  normalizeConfigAgentSdk,
  readProjectConfig,
  type ProjectConfig,
} from "./project-config.js";
import type { FinalizeResponse } from "../types/shared.js";

const EVAL_SESSION_FILE = "eval-session.json";
// The eval command has no scenario file (and therefore no per-scenario
// threshold); mirror `pome run`'s default binary gate.
const EVAL_PASS_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

/** The fields `writeRunArtifactsCore` persists to meta.json that `pome eval`
 *  relies on. Everything is optional-by-parse — validation happens in
 *  `deriveEvalIdentity` so the error can name the flag that fixes it. */
export interface RunMeta {
  runId: string | null;
  /** Scenario slug (`meta.json` key: `scenario`) — the default task name. */
  scenario: string | null;
  title: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
}

export function parseRunMeta(raw: unknown): RunMeta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HostedUsageError(
      "pome eval: meta.json is corrupt — expected a JSON object.",
    );
  }
  const obj = raw as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = obj[key];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  const exitCode = obj.exit_code;
  return {
    runId: str("run_id"),
    scenario: str("scenario"),
    title: str("title"),
    startedAt: str("started_at"),
    completedAt: str("completed_at"),
    exitCode: typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null,
  };
}

// ---------------------------------------------------------------------------
// run-dir validation
// ---------------------------------------------------------------------------

export interface RunDirArtifacts {
  runDir: string;
  meta: RunMeta;
  /** Raw file contents; redaction is re-applied at upload time. */
  eventsJsonl: string;
  stateInitialJson: string;
  stateFinalJson: string;
  /** Present only when the optional signals.jsonl exists. */
  signalsJsonl: string | null;
}

async function readRequiredFile(runDir: string, name: string): Promise<string> {
  try {
    return await readFile(join(runDir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HostedUsageError(
        `pome eval: ${name} not found in ${runDir} — expected a pome run directory (runs/<scenario>/<run-id>).`,
      );
    }
    throw new HostedUsageError(
      `pome eval: ${name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseJsonFile(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HostedUsageError(
      `pome eval: ${name} is corrupt — not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

function validateJsonl(name: string, raw: string): void {
  const lines = raw.split("\n");
  let nonEmpty = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    nonEmpty += 1;
    try {
      JSON.parse(line);
    } catch {
      throw new HostedUsageError(
        `pome eval: ${name} is corrupt — line ${i + 1} is not valid JSON.`,
      );
    }
  }
  if (name === "events.jsonl" && nonEmpty === 0) {
    throw new HostedUsageError(
      "pome eval: events.jsonl is empty — the run captured no trace to evaluate.",
    );
  }
}

/** Read + validate a raw trace directory. Every missing/corrupt artifact
 *  fails with an error that names the offending file (FDRS-656). */
export async function readRunDirArtifacts(
  runDir: string,
): Promise<RunDirArtifacts> {
  const stats = await stat(runDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new HostedUsageError(
      `pome eval: run directory not found: ${runDir}`,
    );
  }

  const metaRaw = await readRequiredFile(runDir, "meta.json");
  const meta = parseRunMeta(parseJsonFile("meta.json", metaRaw));

  const eventsJsonl = await readRequiredFile(runDir, "events.jsonl");
  validateJsonl("events.jsonl", eventsJsonl);

  const stateInitialJson = await readRequiredFile(runDir, "state_initial.json");
  parseJsonFile("state_initial.json", stateInitialJson);
  const stateFinalJson = await readRequiredFile(runDir, "state_final.json");
  parseJsonFile("state_final.json", stateFinalJson);

  // signals.jsonl is optional (adapter-emitted); when present it must parse.
  let signalsJsonl: string | null = null;
  try {
    signalsJsonl = await readFile(join(runDir, "signals.jsonl"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new HostedUsageError(
        `pome eval: signals.jsonl could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (signalsJsonl !== null) validateJsonl("signals.jsonl", signalsJsonl);

  return { runDir, meta, eventsJsonl, stateInitialJson, stateFinalJson, signalsJsonl };
}

// ---------------------------------------------------------------------------
// agent + task derivation
// ---------------------------------------------------------------------------

export interface EvalIdentity {
  agent: string;
  taskName: string;
}

/** Precedence: explicit flags → meta.json (`scenario`, then `title`) for the
 *  task; explicit flag → pome.config.json (`agentSlug`, then `agentId`) for
 *  the agent. */
export function deriveEvalIdentity(
  meta: RunMeta,
  flags: { agent?: string; task?: string },
  config: ProjectConfig | null,
): EvalIdentity {
  const taskName = flags.task?.trim() || meta.scenario || meta.title;
  if (!taskName) {
    throw new HostedUsageError(
      "pome eval: could not derive a task name — meta.json has no `scenario` or `title` field. Pass --task <name>.",
    );
  }
  const agent = flags.agent?.trim() || configAgent(config);
  if (!agent) {
    throw new HostedUsageError(
      "pome eval: no agent identity found. Pass --agent <slug>, or run `pome register agent <name>` so pome.config.json carries agentSlug.",
    );
  }
  return { agent, taskName };
}

function configAgent(config: ProjectConfig | null): string | null {
  if (!config) return null;
  const slug = typeof config.agentSlug === "string" ? config.agentSlug.trim() : "";
  if (slug.length > 0) return slug;
  const id = typeof config.agentId === "string" ? config.agentId.trim() : "";
  if (id.length > 0) return id;
  return null;
}

// ---------------------------------------------------------------------------
// eval-session persistence (idempotent re-runs)
// ---------------------------------------------------------------------------

async function readStoredEvalSession(
  runDir: string,
  apiBaseUrl: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(runDir, EVAL_SESSION_FILE), "utf8");
    const parsed = JSON.parse(raw) as { session_id?: unknown; api_url?: unknown };
    if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
      return null;
    }
    // A session minted against a different control plane can't be finalized
    // here — treat as absent and mint a new one.
    if (typeof parsed.api_url === "string" && parsed.api_url !== apiBaseUrl) {
      return null;
    }
    return parsed.session_id;
  } catch {
    // Missing or corrupt marker → behave like a first run.
    return null;
  }
}

async function writeStoredEvalSession(
  runDir: string,
  sessionId: string,
  apiBaseUrl: string,
): Promise<void> {
  const payload = {
    session_id: sessionId,
    api_url: apiBaseUrl,
    created_at: new Date().toISOString(),
  };
  await writeFile(
    join(runDir, EVAL_SESSION_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined); // best-effort: read-only run dirs still evaluate
}

// ---------------------------------------------------------------------------
// core flow
// ---------------------------------------------------------------------------

/** The narrow client surface `runEval` needs; tests mock exactly this. */
export type EvalClient = UploadClient &
  Pick<HostedClient, "createEvalSession" | "finalize">;

export interface RunEvalOptions {
  runDir: string;
  agent?: string;
  task?: string;
  hosted: { baseUrl: string; apiKey: string };
  /** For tests: inject a client. Otherwise constructed from `hosted`. */
  client?: EvalClient;
  /** For tests: bypass pome.config.json discovery (pass null for "none"). */
  projectConfig?: ProjectConfig | null;
}

export interface RunEvalResult {
  taskName: string;
  agent: string;
  sessionId: string;
  /** True when a stored eval-session was reused — /finalize's idempotent
   *  fast-path returned the already-judged run. */
  reusedSession: boolean;
  cloudRunId: string;
  dashboardUrl: string;
  score: Score;
  exitCode: number;
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const runDir = options.runDir;
  const artifacts = await readRunDirArtifacts(runDir);

  const config =
    options.projectConfig !== undefined
      ? options.projectConfig
      : ((await readProjectConfig(runDir))?.config ?? null);

  const { agent, taskName } = deriveEvalIdentity(
    artifacts.meta,
    { agent: options.agent, task: options.task },
    config,
  );

  const client =
    options.client ??
    createHostedClient({
      baseUrl: options.hosted.baseUrl,
      apiKey: options.hosted.apiKey,
    });

  // Re-apply redaction before anything leaves the machine. events.jsonl and
  // the state blobs are written pre-redacted by artifacts.ts, but `pome eval`
  // also accepts hand-assembled dirs — redaction is idempotent, so this is
  // cheap insurance, and it mirrors what the hosted runner uploads.
  const blobs = {
    eventsJsonl: redactJsonl(artifacts.eventsJsonl),
    stateInitialJson: JSON.stringify(
      redactSecrets(JSON.parse(artifacts.stateInitialJson)),
    ),
    stateFinalJson: JSON.stringify(
      redactSecrets(JSON.parse(artifacts.stateFinalJson)),
    ),
    signalsJsonl: redactJsonl(artifacts.signalsJsonl ?? ""),
  };

  let reusedSession = false;
  let sessionId = await readStoredEvalSession(runDir, options.hosted.baseUrl);
  if (sessionId) {
    reusedSession = true;
  } else {
    const minted = await client.createEvalSession({ agent, taskName });
    sessionId = minted.session_id;
    await writeStoredEvalSession(runDir, sessionId, options.hosted.baseUrl);
  }

  async function uploadAndFinalize(sid: string): Promise<FinalizeResponse> {
    const keys = await uploadRunBlobs(client, sid, blobs);
    return client.finalize(sid, {
      stopReason: "eval_upload",
      exitCode: artifacts.meta.exitCode ?? 0,
      durationMs: durationMsFrom(artifacts.meta),
      agentModel: "unknown",
      agentSdk: config ? normalizeConfigAgentSdk(config) : null,
      // Eval sessions carry no client-side criteria — the cloud eval judge
      // owns them (FDRS-655). Cloud's finalize schema defaults all scenario
      // fields, so empty strings are accepted.
      criteria: [],
      scenarioName: taskName,
      scenarioHash: "",
      scenarioPrompt: "",
      expectedBehavior: "",
      traceStorageKey: keys.eventsKey ?? undefined,
      stateInitialStorageKey: keys.stateInitialKey ?? undefined,
      stateFinalStorageKey: keys.stateFinalKey ?? undefined,
      signalsStorageKey: keys.signalsKey ?? undefined,
    });
  }

  let finalized: FinalizeResponse;
  try {
    finalized = await uploadAndFinalize(sessionId);
  } catch (err) {
    // The stored session may have been reaped server-side (TTL) since the
    // last attempt. Mint a fresh session and retry ONCE — but only for
    // reused sessions and only for orch-shaped failures; auth/quota/usage
    // errors propagate untouched.
    if (!reusedSession || !(err instanceof HostedOrchError)) throw err;
    const minted = await client.createEvalSession({ agent, taskName });
    sessionId = minted.session_id;
    reusedSession = false;
    await writeStoredEvalSession(runDir, sessionId, options.hosted.baseUrl);
    finalized = await uploadAndFinalize(sessionId);
  }

  // Persist the cloud-authoritative score next to the trace, exactly like
  // hosted `pome run` does — `pome inspect` then renders the same verdict.
  const score = scoreFromFinalizeResponse(finalized);
  await writeScoreJson(runDir, score);

  return {
    taskName,
    agent,
    sessionId,
    reusedSession,
    cloudRunId: finalized.run_id,
    dashboardUrl: finalized.dashboard_url,
    score,
    exitCode: finalized.score >= EVAL_PASS_THRESHOLD ? 0 : 1,
  };
}

function durationMsFrom(meta: RunMeta): number {
  const started = meta.startedAt ? Date.parse(meta.startedAt) : Number.NaN;
  const completed = meta.completedAt ? Date.parse(meta.completedAt) : Number.NaN;
  const duration = completed - started;
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
}

// ---------------------------------------------------------------------------
// CLI wrapper (printing + exit codes)
// ---------------------------------------------------------------------------

// FDRS-591/611 per-criterion marker, same glyphs as `pome run`/`pome inspect`.
function markerFor(outcome: "passed" | "failed" | "skipped" | "errored"): string {
  switch (outcome) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "errored":
      return "!";
    default:
      return "-";
  }
}

function countsSummary(score: Score): string {
  return `${score.passed ?? 0} passed, ${score.failed ?? 0} failed, ${score.skipped ?? 0} skipped, ${score.errored ?? 0} errored`;
}

export interface EvalCommandOptions {
  artifactsDir: string;
  agent?: string;
  task?: string;
  apiUrl: string;
}

export async function runEvalCommand(
  runDirArg: string | undefined,
  opts: EvalCommandOptions,
): Promise<void> {
  try {
    let runDir: string;
    if (runDirArg) {
      runDir = resolve(runDirArg);
    } else {
      const latest = await readLatestRun(opts.artifactsDir);
      if (!latest) {
        throw new HostedUsageError(
          `pome eval: no run directory given and ${join(opts.artifactsDir, "latest.json")} not found. Pass a run directory (runs/<scenario>/<run-id>).`,
        );
      }
      runDir = resolve(latest.run_dir);
    }

    // Mirror `pome run`: bad-input paths surface as usage errors (exit 5)
    // BEFORE credential resolution, so a bad path never masquerades as an
    // auth problem.
    const stats = await stat(runDir).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new HostedUsageError(
        `pome eval: run directory not found: ${runDir}`,
      );
    }

    const creds = await resolveCredentials({ apiBaseUrl: opts.apiUrl });
    const result = await runEval({
      runDir,
      agent: opts.agent,
      task: opts.task,
      hosted: { baseUrl: creds.apiBaseUrl, apiKey: creds.apiKey },
    });

    // Same verdict shape as hosted `pome run`: LABEL, score line, cloud URL.
    const status = scoreStatus(result.score, EVAL_PASS_THRESHOLD);
    const label =
      status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "UNEVAL";
    console.error(`${label} ${result.taskName}`);
    if (status === "unevaluated") {
      console.error(
        `  score: un-evaluated (cannot pass) — ${countsSummary(result.score)}; cloud score: ${result.score.satisfaction}/100`,
      );
    } else {
      console.error(`  score: ${result.score.satisfaction}/100`);
    }
    if (result.score.results.length > 0) {
      console.error(`  criteria: ${countsSummary(result.score)}`);
      for (const criterionResult of result.score.results) {
        console.error(
          `  ${markerFor(outcomeOf(criterionResult))} [${criterionResult.criterion.type}] ${criterionResult.criterion.text}`,
        );
      }
    }
    if (result.reusedSession) {
      console.error(
        "  note: this run dir was already evaluated — showing the cloud's stored result (idempotent finalize).",
      );
    }
    console.error(`  cloud: ${result.dashboardUrl}`);
    process.exitCode = result.exitCode;
  } catch (err) {
    const code = exitCodeFor(err);
    console.error(err instanceof Error ? err.message : String(err));
    if (code === 3) {
      console.error(
        "Tip: `pome login` first — `pome eval` uploads the trace to Pome cloud for evaluation (ADR-013; there is no local scoring).",
      );
    }
    process.exitCode = code;
  }
}
