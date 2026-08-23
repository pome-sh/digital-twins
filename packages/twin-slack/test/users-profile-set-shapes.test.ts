// SPDX-License-Identifier: Apache-2.0
// `users.profile.set` takes `profile` as a JSON STRING *or* an object.
import { beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "profile-shapes" });
}

type App = ReturnType<typeof createSlackTwinApp>;

async function post(app: App, token: string, path: string, body: unknown, contentType = "application/json") {
  const init: RequestInit = { method: "POST", headers: { "content-type": contentType } };
  init.body = contentType.startsWith("application/json")
    ? JSON.stringify(body)
    : new URLSearchParams(body as Record<string, string>).toString();
  const response = await app.request(`${base}${path}`, withAuth(token, init));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** The written state, read back — never the echo off the write itself. */
async function displayName(app: App, token: string, user: string): Promise<string> {
  const got = await post(app, token, "/users.profile.get", { user });
  expect(got.body.ok, JSON.stringify(got.body)).toBe(true);
  return got.body.profile.display_name as string;
}

describe("users.profile.set — `profile` as an object, the way Slack takes it", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("accepts an OBJECT profile under application/json and APPLIES it", async () => {
    const app = freshApp();

    const set = await post(app, token, "/users.profile.set", {
      user: "alice",
      profile: { display_name: "object-form" },
    });

    expect(set.status).toBe(200);
    expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
    // ⚠️ NOT just `ok:true`. The twin answered `{ok:false}` at HTTP 200 before
    // this change, so a status-only assertion passes on the bug. And a twin that
    // accepted the object and then dropped it would also answer ok:true — only
    // reading the state back separates the two.
    expect(await displayName(app, token, "alice")).toBe("object-form");
  });

  it("still accepts the JSON-STRING profile — both forms are real", async () => {
    // Slack answered ok:true to the string form on both transports.
    const app = freshApp();

    const set = await post(app, token, "/users.profile.set", {
      user: "alice",
      profile: JSON.stringify({ display_name: "string-form" }),
    });

    expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
    expect(await displayName(app, token, "alice")).toBe("string-form");
  });

  it("takes the string form form-encoded too — the shape Slack documents", async () => {
    const app = freshApp();

    const set = await post(
      app,
      token,
      "/users.profile.set",
      { user: "alice", profile: JSON.stringify({ display_name: "form-encoded" }) },
      "application/x-www-form-urlencoded",
    );

    expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
    expect(await displayName(app, token, "alice")).toBe("form-encoded");
  });

  it("merges into the existing profile rather than replacing it, in either shape", async () => {
    // `usersProfileSet` spreads the incoming keys over the stored profile. The
    // object branch reaches that spread by a different path than the string
    // branch (no `safeParseJson`), so "does the merge still happen" is a real
    // question about the new branch and not a restatement of the old one.
    const app = freshApp();

    await post(app, token, "/users.profile.set", { user: "alice", profile: { display_name: "merged" } });
    await post(app, token, "/users.profile.set", { user: "alice", profile: { status_text: "in a meeting" } });

    const got = await post(app, token, "/users.profile.get", { user: "alice" });
    expect(got.body.profile.display_name).toBe("merged");
    expect(got.body.profile.status_text).toBe("in a meeting");
  });

  it("still refuses a profile that is neither — a number is not a shape Slack takes", async () => {
    // The tightening this must NOT become: `z.unknown()` would accept anything
    // and quietly write nothing legible. The accepted set widened by exactly one
    // shape, and this is the assertion that says so.
    const app = freshApp();

    const set = await post(app, token, "/users.profile.set", { user: "alice", profile: 12345 });

    expect(set.body.ok).toBe(false);
    expect(String(JSON.stringify(set.body))).toContain("profile");
    // And nothing was written — the seeded display name is untouched.
    expect(await displayName(app, token, "alice")).toBe("Alice");
  });

  it("leaves the name/value pair form working", async () => {
    // The third way in. It shares the handler with both `profile` branches, so a
    // union that widened the parse could have broken it without anything else
    // noticing.
    const app = freshApp();

    const set = await post(app, token, "/users.profile.set", {
      user: "alice",
      name: "display_name",
      value: "pair-form",
    });

    expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
    expect(await displayName(app, token, "alice")).toBe("pair-form");
  });
});
