// SPDX-License-Identifier: Apache-2.0
// `RecorderEvent.tool`, the first-class name of the twin action a call invoked.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin } from "../src/index.js";
import { createApp } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

// A twin whose one action `flip_switch` is reachable BOTH as an MCP tool and as
// a REST route — the shape that makes the transport-independence claim testable
// at all. `/plain` has no declared action, which is the `tool: null` case.
const dualSurfaceTwin = defineTwin({
  id: "dual",
  version: "0.1.0",
  fidelity: { default: "semantic" },
  domain: () => ({ flipped: [] as string[] }),
  state: ({ domain }) => ({ flipped: domain.flipped }),
  tools: [
    {
      name: "flip_switch",
      description: "Flip a named switch.",
      schema: z.object({ name: z.string().min(1) }),
      handler: (domain, args) => {
        domain.flipped.push((args as { name: string }).name);
        return { flipped: (args as { name: string }).name };
      },
      mutation: true,
    },
  ],
  routes: (app, { domain, recorder }) => {
    app.post(
      "/switches/:name",
      recorder.handle({ mutation: true, tool: "flip_switch" }, (c) => {
        const name = c.req.param("name")!;
        domain.flipped.push(name);
        return { status: 201, body: { flipped: name } };
      }),
    );
    app.get(
      "/plain",
      recorder.handle({ mutation: false }, () => ({ status: 200, body: { ok: true } })),
    );
  },
});

async function toolsOnTape(app: ReturnType<typeof createApp>): Promise<(string | null)[]> {
  const res = await app.request(`${base}/_pome/events`, withAuth(token));
  const events = (await res.json()) as { tool?: string | null }[];
  return events.map((event) => event.tool ?? null);
}

function post(body: unknown) {
  return withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("RecorderEvent.tool — the same action through every transport", () => {
  it("stamps the tool name on a JSON-RPC tools/call", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(
      `${base}/mcp`,
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "flip_switch", arguments: { name: "a" } },
      }),
    );
    expect(await toolsOnTape(app)).toEqual(["flip_switch"]);
  });

  it("stamps the tool name on the legacy POST /mcp/call dispatch", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(
      `${base}/mcp/call`,
      post({ tool: "flip_switch", arguments: { name: "b" } }),
    );
    expect(await toolsOnTape(app)).toEqual(["flip_switch"]);
  });

  it("stamps the tool name on the legacy POST /mcp/tools/:name dispatch", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(`${base}/mcp/tools/flip_switch`, post({ name: "c" }));
    expect(await toolsOnTape(app)).toEqual(["flip_switch"]);
  });

  it("stamps the SAME name on the REST route that performs the same action", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(`${base}/switches/d`, post({}));
    expect(await toolsOnTape(app)).toEqual(["flip_switch"]);
  });

  it("stamps null on a route that declares no action", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(`${base}/plain`, withAuth(token));
    expect(await toolsOnTape(app)).toEqual([null]);
  });
});

describe("RecorderEvent.tool — the caller's named action, not the successful one", () => {
  // "Was it called" is a question about the ATTEMPT. A call the twin rejected
  // still names what the agent reached for, and a check that cares whether it
  // landed has `status` on the same row. Dropping the name on rejection would
  // make every 4xx invisible to a `was never called` check — the agent's reach
  // for a forbidden action would vanish because it fumbled the arguments.
  it("stamps the tool an unknown-tool JSON-RPC call named", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(
      `${base}/mcp`,
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      }),
    );
    expect(await toolsOnTape(app)).toEqual(["no_such_tool"]);
  });

  it("stamps the tool when the args fail the tool's own schema", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(
      `${base}/mcp`,
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "flip_switch", arguments: { name: "" } },
      }),
    );
    expect(await toolsOnTape(app)).toEqual(["flip_switch"]);
  });

  it("stamps the tool when the legacy /mcp/call names one that does not exist", async () => {
    const app = createApp(dualSurfaceTwin);
    await app.request(`${base}/mcp/call`, post({ tool: "no_such_tool", arguments: {} }));
    expect(await toolsOnTape(app)).toEqual(["no_such_tool"]);
  });
});
