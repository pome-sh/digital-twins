// SPDX-License-Identifier: Apache-2.0
// `content` on the two write doors, which take it DIFFERENTLY, because real GitHub
// takes it differently.

import { describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;
process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function rest(
  app: ReturnType<typeof createGitHubCloneApp>,
  method: string,
  path: string,
  body?: unknown
) {
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
    withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args })
    })
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** What `GET /contents/*` serves back, decoded the way a real caller decodes it. */
async function readBack(app: ReturnType<typeof createGitHubCloneApp>, path: string, ref: string) {
  const got = await rest(app, "GET", `/repos/acme/api/contents/${path}?ref=${ref}`);
  const file = got.body as { encoding: string; content: string };
  return {
    status: got.status,
    encoding: file?.encoding,
    decoded:
      typeof file?.content === "string"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : undefined
  };
}

describe("REST `PUT /contents/*` takes base64, the way GitHub does", () => {
  it("round-trips a base64 body byte-identically", async () => {
    const app = createGitHubCloneApp();
    const text = "hello world\n";

    const put = await rest(app, "PUT", "/repos/acme/api/contents/round.txt", {
      message: "add round.txt",
      content: b64(text),
      branch: "main"
    });
    expect(put.status).toBe(201);

    // Through a DIFFERENT route than the one that wrote it.
    expect(await readBack(app, "round.txt", "main")).toEqual({
      status: 200,
      encoding: "base64",
      decoded: text
    });
  });

  it("mangles bytes that are not UTF-8 — divergence 29, and it is NEW", async () => {
    // ⚠️ This test pins a GAP, not a fidelity claim.
    const app = createGitHubCloneApp();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

    const put = await rest(app, "PUT", "/repos/acme/api/contents/logo.png", {
      message: "add logo.png",
      content: bytes.toString("base64"),
      branch: "main"
    });
    // Accepted, the way GitHub accepts it — the divergence is in what is STORED.
    expect(put.status).toBe(201);

    const got = await rest(app, "GET", "/repos/acme/api/contents/logo.png?ref=main");
    const served = Buffer.from((got.body as { content: string }).content, "base64");
    expect(served.equals(bytes)).toBe(false);
    expect(served).toEqual(Buffer.from(bytes.toString("utf8"), "utf8"));
  });

  it("refuses plain text the way GitHub refuses it — 422, GitHub's message, no `errors` array", async () => {
    const app = createGitHubCloneApp();

    const put = await rest(app, "PUT", "/repos/acme/api/contents/plain.txt", {
      message: "add plain.txt",
      content: "hello world\n",
      branch: "main"
    });

    expect(put.status).toBe(422);
    expect(put.body).toEqual({
      message: "content is not valid Base64",
      documentation_url:
        "https://docs.github.com/rest/repos/contents#create-or-update-file-contents",
      status: "422"
    });

    // Refused, not half-written.
    expect((await readBack(app, "plain.txt", "main")).status).toBe(404);
  });

  it("refuses a well-formed alphabet with a bad length, and characters outside it", async () => {
    const app = createGitHubCloneApp();

    for (const content of ["abcde", "!!!@@@###$$$", "aGVsbG8=extra"]) {
      const put = await rest(app, "PUT", "/repos/acme/api/contents/bad.txt", {
        message: "nope",
        content,
        branch: "main"
      });
      expect(put.status, `content=${content}`).toBe(422);
      expect((put.body as { message: string }).message).toBe("content is not valid Base64");
    }
  });

  it("accepts well-formed base64 that decodes to junk, because GitHub does", async () => {
    const app = createGitHubCloneApp();

    const put = await rest(app, "PUT", "/repos/acme/api/contents/junk.bin", {
      message: "add junk",
      content: "test",
      branch: "main"
    });
    expect(put.status).toBe(201);

    // What it STORES is subject to divergence 29 above — `test` decodes to
    // `b5 eb 2d`, which is not valid UTF-8. The fidelity claim under test is the
    // STATUS: GitHub does not ask whether well-formed base64 means anything, and
    // neither does this twin. A twin that rejected "content that isn't text"
    // would pass every plain-text case in this file and still diverge here.
    const got = await rest(app, "GET", "/repos/acme/api/contents/junk.bin?ref=main");
    expect(typeof (got.body as { content: string }).content).toBe("string");
  });

  it("tolerates whitespace inside the base64, because GitHub does", async () => {
    const app = createGitHubCloneApp();
    const text = "hello world\n";
    const wrapped = `${b64(text).slice(0, 8)}\n${b64(text).slice(8)}`;

    const put = await rest(app, "PUT", "/repos/acme/api/contents/wrapped.txt", {
      message: "add wrapped",
      content: wrapped,
      branch: "main"
    });
    expect(put.status).toBe(201);
    expect((await readBack(app, "wrapped.txt", "main")).decoded).toBe(text);
  });

  it("accepts an empty body as an empty file", async () => {
    const app = createGitHubCloneApp();
    const put = await rest(app, "PUT", "/repos/acme/api/contents/empty.txt", {
      message: "add empty",
      content: "",
      branch: "main"
    });
    expect(put.status).toBe(201);
    expect((await readBack(app, "empty.txt", "main")).decoded).toBe("");
  });
});

describe("the MCP door keeps taking plain text, the way GitHub's MCP server does", () => {
  it("`create_or_update_file` writes plain text through unchanged", async () => {
    const app = createGitHubCloneApp();
    const text = "export const ok = true;\n";

    const called = await mcp(app, "create_or_update_file", {
      owner: "acme",
      repo: "api",
      branch: "main",
      path: "mcp-plain.ts",
      message: "add via mcp",
      content: text
    });
    expect(called.status).toBe(200);

    expect((await readBack(app, "mcp-plain.ts", "main")).decoded).toBe(text);
  });

  it("`push_files` writes plain text through unchanged", async () => {
    const app = createGitHubCloneApp();
    const text = "# notes\n";

    const called = await mcp(app, "push_files", {
      owner: "acme",
      repo: "api",
      branch: "main",
      message: "push via mcp",
      files: [{ path: "mcp-push.md", content: text }]
    });
    expect(called.status).toBe(200);

    expect((await readBack(app, "mcp-push.md", "main")).decoded).toBe(text);
  });

  it("does NOT reject plain text on the MCP door — the doors are asymmetric on purpose", async () => {
    // The guard against a future "unify the doors" change. If this ever starts
    // failing with a 422 `content is not valid Base64`, the REST rule has leaked
    // into the MCP door and the twin now diverges from GitHub's MCP server on
    // every call an examinee actually makes. Re-read this file's header.
    const app = createGitHubCloneApp();

    const called = await mcp(app, "create_or_update_file", {
      owner: "acme",
      repo: "api",
      branch: "main",
      path: "not-base64.txt",
      message: "plain text is correct here",
      content: "hello world\n"
    });

    expect(called.status).toBe(200);
    expect((await readBack(app, "not-base64.txt", "main")).decoded).toBe("hello world\n");
  });

  it("no longer takes an `encoding` switch GitHub does not declare on either tool", async () => {
    // `encoding` came off the REST declaration; this takes it off the MCP validators,
    // where it survived because the served table (a capture) and the zod validators.
    const app = createGitHubCloneApp();

    const called = await mcp(app, "create_or_update_file", {
      owner: "acme",
      repo: "api",
      branch: "main",
      path: "ignored-encoding.txt",
      message: "encoding is not a parameter",
      content: b64("hello world\n"),
      encoding: "base64"
    });

    expect(called.status).toBe(200);
    // Written VERBATIM: the switch was discarded, not honoured.
    expect((await readBack(app, "ignored-encoding.txt", "main")).decoded).toBe(b64("hello world\n"));
  });
});
