// SPDX-License-Identifier: Apache-2.0
//
// Per-route helpers: response shaping, error → Stripe envelope conversion,
// recorder emission, and the declaration-driven route wrapper.
//
// Owned by AGENT-B. AGENT-A's app.ts can import and use these directly.

import type { Context } from "hono";
import { z } from "zod";
import {
  FAILURE_INJECTION_OVERRIDE_KEY,
  recordedRequestHeaders,
  type FailureInjectionOverride,
} from "@pome-sh/sdk/server";
import {
  UndeclaredInputError,
  mountDeclaredRoute,
  type DeclarableRouter,
  type DeclaredRouteInputs,
  type RouteInputDeclaration,
  type RouteInputSpec,
} from "@pome-sh/sdk/route-inputs";
import { TwinError, stripeError } from "../errors.js";
import { setHandlerResult } from "../idempotency.js";
import type {
  Recorder,
  ResolvedSession,
  StateDelta,
  StripeFidelity,
} from "../types.js";
import { requestId } from "../util.js";

/**
 * Pull the account_id off the resolved session set by `bearerAuth()`.
 * Throws if missing — that means a route handler ran without auth, which
 * is a bug.
 */
export function accountId(c: Context): string {
  const session = c.get("session") as ResolvedSession | undefined;
  if (!session) {
    throw new TwinError(
      "api_error",
      "internal_error",
      "Missing session context (auth middleware did not run).",
      { statusCode: 500 }
    );
  }
  return session.account_id;
}

export type RouteResult = {
  status: number;
  body: unknown;
  mutation: boolean;
  /**
   * Optional row-level before/after for state-inspector rendering. When the
   * route doesn't supply one (the default), respond() emits `state_delta:
   * null` regardless of `state_mutation`. Per the canonical schema.
   */
  stateDelta?: StateDelta;
};

export function ok(
  body: unknown,
  mutation = false,
  stateDelta?: StateDelta
): RouteResult {
  return { status: 200, body, mutation, stateDelta };
}

export function created(body: unknown, stateDelta?: StateDelta): RouteResult {
  return { status: 200, body, mutation: true, stateDelta };
  // Stripe returns 200 on POST /v1/payment_intents (not 201). Match it.
}

/**
 * Wrap a route handler. Catches TwinError + Zod errors, emits to the
 * recorder, returns the JSON response. Mirrors twin-github's `handle()`.
 */
export async function handle(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  fn: () => Promise<RouteResult> | RouteResult
) {
  const started = Date.now();
  let requestBody: unknown = null;
  try {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      // Drain the body once for the recorder. Cheap clone since we don't
      // care about parse errors here.
      try {
        requestBody = await c.req.raw.clone().text();
      } catch {
        requestBody = null;
      }
    }
    const result = await fn();
    return respond(
      c,
      recorder,
      runId,
      started,
      requestBody,
      result.status,
      result.body,
      result.mutation,
      "semantic",
      result.stateDelta ?? null
    );
  } catch (error) {
    if (error instanceof TwinError) {
      // Almost every TwinError is thrown before any write. The card
      // decline is the exception: it commits a failed charge +
      // events + PI transition and then throws the 402, carrying the
      // committed delta so the recorder logs the mutation truthfully.
      return respond(
        c,
        recorder,
        runId,
        started,
        requestBody,
        error.status,
        error.toEnvelope(),
        error.state_mutation ?? false,
        error.fidelity ?? "semantic",
        error.state_delta ?? null
      );
    }
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      const envelope = stripeError(
        "invalid_request_error",
        "parameter_invalid",
        first?.message ?? "Invalid request parameters.",
        { param: first?.path?.join(".") }
      );
      return respond(
        c,
        recorder,
        runId,
        started,
        requestBody,
        envelope.status,
        envelope.body,
        false,
        "semantic",
        null
      );
    }
    if (error instanceof SyntaxError) {
      const envelope = stripeError(
        "invalid_request_error",
        "invalid_json",
        "Could not parse request body as JSON."
      );
      return respond(
        c,
        recorder,
        runId,
        started,
        requestBody,
        envelope.status,
        envelope.body,
        false,
        "semantic",
        null
      );
    }
    const envelope = stripeError(
      "api_error",
      "internal_error",
      error instanceof Error ? error.message : "Internal Server Error",
      { statusCode: 500 }
    );
    return respond(
      c,
      recorder,
      runId,
      started,
      requestBody,
      envelope.status,
      envelope.body,
      false,
      "semantic",
      null
    );
  }
}

export function respond(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  started: number,
  requestBody: unknown,
  status: number,
  responseBody: unknown,
  stateMutation: boolean,
  fidelity: StripeFidelity = "semantic",
  stateDelta: StateDelta = null
) {
  const reqId = requestId();
  // The handler's own answer, before any transport-level substitution below.
  // The idempotency middleware wraps this handler and reads it on the way out;
  // `setHandlerResult`'s doc carries what goes wrong without it.
  setHandlerResult(c, { status, body: responseBody });
  // If the failure-injection middleware matched in `after_handler`
  // mode, it parked an override on the context. The handler has already
  // mutated state (so state_mutation + state_delta stay truthful), but the
  // status + response_body on both the recorded event and the wire response
  // are replaced with the configured envelope.
  const override = (c.get(FAILURE_INJECTION_OVERRIDE_KEY as never) as
    | FailureInjectionOverride
    | undefined) ?? null;
  const finalStatus = override ? override.status : status;
  const finalBody = override ? override.body : responseBody;
  // stamping, engine parity: correlation_id
  // persists the adapter's x-pome-correlation-id (falling back to the
  // request id), and x-pome-scenario-step-id lands as the canonical
  // task_step_id plus the legacy scenario_step_id key.
  const stepId = c.req.header("x-pome-scenario-step-id") ?? null;
  recorder?.record({
    ts: new Date().toISOString(),
    run_id: runId,
    twin: "stripe",
    request_id: reqId,
    correlation_id: c.req.header("x-pome-correlation-id") ?? reqId,
    task_step_id: stepId,
    scenario_step_id: stepId,
    step_id: null,
    tool_call_id: null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: requestBody,
    // One shared implementation with the engine's own emit(), so
    // "which headers get recorded" has a single answer across every site.
    request_headers: recordedRequestHeaders(c),
    // Stripe's REST routes are not declared as twin actions: no criterion asks
    // whether a stripe TOOL was called, and stamping a name here that no check
    // can bind would be an unverifiable claim. MCP dispatch still stamps its
    // own name through the engine.
    tool: null,
    status: finalStatus,
    response_body: finalBody,
    latency_ms: Date.now() - started,
    fidelity,
    state_mutation: stateMutation,
    state_delta: stateDelta,
    error: finalStatus >= 400 ? errorMessage(finalBody) : null,
  });
  return c.json(finalBody as never, finalStatus as never);
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "request failed";
}

/**
 * Mount a route at the method and path its own declaration carries, and hand
 * the handler `declaration.parse()`'s output as its only view of the request.
 *
 * `c` still reaches the handler because identity is not a route input:
 * `accountId(c)` reads the session the auth middleware resolved. Every REQUEST
 * value comes from the first argument.
 */
export function declaredRoute<S extends RouteInputSpec>(
  router: DeclarableRouter,
  declaration: RouteInputDeclaration<S>,
  recorder: Recorder | undefined,
  runId: string,
  fn: (input: DeclaredRouteInputs<S>, c: Context) => RouteResult | Promise<RouteResult>
): void {
  mountDeclaredRoute(router, declaration, (c: Context) =>
    handle(c, recorder, runId, async () => fn(await parseDeclared(declaration, c), c))
  );
}

/** Project the declaration's refusals into Stripe's own envelope. Real Stripe
 *  answers an unknown parameter with `parameter_unknown`, which is what an
 *  undeclared input IS — so that is the code, rather than reusing
 *  `parameter_invalid` for a different failure. */
async function parseDeclared<S extends RouteInputSpec>(
  declaration: RouteInputDeclaration<S>,
  c: Context
) {
  try {
    return await declaration.parse(c.req);
  } catch (error) {
    if (error instanceof UndeclaredInputError) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_unknown",
        `Received unknown parameter: ${error.first}`,
        { param: error.first, statusCode: 400 }
      );
    }
    throw error;
  }
}

/** The declared list query, as the domain's list inputs take it. */
export type DeclaredListQuery = {
  readonly limit?: number | undefined;
  readonly starting_after?: string | undefined;
  readonly ending_before?: string | undefined;
  readonly created?: string | Record<string, string> | undefined;
};

/**
 * Flatten the declared list query into the shape every `list*` domain input
 * already takes — `limit` / cursors verbatim, plus `created_gt`/`created_gte`/
 * `created_lt`/`created_lte`.
 *
 * The flattening lives here rather than in the declaration because `created` is
 * ONE parameter on the wire (and one in Stripe's OpenAPI); the four keys are an
 * internal calling convention, and declaring them would report drift that is
 * not real.
 */
export function listQuery(query: DeclaredListQuery): Record<string, unknown> {
  return {
    limit: query.limit,
    starting_after: query.starting_after,
    ending_before: query.ending_before,
    ...flattenCreated(query.created),
  };
}

function flattenCreated(created: DeclaredListQuery["created"]): Record<string, number> {
  const out: Record<string, number> = {};
  if (created === undefined) return out;
  // `created=1700000000` means "that exact second", the same closed range real
  // Stripe reads it as. `value` is what the declaration calls a flat `created=`
  // that arrived alongside sub-keys.
  const flat = typeof created === "string" ? created : created.value;
  if (flat !== undefined && /^\d+$/.test(flat)) {
    out.created_gte = Number(flat);
    out.created_lte = Number(flat);
  }
  if (typeof created === "string") return out;
  for (const op of ["gt", "gte", "lt", "lte"] as const) {
    const value = created[op];
    // A non-numeric bound is ignored rather than refused, which is what this
    // twin has always done with `created[gte]=yesterday`.
    if (value !== undefined && /^\d+$/.test(value)) out[`created_${op}`] = Number(value);
  }
  return out;
}
