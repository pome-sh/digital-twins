// SPDX-License-Identifier: Apache-2.0
//
// F-917 black-box case: a Gmail seed with a named `rate-limited` fault throttles
// `messages.send` by call count over the real wire. Proves the contract that
// pome-cloud relies on — the deployed dist, not a library import.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mintSessionJwt, req, spawnTwin } from "./helpers.mjs";

const GMAIL = { name: "gmail", pkg: "packages/twin-gmail", dbEnv: "GMAIL_TWIN_DB", hostEnv: "GMAIL_TWIN_HOST" };
const SID = "s_fault";
const MAILBOX = "agent@pome-twin.test";

const SEED = {
  primaryMailbox: { email: MAILBOX, displayName: "Agent" },
  faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 1, throttleFor: 1 }],
};

function rawMessage(to) {
  const mime = [`From: ${MAILBOX}`, `To: ${to}`, "Subject: hi", "Content-Type: text/plain; charset=utf-8", "", "hi"].join(
    "\r\n",
  );
  return Buffer.from(mime, "utf8").toString("base64url");
}

describe("contract: gmail rate-limited fault", () => {
  let t;
  let token;

  before(async () => {
    t = await spawnTwin(GMAIL, { env: { POME_SEED_JSON: JSON.stringify(SEED) } });
    token = mintSessionJwt({ sid: SID, extra: { gmail_email: MAILBOX } });
  });
  after(async () => {
    if (t) await t.close();
  });

  async function send(to) {
    return req(t.base, `/s/${SID}/gmail/v1/users/me/messages/send`, {
      method: "POST",
      token,
      body: { raw: rawMessage(to) },
    });
  }

  it("succeeds, throttles with 429 RESOURCE_EXHAUSTED, then recovers", async () => {
    const first = await send("a@pome-twin.test");
    assert.equal(first.status, 200, `send #1 should succeed — got ${first.status} ${first.text}`);

    const second = await send("b@pome-twin.test");
    assert.equal(second.status, 429, `send #2 should be throttled — got ${second.status} ${second.text}`);
    assert.equal(second.json?.error?.status, "RESOURCE_EXHAUSTED");

    const third = await send("c@pome-twin.test");
    assert.equal(third.status, 200, `send #3 should recover — got ${third.status} ${third.text}`);
  });
});
