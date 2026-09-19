// SPDX-License-Identifier: Apache-2.0
//
// Read or write, for the three transports that send every call as a POST.
//
// Before this, `requestKind` answered from the HTTP method for anything that was
// not an MCP tool, so every Linear GraphQL query and every Slack SDK read — the
// official `@slack/web-api` client POSTs `conversations.list` — came out as a
// write that "did not land". The dashboard puts that sentence in its headline,
// so a misread there is not a cosmetic bug: it tells a newcomer the agent failed
// when it did nothing wrong (F-1850).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { graphqlOperationKind, requestKind, tapeRows } from "../../../src/twin/twinTape.js";

const gql = (query: string, operationName?: string) => ({
  query,
  ...(operationName ? { operationName } : {}),
});

describe("GraphQL is read by its operation, not by its POST", () => {
  it.each([
    ["the { } shorthand", gql("{ viewer { id name } }"), "read"],
    ["a named query", gql("query Issues { issues { nodes { id } } }"), "read"],
    ["a subscription", gql("subscription { issueUpdated { id } }"), "read"],
    ["an anonymous mutation", gql('mutation { issueCreate(input: {title: "x"}) { success } }'), "write"],
    ["a named mutation", gql("mutation Create($i: IssueCreateInput!) { issueCreate(input: $i) { success } }"), "write"],
  ])("%s", (_label, body, kind) => {
    expect(requestKind("POST", "/graphql", null, body)).toBe(kind);
  });

  it("is not fooled by a fragment defined before the operation", () => {
    // The fragment's selection set sits at depth zero too; taking it for the
    // `{ }` query shorthand is what turned this mutation into a read.
    const body = gql("fragment F on Issue { id } mutation { issueCreate(input: {}) { issue { ...F } } }");
    expect(graphqlOperationKind(body)).toBe("write");
  });

  it("is not fooled by an object default in the variables", () => {
    const body = gql("mutation M($f: Filter = {state: {eq: 1}}) { issueUpdate(filter: $f) { success } }");
    expect(graphqlOperationKind(body)).toBe("write");
  });

  it("is not fooled by the word inside a string or a comment", () => {
    expect(graphqlOperationKind(gql('{ search(term: "mutation { x }") { id } }'))).toBe("read");
    expect(graphqlOperationKind(gql("# mutation {}\n{ viewer { id } }"))).toBe("read");
  });

  it("reads the operation the request names when there are several", () => {
    const doc = "query A { viewer { id } } mutation B { issueDelete(id: 1) { success } }";
    expect(graphqlOperationKind(gql(doc, "A"))).toBe("read");
    expect(graphqlOperationKind(gql(doc, "B"))).toBe("write");
  });

  it("calls a batch a write if any member is one", () => {
    expect(graphqlOperationKind([gql("{ a }"), gql("mutation { b }")])).toBe("write");
    expect(graphqlOperationKind([gql("{ a }"), gql("{ b }")])).toBe("read");
  });

  it("falls to read — the safe direction — when it cannot tell", () => {
    // A write read as a read loses a mark. A read read as a write prints a
    // false "did not land". Only the first is recoverable.
    for (const body of [undefined, null, "raw", {}, { query: 7 }, gql("")]) {
      expect(requestKind("POST", "/graphql", null, body)).toBe("read");
    }
  });

  it("reads GraphQL over GET as a read, because GET cannot carry a mutation", () => {
    expect(requestKind("GET", "/graphql", null, undefined)).toBe("read");
  });
});

describe("Slack's Web API is read by its method name", () => {
  // Every method the Slack twin declares, with the kind it declares it as. The
  // twin's own declaration is the source of truth, so a method added there is
  // covered here the day it ships.
  const declared = readFileSync(
    new URL("../../../../packages/twin-slack/src/route-inputs.ts", import.meta.url),
    "utf8",
  );
  const methods = [...declared.matchAll(/slack(Read|Write)\("(\/[a-zA-Z.]+)"/g)].map(
    ([, kind, path]) => ({ path: path!, kind: kind === "Write" ? "write" : "read" }) as const,
  );

  it("finds the declarations it is checking against", () => {
    expect(methods.length).toBeGreaterThan(30);
    expect(methods.some((method) => method.kind === "write")).toBe(true);
  });

  it.each(["POST", "GET"])("agrees with the twin on every method, over %s", (http) => {
    // Slack accepts either verb for every method, so the HTTP method must not
    // decide: `GET /chat.postMessage?…` is still a write.
    const wrong = methods.filter((method) => requestKind(http, method.path, null) !== method.kind);
    expect(wrong).toEqual([]);
  });
});

type DeclaredTool = { name: string; annotations?: { readOnlyHint?: boolean } };

describe("an MCP tool is read the way the tool itself declares", () => {
  // MCP's `annotations.readOnlyHint` is each twin's own statement of what a
  // tool does. The verb list is a guess; this is the answer key. A real Claude
  // Code session found the first two misses — `issue_write` read as a read, so
  // a failed one would never have been marked — and checking every declared
  // tool found three more in Linear and one the other way, `pull_request_read`,
  // read as a write that "did not land" on every call.
  const declared = (["github", "slack", "stripe", "gmail", "linear"] as const).flatMap((twin) => {
    const listing = JSON.parse(
      readFileSync(
        new URL(`../../../../packages/twin-${twin}/fixtures/mcp-tools-list.canonical.json`, import.meta.url),
        "utf8",
      ),
    ) as {
      tools?: DeclaredTool[];
      // Some captures keep the JSON-RPC envelope around the listing.
      result?: { tools?: DeclaredTool[] };
    };
    return (listing.tools ?? listing.result?.tools ?? [])
      .filter((tool) => typeof tool.annotations?.readOnlyHint === "boolean")
      .map((tool) => ({
        twin,
        tool: tool.name,
        kind: tool.annotations!.readOnlyHint ? "read" : "write",
      }));
  });

  it("finds the declarations it is checking against", () => {
    // Stripe declares none; the other four declare nearly all of theirs.
    expect(declared.length).toBeGreaterThan(80);
  });

  it("agrees with every tool that declares readOnlyHint", () => {
    const wrong = declared
      .filter(({ tool, kind }) => requestKind("POST", "/mcp", tool) !== kind)
      .map(({ twin, tool, kind }) => `${twin}:${tool} declares ${kind}`);
    expect(wrong).toEqual([]);
  });
});

describe("what did not change", () => {
  it("still reads a REST route by its method", () => {
    expect(requestKind("GET", "/repos/acme/api", null)).toBe("read");
    expect(requestKind("POST", "/repos/acme/api/issues", null)).toBe("write");
    expect(requestKind("PATCH", "/repos/acme/api/issues/2", null)).toBe("write");
  });

  it("does not mistake a dotted file path for a Slack method", () => {
    // One segment is the discriminator; this is five.
    expect(requestKind("PUT", "/repos/acme/api/contents/src/index.ts", null)).toBe("write");
    expect(requestKind("DELETE", "/repos/acme/api/contents/README.md", null)).toBe("write");
  });

  it("still reads an MCP tool by its verb", () => {
    expect(requestKind("POST", "/mcp", "create_issue")).toBe("write");
    expect(requestKind("POST", "/mcp", "list_issues")).toBe("read");
    // `schedule` joined the verb list for Slack, and it fixes this one too.
    expect(requestKind("POST", "/mcp", "slack_schedule_message")).toBe("write");
  });
});

describe("on the tape", () => {
  // A real recorded event as the base, re-pointed at Linear's GraphQL door — a
  // hand-built row would test the schema's patience rather than the reading.
  const recorded = (
    JSON.parse(
      readFileSync(new URL("../../fixtures/twin-tape/github-events.json", import.meta.url), "utf8"),
    ) as Array<Record<string, unknown>>
  )[0]!;
  const event = (over: Record<string, unknown>) => ({
    ...recorded,
    twin: "linear",
    tool: null,
    method: "POST",
    path: "/s/standalone/graphql",
    status: 200,
    state_mutation: false,
    state_delta: null,
    error: null,
    ...over,
  });

  it("marks nothing on a Linear query, where it used to say the write did not land", () => {
    const [row] = tapeRows([event({ request_body: gql("{ viewer { id name } }") })], "/s/standalone");
    expect(row).toMatchObject({ kind: "read", note: null });
  });

  it("still marks a Linear mutation the twin refused", () => {
    const [row] = tapeRows(
      [
        event({
          status: 400,
          error: "request failed",
          request_body: gql("mutation { issueCreate(input: {}) { success } }"),
        }),
      ],
      "/s/standalone",
    );
    expect(row?.kind).toBe("write");
    expect(row?.note).toMatch(/^write did not land \(400\)/);
  });
});
