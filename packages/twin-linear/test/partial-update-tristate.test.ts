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

// The lifecycle timestamps (started_at / completed_at / canceled_at) are not
// set directly by the caller — they are derived from the state transition. So
// `stateId: null` cannot mean "clear the timestamps" the way `description: null`
// means "clear the description": with no target state there is no transition to
// derive them from, and `state_id` itself is left alone by its COALESCE. The
// guard that computes the timestamps and the flags that write them must agree
// on `!= null`, or an unrelated sibling edit sent alongside `stateId: null`
// wipes a Done issue's completedAt while leaving it in the Done state.
describe("issueUpdate lifecycle timestamps ignore a null stateId (F-1166)", () => {
  async function doneIssue(commands: LinearDomain) {
    const team = commands.listTeams()[0]!;
    const done = commands.getWorkflowState("Done", "ENG")!;
    const issue = await commands.createIssue({ teamId: team.id, title: "Lifecycle" });
    const completed = await commands.updateIssue(issue.id, { stateId: done.id });
    expect(completed.completedAt).toBeTruthy();
    return { completed, done };
  }

  it("keeps completedAt when a sibling field is edited alongside stateId: null", async () => {
    const commands = domain();
    const { completed, done } = await doneIssue(commands);

    const updated = await commands.updateIssue(completed.id, {
      stateId: null,
      title: "Lifecycle renamed",
    });

    expect(updated.title).toBe("Lifecycle renamed");
    expect(updated.stateId).toBe(done.id);
    expect(updated.completedAt).toBe(completed.completedAt);
    expect(updated.canceledAt).toBe(completed.canceledAt);
    expect(updated.startedAt).toBe(completed.startedAt);
  });

  it("keeps startedAt when a sibling field is edited alongside stateId: null", async () => {
    const commands = domain();
    const team = commands.listTeams()[0]!;
    const started = commands.getWorkflowState("In Progress", "ENG")!;
    const issue = await commands.createIssue({ teamId: team.id, title: "Lifecycle started" });
    const inProgress = await commands.updateIssue(issue.id, { stateId: started.id });
    expect(inProgress.startedAt).toBeTruthy();

    const updated = await commands.updateIssue(inProgress.id, {
      stateId: null,
      title: "Lifecycle started renamed",
    });

    expect(updated.stateId).toBe(started.id);
    expect(updated.startedAt).toBe(inProgress.startedAt);
  });

  it("keeps completedAt through a GraphQL issueUpdate that sends stateId: null with a title", async () => {
    const instance = app();
    const states = await graphql(
      instance,
      `query { workflowStates(first: 50) { nodes { id name } } }`
    );
    const done = (states.data?.workflowStates.nodes as Array<any>).find((s) => s.name === "Done");
    const issues = await graphql(instance, `query { issues(first: 1) { nodes { id } } }`);
    const issueId = issues.data?.issues.nodes[0].id as string;

    const mutation = `mutation ($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        issue { id title completedAt canceledAt state { id name } }
      }
    }`;

    const completed = await graphql(instance, mutation, {
      id: issueId,
      input: { stateId: done.id },
    });
    expect(completed.errors).toBeUndefined();
    const completedAt = completed.data?.issueUpdate.issue.completedAt as string;
    expect(completedAt).toBeTruthy();

    const renamed = await graphql(instance, mutation, {
      id: issueId,
      input: { stateId: null, title: "Renamed via GraphQL" },
    });

    expect(renamed.errors).toBeUndefined();
    expect(renamed.data?.issueUpdate.issue).toMatchObject({
      title: "Renamed via GraphQL",
      completedAt,
    });
    expect(renamed.data?.issueUpdate.issue.state.name).toBe("Done");
  });

  it("still clears completedAt on a real transition out of Done", async () => {
    const commands = domain();
    const { completed } = await doneIssue(commands);
    const todo = commands.getWorkflowState("Todo", "ENG")!;

    const reopened = await commands.updateIssue(completed.id, { stateId: todo.id });

    expect(reopened.stateId).toBe(todo.id);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.canceledAt).toBeNull();
    expect(reopened.startedAt).toBeNull();
  });
});
