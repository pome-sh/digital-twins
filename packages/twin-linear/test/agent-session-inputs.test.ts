// SPDX-License-Identifier: Apache-2.0
//
// F-1176: the four agent-session mutation inputs take Linear's field names, and
// only Linear's. `test/linear-schema-subset.test.ts` proves the SDL declares no
// invented field; this proves the twin BEHAVES that way over the wire — an
// invented field is rejected, Linear's names are accepted, and session status
// moves through agentActivityCreate because Linear has no `status` to set.
import { describe, expect, it } from "vitest";
import { createRecorderStore } from "@pome-sh/sdk/server";
import {
  DEFAULT_LINEAR_TOKEN,
  createLinearTwinApp,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SECRET = "linear-agent-inputs-test-secret!!";

function app() {
  process.env.TWIN_AUTH_SECRET = SECRET;
  return createLinearTwinApp({
    db: openLinearTwinDatabase(":memory:"),
    seed: testSeed(),
    recorder: createRecorderStore(),
    runId: "agent-inputs-test",
  });
}

type GraphQLResult = { data?: Record<string, any>; errors?: Array<{ message: string }> };

async function graphql(
  instance: ReturnType<typeof createLinearTwinApp>,
  query: string,
  variables?: Record<string, unknown>
): Promise<GraphQLResult> {
  const response = await instance.request("/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GraphQLResult;
}

async function session(instance: ReturnType<typeof createLinearTwinApp>): Promise<string> {
  const issues = await graphql(instance, `query { issues(first: 1) { nodes { id } } }`);
  const created = await graphql(
    instance,
    `mutation ($input: AgentSessionCreateOnIssue!) {
       agentSessionCreateOnIssue(input: $input) { agentSession { id status } }
     }`,
    { input: { issueId: issues.data?.issues.nodes[0].id as string } }
  );
  expect(created.errors).toBeUndefined();
  expect(created.data?.agentSessionCreateOnIssue.agentSession.status).toBe("pending");
  return created.data?.agentSessionCreateOnIssue.agentSession.id as string;
}

async function emit(
  instance: ReturnType<typeof createLinearTwinApp>,
  agentSessionId: string,
  content: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<GraphQLResult> {
  return graphql(
    instance,
    `mutation ($input: AgentActivityCreateInput!) {
       agentActivityCreate(input: $input) {
         agentActivity { id content signal ephemeral agentSession { id status } }
       }
     }`,
    { input: { agentSessionId, content, ...extra } }
  );
}

describe("agent-session mutation inputs take Linear's field names (F-1176)", () => {
  it.each([
    ["AgentSessionCreateOnIssue", "appUserId", `mutation { agentSessionCreateOnIssue(input: { issueId: "x", appUserId: "y" }) { success } }`],
    ["AgentSessionCreateOnIssue", "plan", `mutation { agentSessionCreateOnIssue(input: { issueId: "x", plan: "p" }) { success } }`],
    ["AgentSessionCreateOnComment", "appUserId", `mutation { agentSessionCreateOnComment(input: { commentId: "x", appUserId: "y" }) { success } }`],
    ["AgentSessionUpdateInput", "status", `mutation { agentSessionUpdate(id: "x", input: { status: active }) { success } }`],
    ["AgentSessionUpdateInput", "id", `mutation { agentSessionUpdate(id: "x", input: { id: "x" }) { success } }`],
    ["AgentActivityCreateInput", "sessionId", `mutation { agentActivityCreate(input: { agentSessionId: "x", sessionId: "x", content: {} }) { success } }`],
    ["AgentActivityCreateInput", "body", `mutation { agentActivityCreate(input: { agentSessionId: "x", body: "b", content: {} }) { success } }`],
  ])("%s rejects the invented field %s", async (typeName, field, query) => {
    const result = await graphql(app(), query);
    expect(result.errors?.[0]?.message).toContain(`Field "${field}" is not defined by type "${typeName}"`);
  });

  it("agentSessionUpdate requires id as an argument, because upstream it is not a field of the input", async () => {
    const result = await graphql(app(), `mutation { agentSessionUpdate(input: { plan: "p" }) { success } }`);
    expect(result.errors?.[0]?.message).toContain(
      'Field "agentSessionUpdate" argument "id" of type "String!" is required'
    );
  });

  it("agentSessionUpdate sets plan and externalUrls without touching status", async () => {
    const instance = app();
    const id = await session(instance);
    const updated = await graphql(
      instance,
      `mutation ($id: String!, $input: AgentSessionUpdateInput!) {
         agentSessionUpdate(id: $id, input: $input) { agentSession { status plan externalUrls } }
       }`,
      { id, input: { plan: "PLAN", externalUrls: [{ url: "https://example.test/r", label: "run" }] } }
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.agentSessionUpdate.agentSession).toEqual({
      status: "pending",
      plan: "PLAN",
      externalUrls: [{ url: "https://example.test/r", label: "run" }],
    });
  });
});

describe("session status moves through agent activities, not agentSessionUpdate (F-1176)", () => {
  it.each([
    [{ type: "thought", body: "looking" }, "active"],
    [{ type: "action", action: "search", parameter: "term" }, "active"],
    [{ type: "elicitation", body: "which repo?" }, "awaitingInput"],
    [{ type: "response", body: "done" }, "complete"],
    [{ type: "error", body: "exploded" }, "error"],
    [{ type: "prompt", body: "please fix" }, "pending"],
  ])("a %o activity leaves the session %s", async (content, status) => {
    const instance = app();
    const id = await session(instance);
    const result = await emit(instance, id, content);
    expect(result.errors).toBeUndefined();
    expect(result.data?.agentActivityCreate.agentActivity.agentSession.status).toBe(status);
    expect(result.data?.agentActivityCreate.agentActivity.content).toEqual(content);
  });

  it("carries a signal through, and rejects one Linear does not declare", async () => {
    const instance = app();
    const id = await session(instance);
    const accepted = await emit(instance, id, { type: "response", body: "done" }, { signal: "stop" });
    expect(accepted.errors).toBeUndefined();
    expect(accepted.data?.agentActivityCreate.agentActivity.signal).toBe("stop");

    const rejected = await graphql(
      instance,
      `mutation { agentActivityCreate(input: { agentSessionId: "${id}", content: {}, signal: cancel }) { success } }`
    );
    expect(rejected.errors?.[0]?.message).toContain('Value "cancel" does not exist in "AgentActivitySignal"');
  });

  it("rejects content that is not one of Linear's AgentActivityContent members", async () => {
    const instance = app();
    const id = await session(instance);

    for (const content of [
      { type: "thought" }, // body is required on a thought
      { type: "thought", body: "hi", extra: "no" }, // strict: no unknown keys
      { type: "summary", body: "hi" }, // not an AgentActivityType
      { type: "action", action: "search" }, // parameter is required on an action
    ]) {
      const result = await emit(instance, id, content);
      expect(result.errors?.[0]?.message, JSON.stringify(content)).toContain("agentActivityCreate content");
    }
  });

  it("an activity on an unknown session is a not-found, not a silent create", async () => {
    const result = await emit(app(), "agent_session_nope", { type: "thought", body: "hi" });
    expect(result.errors?.[0]?.message).toContain("Agent session not found");
  });
});
