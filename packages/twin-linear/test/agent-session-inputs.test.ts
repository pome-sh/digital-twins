// SPDX-License-Identifier: Apache-2.0
//
// F-1176: the agent-session MUTATION INPUTS are Linear's, and so is the model
// they imply.
//
// F-1172 fixed the output type and said, in the guard file's own words, "do not
// read this file as evidence about the input surface". The inputs still carried
// `status` and `id` on `AgentSessionUpdateInput`, `appUserId` and `plan` on the
// two creates, and `sessionId` / `type` / `body` on `AgentActivityCreateInput`
// — none of which Linear declares. `test/linear-schema-subset.test.ts` now
// guards the NAMES against Linear's real introspection; this file drives the
// BEHAVIOUR they imply, which introspection cannot show:
//
//   * an argument Linear does not accept is refused here too, and
//   * a session's status moves through activities, because upstream there is
//     no other way to move it.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_TOKEN,
  LinearDomain,
  createLinearTwinApp,
  exportLinearState,
  openLinearTwinDatabase,
} from "../src/index.js";
import { AGENT_ACTIVITY_SESSION_STATUS } from "../src/domain/normalize.js";
import { testSeed } from "./_helpers.js";

function app() {
  return createLinearTwinApp({
    db: openLinearTwinDatabase(":memory:"),
    seed: testSeed(),
    runId: "agent-inputs-test",
  });
}

function domain() {
  const db = openLinearTwinDatabase(":memory:");
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  return commands;
}

async function graphql(
  instance: ReturnType<typeof createLinearTwinApp>,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await instance.request("/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as { data?: Record<string, any>; errors?: Array<{ message: string }> };
}

async function newSession(instance: ReturnType<typeof createLinearTwinApp>) {
  const issues = await graphql(instance, `query { issues(first: 1) { nodes { id } } }`);
  const created = await graphql(
    instance,
    `mutation ($input: AgentSessionCreateOnIssue!) {
       agentSessionCreateOnIssue(input: $input) { agentSession { id status } }
     }`,
    { input: { issueId: issues.data?.issues.nodes[0].id } }
  );
  expect(created.errors).toBeUndefined();
  return created.data?.agentSessionCreateOnIssue.agentSession as { id: string; status: string };
}

const CREATE_ACTIVITY = `mutation ($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    agentActivity {
      id
      content
      signal
      ephemeral
      user { id }
      agentSession { id status }
    }
  }
}`;

describe("the mutation inputs refuse what Linear refuses (F-1176)", () => {
  it("agentSessionUpdate has no status field — status is not settable by hand", async () => {
    const instance = app();
    const session = await newSession(instance);

    const updated = await graphql(
      instance,
      `mutation ($id: String!, $input: AgentSessionUpdateInput!) {
         agentSessionUpdate(id: $id, input: $input) { agentSession { status } }
       }`,
      { id: session.id, input: { status: "active" } }
    );

    expect(updated.errors?.[0]?.message).toMatch(
      /Field "status" is not defined by type "AgentSessionUpdateInput"/
    );
  });

  it("agentSessionUpdate has no id field — id is the mutation's own argument", async () => {
    const instance = app();
    const session = await newSession(instance);

    const updated = await graphql(
      instance,
      `mutation ($id: String!, $input: AgentSessionUpdateInput!) {
         agentSessionUpdate(id: $id, input: $input) { agentSession { id } }
       }`,
      { id: session.id, input: { id: session.id } }
    );

    expect(updated.errors?.[0]?.message).toMatch(
      /Field "id" is not defined by type "AgentSessionUpdateInput"/
    );
  });

  it("agentSessionUpdate refuses a null id, because Linear declares String!", async () => {
    const instance = app();
    await newSession(instance);

    const updated = await graphql(
      instance,
      `mutation ($id: String, $input: AgentSessionUpdateInput!) {
         agentSessionUpdate(id: $id, input: $input) { agentSession { id } }
       }`,
      { id: null, input: {} }
    );

    // A nullable variable cannot even be supplied to a non-null argument.
    expect(updated.errors?.[0]?.message).toMatch(/\$id.*of type "String".*"String!"/s);
  });

  it("the create inputs carry neither appUserId nor plan", async () => {
    const instance = app();
    const issues = await graphql(instance, `query { issues(first: 1) { nodes { id } } }`);
    const issueId = issues.data?.issues.nodes[0].id as string;

    for (const [field, value] of [
      ["appUserId", "user_agent"],
      ["plan", "PLAN"],
    ] as const) {
      const created = await graphql(
        instance,
        `mutation ($input: AgentSessionCreateOnIssue!) {
           agentSessionCreateOnIssue(input: $input) { agentSession { id } }
         }`,
        { input: { issueId, [field]: value } }
      );
      expect(created.errors?.[0]?.message).toMatch(
        new RegExp(`Field "${field}" is not defined by type "AgentSessionCreateOnIssue"`)
      );
    }
  });

  it("agentActivityCreate takes agentSessionId and content, not sessionId/type/body", async () => {
    const instance = app();
    const session = await newSession(instance);

    const legacy = await graphql(instance, CREATE_ACTIVITY, {
      input: { sessionId: session.id, type: "thought", body: "thinking" },
    });
    expect(legacy.errors?.map((error) => error.message).join(" ")).toMatch(
      /Field "sessionId" is not defined by type "AgentActivityCreateInput"/
    );

    const current = await graphql(instance, CREATE_ACTIVITY, {
      input: { agentSessionId: session.id, content: { type: "thought", body: "thinking" } },
    });
    expect(current.errors).toBeUndefined();
    expect(current.data?.agentActivityCreate.agentActivity.content).toEqual({
      type: "thought",
      body: "thinking",
    });
  });
});

describe("a session's status follows its activities (F-1176)", () => {
  it("moves the session for every AgentActivityType, from the one table that says so", async () => {
    // Driven off the table itself so a member added to `AgentActivityType`
    // without a transition cannot pass by being forgotten here.
    for (const [type, expected] of Object.entries(AGENT_ACTIVITY_SESSION_STATUS)) {
      const instance = app();
      const session = await newSession(instance);
      expect(session.status).toBe("pending");

      const content =
        type === "action" ? { type, action: "search", parameter: "twin" } : { type, body: `a ${type}` };
      const emitted = await graphql(instance, CREATE_ACTIVITY, {
        input: { agentSessionId: session.id, content },
      });

      expect(emitted.errors, `${type} was refused`).toBeUndefined();
      expect(
        emitted.data?.agentActivityCreate.agentActivity.agentSession.status,
        `${type} should leave the session ${expected}`
      ).toBe(expected);
    }
  });

  it("keeps moving the session as the agent works, ending complete", async () => {
    const instance = app();
    const session = await newSession(instance);

    const statuses: string[] = [];
    for (const content of [
      { type: "thought", body: "reading the issue" },
      { type: "action", action: "search", parameter: "twin" },
      { type: "elicitation", body: "which team owns this?" },
      { type: "response", body: "done" },
    ]) {
      const emitted = await graphql(instance, CREATE_ACTIVITY, {
        input: { agentSessionId: session.id, content },
      });
      expect(emitted.errors).toBeUndefined();
      statuses.push(emitted.data?.agentActivityCreate.agentActivity.agentSession.status);
    }

    expect(statuses).toEqual(["active", "active", "awaitingInput", "complete"]);
  });

  it("stamps the session's updatedAt when an activity moves it", async () => {
    const commands = domain();
    const issue = commands.listIssues()[0]!;
    const session = await commands.createAgentSessionOnIssue({ issueId: issue.id });

    await commands.createAgentActivity({
      agentSessionId: session.id,
      content: { type: "response", body: "done" },
    });

    const after = commands.requireAgentSession(session.id);
    expect(after.status).toBe("complete");
    expect(after.updatedAt).not.toBe(session.updatedAt);
  });
});

describe("content is Linear's AgentActivityContent, not a free-text body (F-1176)", () => {
  it("round-trips an action's action/parameter/result, which carry no body upstream", async () => {
    const instance = app();
    const session = await newSession(instance);

    const emitted = await graphql(instance, CREATE_ACTIVITY, {
      input: {
        agentSessionId: session.id,
        content: { type: "action", action: "search", parameter: "twin", result: "4 hits" },
      },
    });

    expect(emitted.errors).toBeUndefined();
    expect(emitted.data?.agentActivityCreate.agentActivity.content).toEqual({
      type: "action",
      action: "search",
      parameter: "twin",
      result: "4 hits",
    });
  });

  it("refuses a body on an action, and an action on a thought", async () => {
    const instance = app();
    const session = await newSession(instance);

    for (const content of [
      { type: "action", body: "searched for twin" },
      { type: "thought", body: "thinking", action: "search" },
    ]) {
      const emitted = await graphql(instance, CREATE_ACTIVITY, {
        input: { agentSessionId: session.id, content },
      });
      expect(emitted.errors?.[0]?.message).toMatch(/Invalid agent activity content/);
    }
  });

  it("refuses a type Linear does not have", async () => {
    const instance = app();
    const session = await newSession(instance);

    const emitted = await graphql(instance, CREATE_ACTIVITY, {
      input: { agentSessionId: session.id, content: { type: "musing", body: "hmm" } },
    });

    expect(emitted.errors?.[0]?.message).toMatch(/Invalid agent activity content/);
  });

  it("carries prompt's title and error's reasonCode, and an agent's bodyData", async () => {
    const instance = app();
    const session = await newSession(instance);

    const prompted = await graphql(instance, CREATE_ACTIVITY, {
      input: {
        agentSessionId: session.id,
        content: { type: "prompt", body: "review this", title: "Review", bodyData: { blocks: 1 } },
      },
    });
    expect(prompted.errors).toBeUndefined();
    expect(prompted.data?.agentActivityCreate.agentActivity.content).toMatchObject({
      title: "Review",
      bodyData: { blocks: 1 },
    });

    const failed = await graphql(instance, CREATE_ACTIVITY, {
      input: {
        agentSessionId: session.id,
        content: { type: "error", body: "rate limited", reasonCode: "RATE_LIMIT" },
      },
    });
    expect(failed.errors).toBeUndefined();
    expect(failed.data?.agentActivityCreate.agentActivity.content).toMatchObject({
      reasonCode: "RATE_LIMIT",
    });
  });

  it("defaults ephemeral from the content's type, as it did from the old type field", async () => {
    const instance = app();
    const session = await newSession(instance);

    const thought = await graphql(instance, CREATE_ACTIVITY, {
      input: { agentSessionId: session.id, content: { type: "thought", body: "thinking" } },
    });
    const response = await graphql(instance, CREATE_ACTIVITY, {
      input: { agentSessionId: session.id, content: { type: "response", body: "done" } },
    });

    expect(thought.data?.agentActivityCreate.agentActivity.ephemeral).toBe(true);
    expect(response.data?.agentActivityCreate.agentActivity.ephemeral).toBe(false);
  });
});

describe("signal, agentSession and user complete the AgentActivity surface (F-1176)", () => {
  it("round-trips a signal and refuses one Linear does not declare", async () => {
    const instance = app();
    const session = await newSession(instance);

    const stopped = await graphql(instance, CREATE_ACTIVITY, {
      input: {
        agentSessionId: session.id,
        content: { type: "response", body: "stopping" },
        signal: "stop",
      },
    });
    expect(stopped.errors).toBeUndefined();
    expect(stopped.data?.agentActivityCreate.agentActivity.signal).toBe("stop");

    const bogus = await graphql(instance, CREATE_ACTIVITY, {
      input: {
        agentSessionId: session.id,
        content: { type: "response", body: "halting" },
        signal: "halt",
      },
    });
    expect(bogus.errors?.[0]?.message).toMatch(/Value "halt" does not exist in "AgentActivitySignal"/);
  });

  it("leaves signal null when the agent sends none", async () => {
    const instance = app();
    const session = await newSession(instance);

    const emitted = await graphql(instance, CREATE_ACTIVITY, {
      input: { agentSessionId: session.id, content: { type: "thought", body: "thinking" } },
    });

    expect(emitted.data?.agentActivityCreate.agentActivity.signal).toBeNull();
  });

  it("names the session `agentSession` and always has a user", async () => {
    const instance = app();
    const session = await newSession(instance);

    const emitted = await graphql(instance, CREATE_ACTIVITY, {
      input: { agentSessionId: session.id, content: { type: "thought", body: "thinking" } },
    });

    const activity = emitted.data?.agentActivityCreate.agentActivity;
    expect(activity.agentSession.id).toBe(session.id);
    expect(activity.user.id).toBeTruthy();

    // `session` was the twin's own spelling; Linear has no such field.
    const stale = await graphql(
      instance,
      `query ($id: String!) { agentSession(id: $id) { activities(first: 5) { nodes { session { id } } } } }`,
      { id: session.id }
    );
    expect(stale.errors?.[0]?.message).toMatch(/Cannot query field "session" on type "AgentActivity"/);
  });

  it("reads the activities back off the session in order", async () => {
    const instance = app();
    const session = await newSession(instance);
    for (const body of ["first", "second"]) {
      await graphql(instance, CREATE_ACTIVITY, {
        input: { agentSessionId: session.id, content: { type: "thought", body } },
      });
    }

    const read = await graphql(
      instance,
      `query ($id: String!) {
         agentSession(id: $id) { status activities(first: 10) { nodes { content } } }
       }`,
      { id: session.id }
    );

    expect(read.errors).toBeUndefined();
    expect(read.data?.agentSession.activities.nodes.map((node: any) => node.content.body)).toEqual([
      "first",
      "second",
    ]);
    expect(read.data?.agentSession.status).toBe("active");
  });
});

// The `AgentSessionEvent` / `prompted` webhook is a documented twin behaviour
// (REFERENCE-DIVERGENCES.md). Its `status` used to be read off the session
// BEFORE the activity landed, which was harmless while nothing moved the
// session and is a lie now that the activity is what moves it.
describe("the prompted webhook carries the status the activity produced (F-1176)", () => {
  it("reports pending after a prompt lands on an active session", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const commands = new LinearDomain(db);
    // The destination is refused by the SSRF guard, which is fine: the delivery
    // and its payload are recorded either way.
    commands.seed(
      testSeed({
        webhooks: [
          {
            id: "webhook_agent",
            label: "Agent sessions",
            url: "http://127.0.0.1:9/blocked",
            resourceTypes: ["AgentSessionEvent"],
            allPublicTeams: true,
            enabled: true,
          },
        ],
      })
    );
    const issue = commands.listIssues()[0]!;
    const session = await commands.createAgentSessionOnIssue({ issueId: issue.id });

    await commands.createAgentActivity({
      agentSessionId: session.id,
      content: { type: "thought", body: "working" },
    });
    expect(commands.requireAgentSession(session.id).status).toBe("active");

    await commands.createAgentActivity({
      agentSessionId: session.id,
      content: { type: "prompt", body: "which team owns this?" },
    });

    const prompted = (exportLinearState(db).webhookDeliveries as Array<Record<string, any>>).find(
      (delivery) => delivery.action === "prompted"
    );
    expect(prompted?.payload.data).toMatchObject({ id: session.id, status: "pending" });
    expect(commands.requireAgentSession(session.id).status).toBe("pending");
  });
});
