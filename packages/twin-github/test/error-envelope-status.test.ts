// SPDX-License-Identifier: Apache-2.0
// `status` in the error envelope is a STRING, as real GitHub sends it: 59/59 probed
// live 2026-08-12; 5xx and 429 are inferred from GitHub's `basic-error`.

import { describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { githubError } from "../src/errors.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;
process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function rest(app: ReturnType<typeof createGitHubCloneApp>, method: string, path: string, body?: unknown) {
  const token = await signTestToken();
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(token, init));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function mcp(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  const token = await signTestToken();
  const response = await app.request(
    `${base}/mcp/call`,
    withAuth(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, arguments: args }) })
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("the envelope builder always renders `status` as a string", () => {
  it("stringifies every status it is handed", () => {
    // The teeth, on the helper rather than on one route. Written as data so a
    // status class the twin gains is covered without editing an assertion.
    for (const code of [400, 401, 403, 404, 409, 422, 500, 501, 503]) {
      expect(githubError("x", code)).toMatchObject({ status: String(code) });
      expect(typeof githubError("x", code).status).toBe("string");
    }
  });

  it("does not disturb the other three leaves", () => {
    // The generic url is what GitHub sends where it names no operation. The
    // DOOR supplies the specific one.
    expect(githubError("Not Found", 404)).toEqual({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
      status: "404"
    });
    expect(githubError("Validation Failed", 422, [{ resource: "Request", field: "q", code: "missing" }], "https://docs.github.com/rest/search/search#search-code")).toEqual({
      message: "Validation Failed",
      documentation_url: "https://docs.github.com/rest/search/search#search-code",
      status: "422",
      errors: [{ resource: "Request", field: "q", code: "missing" }]
    });
  });

  it("keeps the HTTP status a NUMBER — only the body leaf is a string", async () => {
    // The one way this change could go wrong is by stringifying the wrong
    // `status`: `githubErrorEnvelope` returns {status, body} where the outer one
    // is what the engine writes to the status line. A string there would break
    // every response, so this asserts the two are deliberately different types.
    const app = createGitHubCloneApp();
    const got = await rest(app, "GET", "/repos/acme/nope");

    expect(got.status).toBe(404);
    expect(typeof got.status).toBe("number");
    expect((got.body as { status: unknown }).status).toBe("404");
  });
});

describe("on the wire, across every error class the twin can be made to emit", () => {
  it("404 from a read", async () => {
    const app = createGitHubCloneApp();
    // This route names its own operation, as GitHub did on all 45 routed,
    // authenticated errors measured. `status` is untouched.
    expect(await rest(app, "GET", "/repos/acme/nope")).toEqual({
      status: 404,
      body: {
        message: "Not Found",
        documentation_url: "https://docs.github.com/rest/repos/repos#get-a-repository",
        status: "404"
      }
    });
  });

  it("422 from the zod branch — a missing required body field", async () => {
    const app = createGitHubCloneApp();
    const got = await rest(app, "POST", "/repos/acme/api/issues", { body: "no title" });
    expect(got.status).toBe(422);
    expect(got.body).toMatchObject({ message: "Validation Failed", status: "422" });
  });

  it("422 from the domain — a duplicate label", async () => {
    const app = createGitHubCloneApp();
    const got = await rest(app, "POST", "/repos/acme/api/labels", { name: "bug", color: "ffffff" });
    expect(got.status).toBe(422);
    expect(got.body).toMatchObject({ message: "Validation Failed", status: "422" });
  });

  it("409 from the contents door's optimistic locking, now with a string", async () => {
    const app = createGitHubCloneApp();
    const seeded = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", { message: "seed", content: b64("hello\n"), branch: "main" });
    expect(seeded.status).toBe(201);

    expect(await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", { message: "again", content: b64("x\n"), branch: "main", sha: "deadbeef" })).toEqual({
      status: 409,
      body: {
        message: "probe.txt does not match deadbeef",
        documentation_url: "https://docs.github.com/rest/repos/contents#create-or-update-file-contents",
        status: "409"
      }
    });
  });

  it("400 from the JSON-parse branch", async () => {
    const app = createGitHubCloneApp();
    const got = await rest(app, "POST", "/repos/acme/api/issues", "{");
    expect(got.status).toBe(400);
    expect(got.body).toMatchObject({ message: "Problems parsing JSON", status: "400" });
  });

  it("422 from the unknown-tool branch on the MCP door", async () => {
    const app = createGitHubCloneApp();
    const got = await mcp(app, "no_such_tool_at_all", { owner: "acme", repo: "api" });
    expect(got.status).toBe(422);
    expect(got.body).toMatchObject({ message: "Validation Failed", status: "422" });
  });

  it("422 from the MCP door's own validation", async () => {
    const app = createGitHubCloneApp();
    const got = await mcp(app, "create_issue", { owner: "acme", repo: "api" });
    expect(got.status).toBe(422);
    expect(got.body).toMatchObject({ status: "422" });
  });
});

describe("the 401 envelopes now carry both leaves", () => {
  it("a BAD credential answers GitHub's 401 body, whole (was divergence 31)", async () => {
    const app = createGitHubCloneApp();

    // Re-measured live 2026-08-13, `GET /user` with a bad bearer. The whole
    // body, not the two leaves: dropping `message` would pass a per-leaf check.
    const got = await app.request(`${base}/repos/acme/api`, { headers: { authorization: "Bearer ghp_pome_not_a_real_token" } });
    expect(got.status).toBe(401);
    expect(typeof got.status).toBe("number");

    expect(await got.json()).toEqual({
      message: "Bad credentials",
      documentation_url: "https://docs.github.com/rest",
      status: "401"
    });
  });

  it("a MISSING credential says `Requires authentication`, not `Bad credentials`", async () => {
    const app = createGitHubCloneApp();

    // Same probe, no `Authorization` header at all — which is why
    // `unauthorized` takes `kind`. The twin used to answer `Bad credentials`.
    const got = await app.request(`${base}/repos/acme/api`);
    expect(got.status).toBe(401);

    expect(await got.json()).toEqual({
      message: "Requires authentication",
      documentation_url: "https://docs.github.com/rest",
      status: "401"
    });
  });

  it("a sid mismatch stays `Forbidden`, and gains the same two leaves", async () => {
    // A twin-only failure mode — GitHub has no session id — rendered in
    // GitHub's 401 family, carrying the leaves every GitHub 401 does.
    const app = createGitHubCloneApp();
    const token = await signTestToken({ sid: "someone-else" });
    const got = await app.request(`${base}/repos/acme/api`, withAuth(token));
    expect(got.status).toBe(401);

    expect(await got.json()).toEqual({
      message: "Forbidden",
      documentation_url: "https://docs.github.com/rest",
      status: "401"
    });
  });

  it("the admin-gate 403 is github-shaped too, and no longer the SDK's default", async () => {
    // Generic url on purpose: `/admin/*` is a twin-only route with no GitHub
    // operation behind it, same as `/pulls/:n/diff` (divergence 32).
    const previous = process.env.TWIN_ADMIN_TOKEN;
    process.env.TWIN_ADMIN_TOKEN = "f1497-admin-token";
    try {
      const app = createGitHubCloneApp();
      const got = await app.request("/admin/reset", { method: "POST" });
      expect(got.status).toBe(403);

      expect(await got.json()).toEqual({
        message: "Forbidden",
        documentation_url: "https://docs.github.com/rest",
        status: "403"
      });
    } finally {
      if (previous === undefined) delete process.env.TWIN_ADMIN_TOKEN;
      else process.env.TWIN_ADMIN_TOKEN = previous;
    }
  });

  it("the 501 catch-all carries no status leaf either", async () => {
    const app = createGitHubCloneApp();
    const got = await rest(app, "GET", "/repos/acme/api/actions/runs");
    expect(got.status).toBe(501);
    expect("status" in (got.body as object)).toBe(false);
  });

  it("the 401 and the 501 catch-all still name NO operation — and must not", async () => {
    const app = createGitHubCloneApp();

    // The part of divergence 32 that was never a gap: GitHub answers generically
    // on every 401 and unrouted path. `.not.toContain` catches an operation url.
    const generic = "https://docs.github.com/rest";
    for (const init of [
      { headers: { authorization: "Bearer ghp_pome_not_a_real_token" } },
      {}, // no Authorization header at all — GitHub is generic here too (8/8)
    ]) {
      const unauthorized = await app.request(`${base}/repos/acme/api`, init);
      expect(unauthorized.status).toBe(401);
      const url = ((await unauthorized.json()) as { documentation_url: string }).documentation_url;
      expect(url).toBe(generic);
      expect(url).not.toContain("#");
    }

    const unrouted = await rest(app, "GET", "/repos/acme/api/actions/runs");
    expect(unrouted.status).toBe(501);
    expect(JSON.stringify(unrouted.body)).not.toContain("docs.github.com");
  });
});
