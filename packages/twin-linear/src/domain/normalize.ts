// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { LinearTwinError, badUserInput } from "../errors.js";
import { byteLength } from "../ids.js";
import {
  BODY_MAX_BYTES,
  TITLE_MAX_BYTES,
  type LinearAgentActivityContent,
  type LinearAgentActivitySignal,
  type LinearAgentActivityType,
  type LinearAgentSessionStatus,
  type LinearIssuePriority,
  type LinearWorkflowStateType,
} from "../types.js";

export function assertTitle(title: string): void {
  if (byteLength(title) > TITLE_MAX_BYTES) badUserInput(`Issue title exceeds ${TITLE_MAX_BYTES} bytes`);
}

export function assertBody(body: string): void {
  if (byteLength(body) > BODY_MAX_BYTES) badUserInput(`Body exceeds ${BODY_MAX_BYTES} bytes`);
}

export function normalizePriority(value: number | null | undefined): LinearIssuePriority {
  const n = typeof value === "number" ? Math.trunc(value) : 0;
  if (n < 0 || n > 4) badUserInput("priority must be 0..4");
  return n as LinearIssuePriority;
}

export function normalizeScopes(value: string[] | string | undefined, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...fallback];
}

export function inferStateType(name: string): LinearWorkflowStateType {
  const lower = name.toLowerCase();
  if (lower.includes("backlog")) return "backlog";
  if (lower.includes("progress") || lower.includes("started")) return "started";
  if (lower.includes("done") || lower.includes("complete")) return "completed";
  if (lower.includes("cancel")) return "canceled";
  return "unstarted";
}

/** Linear's AgentSessionStatus members, verbatim. */
export const AGENT_SESSION_STATUSES: LinearAgentSessionStatus[] = [
  "pending",
  "active",
  "awaitingInput",
  "complete",
  "error",
  "stale",
];

/**
 * A status read back OUT of storage. An unknown value here is a corrupt or
 * unmigrated database, not bad caller input — and left unchecked it dies at
 * GraphQL enum serialisation (`Enum "AgentSessionStatus" cannot represent
 * value: "canceled"`), which names neither the row nor the cause. Fail at the
 * boundary where the message can.
 */
export function readSessionStatus(value: string): LinearAgentSessionStatus {
  if (!AGENT_SESSION_STATUSES.includes(value as LinearAgentSessionStatus)) {
    throw new LinearTwinError(
      500,
      "INTERNAL_SERVER_ERROR",
      `Stored agent session status "${value}" is not one of Linear's AgentSessionStatus members ` +
        `(${AGENT_SESSION_STATUSES.join(", ")}). This database predates the rename and was not migrated.`
    );
  }
  return value as LinearAgentSessionStatus;
}

/**
 * An activity's author, read back OUT of storage. Linear declares
 * `AgentActivity.user: User!`, and `agent_activities.user_id` is nullable only
 * because its foreign key is `ON DELETE SET NULL` — nothing in the twin writes
 * a null. Same reasoning as `readSessionStatus`: fail here, naming the row,
 * rather than at GraphQL non-null serialisation, which names neither.
 */
export function readActivityUserId(activityId: string, value: string | null): string {
  if (!value) {
    throw new LinearTwinError(
      500,
      "INTERNAL_SERVER_ERROR",
      `Agent activity "${activityId}" has no user. Linear declares AgentActivity.user as non-null; ` +
        `this row's author was cleared, which no code path in this twin does.`
    );
  }
  return value;
}

/** Linear's AgentActivitySignal members, verbatim. */
export const AGENT_ACTIVITY_SIGNALS = ["stop", "continue", "auth", "select"] as const satisfies
  readonly LinearAgentActivitySignal[];

/**
 * THE ONE INVENTED THING — how an activity moves the session.
 *
 * Upstream, `agentSessionUpdate` has no `status` field at all: Linear's agent
 * guide says session state "is updated automatically based on the agent's
 * emitted activities. No manual state management is required." So the SHAPE of
 * the model is verified upstream truth — status follows activities, and is not
 * settable through the update mutation. Linear never publishes WHICH activity
 * yields which status, and introspection cannot show behaviour, so this
 * particular table is twin-owned and written up in `REFERENCE-DIVERGENCES.md`.
 *
 * The alternative to naming it was a twin whose sessions sit at `pending`
 * forever, which is worse fidelity than a documented mapping.
 */
export const AGENT_ACTIVITY_SESSION_STATUS: Record<LinearAgentActivityType, LinearAgentSessionStatus> = {
  thought: "active",
  action: "active",
  elicitation: "awaitingInput",
  response: "complete",
  error: "error",
  prompt: "pending",
};

/**
 * Linear's `AgentActivityContent`, as a parser.
 *
 * Upstream declares the input field as `JSONObject!` and validates server-side,
 * where introspection cannot see it — so this mirrors the OUTPUT union, which
 * introspection can. Strict on unknown keys, because the twin's rule is a loud
 * refusal over a silent stub: a misspelled `bodyy` should name itself here
 * rather than round-trip out as content nobody can read.
 */
const bodyContent = { body: z.string().min(1), bodyData: z.unknown().optional() };
const agentActivityContentSchema: z.ZodType<LinearAgentActivityContent> = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("thought"), ...bodyContent }).strict(),
    z.object({ type: z.literal("response"), ...bodyContent }).strict(),
    z.object({ type: z.literal("elicitation"), ...bodyContent }).strict(),
    z.object({ type: z.literal("prompt"), ...bodyContent, title: z.string().nullish() }).strict(),
    z.object({ type: z.literal("error"), ...bodyContent, reasonCode: z.string().nullish() }).strict(),
    z
      .object({
        type: z.literal("action"),
        action: z.string().min(1),
        parameter: z.string().min(1),
        result: z.string().nullish(),
        resultData: z.unknown().optional(),
      })
      .strict(),
  ]
);

export function normalizeActivityContent(value: unknown): LinearAgentActivityContent {
  const parsed = agentActivityContentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    badUserInput(
      `Invalid agent activity content${issue ? `: ${issue.path.join(".") || "type"} — ${issue.message}` : ""}`
    );
  }
  const content = parsed.data;
  if ("body" in content) assertBody(content.body);
  return content;
}

export function normalizeActivitySignal(value: string): LinearAgentActivitySignal {
  if (!AGENT_ACTIVITY_SIGNALS.includes(value as LinearAgentActivitySignal)) {
    badUserInput(`Invalid agent activity signal: ${value}`);
  }
  return value as LinearAgentActivitySignal;
}
