// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — the twin's published input surface, driven over real HTTP.
//
// The two properties here are the ones nothing else can see. `app.test.ts` and
// friends prove the endpoints WORK; these prove the declaration is the only way
// in (an unnamed argument is refused, not ignored) and that it covers every
// route that exists (no route mounted without a declaration, no declaration
// nothing mounts). Either hole would leave `route-inputs.json` an incomplete
// list that pome-cloud's lane still compares — a pass nobody measured.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createRecorderHandle } from "@pome-sh/sdk/server";
import { diffRegisteredRoutes } from "@pome-sh/sdk/route-inputs";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { registerSlackRoutes } from "../src/routes.js";
import { SLACK_ROUTE_INPUTS } from "../src/route-inputs.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";

/** A query/body key no Slack method declares, and no vendor ever will. */
const PROBE = "pome_undeclared_probe";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "route-input-declarations" });
}

type Envelope = { ok?: unknown; error?: unknown; response_metadata?: { messages?: unknown } };

/**
 * Slack answers an application-level refusal with HTTP **200** and
 * `{ok:false, error}` — `twin.ts`'s `slackErrorEnvelope`, frozen because the
 * official SDKs read a non-200 as a transport failure. So the ENVELOPE is the
 * assertion; a 4xx is accepted too, for any surface that ever answers one.
 */
async function expectRefusal(response: Response, label: string) {
  const body = (await response.json()) as Envelope;
  expect(response.status < 500, `${label} — status ${response.status}, body ${JSON.stringify(body)}`).toBe(
    true
  );
  expect(body.ok, `${label} accepted an undeclared input: ${JSON.stringify(body)}`).toBe(false);
  expect(body.error, `${label} refused with the wrong Slack code`).toBe("invalid_arguments");
  // The refusal names the offending key, so the caller can fix the call.
  expect(JSON.stringify(body.response_metadata ?? ""), label).toContain(PROBE);
}

describe("declared route inputs", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("refuses an input the declaration does not name", async () => {
    expect(SLACK_ROUTE_INPUTS.length).toBeGreaterThan(0);
    for (const declaration of SLACK_ROUTE_INPUTS) {
      const app = freshApp();
      const url = `/s/${TEST_SID}${declaration.path}?${PROBE}=x`;

      // An undeclared QUERY key, on both methods. On POST the arguments are
      // declared as body inputs, so the whole query string is undeclared there.
      await expectRefusal(
        await app.request(url, withAuth(token, { method: declaration.method })),
        `${declaration.surface} (undeclared query key)`
      );

      if (declaration.method !== "POST") continue;

      // An undeclared top-level BODY field, in both encodings Slack accepts.
      await expectRefusal(
        await app.request(
          `/s/${TEST_SID}${declaration.path}`,
          withAuth(token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [PROBE]: "x" }),
          })
        ),
        `${declaration.surface} (undeclared JSON body field)`
      );
      await expectRefusal(
        await app.request(
          `/s/${TEST_SID}${declaration.path}`,
          withAuth(token, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ [PROBE]: "x" }).toString(),
          })
        ),
        `${declaration.surface} (undeclared form body field)`
      );
    }
  });

  it("declares every route it registers, and registers every route it declares", () => {
    const registered: string[] = [];
    const record = (method: string) => (path: string) => {
      registered.push(`${method} ${path}`);
    };
    // A router that only remembers what it was asked to mount: the registrar
    // gets its method and path from the declaration, so anything it mounts
    // without one, or declares without mounting, shows up in the diff.
    const router = {
      get: record("GET"),
      post: record("POST"),
      put: record("PUT"),
      patch: record("PATCH"),
      delete: record("DELETE"),
      all: record("ALL"),
    } as unknown as Hono;

    const db = openSlackTwinDatabase(":memory:");
    const domain = new SlackDomain(db);
    registerSlackRoutes(router, {
      domain,
      recorder: createRecorderHandle({ runId: "route-diff", twin: "slack" }),
      runId: "route-diff",
      twin: "slack",
    });

    expect(registered.length).toBe(SLACK_ROUTE_INPUTS.length);
    expect(diffRegisteredRoutes(registered, SLACK_ROUTE_INPUTS)).toEqual({
      undeclared: [],
      unmounted: [],
      duplicated: [],
    });
  });
});
