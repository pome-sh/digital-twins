// SPDX-License-Identifier: Apache-2.0
// F-1491 — optimistic locking on `PUT` / `DELETE /repos/:owner/:repo/contents/*`.
//
// ── THE MEASUREMENT THIS FILE PINS ────────────────────────────────────────
//
// Probed live against real GitHub on 2026-08-12, two throwaway private repos,
// both deleted after. `.context/probe-f1490-f1491.sh` and
// `.context/probe-sha-detail.sh` are the transcripts.
//
// The ticket's title carried 409 as a HYPOTHESIS. It measured true, and it
// measured true THREE WAYS — a `sha` that is not a sha, a well-formed 40-hex
// sha that exists nowhere, and the real sha OF A DIFFERENT BLOB all get the
// same answer, so GitHub does not distinguish "malformed" from "stale":
//
//   | request                                    | GitHub answered                 |
//   |--------------------------------------------|---------------------------------|
//   | existing path, no `sha`                    | 422 `Invalid request.\n\n"sha"…`|
//   | existing path, `sha: "deadbeef"`           | **409** `<path> does not match …`|
//   | existing path, 40-hex sha that exists not  | **409** `<path> does not match …`|
//   | existing path, real sha of ANOTHER file    | **409** `<path> does not match …`|
//   | path that does NOT exist, any `sha`        | **201** — `sha` ignored entirely|
//   | existing path, correct `sha`               | 200 (not 201)                   |
//   | `branch` that does not exist + wrong `sha` | 404 — branch is checked FIRST   |
//
//   422: {"message":"Invalid request.\n\n\"sha\" wasn't supplied.",
//         "documentation_url":"https://docs.github.com/rest/repos/contents#create-or-update-file-contents",
//         "status":"422"}
//   409: {"message":"dir/sub/file.txt does not match deadbeef",
//         "documentation_url":"https://docs.github.com/rest/repos/contents#create-or-update-file-contents",
//         "status":"409"}
//
// Neither body carries an `errors` array. `DELETE` answers the same two shapes
// against its own doc anchor (`#delete-a-file`).
//
// `status` is a quoted string in the assertions below because F-1490 closed
// that half globally in `githubError` — 59 of 59 measured GitHub error responses
// send it quoted, and GitHub's own `basic-error` schema types it `string`. The
// numbers this file shipped with were the divergence, not the claim.
//
// The OTHER half of F-1490 is still open and deliberately not widened here:
// every envelope this twin builds outside the four sites below carries the
// generic `https://docs.github.com/rest` where GitHub names the operation
// (divergence 32). This file pins the operation-specific url because a sha
// conflict can only come FROM the contents operations, so the throw site knows
// which one — exactly the subset F-1490 could not generalise.
//
// ── WHY THIS DID NOT GO IN `validationFailed` ─────────────────────────────
//
// `validationFailed(field, code, value)` yields `Validation Failed` plus a
// structured `errors` array and is used on 48 call sites. GitHub's OTHER 422s
// were measured too, and they split cleanly rather than agreeing with either
// shape:
//
//   * a MISSING required body field → `Invalid request.\n\n"<field>" wasn't
//     supplied.`, no `errors` array. Measured on four unrelated surfaces:
//     `PUT /contents` (`sha`), `DELETE /contents` (`sha`), `POST /issues`
//     (`title`), `POST /pulls` (`head`).
//   * a business rule on an existing model → `Validation Failed` WITH an
//     `errors` array, which is what this twin already emits. Measured on
//     `POST /labels` (`{resource:"Label",code:"already_exists",field:"name"}`)
//     and `POST /pulls` head==base (`{resource:"PullRequest",code:"custom"}`).
//
// So the twin's generic shape is RIGHT for the already-exists family and wrong
// for the missing-field family. Migrating the whole missing-field family is a
// global change to `githubErrorEnvelope`'s zod branch — it would move
// `POST /issues` without a title and every other required field — and is not
// this ticket. The last test in this file is the guard that it did not happen
// by accident.

import { describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;
process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;

const PUT_DOC = "https://docs.github.com/rest/repos/contents#create-or-update-file-contents";
const DELETE_DOC = "https://docs.github.com/rest/repos/contents#delete-a-file";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function rest(app: ReturnType<typeof createGitHubCloneApp>, method: string, path: string, body?: unknown) {
  const token = await signTestToken();
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
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

/** Write `path` on `main` and hand back the blob sha GitHub's callers would hold. */
async function seedFile(app: ReturnType<typeof createGitHubCloneApp>, path: string, text = "hello\n") {
  const put = await rest(app, "PUT", `/repos/acme/api/contents/${path}`, { message: `seed ${path}`, content: b64(text), branch: "main" });
  expect(put.status).toBe(201);
  const got = await rest(app, "GET", `/repos/acme/api/contents/${path}?ref=main`);
  return (got.body as { sha: string }).sha;
}

describe("F-1491 — a wrong `sha` on the contents door is a 409, as GitHub answers it", () => {
  it("PUT with a `sha` that is not a sha at all", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "again",
      content: b64("hello again\n"),
      branch: "main",
      sha: "deadbeef"
    });

    // Whole-envelope equality, so an `errors` array coming back is a failure.
    expect(put).toEqual({
      status: 409,
      body: { message: "probe.txt does not match deadbeef", documentation_url: PUT_DOC, status: "409" }
    });
  });

  it("PUT with a well-formed 40-hex `sha` that exists nowhere — GitHub does not distinguish", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");
    const ghost = "0123456789abcdef0123456789abcdef01234567";

    const put = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "again",
      content: b64("x\n"),
      branch: "main",
      sha: ghost
    });

    expect(put).toEqual({
      status: 409,
      body: { message: `probe.txt does not match ${ghost}`, documentation_url: PUT_DOC, status: "409" }
    });
  });

  it("PUT with the real `sha` OF ANOTHER FILE — a stale sha is the same conflict", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");
    const otherSha = await seedFile(app, "other.txt", "other\n");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "again",
      content: b64("x\n"),
      branch: "main",
      sha: otherSha
    });

    expect(put).toEqual({
      status: 409,
      body: { message: `probe.txt does not match ${otherSha}`, documentation_url: PUT_DOC, status: "409" }
    });
  });

  it("names the FULL path, not the basename", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "dir/sub/file.txt");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/dir/sub/file.txt", {
      message: "again",
      content: b64("x\n"),
      branch: "main",
      sha: "deadbeef"
    });

    expect(put).toEqual({
      status: 409,
      body: { message: "dir/sub/file.txt does not match deadbeef", documentation_url: PUT_DOC, status: "409" }
    });
  });

  it("DELETE with a wrong `sha`, against its own doc anchor", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "dir/sub/file.txt");

    const del = await rest(app, "DELETE", "/repos/acme/api/contents/dir/sub/file.txt", {
      message: "rm",
      branch: "main",
      sha: "deadbeef"
    });

    expect(del).toEqual({
      status: 409,
      body: { message: "dir/sub/file.txt does not match deadbeef", documentation_url: DELETE_DOC, status: "409" }
    });
  });

  it("refuses the write — a conflicted PUT leaves the old content in place", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt", "original\n");

    await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "again",
      content: b64("clobbered\n"),
      branch: "main",
      sha: "deadbeef"
    });

    const got = await rest(app, "GET", "/repos/acme/api/contents/probe.txt?ref=main");
    const file = got.body as { content: string };
    expect(Buffer.from(file.content, "base64").toString("utf8")).toBe("original\n");
  });

  it("answers the MCP door the same way — the sha rule is domain-level, not REST-level", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");

    // Plain text on this door (F-1460); only the `sha` semantics are shared.
    const called = await mcp(app, "create_or_update_file", {
      owner: "acme",
      repo: "api",
      path: "probe.txt",
      message: "again",
      content: "hello again\n",
      branch: "main",
      sha: "deadbeef"
    });

    expect(called).toEqual({
      status: 409,
      body: { message: "probe.txt does not match deadbeef", documentation_url: PUT_DOC, status: "409" }
    });
  });

  it("answers `delete_file` on the MCP door the same way", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");

    const called = await mcp(app, "delete_file", {
      owner: "acme",
      repo: "api",
      path: "probe.txt",
      message: "rm",
      branch: "main",
      sha: "deadbeef"
    });

    expect(called).toEqual({
      status: 409,
      body: { message: "probe.txt does not match deadbeef", documentation_url: DELETE_DOC, status: "409" }
    });
  });
});

describe("F-1491 — a MISSING `sha` is still a 422, but GitHub's 422, not the generic one", () => {
  it("PUT on an existing path with no `sha`", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "again",
      content: b64("x\n"),
      branch: "main"
    });

    expect(put).toEqual({
      status: 422,
      body: {
        message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
        documentation_url: PUT_DOC,
        status: "422"
      }
    });
  });

  it("PUT on a nested existing path with no `sha`", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "dir/sub/file.txt");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/dir/sub/file.txt", {
      message: "again",
      content: b64("x\n"),
      branch: "main"
    });

    // GitHub names the FIELD, not the path — the message is identical whatever
    // the path is, unlike the 409 above.
    expect(put).toEqual({
      status: 422,
      body: {
        message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
        documentation_url: PUT_DOC,
        status: "422"
      }
    });
  });

  it("answers the MCP door the same way", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");

    const called = await mcp(app, "create_or_update_file", {
      owner: "acme",
      repo: "api",
      path: "probe.txt",
      message: "again",
      content: "x\n",
      branch: "main"
    });

    expect(called).toEqual({
      status: 422,
      body: {
        message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
        documentation_url: PUT_DOC,
        status: "422"
      }
    });
  });
});

describe("F-1491 — the cases the twin already had right, now guarded", () => {
  it("ignores `sha` entirely when the path does not exist — 201, not a conflict", async () => {
    const app = createGitHubCloneApp();

    // Measured: GitHub creates the file and never looks at the sha. A twin that
    // 409'd here (the intuitive reading of "wrong sha") would diverge.
    const put = await rest(app, "PUT", "/repos/acme/api/contents/brand/new.txt", {
      message: "create",
      content: b64("fresh\n"),
      branch: "main",
      sha: "deadbeef"
    });
    expect(put.status).toBe(201);

    const got = await rest(app, "GET", "/repos/acme/api/contents/brand/new.txt?ref=main");
    expect(Buffer.from((got.body as { content: string }).content, "base64").toString("utf8")).toBe("fresh\n");
  });

  it("checks the branch BEFORE the sha", async () => {
    const app = createGitHubCloneApp();
    await seedFile(app, "probe.txt");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "again",
      content: b64("x\n"),
      branch: "no-such-branch",
      sha: "deadbeef"
    });

    // GitHub: 404 `Branch no-such-branch not found`. The twin's own 404 message
    // is a separate, unregistered divergence — what this pins is the ORDER, so
    // a future refactor cannot start answering 409 for a bad branch.
    expect(put.status).toBe(404);
  });

  it("takes the correct `sha` and answers 200, not 201", async () => {
    const app = createGitHubCloneApp();
    const sha = await seedFile(app, "probe.txt", "original\n");

    const put = await rest(app, "PUT", "/repos/acme/api/contents/probe.txt", {
      message: "update",
      content: b64("updated\n"),
      branch: "main",
      sha
    });
    expect(put.status).toBe(200);

    const got = await rest(app, "GET", "/repos/acme/api/contents/probe.txt?ref=main");
    expect(Buffer.from((got.body as { content: string }).content, "base64").toString("utf8")).toBe("updated\n");
  });

  it("DELETE on a path that does not exist is 404, whatever the sha", async () => {
    const app = createGitHubCloneApp();
    const sha = await seedFile(app, "probe.txt");

    const del = await rest(app, "DELETE", "/repos/acme/api/contents/nope.txt", { message: "rm", branch: "main", sha });
    expect(del.status).toBe(404);
  });
});

describe("F-1491 — `validationFailed`'s other 48 call sites did NOT move", () => {
  it("keeps `Validation Failed` + an `errors` array for the already-exists family", async () => {
    const app = createGitHubCloneApp();

    // Measured on real GitHub: `POST /labels` on a name that exists answers
    // `Validation Failed` WITH `errors: [{resource:"Label",code:"already_exists",
    // field:"name"}]`. The twin's generic shape is CORRECT here, so the sha fix
    // must not have leaked into the shared helper.
    const dup = await rest(app, "POST", "/repos/acme/api/labels", { name: "bug", color: "ffffff" });

    expect(dup.status).toBe(422);
    expect(dup.body).toMatchObject({
      message: "Validation Failed",
      errors: [{ resource: "Request", field: "name", code: "already_exists" }]
    });
  });

  it("leaves the missing-required-FIELD family alone — that migration is global, not this ticket", async () => {
    const app = createGitHubCloneApp();

    // GitHub answers `Invalid request.\n\n"title" wasn't supplied.` here too, so
    // this assertion pins a KNOWN GAP, not a fidelity claim: closing it means
    // moving `githubErrorEnvelope`'s zod branch for every required field on
    // every route. If a later change closes it, this test SHOULD fail and be
    // deleted — that is the signal, not a regression.
    const untitled = await rest(app, "POST", "/repos/acme/api/issues", { body: "no title" });

    expect(untitled.status).toBe(422);
    expect(untitled.body).toMatchObject({ message: "Validation Failed" });
  });
});
