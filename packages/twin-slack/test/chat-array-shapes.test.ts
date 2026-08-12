// SPDX-License-Identifier: Apache-2.0
//
// `blocks` and `attachments` take a JSON STRING *or* a native ARRAY (F-1487).
//
// ── WHAT WAS MEASURED, AND AGAINST WHOM ────────────────────────────────────
//
// Five declarations in `route-inputs.ts` were `absentIfEmpty()` =
// `z.string().optional()`, and the domain ran `sanitizeJsonString` over each:
//
//   POST /chat.postMessage      blocks, attachments
//   POST /chat.update           blocks, attachments
//   POST /chat.scheduleMessage  blocks
//
// So a body like `{"channel":"C1","blocks":[{"type":"section", …}]}` — the
// natural spelling under `application/json`, and what an SDK produces — failed
// the route parse and the method answered `{ok:false, error:"invalid_arguments"}`
// at HTTP 200, the shape a status-code-only check reads as success.
//
// ⚠️ THIS WAS NOT INHERITED FROM F-1462. That ticket measured an OBJECT
// `profile` on a profile method; these are ARRAYS on three messaging methods
// with different validators behind them, and assuming they agree is the exact
// error F-1462 was opened to prevent. All five were called separately on
// 2026-08-12 against `pome-twin-sandbox`, three requests each:
//
//   C  form-encoded + JSON string   ok:true   (Slack's documented shape)
//   B  application/json + string    ok:true   (so JSON bodies are fine here)
//   A  application/json + ARRAY     ok:true   and each array's contents came
//                                             back inside `message.blocks` /
//                                             `message.attachments` — APPLIED,
//                                             not merely tolerated
//
// B is what makes A readable: without it a refusal could have meant "Slack takes
// no JSON body on this method", which is a different ticket. Slack accepts BOTH
// forms on all five, so the twin refusing one was a false FAILURE — an
// examinee's agent that sends the natural JSON shape fails here and passes in
// production.
//
// ⚠️ THE STRING FORM IS NOT DEPRECATED BY THIS. Both are real, and the string
// form is what `sandboxes/slack/rest-writes.ts` and every form-encoded SDK send.
// A fix that swapped one for the other would move the divergence rather than
// close it, so every case below is asserted in both shapes, and the assertions
// read the WRITTEN STATE back — through `conversations.history`, or out of the
// `scheduled_messages` row — rather than trusting the write's echo.
import { beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { jsonStringOrArrayField, sanitizeJsonString } from "../src/domain/helpers.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;
const CHANNEL = "C_GENERAL";

/** The two shapes under test, one per field — they are NOT interchangeable. */
const blocksValue = (text: string) => [{ type: "section", text: { type: "mrkdwn", text } }];
const attachmentsValue = (text: string) => [{ color: "#36a64f", text }];

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { app: createSlackTwinApp({ db, domain, runId: "chat-array-shapes" }), db };
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

/** The written state, read back through a DIFFERENT route than the one that wrote it. */
async function stored(app: App, token: string, ts: string) {
  const got = await app.request(
    `${base}/conversations.history?channel=${CHANNEL}&limit=100`,
    withAuth(token, {}),
  );
  const body = (await got.json()) as { messages?: Record<string, any>[] };
  return body.messages?.find((m) => m.ts === ts) ?? {};
}

describe("chat.postMessage / chat.update / chat.scheduleMessage — blocks and attachments as arrays", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  // ── The ruling, one test per declaration ──────────────────────────────────
  //
  // Five separate cases rather than a loop over a table, because five separate
  // vendor measurements is what licenses them — a loop would read as one
  // finding generalised five ways, which is the shape this ticket exists to
  // avoid.

  it("chat.postMessage accepts an ARRAY `blocks` and APPLIES it", async () => {
    const { app } = freshApp();

    const res = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      blocks: blocksValue("array-form"),
    });

    expect(res.status).toBe(200);
    // ⚠️ NOT just `ok:true`. The twin answered `{ok:false}` at HTTP 200 before
    // this change, so a status-only assertion passes on the bug. And a twin that
    // accepted the array and then dropped it would also answer ok:true — only
    // reading the state back separates the two.
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect((await stored(app, token, res.body.ts)).blocks).toEqual(blocksValue("array-form"));
  });

  it("chat.postMessage accepts an ARRAY `attachments` and APPLIES it", async () => {
    const { app } = freshApp();

    const res = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      attachments: attachmentsValue("array-form"),
    });

    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect((await stored(app, token, res.body.ts)).attachments).toEqual(attachmentsValue("array-form"));
  });

  it("chat.update accepts an ARRAY `blocks` and REPLACES what was there", async () => {
    const { app } = freshApp();
    const posted = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      blocks: JSON.stringify(blocksValue("before")),
    });

    const res = await post(app, token, "/chat.update", {
      channel: CHANNEL,
      ts: posted.body.ts,
      text: "edited",
      blocks: blocksValue("after"),
    });

    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    // ⚠️ THIS IS THE ASSERTION THAT CATCHES THE CATEGORY ERROR, and it is why
    // the previous value is a DIFFERENT value rather than empty. `chat.update`
    // falls back to the stored blocks when the new value will not parse, so a
    // `sanitizeJsonString` run unconditionally over the array would answer
    // `ok:true` and leave "before" in place — a silent partial success that an
    // `ok:true` assertion cannot see.
    expect((await stored(app, token, posted.body.ts)).blocks).toEqual(blocksValue("after"));
  });

  it("chat.update accepts an ARRAY `attachments` and REPLACES what was there", async () => {
    const { app } = freshApp();
    const posted = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      attachments: JSON.stringify(attachmentsValue("before")),
    });

    const res = await post(app, token, "/chat.update", {
      channel: CHANNEL,
      ts: posted.body.ts,
      text: "edited",
      attachments: attachmentsValue("after"),
    });

    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect((await stored(app, token, posted.body.ts)).attachments).toEqual(attachmentsValue("after"));
  });

  it("chat.scheduleMessage accepts an ARRAY `blocks` and STORES it", async () => {
    // No route serves a scheduled message's blocks back — not this twin, and not
    // real Slack's `chat.scheduledMessages.list`. So the stored row is read
    // directly; the alternative is trusting an echo that does not carry the
    // field, which would assert nothing about application.
    const { app, db } = freshApp();

    const res = await post(app, token, "/chat.scheduleMessage", {
      channel: CHANNEL,
      text: "later",
      post_at: Math.floor(Date.now() / 1000) + 600,
      blocks: blocksValue("array-form"),
    });

    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const row = db
      .prepare(`SELECT blocks_json FROM scheduled_messages WHERE id = ?`)
      .get(res.body.scheduled_message_id) as { blocks_json: string };
    expect(JSON.parse(row.blocks_json)).toEqual(blocksValue("array-form"));
  });

  // ── The half a swap would have broken ─────────────────────────────────────

  it("still accepts the JSON-STRING form on all five, under application/json", async () => {
    const { app, db } = freshApp();

    const posted = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      blocks: JSON.stringify(blocksValue("string-form")),
      attachments: JSON.stringify(attachmentsValue("string-form")),
    });
    expect(posted.body.ok, JSON.stringify(posted.body)).toBe(true);
    const afterPost = await stored(app, token, posted.body.ts);
    expect(afterPost.blocks).toEqual(blocksValue("string-form"));
    expect(afterPost.attachments).toEqual(attachmentsValue("string-form"));

    const updated = await post(app, token, "/chat.update", {
      channel: CHANNEL,
      ts: posted.body.ts,
      blocks: JSON.stringify(blocksValue("string-edit")),
      attachments: JSON.stringify(attachmentsValue("string-edit")),
    });
    expect(updated.body.ok, JSON.stringify(updated.body)).toBe(true);
    const afterUpdate = await stored(app, token, posted.body.ts);
    expect(afterUpdate.blocks).toEqual(blocksValue("string-edit"));
    expect(afterUpdate.attachments).toEqual(attachmentsValue("string-edit"));

    const scheduled = await post(app, token, "/chat.scheduleMessage", {
      channel: CHANNEL,
      text: "later",
      post_at: Math.floor(Date.now() / 1000) + 600,
      blocks: JSON.stringify(blocksValue("string-form")),
    });
    expect(scheduled.body.ok, JSON.stringify(scheduled.body)).toBe(true);
    const row = db
      .prepare(`SELECT blocks_json FROM scheduled_messages WHERE id = ?`)
      .get(scheduled.body.scheduled_message_id) as { blocks_json: string };
    expect(JSON.parse(row.blocks_json)).toEqual(blocksValue("string-form"));
  });

  it("takes the string form FORM-ENCODED too — the shape Slack documents", async () => {
    // The transport the capture leg and every Slack SDK use. It reaches the same
    // union by a path where an array is not even expressible, so it is the case
    // a widened parse could have broken without anything else noticing.
    const { app } = freshApp();

    const res = await post(
      app,
      token,
      "/chat.postMessage",
      { channel: CHANNEL, text: "hello", blocks: JSON.stringify(blocksValue("form-encoded")) },
      "application/x-www-form-urlencoded",
    );

    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect((await stored(app, token, res.body.ts)).blocks).toEqual(blocksValue("form-encoded"));
  });

  // ── The boundary: the accepted set widened by exactly ONE shape ───────────

  it("still refuses a `blocks` that is neither — a number is not a shape Slack takes", async () => {
    // The tightening this must NOT become: `z.unknown()` would accept anything
    // and quietly write nothing legible.
    const { app } = freshApp();

    const res = await post(app, token, "/chat.postMessage", { channel: CHANNEL, text: "hello", blocks: 12345 });

    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).toContain("blocks");
  });

  it("still refuses an array of NON-objects — the union widened to arrays of blocks, not to arrays", async () => {
    const { app } = freshApp();

    const res = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      attachments: [1, 2, 3],
    });

    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).toContain("attachments");
  });

  it("a refused `blocks` writes NOTHING — the refusal stays clean", async () => {
    // A partial write reported as a failure would be worse than either the bug
    // or the fix, and nothing else here would see it.
    const { app } = freshApp();
    const posted = await post(app, token, "/chat.postMessage", {
      channel: CHANNEL,
      text: "hello",
      blocks: JSON.stringify(blocksValue("intact")),
    });

    const refused = await post(app, token, "/chat.update", {
      channel: CHANNEL,
      ts: posted.body.ts,
      text: "edited",
      blocks: 12345,
    });

    expect(refused.body.ok).toBe(false);
    const after = await stored(app, token, posted.body.ts);
    expect(after.blocks).toEqual(blocksValue("intact"));
    expect(after.text).toBe("hello");
  });
});

describe("jsonStringOrArrayField — why the parse follows the type", () => {
  it("sanitizeJsonString over an ARRAY returns the FALLBACK, which is the whole reason", async () => {
    // The mechanism the fix is built on, asserted rather than claimed in a
    // comment. `JSON.parse` coerces its argument to a string first, so an array
    // arrives as "[object Object]" and throws — and the fallback is what gets
    // written. On `chat.update` the fallback is the PREVIOUS value, so running
    // it unconditionally would silently discard the edit and answer ok:true.
    const value = blocksValue("would-be-lost");
    expect(sanitizeJsonString(value as unknown as string, "PREVIOUS")).toBe("PREVIOUS");
    expect(jsonStringOrArrayField(value, "PREVIOUS")).toBe(JSON.stringify(value));
  });

  it("still parses and re-serialises the string branch", async () => {
    // The string branch must keep going through sanitizeJsonString: it is what
    // canonicalises the stored JSON and what falls back on a malformed value.
    expect(jsonStringOrArrayField('[{"type":"section"}]', "[]")).toBe('[{"type":"section"}]');
    expect(jsonStringOrArrayField("not json at all", "[]")).toBe("[]");
  });
});
