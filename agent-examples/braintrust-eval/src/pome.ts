// SPDX-License-Identifier: Apache-2.0
//
// The Pome half: mint a sandbox with this row's world, hand the agent a URL and
// a token, then finalize and read the verdicts back. Plain `fetch` against
// `api.pome.sh/v1` and nothing else — no `@pome-sh/*` dependency, on purpose.
// A reader porting this to their own harness needs to see the HTTP contract, and
// an example with no SDK is the shortest way to show it.
//
// ── Two tokens, and they are not interchangeable ────────────────────────────
//
//   POME_API_KEY (`pme_…`)  is the TEAM key. It reaches `api.pome.sh/v1` and
//                           nothing else. Keep it out of the agent's reach.
//   `agent_token`           comes back from the mint. It reaches the twins on
//                           `twins.pome.sh` and expires with the sandbox. This
//                           is what the agent gets.
//
// The `provider_credentials.stripe.api_key` in the mint response is a third
// thing again: it is the key the twin expects to SEE inside the sandbox, the
// shape a real Stripe SDK would send. It does not authenticate you to
// `twins.pome.sh`, and a call bearing it comes back `404 No twin pod for this
// session` — the proxy resolves the sandbox from the bearer, and only the
// `agent_token` says which sandbox this is. Measured against prod 2026-08-27.

import { classificationColumns, readVerdicts, scoreColumns } from "./scoring.js";
import type { ClassificationColumn, PomeVerdict, ScoreColumn } from "./scoring.js";
import type { RefundWorld, StripeSeed } from "./dataset.js";

export const DEFAULT_API_URL = "https://api.pome.sh";

export type Env = Record<string, string | undefined>;

export interface ControlPlaneRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Assemble one control-plane call.
 *
 * `env` is a PARAMETER rather than a read of `process.env`, and that is the
 * whole reason this function exists separately from the fetch that uses it: it
 * makes "the credential is resolved at call time" a structural property instead
 * of a convention. `scripts/smoke-examples.mjs` launches this example for real
 * on every PR with no key in the environment, and an example that resolved a
 * credential during module evaluation would crash on load and red CI.
 *
 * A MISSING key is not an error here either. It sends the request without an
 * Authorization header and lets the control plane answer `401 invalid_auth`,
 * which `controlPlane()` turns into one actionable line. Throwing early would
 * mean the example could exit before making any outbound call at all — which is
 * indistinguishable, to the smoke classifier, from an example that is broken.
 */
export function controlPlaneRequest(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): ControlPlaneRequest {
  const base = (env.POME_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  const apiKey = env.POME_API_KEY?.trim();
  return {
    url: `${base}${path}`,
    method,
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/**
 * Read the seeded charge back and refuse to run the agent against a world that
 * is not the one we asked for.
 *
 * This exists because the Stripe twin's seed schema is a plain `z.object` and
 * not `.strict()`: an unrecognised top-level key is dropped without a word, and
 * `POST /v1/seeds/validate` answers `valid: true` for a seed that will boot an
 * empty world. (gmail and linear refuse an unknown key; github, slack and stripe
 * do not.) The failure that produces is the worst kind — every criterion
 * `skipped` because its charge resolves nowhere, which is neither a pass nor a
 * fail, and a Braintrust row of blank cells reads like a quiet afternoon.
 *
 * So the seed is checked twice, at two different layers, and both are cheap:
 * `POST /v1/seeds/validate` before minting says whether the twin's own parser
 * accepts the SHAPE, and this says whether the world actually ARRIVED.
 */
export function assertWorldSeeded(world: RefundWorld, charge: unknown): void {
  const refuse = (detail: string): never => {
    throw new Error(
      `the seeded world did not land in this sandbox: ${detail}. The Stripe twin's seed schema ` +
        `is not strict, so a mistyped key is dropped silently and the sandbox boots empty — ` +
        `check the seed's top-level keys against the twin's own seed shape.`,
    );
  };

  if (charge === null || typeof charge !== "object") {
    return void refuse(`charge "${world.chargeId}" is not there at all`);
  }
  const row = charge as Record<string, unknown>;
  if (row.id !== world.chargeId) {
    return void refuse(`expected charge "${world.chargeId}", found ${JSON.stringify(row.id)}`);
  }
  if (row.amount !== world.chargeMinorUnits) {
    return void refuse(
      `charge "${world.chargeId}" has amount ${JSON.stringify(row.amount)}, seeded ` +
        `${world.chargeMinorUnits}`,
    );
  }
  if (row.amount_refunded !== 0) {
    return void refuse(
      `charge "${world.chargeId}" starts with amount_refunded ${JSON.stringify(row.amount_refunded)} ` +
        `— the refundable headroom this row depends on is already gone`,
    );
  }
  if (row.status !== "succeeded") {
    return void refuse(
      `charge "${world.chargeId}" has status ${JSON.stringify(row.status)}, and the twin refuses ` +
        `to refund a charge that is not "succeeded"`,
    );
  }
}

// ── The outbound marker ─────────────────────────────────────────────────────
//
// `scripts/smoke-examples.mjs` launches every example for real on every PR, with
// no credentials and every base URL pointed at a dead loopback port, and asks
// one question: did this process reach an outbound call, or did it die during
// wiring? It cannot tell those apart from an exit code, so an example says so
// itself, once, immediately before its first outbound call.
//
// This example's first outbound call is `POST /v1/seeds/validate`, which is why
// the marker lives here and not next to the model call.

let markerEmitted = false;

function markOutbound(env: Env): void {
  if (markerEmitted || env.POME_SMOKE_MARK_OUTBOUND !== "1") return;
  markerEmitted = true;
  // The literal, not a constant: `assertEveryExampleEmitsMarker` in
  // `scripts/smoke-examples.mjs` greps each example's `src/*.ts` for exactly
  // this call, and a name it would have to resolve is a name it cannot.
  console.error("POME_SMOKE_REACHED_OUTBOUND");
}

export interface ControlPlaneResponse {
  status: number;
  body: unknown;
  text: string;
}

/** One control-plane call, with the two failures worth naming turned into
 *  sentences a reader can act on. */
export async function controlPlane(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<ControlPlaneResponse> {
  const req = controlPlaneRequest(env, method, path, body);
  markOutbound(env);
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;

  if (res.status === 401) {
    throw new Error(
      `${method} ${path} → 401. Set POME_API_KEY to a team key (\`pme_…\`), from the Pome ` +
        `dashboard or \`pome login\`. The sandbox's own \`agent_token\` does NOT work here — ` +
        `it authenticates the agent to the twins, not you to the control plane.`,
    );
  }
  if (res.status === 402) {
    throw new Error(
      `${method} ${path} → 402 quota_exceeded: too many sandboxes open at once. This example ` +
        `mints one per dataset row, so lower POME_EVAL_CONCURRENCY (or stop the open ones). ` +
        `${detailOf(parsed)}`,
    );
  }
  return { status: res.status, body: parsed, text };
}

function detailOf(body: unknown): string {
  const message = (body as { error?: { message?: unknown } })?.error?.message;
  return typeof message === "string" ? message : "";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expect2xx(res: ControlPlaneResponse, what: string): unknown {
  if (res.status >= 200 && res.status < 300) return res.body;
  throw new Error(`${what} → ${res.status}: ${res.text.slice(0, 600)}`);
}

// ── The Pome half, end to end ───────────────────────────────────────────────

export interface Sandbox {
  sessionId: string;
  /** REST base for this sandbox's Stripe twin, on `twins.pome.sh`. */
  apiUrl: string;
  /** The bearer the AGENT uses against `apiUrl`. Expires with the sandbox. */
  agentToken: string;
  expiresAt: string;
}

export interface PomeCriterionDef {
  id: string;
  kind: "code" | "model";
  text: string;
}

export interface PomeRunEvidence {
  sessionId: string;
  runId: string;
  /** Pome's own 0–100 for the run. */
  score: number;
  dashboardUrl: string;
  verdicts: PomeVerdict[];
  scores: ScoreColumn[];
  classifications: ClassificationColumn[];
}

/**
 * Would this world boot? Free, and nothing is provisioned — the twin's OWN
 * boot-time parser runs, so it cannot accept a seed the pod would reject.
 *
 * Worth calling before a fan-out: a shape error caught here is one 422 in well
 * under a second, instead of N sandboxes that each spend quota and then boot the
 * wrong world. It is NOT sufficient on its own — see `assertWorldSeeded` above.
 */
export async function validateSeed(env: Env, twins: string[], seed: unknown): Promise<void> {
  const res = await controlPlane(env, "POST", "/v1/seeds/validate", { twins, seed });
  expect2xx(res, "POST /v1/seeds/validate");
}

/** Start one sandbox on one world. */
export async function mintSandbox(input: {
  env: Env;
  twins: string[];
  /** The task markdown. `POST /v1/sandboxes` requires one even when a seed is
   *  supplied; sending the real task rather than a `# ..` placeholder is what
   *  makes the run readable in the dashboard afterwards. */
  taskMarkdown: string;
  seed: unknown;
  /** Tags every sandbox in this eval as trials of one thing, so
   *  `GET /v1/runs?group_id=…` reads them back together. */
  groupId?: string;
}): Promise<Sandbox> {
  const body = expect2xx(
    await controlPlane(input.env, "POST", "/v1/sandboxes", {
      twins: input.twins,
      task_source: Buffer.from(input.taskMarkdown, "utf8").toString("base64"),
      seed: input.seed,
      ...(input.groupId ? { group_id: input.groupId } : {}),
    }),
    "POST /v1/sandboxes",
  ) as {
    session_id: string;
    expires_at: string;
    agent_token: string;
    per_twin?: Record<string, { api_url: string }>;
    twin_url?: string;
  };

  const twin = input.twins[0]!;
  const apiUrl = body.per_twin?.[twin]?.api_url ?? body.twin_url;
  if (!apiUrl) {
    throw new Error(`POST /v1/sandboxes returned no api_url for the "${twin}" twin`);
  }
  return {
    sessionId: body.session_id,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    agentToken: body.agent_token,
    expiresAt: body.expires_at,
  };
}

/** Read one charge off a live sandbox, with the AGENT's token. */
export async function readCharge(sandbox: Sandbox, chargeId: string): Promise<unknown> {
  const res = await fetch(`${sandbox.apiUrl}/v1/charges/${encodeURIComponent(chargeId)}`, {
    headers: { authorization: `Bearer ${sandbox.agentToken}` },
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /v1/charges/${chargeId} → ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/**
 * Grade the run and close the sandbox.
 *
 * `source: "twin-pull"` is what makes this reachable over plain HTTP: the
 * control plane reads the tape and the final state off the LIVE twin itself, so
 * there is nothing for the caller to capture, gzip or upload. The sandbox must
 * still be live — the tape is in-sandbox and does not survive teardown — and the
 * agent must actually have called the twin: an empty tape comes back
 * `409 capture_incomplete` rather than a score of zero, which is the right way
 * round. Measured against prod 2026-08-27.
 */
export async function finalizeRun(input: {
  env: Env;
  sandbox: Sandbox;
  criteria: PomeCriterionDef[];
  taskName: string;
  prompt: string;
  expectedBehavior: string;
  agentModel: string;
  agentSdk: string;
  durationMs: number;
}): Promise<PomeRunEvidence> {
  const body = expect2xx(
    await controlPlane(input.env, "POST", `/v1/sandboxes/${input.sandbox.sessionId}/finalize`, {
      source: "twin-pull",
      stop_reason: "completed",
      exit_code: 0,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      agent_model: input.agentModel,
      agent_sdk: input.agentSdk,
      scenario_name: input.taskName,
      scenario_prompt: input.prompt,
      expected_behavior: input.expectedBehavior,
      criteria: input.criteria.map((c) => ({ id: c.id, kind: c.kind, text: c.text })),
    }),
    `POST /v1/sandboxes/${input.sandbox.sessionId}/finalize`,
  ) as { run_id: string; score: number; dashboard_url: string };

  const verdicts = readVerdicts(body);
  return {
    sessionId: input.sandbox.sessionId,
    runId: body.run_id,
    score: body.score,
    dashboardUrl: body.dashboard_url,
    verdicts,
    scores: scoreColumns(verdicts),
    classifications: classificationColumns(verdicts),
  };
}

/**
 * Stop a sandbox we are not going to grade.
 *
 * Only reached when the agent threw, so finalize never ran. The control plane
 * refuses to delete a sandbox whose run was never graded (`409`,
 * `details.reason === "ungraded_session"`) and hands back a one-time
 * `discard_token` to confirm with — there is nothing worth grading here, so we
 * confirm. Best-effort: a sandbox we fail to stop expires on its own within 30
 * minutes, and losing the row's real error behind a teardown error would be the
 * worse trade.
 */
export async function stopSandbox(env: Env, sessionId: string): Promise<void> {
  const path = `/v1/sandboxes/${encodeURIComponent(sessionId)}`;
  let res = await controlPlane(env, "DELETE", path).catch(() => null);
  if (res?.status === 409) {
    const details = (res.body as { error?: { details?: { reason?: string; discard_token?: string } } })
      ?.error?.details;
    if (details?.reason === "ungraded_session" && details.discard_token) {
      res = await controlPlane(
        env,
        "DELETE",
        `${path}?confirm_discard=${encodeURIComponent(details.discard_token)}`,
      ).catch(() => null);
    }
  }
  if (res && res.status >= 400 && res.status !== 404 && res.status !== 409) {
    console.warn(`could not stop sandbox ${sessionId} (${res.status}); it expires on its own.`);
  }
}

/**
 * Mint → assert → drive → finalize, for one row.
 *
 * This is the whole Pome half of the recipe, and it is deliberately the only
 * thing in this file that knows the order. `drive` is the seam: everything above
 * it is the same whichever eval framework or agent framework you brought, so a
 * sibling example that runs the same worlds under a different harness copies
 * this file unchanged and writes its own caller.
 *
 * (Copied rather than shared, and on purpose: `agent-examples/*` sit outside the
 * repo's npm workspace and each installs on its own, so a cross-package import
 * would not resolve. The repo's convention here is duplication.)
 */
export async function withPomeSandbox(input: {
  env: Env;
  twins: string[];
  taskMarkdown: string;
  seed: unknown;
  groupId?: string;
  criteria: PomeCriterionDef[];
  taskName: string;
  prompt: string;
  expectedBehavior: string;
  /** Run once against the freshly-minted sandbox, before the agent. Throw to
   *  abort the row — see `assertWorldSeeded`. */
  assertWorld?: (sandbox: Sandbox) => Promise<void>;
  drive: (sandbox: Sandbox) => Promise<{ summary: string; agentModel: string; agentSdk: string }>;
}): Promise<{ summary: string; pome: PomeRunEvidence }> {
  const sandbox = await mintSandbox(input);
  try {
    await input.assertWorld?.(sandbox);
    const startedAt = Date.now();
    const driven = await input.drive(sandbox);
    const durationMs = Date.now() - startedAt;
    // Finalize while the sandbox is STILL LIVE. The twin's tape is in-sandbox
    // and does not survive teardown, so a run finalized after the 30-minute TTL
    // has nothing left to grade.
    const pome = await finalizeRun({
      env: input.env,
      sandbox,
      criteria: input.criteria,
      taskName: input.taskName,
      prompt: input.prompt,
      expectedBehavior: input.expectedBehavior,
      agentModel: driven.agentModel,
      agentSdk: driven.agentSdk,
      durationMs,
    });
    return { summary: driven.summary, pome };
  } catch (err) {
    // finalize never ran, so the sandbox is still holding quota. Stop it, then
    // re-raise the row's own error — never the teardown's.
    await stopSandbox(input.env, sandbox.sessionId);
    throw err;
  }
}
