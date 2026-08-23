// SPDX-License-Identifier: Apache-2.0
// `documentation_url` names the operation the caller asked for, and stays generic
// exactly where real GitHub stays generic.

import { describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { GITHUB_ROUTE_INPUTS } from "../src/route-inputs.js";
import { toolArgumentSchemas } from "../src/tools.js";
import {
  MCP_OPERATION_ENTRIES,
  OPERATION_DOCS,
  REST_OPERATION_IDS,
  restOperationDocumentationUrl,
  toolOperationDocumentationUrl,
} from "../src/operation-docs.js";
import { githubToolInputSchema } from "../src/tools.js";
import type { OperationDocsArtifact } from "../src/operation-docs.js";
import committedArtifact from "../fixtures/operation-docs.raw.json" with { type: "json" };
import { verifyOperationDocs } from "../scripts/operation-docs-artifact.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;
process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;

const GENERIC = "https://docs.github.com/rest";

async function rest(method: string, path: string, body?: unknown) {
  const app = createGitHubCloneApp();
  const token = await signTestToken();
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(token, init));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

/** One MCP tool call over the legacy dispatch surface, on a fresh world. */
async function mcp(tool: string, args: unknown, app = createGitHubCloneApp()) {
  const token = await signTestToken();
  const response = await app.request(
    `${base}/mcp/call`,
    withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args }),
    })
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

const docUrl = (body: Record<string, unknown>) => body.documentation_url;

describe("a routed, authenticated error names its operation", () => {
 it("404 on GET /repos/:owner/:repo — the exact case pinned as generic", async () => {
    const got = await rest("GET", "/repos/acme/nope");
    expect(got.status).toBe(404);
    expect(got.body).toEqual({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest/repos/repos#get-a-repository",
      status: "404",
    });
  });

  it("404 from `requireRepo` reached through a DIFFERENT door answers that door's url", async () => {
    // The whole point: one `notFound()` inside `domain.requireRepo()`, two
    // callers, two urls. A throw-site constant cannot do this.
    expect(docUrl((await rest("GET", "/repos/acme/nope/issues")).body)).toBe(
      "https://docs.github.com/rest/issues/issues#list-repository-issues"
    );
    expect(docUrl((await rest("GET", "/repos/acme/nope/pulls")).body)).toBe(
      "https://docs.github.com/rest/pulls/pulls#list-pull-requests"
    );
    expect(docUrl((await rest("GET", "/repos/acme/nope/branches")).body)).toBe(
      "https://docs.github.com/rest/branches/branches#list-branches"
    );
  });

  it("422 from the declaration's own validation carries it too", async () => {
    // GitHub's 14 measured 422s were operation-specific like the 404s; the
    // envelope is per-DOOR, so it covers the zod branch as well as the domain's.
    const got = await rest("POST", "/repos/acme/api/issues", { body: "no title" });
    expect(got.status).toBe(422);
    expect(got.body).toMatchObject({
      message: "Validation Failed",
      documentation_url: "https://docs.github.com/rest/issues/issues#create-an-issue",
    });
  });

 it("does not overwrite a url the throw site already knew (the 409)", async () => {
    const app = createGitHubCloneApp();
    const token = await signTestToken();
    const put = (body: unknown) =>
      app.request(
        `${base}/repos/acme/api/contents/probe.txt`,
        withAuth(token, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    const seeded = await put({
      message: "seed",
      content: Buffer.from("hello\n", "utf8").toString("base64"),
      branch: "main",
    });
    expect(seeded.status).toBe(201);
    const conflict = await put({
      message: "again",
      content: Buffer.from("x\n", "utf8").toString("base64"),
      branch: "main",
      sha: "deadbeef",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      documentation_url: "https://docs.github.com/rest/repos/contents#create-or-update-file-contents",
    });
  });

  it("every route that maps to an operation serves that operation's url", () => {
    // The plumbing half: 64 of the 66 mounted surfaces resolve, and the reader
    // answers for each. The literals above are what says the values are right.
    const mounted = GITHUB_ROUTE_INPUTS.map((declaration) => declaration.surface);
    const mapped = mounted.filter((surface) => REST_OPERATION_IDS[surface]);
    expect(mapped).toHaveLength(64);
    for (const surface of mapped) {
      const url = restOperationDocumentationUrl(surface);
      expect(url, surface).toBe(OPERATION_DOCS[REST_OPERATION_IDS[surface]!]!.url);
      expect(url, surface).toMatch(/^https:\/\/docs\.github\.com\/rest\/[a-z-]+\/[a-z-]+#/);
    }
  });
});

describe("the three classes GitHub answers GENERICALLY stay generic", () => {
  it("a 401 names no operation — authentication fails before dispatch (8/8 measured)", async () => {
    const app = createGitHubCloneApp();
    const got = await app.request(`${base}/repos/acme/api`, {
      headers: { authorization: "Bearer ghp_pome_not_a_real_token" },
    });
    expect(got.status).toBe(401);

    // ⚠️ THE URL MOVED FROM `""` TO `GENERIC`, AND THE ASSERTION DID NOT SOFTEN.
    const body = (await got.json()) as Record<string, unknown>;
    expect(body).toEqual({
      message: "Bad credentials",
      documentation_url: GENERIC,
      status: "401",
    });
    expect(String(body.documentation_url)).not.toContain("#");
  });

  it("a 401 with NO Authorization header is generic too, and says the other thing", async () => {
    // GitHub's 8/8 generic 401s include the header-less probes.
    const app = createGitHubCloneApp();
    const got = await app.request(`${base}/repos/acme/api`);
    expect(got.status).toBe(401);

    const body = (await got.json()) as Record<string, unknown>;
    expect(body).toEqual({
      message: "Requires authentication",
      documentation_url: GENERIC,
      status: "401",
    });
    expect(String(body.documentation_url)).not.toContain("#");
  });

  it("an unrouted path names no operation — the 501 catch-all (4/4 measured)", async () => {
    const got = await rest("GET", "/repos/acme/api/actions/runs");
    expect(got.status).toBe(501);
    expect("documentation_url" in got.body).toBe(false);
    expect(JSON.stringify(got.body)).not.toContain("docs.github.com");
  });

  it("the two twin-only routes stay generic — GitHub has no operation to name", async () => {
    // `/pulls/:n/diff` and `/pulls/:n/status` are this twin's own paths. GitHub
    // serves a diff off `pulls/get` with a media type and a status off
    // `/commits/{ref}/status`, so there is no operation this url could name.
    expect(REST_OPERATION_IDS["GET /repos/:owner/:repo/pulls/:number/diff"]).toBeNull();
    expect(REST_OPERATION_IDS["GET /repos/:owner/:repo/pulls/:number/status"]).toBeNull();
    expect(docUrl((await rest("GET", "/repos/acme/nope/pulls/1/diff")).body)).toBe(GENERIC);
    expect(docUrl((await rest("GET", "/repos/acme/nope/pulls/1/status")).body)).toBe(GENERIC);
  });
});

describe("the MCP door, decided per tool", () => {
  it("a single-operation tool answers its operation's url", async () => {
    const got = await mcp("get_file_contents", { owner: "acme", repo: "nope", path: "README.md" });
    expect(got.status).toBe(404);
    expect(docUrl(got.body)).toBe("https://docs.github.com/rest/repos/contents#get-repository-content");
  });

  it("a per-method tool answers the method's operation, not the tool's", async () => {
    expect(
      docUrl((await mcp("pull_request_read", { method: "get_files", owner: "acme", repo: "nope", pullNumber: 1 })).body)
    ).toBe("https://docs.github.com/rest/pulls/pulls#list-pull-requests-files");
    expect(
      docUrl((await mcp("pull_request_read", { method: "get_reviews", owner: "acme", repo: "nope", pullNumber: 1 })).body)
    ).toBe("https://docs.github.com/rest/pulls/reviews#list-reviews-for-a-pull-request");
    // A PR's conversation is issue comments, and so is its url.
    expect(
      docUrl((await mcp("pull_request_read", { method: "get_comments", owner: "acme", repo: "nope", pullNumber: 1 })).body)
    ).toBe("https://docs.github.com/rest/issues/comments#list-issue-comments");
    expect(
      docUrl((await mcp("issue_read", { method: "get", owner: "acme", repo: "nope", issue_number: 1 })).body)
    ).toBe("https://docs.github.com/rest/issues/issues#get-an-issue");
  });

  it("a method this twin 501-refuses stays generic — its refusal is not GitHub's error", async () => {
    const got = await mcp("issue_read", { method: "get_sub_issues", owner: "acme", repo: "api", issue_number: 1 });
    expect(got.status).toBe(501);
    expect(docUrl(got.body)).toBe(GENERIC);
  });

  it("create_repository splits on the argument, because GitHub splits on the route", async () => {
    const app = createGitHubCloneApp();
    // `owner` present → the org route (`POST /orgs/{org}/repos`).
    expect(docUrl((await mcp("create_repository", { name: "api", owner: "acme" }, app)).body)).toBe(
      "https://docs.github.com/rest/repos/repos#create-an-organization-repository"
    );
    // `owner` absent → the authenticated-user route (`POST /user/repos`).
    expect((await mcp("create_repository", { name: "solo" }, app)).status).toBe(200);
    expect(docUrl((await mcp("create_repository", { name: "solo" }, app)).body)).toBe(
      "https://docs.github.com/rest/repos/repos#create-a-repository-for-the-authenticated-user"
    );
  });

  it("an unmappable tool stays generic, and says why on the artifact", async () => {
    // `get_tag` is two upstream legs — `git/get-ref` then `git/get-tag` — and a
    // not-found does not identify which one would have raised it.
    const got = await mcp("get_tag", { owner: "acme", repo: "nope", tag: "v1.0.0" });
    expect(got.status).toBe(404);
    expect(docUrl(got.body)).toBe(GENERIC);
    for (const tool of ["push_files", "create_branch", "get_tag"]) {
      expect(toolOperationDocumentationUrl(tool, {}), tool).toBeUndefined();
    }
  });

  it("the streamable-HTTP JSON-RPC door answers the same url as the legacy shim", async () => {
    // Three MCP surfaces reach `executeTool` — `/mcp` (JSON-RPC), `/mcp/call`
    // and `/mcp/tools/:name` — and the stamp is on the dispatcher, so it cannot
    // be right on one and wrong on another. Driven here rather than assumed.
    const app = createGitHubCloneApp();
    const token = await signTestToken();
    const response = await app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "list_branches", arguments: { owner: "acme", repo: "nope" } },
        }),
      })
    );
    const rpc = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(rpc.result.isError).toBe(true);
    expect(JSON.parse(rpc.result.content[0]!.text)).toMatchObject({
      documentation_url: "https://docs.github.com/rest/branches/branches#list-branches",
    });
  });

  it("the MCP door's own argument refusal stays generic", async () => {
    // Before the arguments parse, a per-method tool does not KNOW its operation
    // — and GitHub's MCP server refuses bad arguments itself rather than
    // proxying a REST error, so there is nothing to name here either.
    const got = await mcp("create_issue", { owner: "acme", repo: "api" });
    expect(got.status).toBe(422);
    expect(docUrl(got.body)).toBe(GENERIC);
  });

  it("all 36 served tools are decided — 33 named, 3 registered unmappable", () => {
    const served = toolArgumentSchemas.map((tool) => tool.name).sort();
    expect(served).toHaveLength(36);
    const decided = served.filter((name) => MCP_OPERATION_ENTRIES[name] !== null);
    const unmappable = served.filter((name) => MCP_OPERATION_ENTRIES[name] === null);
    expect(decided).toHaveLength(33);
    expect(unmappable).toEqual(["create_branch", "get_tag", "push_files"]);
  });
});

describe("the vendored artifact's gate", () => {
  const surfaces = GITHUB_ROUTE_INPUTS.map((declaration) => declaration.surface);
  const toolMethods: Record<string, readonly string[] | undefined> = Object.fromEntries(
    toolArgumentSchemas.map((tool) => {
      const properties = (githubToolInputSchema(tool.schema as never).properties ?? {}) as Record<
        string,
        { enum?: unknown }
      >;
      const values = properties.method?.enum;
      return [tool.name, Array.isArray(values) ? (values as string[]) : undefined];
    })
  );
  const clone = () => JSON.parse(JSON.stringify(committedArtifact)) as OperationDocsArtifact;
  const verify = (artifact: OperationDocsArtifact) =>
    verifyOperationDocs({ artifact, surfaces, toolMethods });

  it("passes on the committed artifact", () => {
    expect(verify(clone())).toEqual([]);
  });

  it("reds when a surface is mounted and unmapped", () => {
    const artifact = clone();
    delete artifact.rest["GET /repos/:owner/:repo"];
    expect(verify(artifact).join("\n")).toContain("rest keys are not the twin's mounted surfaces");
  });

  it("reds when a pairing is re-pointed at another operation", () => {
    const artifact = clone();
    artifact.rest["GET /repos/:owner/:repo"] = "issues/get";
    expect(verify(artifact).join("\n")).toContain("whose path shape is not the surface's");
  });

  it("reds when a url stops matching its own category/subcategory", () => {
    const artifact = clone();
    artifact.operations["repos/get"]!.url = "https://docs.github.com/rest/issues/issues#get-an-issue";
    expect(verify(artifact).join("\n")).toContain("was edited by hand");
  });

  it("reds when a tool is dropped to unmappable without a reason", () => {
    const artifact = clone();
    artifact.mcp.get_commit = null;
    expect(verify(artifact).join("\n")).toContain("UNMAPPABLE_TOOLS gives no reason");
  });

  it("reds when a mapped method is not one the tool's schema accepts", () => {
    const artifact = clone();
    const entry = artifact.mcp.issue_read as { byMethod: Record<string, string> };
    entry.byMethod.get_ancestors = "issues/get";
    expect(verify(artifact).join("\n")).toContain("names a door that cannot be knocked on");
  });

  it("reds when the artifact carries an operation no door names", () => {
    const artifact = clone();
    artifact.operations["issues/lock"] = {
      method: "PUT",
      path: "/repos/{owner}/{repo}/issues/{issue_number}/lock",
      category: "issues",
      subcategory: "issues",
      url: "https://docs.github.com/rest/issues/issues#lock-an-issue",
    };
    expect(verify(artifact).join("\n")).toContain("which no door names");
  });
});
