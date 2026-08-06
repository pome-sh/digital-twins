// SPDX-License-Identifier: Apache-2.0
//
// Scenario-level failure injection (FDRS-339), graduated from twin-stripe
// into the engine by the F-684 port ruling: making a twin fail on attempt N
// of a (method, path) tuple is a generic twin capability — any provider
// double needs "the server processed it but the client never saw the
// response" to reproduce lost-response retry bugs. Only the rule *payloads*
// (status + error envelope) are twin-domain; they ride in via the seed.
//
// Two modes:
//
//   - `before_handler` → the matched request never reaches the route
//     handler; the middleware returns the configured envelope directly and
//     records a `state_mutation: false`, `state_delta: null` event.
//   - `after_handler` → the handler is invoked normally (state mutation
//     and `state_delta` capture proceed). The middleware parks the override
//     on the context under `FAILURE_INJECTION_OVERRIDE_KEY`; the twin's
//     response path substitutes status + body on the way out, so the
//     recorded event and the wire agree. This models a "server processed
//     but response delivery failed" failure — required to reproduce the
//     FDRS-316 hero scenario.
//
// Counters live per `(account_id, method, path)` so successive POSTs from
// the same account to the same path resolve to `attempt: 1`, `attempt: 2`,
// …, deterministically. Other routes don't influence the counter — only
// requests to a tuple that has at least one registered rule are counted.

//
// The rule shape, schema, mode enum and store now live in
// `./failure-injection-rules.js` (no `hono`, so the declaration surface a twin's
// seed pulls in stays resolvable for a consumer with no hono installed). They are
// re-exported here so `@pome-sh/sdk/server` is unchanged.
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { RecorderEvent } from "@pome-sh/wire";
import { recordedRequestHeaders } from "./request-capture.js";
import {
  FAILURE_INJECTION_OVERRIDE_KEY,
  type FailureInjectionOverride,
  type FailureInjectionRule,
  type FailureInjectionStore,
} from "./failure-injection-rules.js";

export * from "./failure-injection-rules.js";

export interface FailureInjectionMiddlewareOptions {
  /** Sink for before_handler events. Optional — a recorderless app still injects. */
  recorder?: { record(event: RecorderEvent): void };
  runId: string;
  twin: string;
}

export function failureInjectionMiddleware(
  store: FailureInjectionStore,
  options: FailureInjectionMiddlewareOptions
): MiddlewareHandler {
  return async (c, next) => {
    const session = c.get("session") as { account_id?: unknown; sid?: unknown } | undefined;
    // Auth runs first; if it failed there's no session and we shouldn't
    // shadow that with a manufactured failure.
    if (!session) {
      await next();
      return;
    }
    const accountId =
      typeof session.account_id === "string" ? session.account_id : String(session.sid ?? "_anon");

    const method = c.req.method.toUpperCase();
    const rawPath = new URL(c.req.url).pathname;
    // Rules are written against the canonical provider path
    // (e.g., "/v1/refunds"). Strip the session prefix when present so
    // path-mounted (`/s/:sid/v1/refunds`) and root-mounted (`/v1/refunds`,
    // stripe F3 SDK compat) requests both match.
    const path = stripSessionPrefix(rawPath);

    const rule = store.matchAndConsume(accountId, method, path);
    if (!rule) {
      await next();
      return;
    }

    if (rule.mode === "before_handler") {
      const started = Date.now();
      let requestBody: unknown = null;
      try {
        requestBody = await c.req.raw.clone().text();
      } catch {
        requestBody = null;
      }
      const requestId = `req_${randomUUID()}`;
      const stepId = c.req.header("x-pome-scenario-step-id") ?? null;
      options.recorder?.record({
        ts: new Date().toISOString(),
        run_id: options.runId,
        twin: options.twin,
        request_id: requestId,
        correlation_id: c.req.header("x-pome-correlation-id") ?? requestId,
        task_step_id: stepId,
        scenario_step_id: stepId,
        step_id: null,
        tool_call_id: null,
        method,
        path: rawPath,
        request_body: requestBody,
        // F-1125 — same capture policy as the engine's emit(); an injected
        // fault must not be the one row a header-reading check cannot see.
        request_headers: recordedRequestHeaders(c),
        // Injection is transport-level: it intercepts a (method, path) tuple,
        // never a declared twin action.
        tool: null,
        status: rule.status,
        response_body: rule.body,
        latency_ms: Date.now() - started,
        fidelity: "semantic",
        state_mutation: false,
        state_delta: null,
        error: rule.status >= 400 ? errorMessage(rule.body) : null,
      });
      return c.json(rule.body as never, rule.status as never);
    }

    // after_handler: let the handler run, but stash the override so the
    // twin's response path can substitute status + body on the way out.
    // state_mutation + state_delta keep the real-handler truth.
    const override: FailureInjectionOverride = { status: rule.status, body: rule.body };
    c.set(FAILURE_INJECTION_OVERRIDE_KEY as never, override as never);
    await next();
  };
}

function stripSessionPrefix(path: string): string {
  const match = path.match(/^\/s\/[^/]+(\/.*)$/);
  return match?.[1] ?? path;
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "request failed";
}
