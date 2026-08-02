// SPDX-License-Identifier: Apache-2.0
import { badUserInput } from "../errors.js";
import { byteLength } from "../ids.js";
import {
  BODY_MAX_BYTES,
  TITLE_MAX_BYTES,
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

export function normalizeSessionStatus(value: string): LinearAgentSessionStatus {
  if (!AGENT_SESSION_STATUSES.includes(value as LinearAgentSessionStatus)) {
    badUserInput(`Invalid agent session status: ${value}`);
  }
  return value as LinearAgentSessionStatus;
}

export function normalizeActivityType(value: string): LinearAgentActivityType {
  const allowed: LinearAgentActivityType[] = [
    "thought",
    "elicitation",
    "action",
    "response",
    "error",
    "prompt",
  ];
  if (!allowed.includes(value as LinearAgentActivityType)) badUserInput(`Invalid agent activity type: ${value}`);
  return value as LinearAgentActivityType;
}
