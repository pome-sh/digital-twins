// SPDX-License-Identifier: Apache-2.0
//
// F-1166: partial updates must honour the three-way distinction that GraphQL
// partial-update inputs require:
//
//   * key absent entirely        -> leave the stored value alone
//   * key present, value `null`  -> clear the stored value
//   * key present, value `undefined` -> leave the stored value alone
//     (`undefined` is the absence of a value, not a value)
//
// The twin used to conflate the last two by testing key presence with the `in`
// operator, so any caller that built a patch object literal with every key
// always present silently wiped every field it did not mention.
import { describe, expect, it } from "vitest";
import { createRecorderStore } from "@pome-sh/sdk/server";
import {
  DEFAULT_LINEAR_TOKEN,
  LinearDomain,
  createLinearTwinApp,
  linearTools,
  openLinearTwinDatabase,
} from "../src/index.js";
import { parseAgentSessionUpdateInput } from "../src/graphql/mutation-inputs.js";
import { testSeed } from "./_helpers.js";

const SECRET = "linear-tristate-test-secret-32chars!";

function domain() {
  const db = openLinearTwinDatabase(":memory:");
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  return commands;
}

function app() {
  process.env.TWIN_AUTH_SECRET = SECRET;
  const db = openLinearTwinDatabase(":memory:");
  return createLinearTwinApp({
    db,
    seed: testSeed(),
    recorder: createRecorderStore(),
    runId: "tristate-test",
  });
}

async function graphql(
  instance: ReturnType<typeof createLinearTwinApp>,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await instance.request("/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string }>;
  };
}

function callTool(commands: LinearDomain, name: string, args: Record<string, unknown>) {
  const tool = linearTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
  return tool.handler(commands, args, { reportDelta: () => {} } as never);
}

async function seededSession(commands: LinearDomain, plan: string) {
  const issue = commands.listIssues()[0]!;
  return commands.createAgentSessionOnIssue({ issueId: issue.id, plan, externalUrl: null });
}

describe("agentSessionUpdate partial-update tri-state (F-1166)", () => {
  it("leaves plan untouched when the key is present but undefined", async () => {
    const commands = domain();
    const session = await seededSession(commands, "PLAN-RESIDUE");

    const updated = commands.updateAgentSession(session.id, {
      state: "active",
      plan: undefined,
      externalUrl: undefined,
    });

    expect(updated.plan).toBe("PLAN-RESIDUE");
    expect(updated.state).toBe("active");
  });

  it("leaves plan untouched when the key is absent", async () => {
    const commands = domain();
    const session = await seededSession(commands, "PLAN-RESIDUE");

    const updated = commands.updateAgentSession(session.id, { state: "active" });

    expect(updated.plan).toBe("PLAN-RESIDUE");
  });

  it("clears plan when the key is present and null", async () => {
    const commands = domain();
    const session = await seededSession(commands, "PLAN-RESIDUE");

    const updated = commands.updateAgentSession(session.id, { plan: null });

    expect(updated.plan).toBeNull();
  });

  it("parses a present-but-undefined plan as 'not provided', not as null", () => {
    expect(parseAgentSessionUpdateInput({ id: "x", state: "active", plan: undefined }).plan).toBeUndefined();
    expect(parseAgentSessionUpdateInput({ id: "x", state: "active" }).plan).toBeUndefined();
    expect(parseAgentSessionUpdateInput({ id: "x", plan: null }).plan).toBeNull();
    expect(parseAgentSessionUpdateInput({ id: "x", plan: "PLAN" }).plan).toBe("PLAN");
  });

  it("preserves plan across a GraphQL agentSessionUpdate that only sets state", async () => {
    const instance = app();
    const issues = await graphql(instance, `query { issues(first: 1) { nodes { id } } }`);
    const issueId = issues.data?.issues.nodes[0].id as string;

    const created = await graphql(
      instance,
      `mutation ($input: AgentSessionCreateOnIssue!) {
         agentSessionCreateOnIssue(input: $input) { agentSession { id plan externalUrl } }
       }`,
      { input: { issueId, plan: "PLAN-RESIDUE", externalUrl: "https://example.test/run/1" } }
    );
    const sessionId = created.data?.agentSessionCreateOnIssue.agentSession.id as string;

    const updated = await graphql(
      instance,
      `mutation ($id: String!, $input: AgentSessionUpdateInput!) {
         agentSessionUpdate(id: $id, input: $input) { agentSession { id state plan externalUrl } }
       }`,
      { id: sessionId, input: { state: "active" } }
    );

    expect(updated.errors).toBeUndefined();
    expect(updated.data?.agentSessionUpdate.agentSession).toMatchObject({
      state: "active",
      plan: "PLAN-RESIDUE",
      externalUrl: "https://example.test/run/1",
    });
  });

  it("still clears plan through GraphQL when null is sent explicitly", async () => {
    const instance = app();
    const issues = await graphql(instance, `query { issues(first: 1) { nodes { id } } }`);
    const issueId = issues.data?.issues.nodes[0].id as string;
    const created = await graphql(
      instance,
      `mutation ($input: AgentSessionCreateOnIssue!) {
         agentSessionCreateOnIssue(input: $input) { agentSession { id } }
       }`,
      { input: { issueId, plan: "PLAN-RESIDUE" } }
    );
    const sessionId = created.data?.agentSessionCreateOnIssue.agentSession.id as string;

    const updated = await graphql(
      instance,
      `mutation ($id: String!, $input: AgentSessionUpdateInput!) {
         agentSessionUpdate(id: $id, input: $input) { agentSession { plan } }
       }`,
      { id: sessionId, input: { plan: null } }
    );

    expect(updated.data?.agentSessionUpdate.agentSession.plan).toBeNull();
  });
});

describe("sibling mutations share the tri-state contract (F-1166)", () => {
  it("issueUpdate leaves description untouched when the key is present but undefined", async () => {
    const commands = domain();
    const team = commands.listTeams()[0]!;
    const issue = await commands.createIssue({ teamId: team.id, title: "Tri", description: "KEEP-ME" });

    const updated = await commands.updateIssue(issue.id, { title: "Tri 2", description: undefined });

    expect(updated.description).toBe("KEEP-ME");
    expect((await commands.updateIssue(issue.id, { description: null })).description).toBeNull();
  });

  it("updateLabel leaves description untouched when the key is present but undefined", async () => {
    const commands = domain();
    const label = commands.requireLabel("Bug");

    const updated = await commands.updateLabel(label.id, { name: "Bug 2", description: undefined });

    expect(updated.description).toBe("Defect");
    expect((await commands.updateLabel(label.id, { description: null })).description).toBeNull();
  });

  it("issueLabelUpdate over GraphQL preserves description when the input omits it", async () => {
    const instance = app();
    const labels = await graphql(
      instance,
      `query { issueLabels(first: 50) { nodes { id name description } } }`
    );
    const label = (labels.data?.issueLabels.nodes as Array<any>).find((l) => l.description);

    const updated = await graphql(
      instance,
      `mutation ($id: String!, $input: IssueLabelUpdateInput!) {
         issueLabelUpdate(id: $id, input: $input) { issueLabel { id name description } }
       }`,
      { id: label.id, input: { name: `${label.name} renamed` } }
    );

    expect(updated.errors).toBeUndefined();
    expect(updated.data?.issueLabelUpdate.issueLabel.description).toBe(label.description);
  });

  it("updateProject leaves description untouched when the key is present but undefined", () => {
    const commands = domain();
    const team = commands.listTeams()[0]!;
    const project = commands.createProject({
      teamId: team.id,
      name: "Tri project",
      description: "KEEP-ME",
    });

    const updated = commands.updateProject(project.id, { name: "Tri project 2", description: undefined });

    expect(updated.description).toBe("KEEP-ME");
    expect(commands.updateProject(project.id, { description: null }).description).toBeNull();
  });

  it("updateDocument leaves content untouched when the key is present but undefined", () => {
    const commands = domain();
    const team = commands.listTeams()[0]!;
    const doc = commands.createDocument({ title: "Tri doc", content: "KEEP-ME", team: team.id });

    const updated = commands.updateDocument(doc.id, { title: "Tri doc 2", content: undefined });

    expect(updated.content).toBe("KEEP-ME");
    expect(commands.updateDocument(doc.id, { content: null }).content).toBeNull();
  });

  it("MCP save_issue preserves description when the caller does not mention it", async () => {
    const commands = domain();
    const team = commands.listTeams()[0]!;
    const issue = await commands.createIssue({ teamId: team.id, title: "MCP tri", description: "KEEP-ME" });

    await callTool(commands, "save_issue", { id: issue.id, title: "MCP tri 2" });

    expect(commands.requireIssue(issue.id).description).toBe("KEEP-ME");
  });

  it("MCP save_document preserves content when the caller does not mention it", async () => {
    const commands = domain();
    const team = commands.listTeams()[0]!;
    const doc = commands.createDocument({ title: "MCP doc", content: "KEEP-ME", team: team.id });

    await callTool(commands, "save_document", { id: doc.id, title: "MCP doc 2" });

    expect(commands.requireDocument(doc.id).content).toBe("KEEP-ME");
  });
});
