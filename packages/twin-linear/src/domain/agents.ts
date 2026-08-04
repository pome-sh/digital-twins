// SPDX-License-Identifier: Apache-2.0
import { notFound } from "../errors.js";
import type {
  LinearAgentActivity,
  LinearAgentSession,
  LinearAgentSessionExternalUrl,
} from "../types.js";
import { assertBody, normalizeActivityType, normalizeSessionStatus } from "./normalize.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapAgentActivity, mapAgentSession, type AgentActivityRow, type AgentSessionRow } from "./rows.js";
import { emitWebhook } from "./webhooks.js";

export function listAgentSessions(domain: LinearDomain): LinearAgentSession[] {
  return (
    domain.db.prepare("SELECT * FROM agent_sessions ORDER BY created_at, id").all() as AgentSessionRow[]
  ).map(mapAgentSession);
}

export function getAgentSession(domain: LinearDomain, ref: string): LinearAgentSession | null {
  const row = domain.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(ref) as
    | AgentSessionRow
    | undefined;
  return row ? mapAgentSession(row) : null;
}

export type AgentSessionOnIssueInput = {
  issueId: string;
  appUserId?: string;
  plan?: string | null;
  externalUrls?: LinearAgentSessionExternalUrl[] | null;
};

export type AgentSessionOnCommentInput = {
  commentId: string;
  appUserId?: string;
  plan?: string | null;
  externalUrls?: LinearAgentSessionExternalUrl[] | null;
};

export type AgentSessionPatch = {
  status?: string;
  plan?: string | null;
  externalUrls?: LinearAgentSessionExternalUrl[] | null;
};

export async function createAgentSessionOnIssue(
  domain: LinearDomain,
  input: AgentSessionOnIssueInput,
  actor: ActorContext = {}
): Promise<LinearAgentSession> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(input.issueId);
  const viewer = domain.resolveViewer(actor);
  const agent =
    (input.appUserId ? domain.requireUser(input.appUserId) : null) ??
    domain.listUsers().find((u) => u.app) ??
    viewer;
  const now = domain.tick();
  const id = domain.nextId("agent_session");
  domain.db
    .prepare(
      `INSERT INTO agent_sessions(id, issue_id, comment_id, app_user_id, status, plan, external_urls_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      issue.id,
      null,
      agent.id,
      "pending",
      input.plan ?? null,
      JSON.stringify(input.externalUrls ?? []),
      now,
      now
    );
  const session = domain.requireAgentSession(id);
  await emitWebhook(domain, {
    type: "AgentSessionEvent",
    action: "created",
    data: { id: session.id, issueId: issue.id, status: session.status },
    actor: viewer,
    teamId: issue.teamId,
  });
  return session;
}

export async function createAgentSessionOnComment(
  domain: LinearDomain,
  input: AgentSessionOnCommentInput,
  actor: ActorContext = {}
): Promise<LinearAgentSession> {
  // comments:create covers mention-triggered sessions from createComment; write covers GraphQL.
  domain.requireScopes(actor, ["comments:create"]);
  const comment = domain.requireComment(input.commentId);
  const issue = domain.requireIssue(comment.issueId);
  const viewer = domain.resolveViewer(actor);
  const agent =
    (input.appUserId ? domain.requireUser(input.appUserId) : null) ??
    domain.listUsers().find((u) => u.app) ??
    viewer;
  const now = domain.tick();
  const id = domain.nextId("agent_session");
  domain.db
    .prepare(
      `INSERT INTO agent_sessions(id, issue_id, comment_id, app_user_id, status, plan, external_urls_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      issue.id,
      comment.id,
      agent.id,
      "pending",
      input.plan ?? null,
      JSON.stringify(input.externalUrls ?? []),
      now,
      now
    );
  return domain.requireAgentSession(id);
}

export function updateAgentSession(
  domain: LinearDomain,
  id: string,
  input: AgentSessionPatch,
  actor: ActorContext = {}
): LinearAgentSession {
  domain.requireScopes(actor, ["write"]);
  const session = domain.requireAgentSession(id);
  const now = domain.tick();
  // Nullable fields are tri-state: `undefined` (absent, or explicitly passed as undefined)
  // means "leave alone", `null` means "clear". Never test presence with `in` here — callers
  // build this patch as an object literal with every key present, so `in` would clear
  // every field the caller did not mention (F-1166).
  domain.db
    .prepare(
      `UPDATE agent_sessions SET
          status = COALESCE(?, status),
          plan = CASE WHEN ? THEN ? ELSE plan END,
          external_urls_json = CASE WHEN ? THEN ? ELSE external_urls_json END,
          updated_at = ?
         WHERE id = ?`
    )
    .run(
      input.status ? normalizeSessionStatus(input.status) : null,
      input.plan !== undefined ? 1 : 0,
      input.plan ?? null,
      input.externalUrls !== undefined ? 1 : 0,
      JSON.stringify(input.externalUrls ?? []),
      now,
      session.id
    );
  return domain.requireAgentSession(session.id);
}

export async function createAgentActivity(
  domain: LinearDomain,
  input: { sessionId: string; type: string; body: string; ephemeral?: boolean },
  actor: ActorContext = {}
): Promise<LinearAgentActivity> {
  domain.requireScopes(actor, ["write"]);
  assertBody(input.body);
  const session = domain.requireAgentSession(input.sessionId);
  const viewer = domain.resolveViewer(actor);
  const type = normalizeActivityType(input.type);
  const now = domain.tick();
  const id = domain.nextId("agent_activity");
  const ephemeral =
    typeof input.ephemeral === "boolean" ? input.ephemeral : type === "thought" || type === "action";
  domain.db
    .prepare(
      `INSERT INTO agent_activities(id, session_id, user_id, type, body, ephemeral, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(id, session.id, viewer.id, type, input.body, ephemeral ? 1 : 0, now, now);
  if (type === "prompt") {
    await emitWebhook(domain, {
      type: "AgentSessionEvent",
      action: "prompted",
      data: { id: session.id, status: session.status },
      actor: viewer,
      teamId: session.issueId ? domain.requireIssue(session.issueId).teamId : null,
    });
  }
  const activity = domain.getAgentActivity(id);
  if (!activity) notFound(`Agent activity not found: ${id}`);
  return activity;
}

export function getAgentActivity(domain: LinearDomain, ref: string): LinearAgentActivity | null {
  const row = domain.db.prepare("SELECT * FROM agent_activities WHERE id = ?").get(ref) as
    | AgentActivityRow
    | undefined;
  return row ? mapAgentActivity(row) : null;
}

export function listAgentActivities(domain: LinearDomain, sessionId: string): LinearAgentActivity[] {
  return (
    domain.db
      .prepare("SELECT * FROM agent_activities WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId) as AgentActivityRow[]
  ).map(mapAgentActivity);
}
