// SPDX-License-Identifier: Apache-2.0
// F-1490 — `status` in the error envelope is a STRING, the way real GitHub sends it.
//
// ── THE MEASUREMENT THIS FILE PINS ────────────────────────────────────────
//
// Probed live against `api.github.com` on 2026-08-12 (two throwaway private
// repos, both deleted; `.context/probe-*.sh` are the transcripts). **59 of 59**
// error responses carried `status` as a JSON string. Zero exceptions, zero
// absences:
//
//   | HTTP | responses | `status` |
//   |------|-----------|----------|
//   | 400  | 1         | `"400"`  |
//   | 401  | 8         | `"401"`  |
//   | 403  | 3         | `"403"`  |
//   | 404  | 24        | `"404"`  |
//   | 409  | 9         | `"409"`  |
//   | 422  | 14        | `"422"`  |
//
// GitHub's own published OpenAPI description says the same thing out loud —
// `basic-error` declares `status: {type: string}`. Wire and vendor schema were
// obtained independently and agree, which is why this is a FIX and not a
// registered divergence: the ticket asked for exactly this re-measurement
// ("odd enough that it is worth re-measuring across several error classes")
// and it held on every class.
//
// ⚠️ NOT MEASURED, INFERRED: 5xx and 429. Neither can be provoked safely
// against live GitHub, so their string-ness rests on `basic-error` alone. The
// twin sends a string there for consistency; if it ever matters, probe it.
//
// ── WHY THE TEETH ARE ON THE HELPER ───────────────────────────────────────
//
// `githubError` builds the body for every envelope that flows through
// `githubErrorEnvelope` — TwinError, the zod branch, the unknown-tool branch,
// the JSON-parse branch and the 500 fallback — so one assertion on the helper
// covers all of them, and the wire tests below stop it being a unit test that
// agrees with itself.
//
// ⚠️ IT DOES NOT COVER EVERY ENVELOPE THE TWIN EMITS, and F-1490 measured
// exactly which ones it misses: the 401 sites in `twin.ts`, the SDK's admin-gate
// 403, and the 501 catch-all all build their bodies by hand and carry NO
// `status` leaf at all. Those are registered as divergences 31 and 32 rather
// than fixed here, because two of the three live in `@pome-sh/sdk` and are
// shared by all five twins. The last test in this file pins that gap so it
// cannot be mistaken for coverage.

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

describe("F-1490 — the envelope builder always renders `status` as a string", () => {
  it("stringifies every status it is handed", () => {
    // The teeth, on the helper rather than on one route. Written as data so a
    // status class the twin gains is covered without editing an assertion.
    for (const code of [400, 401, 403, 404, 409, 422, 500, 501, 503]) {
      expect(githubError("x", code)).toMatchObject({ status: String(code) });
      expect(typeof githubError("x", code).status).toBe("string");
    }
  });

  it("does not disturb the other three leaves", () => {
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

describe("F-1490 — on the wire, across every error class the twin can be made to emit", () => {
  it("404 from a read", async () => {
    const app = createGitHubCloneApp();
    expect(await rest(app, "GET", "/repos/acme/nope")).toEqual({
      status: 404,
      body: { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" }
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

  it("409 from the contents door's optimistic locking (F-1491's shape, now with a string)", async () => {
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

describe("F-1490 — the envelopes this fix does NOT reach, pinned as gaps", () => {
  it("401 carries an empty documentation_url and NO status leaf — divergence 31", async () => {
    const app = createGitHubCloneApp();

    // ⚠️ A GAP, not a fidelity claim. Real GitHub answers
    // `{message:"Bad credentials", documentation_url:"https://docs.github.com/rest", status:"401"}`
    // — measured 8/8 across five route shapes. This body is built by hand in
    // `src/twin.ts` (and defaulted in `@pome-sh/sdk`'s `auth.ts`), never reaching
    // `githubError`, which is the whole reason the ticket's "githubError builds
    // every envelope" premise was wrong. Fixing it touches the SDK and therefore
    // all five twins, so it is registered and ticketed instead.
    const got = await app.request(`${base}/repos/acme/api`, { headers: { authorization: "Bearer ghp_pome_not_a_real_token" } });
    expect(got.status).toBe(401);

    const body = await got.json() as Record<string, unknown>;
    expect(body).toEqual({ message: "Bad credentials", documentation_url: "" });
    expect("status" in body).toBe(false);
  });

  it("the 501 catch-all carries no status leaf either", async () => {
    const app = createGitHubCloneApp();
    const got = await rest(app, "GET", "/repos/acme/api/actions/runs");
    expect(got.status).toBe(501);
    expect("status" in (got.body as object)).toBe(false);
  });

  it("every reached envelope still carries the GENERIC documentation_url — divergence 32", async () => {
    const app = createGitHubCloneApp();

    // ⚠️ Also a gap. Real GitHub names the operation on 45 of the 59 measured
    // errors. The twin cannot: `errorEnvelope` receives the error and nothing
    // else, and `notFound()` in `requireRepo` is reachable from ~40 routes and
    // ~30 tools, so the throw site does not know which door was knocked on.
    // The contents-door sha errors are the exception (F-1491) precisely because
    // they can only come from one operation.
    const got = await rest(app, "GET", "/repos/acme/nope");
    expect((got.body as { documentation_url: string }).documentation_url).toBe("https://docs.github.com/rest");
  });
});
