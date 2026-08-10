// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { badUserInput } from "../errors.js";
import { AGENT_ACTIVITY_SIGNALS } from "../domain/normalize.js";
import type { IssueCreateInput, IssueUpdateInput } from "../domain/index.js";

const optionalString = z.string().nullish();
const optionalStringArray = z.array(z.string()).nullish();

export const issueCreateInputSchema = z
  .object({
    teamId: z.string().min(1),
    title: z.string().min(1),
    description: optionalString,
    priority: z.number().nullish(),
    estimate: z.number().nullish(),
    stateId: optionalString,
    assigneeId: optionalString,
    delegateId: optionalString,
    labelIds: optionalStringArray,
    projectId: optionalString,
    cycleId: optionalString,
    parentId: optionalString,
    createAsUser: optionalString,
    displayIconUrl: optionalString,
    dueDate: optionalString,
  })
  .strict();

export const issueUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: optionalString,
    priority: z.number().nullish(),
    estimate: z.number().nullish(),
    stateId: optionalString,
    assigneeId: optionalString,
    delegateId: optionalString,
    labelIds: optionalStringArray,
    projectId: optionalString,
    cycleId: optionalString,
    parentId: optionalString,
    archivedAt: optionalString,
    dueDate: optionalString,
  })
  .strict();

export const commentCreateInputSchema = z
  .object({
    issueId: z.string().min(1).optional(),
    parentId: optionalString,
    body: z.string().min(1),
    createAsUser: optionalString,
    displayIconUrl: optionalString,
  })
  .strict();

export const commentUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    body: z.string().min(1),
  })
  .strict();

export const issueLabelCreateInputSchema = z
  .object({
    name: z.string().min(1),
    color: z.string().optional(),
    description: optionalString,
    teamId: optionalString,
  })
  .strict();

export const issueLabelUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    color: z.string().optional(),
    description: optionalString,
  })
  .strict();

export const webhookCreateInputSchema = z
  .object({
    url: z.string().min(1),
    label: z.string().optional(),
    resourceTypes: z.array(z.string()).optional(),
    teamId: optionalString,
    allPublicTeams: z.boolean().optional(),
    secret: optionalString,
    enabled: z.boolean().optional(),
  })
  .strict();

/** Mirrors Linear's `AgentSessionExternalUrlInput` field-for-field (F-1172). */
const agentSessionExternalUrlSchema = z
  .object({ url: z.string().min(1), label: z.string() })
  .strict();
const optionalExternalUrls = z.array(agentSessionExternalUrlSchema).nullish();

// F-1176 — these four mirror Linear's mutation inputs. `appUserId` and a
// create-time `plan` are gone (Linear declares neither), `status` is gone (a
// session's status follows its activities), and `id` is the mutation's own
// non-null argument rather than an input field.
export const agentSessionOnIssueInputSchema = z
  .object({
    issueId: z.string().min(1),
    externalUrls: optionalExternalUrls,
  })
  .strict();

export const agentSessionOnCommentInputSchema = z
  .object({
    commentId: z.string().min(1),
    externalUrls: optionalExternalUrls,
  })
  .strict();

export const agentSessionUpdateInputSchema = z
  .object({
    plan: optionalString,
    externalUrls: optionalExternalUrls,
  })
  .strict();

export const agentActivityCreateInputSchema = z
  .object({
    agentSessionId: z.string().min(1),
    // `JSONObject!` upstream. The envelope is checked here; which of Linear's
    // six `AgentActivityContent` members it is, and whether it is well formed,
    // is the domain's `normalizeActivityContent` — the same split as
    // `priority` and `normalizePriority`, and the reason a bad content names
    // itself rather than surfacing as a stray "expected string".
    content: z.record(z.string(), z.unknown()),
    signal: z.enum(AGENT_ACTIVITY_SIGNALS).nullish(),
    ephemeral: z.boolean().optional(),
  })
  .strict();

function parseOrBadUserInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    badUserInput(issue ? `${label}: ${issue.message}` : `Invalid ${label}`);
  }
  return parsed.data;
}

export function parseIssueCreateInput(input: unknown): IssueCreateInput {
  const raw = parseOrBadUserInput(issueCreateInputSchema, input, "issueCreate input");
  return {
    teamId: raw.teamId,
    title: raw.title,
    description: raw.description ?? null,
    priority: raw.priority ?? undefined,
    estimate: raw.estimate,
    stateId: raw.stateId ?? null,
    assigneeId: raw.assigneeId ?? null,
    delegateId: raw.delegateId ?? null,
    labelIds: raw.labelIds ?? null,
    projectId: raw.projectId ?? null,
    cycleId: raw.cycleId ?? null,
    parentId: raw.parentId ?? null,
    createAsUser: raw.createAsUser ?? null,
    displayIconUrl: raw.displayIconUrl ?? null,
    dueDate: raw.dueDate ?? null,
  };
}

export function parseIssueUpdateInput(input: unknown): { id?: string; patch: IssueUpdateInput } {
  const raw = parseOrBadUserInput(issueUpdateInputSchema, input, "issueUpdate input");
  const patch: IssueUpdateInput = {};
  if (raw.title !== undefined) patch.title = raw.title;
  if (raw.description !== undefined) patch.description = raw.description ?? null;
  if (raw.priority !== undefined) patch.priority = raw.priority ?? null;
  if (raw.estimate !== undefined) patch.estimate = raw.estimate ?? null;
  if (raw.stateId !== undefined) patch.stateId = raw.stateId ?? null;
  if (raw.assigneeId !== undefined) patch.assigneeId = raw.assigneeId ?? null;
  if (raw.delegateId !== undefined) patch.delegateId = raw.delegateId ?? null;
  if (raw.labelIds !== undefined) patch.labelIds = raw.labelIds ?? [];
  if (raw.projectId !== undefined) patch.projectId = raw.projectId ?? null;
  if (raw.cycleId !== undefined) patch.cycleId = raw.cycleId ?? null;
  if (raw.parentId !== undefined) patch.parentId = raw.parentId ?? null;
  if (raw.archivedAt !== undefined) patch.archivedAt = raw.archivedAt ?? null;
  if (raw.dueDate !== undefined) patch.dueDate = raw.dueDate ?? null;
  return { id: raw.id, patch };
}

export function parseCommentCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(commentCreateInputSchema, input, "commentCreate input");
  return {
    issueId: raw.issueId,
    parentId: raw.parentId ?? null,
    body: raw.body,
    createAsUser: raw.createAsUser ?? null,
    displayIconUrl: raw.displayIconUrl ?? null,
  };
}

export function parseCommentUpdateInput(input: unknown) {
  return parseOrBadUserInput(commentUpdateInputSchema, input, "commentUpdate input");
}

export function parseIssueLabelCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(issueLabelCreateInputSchema, input, "issueLabelCreate input");
  return {
    name: raw.name,
    color: raw.color,
    description: raw.description ?? null,
    teamId: raw.teamId ?? null,
  };
}

export function parseIssueLabelUpdateInput(input: unknown) {
  const raw = parseOrBadUserInput(issueLabelUpdateInputSchema, input, "issueLabelUpdate input");
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    description: raw.description,
  };
}

export function parseWebhookCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(webhookCreateInputSchema, input, "webhookCreate input");
  return {
    url: raw.url,
    label: raw.label,
    resourceTypes: raw.resourceTypes,
    teamId: raw.teamId ?? null,
    allPublicTeams: raw.allPublicTeams,
    secret: raw.secret ?? null,
    enabled: raw.enabled,
  };
}

export function parseAgentSessionOnIssueInput(input: unknown) {
  const raw = parseOrBadUserInput(agentSessionOnIssueInputSchema, input, "agentSessionCreateOnIssue input");
  return { issueId: raw.issueId, externalUrls: raw.externalUrls ?? null };
}

export function parseAgentSessionOnCommentInput(input: unknown) {
  const raw = parseOrBadUserInput(
    agentSessionOnCommentInputSchema,
    input,
    "agentSessionCreateOnComment input"
  );
  return { commentId: raw.commentId, externalUrls: raw.externalUrls ?? null };
}

export function parseAgentSessionUpdateInput(input: unknown) {
  const raw = parseOrBadUserInput(agentSessionUpdateInputSchema, input, "agentSessionUpdate input");
  return { plan: raw.plan, externalUrls: raw.externalUrls };
}

export function parseAgentActivityCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(agentActivityCreateInputSchema, input, "agentActivityCreate input");
  return {
    agentSessionId: raw.agentSessionId,
    content: raw.content,
    signal: raw.signal ?? null,
    ephemeral: raw.ephemeral,
  };
}
