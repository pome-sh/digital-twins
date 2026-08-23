// SPDX-License-Identifier: Apache-2.0
// The twin's published input surface, driven over real HTTP.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createRecorderHandle } from "@pome-sh/sdk/server";
import { diffRegisteredRoutes, type UndeclaredDisposition } from "@pome-sh/sdk/route-inputs";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { registerSlackRoutes } from "../src/routes.js";
import { SLACK_ROUTE_INPUTS } from "../src/route-inputs.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";

/** A query/body key no Slack method declares, and no vendor ever will. */
const PROBE = "pome_undeclared_probe";

/** the ruling for this twin: `api.test` — the one Web API method that answers without
 *  a token — accepted `pome_undeclared_probe` as a GET query key and as. */
const RULED: UndeclaredDisposition = "ignore";

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
 * What a Slack answer is, for comparison purposes.
 *
 * Slack answers an application-level refusal with HTTP **200** and
 * `{ok:false, error}` — `twin.ts`'s `slackErrorEnvelope`, frozen because the
 * official SDKs read a non-200 as a transport failure. So the status alone
 * distinguishes almost nothing here and the ENVELOPE has to be part of the
 * comparison: `ok` and the error code are where a Slack method says no.
 */
async function answer(response: Response): Promise<{ status: number; ok: unknown; error: unknown; text: string }> {
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as Envelope;
  return { status: response.status, ok: body.ok, error: body.error, text };
}

function summary(a: Awaited<ReturnType<typeof answer>>): string {
  return `${a.status} ok=${String(a.ok)} error=${String(a.error)}`;
}

describe("declared route inputs", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("is ruled `ignore` on undeclared input, on every route", () => {
    expect(SLACK_ROUTE_INPUTS.length).toBeGreaterThan(0);
    const dissenting = SLACK_ROUTE_INPUTS.filter((d) => d.undeclared !== RULED).map(
      (d) => `${d.surface} is '${d.undeclared}'`
    );
    // One ruling per twin: `token` rides on all 62 surfaces, so a route
    // answering differently from its neighbours would make "does Slack mind an
    // extra field" depend on which method you called.
    expect(dissenting, `these routes disagree with the twin's heat ruling ('${RULED}')`).toEqual(
      []
    );
  });

  it("serves a request carrying an input the declaration does not name, unchanged", async () => {
    // Two twins driven through the SAME sequence of calls, one of them with the
    // probe added to every one. A discarded argument cannot change an answer,
    // so the two have to agree call for call — including on the
    // `channel_not_found`s the bare paths provoke, which is a much stronger
    // claim than "the probed call came back ok".
    const plain = freshApp();
    const probed = freshApp();
    const at = (app: Hono, path: string, init: RequestInit) =>
      app.request(`/s/${TEST_SID}${path}`, withAuth(token, init));

    for (const declaration of SLACK_ROUTE_INPUTS) {
      const { path, method, surface } = declaration;

      // An undeclared QUERY key, on both methods. On POST the arguments are
      // declared as body inputs, so the whole query string is undeclared there.
      const bare = await answer(await at(plain, path, { method }));
      const withQuery = await answer(await at(probed, `${path}?${PROBE}=x`, { method }));
      expect(summary(withQuery), `${surface} (undeclared query key): ${withQuery.text}`).toBe(
        summary(bare)
      );
      expect(withQuery.text, `${surface} named the undeclared query key in its answer`).not.toContain(
        PROBE
      );

      if (method !== "POST") continue;

      // An undeclared top-level BODY field, in both encodings Slack accepts.
      for (const [label, headers, body] of [
        ["JSON", { "content-type": "application/json" }, JSON.stringify({})],
        [
          "form",
          { "content-type": "application/x-www-form-urlencoded" },
          new URLSearchParams().toString(),
        ],
      ] as const) {
        const bareBody = await answer(await at(plain, path, { method: "POST", headers, body }));
        const probedBody = await answer(
          await at(probed, path, {
            method: "POST",
            headers,
            body:
              label === "JSON"
                ? JSON.stringify({ [PROBE]: "x" })
                : new URLSearchParams({ [PROBE]: "x" }).toString(),
          })
        );
        expect(
          summary(probedBody),
          `${surface} (undeclared ${label} body field): ${probedBody.text}`
        ).toBe(summary(bareBody));
        expect(
          probedBody.text,
          `${surface} named the undeclared ${label} body field in its answer`
        ).not.toContain(PROBE);
      }
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
