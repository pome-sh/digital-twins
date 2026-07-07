// SPDX-License-Identifier: Apache-2.0
//
// Test bootstrap. Since F-684 the twin assembles on the @pome-sh/sdk engine
// via `createTwinStripeApp` (src/twin.ts) — auth, recorder + redaction, MCP
// dispatch, /_pome/*, admin gate, and failure injection are the engine's;
// the helper only opens a db, seeds the default world, and hands back a
// domain handle over the same db for direct assertions.
import { createTwinStripeApp } from "../src/twin.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { StripeDomain } from "../src/domain/index.js";
import { defaultSeed } from "../src/seed.js";
import type { ResolvedSession, TwinStripeDatabase } from "../src/types.js";
import {
  TEST_ACCOUNT_ID,
  TEST_AUTH_SECRET,
  TEST_SID,
  signTestToken,
  withAuth,
} from "./_authHelper.js";

export { TEST_ACCOUNT_ID, TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth };
export type { ResolvedSession };

export type StripeTestApp = {
  app: ReturnType<typeof createTwinStripeApp>;
  base: string;
  token: string;
  domain: StripeDomain;
  db: TwinStripeDatabase;
};

/** Build a fresh app + session token over an in-memory db with the default seed. */
export async function createStripeApp(): Promise<StripeTestApp> {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  const db = openTwinStripeDatabase(":memory:");
  const app = createTwinStripeApp({ db, seed: defaultSeed(), runId: "test-run" });
  // StripeDomain is stateless over the db; a second handle sees the same state.
  const domain = new StripeDomain(db);
  const token = await signTestToken();
  return { app, base: `/s/${TEST_SID}`, token, domain, db };
}

export async function rest(
  test: StripeTestApp,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  const headers = new Headers(extraHeaders);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  init.headers = headers;
  const response = await test.app.request(`${test.base}${path}`, withAuth(test.token, init));
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export async function callTool(
  test: StripeTestApp,
  tool: string,
  args: unknown
): Promise<{ status: number; body: any }> {
  const response = await test.app.request(
    `${test.base}/mcp/call`,
    withAuth(test.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args })
    })
  );
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}
