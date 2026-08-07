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

/** Linear's AgentSessionStatus members, verbatim (F-1172). */
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
 * boundary where the message can (F-1172).
 */
export function readSessionStatus(value: string): LinearAgentSessionStatus {
  if (!AGENT_SESSION_STATUSES.includes(value as LinearAgentSessionStatus)) {
    throw new LinearTwinError(
      500,
      "INTERNAL_SERVER_ERROR",
      `Stored agent session status "${value}" is not one of Linear's AgentSessionStatus members ` +
        `(${AGENT_SESSION_STATUSES.join(", ")}). This database predates the F-1172 rename and was not migrated.`
    );
  }
  return value as LinearAgentSessionStatus;
}

export function normalizeSessionStatus(value: string): LinearAgentSessionStatus {
  if (!AGENT_SESSION_STATUSES.includes(value as LinearAgentSessionStatus)) {
    badUserInput(`Invalid agent session status: ${value}`);
  }
  return value as LinearAgentSessionStatus;
}

/** Linear's `AgentActivitySignal` members, verbatim (F-1176). */
export const AGENT_ACTIVITY_SIGNALS: LinearAgentActivitySignal[] = ["stop", "continue", "auth", "select"];

/**
 * `AgentActivityCreateInput.content`, member-for-member with Linear's
 * `AgentActivityContent` union (F-1176). Strict on purpose: an unknown key here
 * is a caller writing against a shape Linear does not accept, and the twin's
 * rule is a loud error over a silent stub.
 *
 * `bodyData` / `resultData` are omitted — Linear derives them server-side from
 * the markdown body, and the twin does not model rich text.
 */
const agentActivityContentSchema = z.union([
  z.object({ type: z.enum(["thought", "elicitation", "response"]), body: z.string().min(1) }).strict(),
  z.object({ type: z.literal("prompt"), body: z.string().min(1), title: z.string().optional() }).strict(),
  z
    .object({ type: z.literal("error"), body: z.string().min(1), reasonCode: z.string().optional() })
    .strict(),
  z
    .object({
      type: z.literal("action"),
      action: z.string().min(1),
      parameter: z.string(),
      result: z.string().optional(),
    })
    .strict(),
]);

export function parseActivityContent(value: unknown): LinearAgentActivityContent {
  const parsed = agentActivityContentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    badUserInput(
      `agentActivityCreate content: ${issue ? `${issue.path.join(".") || "content"} ${issue.message}` : "invalid"}`
    );
  }
  const content = parsed.data as LinearAgentActivityContent;
  if ("body" in content) assertBody(content.body);
  return content;
}

export function normalizeActivitySignal(value: string): LinearAgentActivitySignal {
  if (!AGENT_ACTIVITY_SIGNALS.includes(value as LinearAgentActivitySignal)) {
    badUserInput(`Invalid agent activity signal: ${value}`);
  }
  return value as LinearAgentActivitySignal;
}

/**
 * The status an emitted activity moves its session to (F-1176).
 *
 * Upstream truth, verified: `AgentSessionUpdateInput` has no `status` field at
 * all, and Linear's agent guide states that session state is "updated
 * automatically based on the agent's emitted activities. No manual state
 * management is required." So status following activities is Linear's model,
 * not the twin's invention.
 *
 * The table itself IS twin-owned — Linear does not publish which activity type
 * yields which status, and introspection cannot show behaviour. It is
 * registered as a known divergence in `REFERENCE-DIVERGENCES.md`. The mapping
 * is the semantically forced one: work in progress is `active`, asking the user
 * something waits on them, a final answer or a failure ends the session, and a
 * fresh prompt puts the session back in the queue.
 */
export function deriveSessionStatus(type: LinearAgentActivityType): LinearAgentSessionStatus {
  switch (type) {
    case "thought":
    case "action":
      return "active";
    case "elicitation":
      return "awaitingInput";
    case "response":
      return "complete";
    case "error":
      return "error";
    case "prompt":
      return "pending";
  }
}
