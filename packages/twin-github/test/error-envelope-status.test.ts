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
// `status` leaf at all. That is registered as divergence 31 rather than fixed
// here, because two of the three live in `@pome-sh/sdk` and are shared by all
// five twins. The last test in this file pins that gap so it cannot be mistaken
// for coverage.
//
// The OTHER leaf F-1490 registered — `documentation_url` naming no operation,
// divergence 32 — was closed by F-1498, and the two assertions that pinned it
// generic moved rather than went away. Where they went, and why the new reading
// is honest, is written on each of them below.

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
    // The generic url is still the helper's default, and F-1498 did not change
    // that: it is what GitHub sends where it names no operation, and what the
    // twin sends where it knows none. The DOOR supplies the specific one.
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
    // ⚠️ MOVED BY F-1498, and this is the whole envelope so it cannot move
    // quietly: `documentation_url` was the generic `https://docs.github.com/rest`
    // here, pinned deliberately as divergence 32's evidence. This route now
    // names its own operation, which is what real GitHub answered on all 45
    // routed, authenticated errors it was measured on. `status` — this file's
    // subject — is untouched.
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

describe("F-1490's gaps, closed by F-1497 — the 401 envelopes now carry both leaves", () => {
  it("a BAD credential answers GitHub's 401 body, whole (was divergence 31)", async () => {
    const app = createGitHubCloneApp();

    // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and the flip is the point.
    // It read `{message:"Bad credentials", documentation_url:""}` with no
    // `status` leaf, deliberately, so divergence 31 could not be mistaken for
    // coverage. F-1497 closed it: `auth.unauthorized` in `src/twin.ts` builds
    // through `githubError` now, so both leaves arrive.
    //
    // Real GitHub, re-measured live 2026-08-13 on `GET /user` with a bad
    // bearer — byte for byte what is asserted below:
    //   {"message":"Bad credentials",
    //    "documentation_url":"https://docs.github.com/rest","status":"401"}
    //
    // The whole body, not the two leaves that moved: a fix that dropped
    // `message` while adding `status` would pass a per-leaf assertion.
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

    // The second half of F-1497's github fix, and the reason `unauthorized`
    // takes `kind`. Same probe, same day, no `Authorization` header at all:
    //   {"message":"Requires authentication",
    //    "documentation_url":"https://docs.github.com/rest","status":"401"}
    // The twin answered `Bad credentials` to both until F-1497 — measured and
    // registered by F-1490, unfixed until now.
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
    // GitHub's 401 family. The message is the frozen F-712 row 5 pin; what
    // F-1497 changed is that it now carries the leaves every GitHub 401 does.
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
    // Before F-1497 this body came from `@pome-sh/sdk`'s `admin-gate.ts` and
    // read `{message:"Forbidden", documentation_url:""}`. The gate is shared by
    // all five twins, so it could not be made github-shaped — twin-github
    // declares `admin.forbidden` instead.
    //
    // The url is GENERIC on purpose even though GitHub's measured 403s name the
    // operation (3/3): `/admin/*` is a twin-only route with no GitHub operation
    // behind it, the same reason `/pulls/:n/diff` stays generic (divergence 32).
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

  it("the 401 and the 501 catch-all still name NO operation — and must not (F-1498)", async () => {
    const app = createGitHubCloneApp();

    // ⚠️ RE-CUT BY F-1498, then again by F-1497, and it survived both because
    // it is the boundary between them. It began as "every reached envelope
    // still carries the GENERIC documentation_url" and stood for divergence
    // 32's whole surface; F-1498 closed the half where a routed, authenticated
    // error must NAME its operation (`test/operation-documentation-url.test.ts`).
    //
    // What survives is the part of divergence 32 that was never a gap. GitHub
    // itself answers generically on 14 of 59 measured errors, and two of those
    // three classes are these — every 401 (8/8), because authentication fails
    // before dispatch, and every unrouted path (4/4).
    //
    // ⚠️ F-1497 CHANGED THE 401 READING FROM `""` TO THE GENERIC URL, and the
    // two must not be confused. `""` was divergence 31's gap — an empty leaf
    // where GitHub sends a real url. The generic url is divergence 32's
    // REQUIREMENT — the right url, which must never become
    // `…#get-a-repository`. F-1497 fixed the first without touching the
    // second, which is the whole trap it had to walk past: the `.not.toContain`
    // below is what would catch a fix that stamped the operation here, and it
    // is written as the anchor character rather than as one url so any
    // operation url trips it.
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
