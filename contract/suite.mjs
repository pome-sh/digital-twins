// SPDX-License-Identifier: Apache-2.0
//
// Reusable body of the black-box twin runtime-contract suite.
// Extracted verbatim from contract.test.mjs so the same frozen
// assertions can run against any built twin artifact AND the sdk-booted
// proof entry (contract/sdk-boot.test.mjs). Changing any asserted status or
// shape here is a contract change: update CONTRACT.md in the same PR and
// coordinate the pome-cloud consumer PR per the contract doc.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTH_SECRET, mintSessionJwt, req, spawnTwin, spawnTwinRaw } from "./helpers.mjs";

const SID = "contract-sid";
const sPath = (p) => `/s/${SID}${p}`;

// Per-twin frozen expectations, taken from live probes on 2026-07-07.
export const PER_TWIN = {
  github: {
    // /healthz carries fidelity + access_control on top of the shared core.
    healthzFidelity: "semantic",
    healthzExtras: ["access_control"],
    sessionHealthz: { status: 200 },
    // github validates seeds: a garbage body is a 422 GitHub validation error.
    adminSeedGarbage: { status: 422, check: (b) => b.message === "Validation Failed" },
    // CONTRACT CHANGE: `noAuth` sends NO Authorization header, and real
    // GitHub answers that with `Requires authentication` — `Bad credentials`
    // is what it answers a bad token. Measured live 2026-08-13 on `GET /user`,
    // both ways. The twin used to collapse the two; CONTRACT.md's auth
    // table moved with this line. No pome-cloud consumer reads either string
    // (searched: zero hits for "Bad credentials" in that repo).
    noAuth: {
      status: 401,
      check: (b) =>
        b.message === "Requires authentication" &&
        b.documentation_url === "https://docs.github.com/rest" &&
        b.status === "401",
    },
    wrongSid: {
      status: 401,
      check: (b) =>
        b.message === "Forbidden" &&
        b.documentation_url === "https://docs.github.com/rest" &&
        b.status === "401",
    },
    // hono/jwt's verify throws on an expired token before auth.ts's explicit
    // "Token expired" branch is reached, so the wire says "Bad credentials".
    expired: { status: 401, check: (b) => b.message === "Bad credentials" },
    rawToken: { status: 401 },
    mcpCallUnknown: { status: 422, check: (b) => b.message === "Validation Failed" },
    // Body-parsing corners (review pins, probed 2026-07-08): github is
    // strict JSON everywhere — form-encoded and malformed bodies answer the
    // GitHub wire error; {name}/{params} aliases are not accepted.
    aliasTool: "list_repos",
    adminSeedForm: { status: 400, check: (b) => b.message === "Problems parsing JSON" },
    adminSeedMalformed: { status: 400, check: (b) => b.message === "Problems parsing JSON" },
    mcpCallAlias: { status: 422, check: (b) => b.message === "Validation Failed" && b.errors?.[0]?.field === "tool" },
    mcpCallForm: { status: 400, check: (b) => b.message === "Problems parsing JSON" },
    mcpCallMalformed: { status: 400, check: (b) => b.message === "Problems parsing JSON" },
    pomeHealthKeys: ["fidelity", "implementation", "ok", "runtime", "twin"],
    adminSeedTape: "delta-null",
    unknownSession: { status: 501, check: (b) => b._twin?.fidelity === "unsupported" },
    unknownRoot: { status: 404 },
  },
  slack: {
    // slack's /healthz carries no fidelity field today.
    healthzFidelity: undefined,
    sessionHealthz: { status: 200 },
    // slack accepts arbitrary seed bodies with 200 {ok:true} (no validation).
    adminSeedGarbage: { status: 200, check: (b) => b.ok === true },
    noAuth: { status: 401, check: (b) => b.ok === false && b.error === "not_authed" },
    wrongSid: { status: 401, check: (b) => b.error === "invalid_auth" },
    // slack is the only twin distinguishing token_expired from invalid_auth.
    expired: { status: 401, check: (b) => b.error === "token_expired" },
    rawToken: { status: 401 },
    mcpCallUnknown: { status: 404, check: (b) => b.error === "unknown_tool" },
    // Body-parsing corners (review pins; probed 2026-07-08 against the
    // pre-port 3cd86eb build): slack parses form-or-JSON tolerantly on every
    // surface (official Slack SDKs default to form-urlencoded; malformed JSON
    // collapses to {}), accepts the {name}/{params} alias keys, a body naming
    // no tool is 400 {ok:false, error:"invalid_arguments"}, and admin errors
    // (a form seed whose string value fails the seed schema) are 500
    // internal_error — the admin surface has its own envelope.
    // `slack_read_user_profile` because this probe sends no arguments at all
    // ({name, params:{}} and a bare `tool=` form body) and it is one of the
    // two Slack tools with an empty `required` — it defaults to the caller.
    aliasTool: "slack_read_user_profile",
    adminSeedForm: { status: 500, check: (b) => b.ok === false && b.error === "internal_error" },
    adminSeedMalformed: { status: 200, check: (b) => b.ok === true },
    mcpCallAlias: { status: 200, check: (b) => b.ok === true },
    mcpCallForm: { status: 200, check: (b) => b.ok === true },
    mcpCallMalformed: { status: 400, check: (b) => b.ok === false && b.error === "invalid_arguments" },
    pomeHealthKeys: ["ok", "twin"],
    adminSeedTape: "delta-null",
    unknownSession: {
      status: 501,
      check: (b) => b.error === "unsupported_endpoint" && b._twin?.fidelity === "unsupported",
    },
    unknownRoot: { status: 404 },
  },
  stripe: {
    healthzFidelity: "semantic",
    healthzExtras: ["tthw_seconds"],
    // stripe has no per-session /healthz; the path falls to the 501 catch-all.
    sessionHealthz: { status: 501 },
    adminSeedGarbage: { status: 200, check: (b) => b.ok === true },
    noAuth: { status: 401, check: (b) => b.error?.code === "unauthorized" },
    // stripe is the only twin answering a sid mismatch with 403 (not 401).
    wrongSid: { status: 403, check: (b) => b.error?.code === "forbidden" },
    expired: { status: 401, check: (b) => b.error?.code === "unauthorized" },
    // stripe accepts a prefix-less bearer (raw JWT) today — the raw-bearer row
    // of CONTRACT.md's per-twin frozen differences.
    rawToken: { status: 200 },
    mcpCallUnknown: { status: 400, check: (b) => b.error?.code === "tool_unknown" },
    // Body-parsing corners (review pins, probed on the pre-port twin):
    // stripe reads form-or-JSON (malformed JSON collapses to {}), rejects the
    // alias keys with its parameter_invalid envelope, and dispatches
    // form-encoded legacy /mcp/call bodies.
    aliasTool: "retrieve_balance",
    adminSeedForm: { status: 200, check: (b) => b.ok === true },
    adminSeedMalformed: { status: 200, check: (b) => b.ok === true },
    mcpCallAlias: { status: 400, check: (b) => b.error?.code === "parameter_invalid" && b.error?.param === "tool" },
    mcpCallForm: { status: 200, check: (b) => typeof b === "object" },
    mcpCallMalformed: { status: 400, check: (b) => b.error?.code === "parameter_invalid" && b.error?.param === "tool" },
    pomeHealthKeys: ["fidelity", "implementation", "ok", "recorder", "runtime", "tthw_seconds", "twin"],
    adminSeedTape: "none",
    // Probed on the 3cd86eb baseline: an api-key-shaped bearer that resolves
    // nowhere answers the frozen Invalid-API-Key envelope, never the JWT
    // "Bad credentials" message.
    unknownApiKey: {
      status: 401,
      check: (b) => b.error?.code === "unauthorized" && b.error?.message === "Invalid API Key provided.",
    },
    unknownSession: {
      status: 501,
      check: (b) => b.error?.code === "endpoint_not_supported" && b.error?.fidelity === "unsupported",
    },
    // stripe's root-level unknown paths hit the /v1 auth wall first: 401.
    unknownRoot: { status: 401 },
  },
  gmail: {
    healthzFidelity: "semantic",
    sessionHealthz: { status: 200 },
    adminSeedGarbage: {
      status: 400,
      check: (b) => b.error?.status === "INVALID_ARGUMENT",
    },
    noAuth: {
      status: 401,
      check: (b) => b.error?.status === "UNAUTHENTICATED",
    },
    wrongSid: {
      status: 401,
      check: (b) => b.error?.status === "UNAUTHENTICATED",
    },
    expired: {
      status: 401,
      check: (b) => b.error?.status === "UNAUTHENTICATED",
    },
    rawToken: { status: 401 },
    mcpCallUnknown: {
      status: 404,
      check: (b) => b.error?.status === "NOT_FOUND",
    },
    aliasTool: "list_labels",
    adminSeedForm: {
      status: 400,
      check: (b) => b.error?.status === "INVALID_ARGUMENT",
    },
    adminSeedMalformed: {
      status: 400,
      check: (b) => b.error?.status === "INVALID_ARGUMENT",
    },
    mcpCallAlias: {
      status: 400,
      check: (b) => b.error?.status === "INVALID_ARGUMENT",
    },
    mcpCallForm: {
      status: 400,
      check: (b) => b.error?.status === "INVALID_ARGUMENT",
    },
    mcpCallMalformed: {
      status: 400,
      check: (b) => b.error?.status === "INVALID_ARGUMENT",
    },
    pomeHealthKeys: ["fidelity", "ok", "twin", "version"],
    // The generic tape probe sends `{}`, which is an invalid Gmail seed, so
    // the recorded failed request has no committed state delta.
    adminSeedTape: "delta-null",
    unknownSession: {
      status: 501,
      check: (b) => b.error?.status === "UNIMPLEMENTED",
    },
    unknownRoot: { status: 404 },
  },
  linear: {
    healthzFidelity: "semantic",
    sessionHealthz: { status: 200 },
    adminSeedGarbage: {
      status: 400,
      check: (b) => b.errors?.[0]?.extensions?.code === "BAD_USER_INPUT",
    },
    noAuth: {
      status: 401,
      check: (b) => b.errors?.[0]?.extensions?.code === "AUTHENTICATION_ERROR",
    },
    wrongSid: {
      status: 401,
      check: (b) => b.errors?.[0]?.extensions?.code === "AUTHENTICATION_ERROR",
    },
    expired: {
      status: 401,
      check: (b) => b.errors?.[0]?.extensions?.code === "AUTHENTICATION_ERROR",
    },
    // Linear accepts prefix-less JWTs (`allowRawBearer: true`) and also
    // resolves seeded personal tokens such as `lin_test_admin`.
    rawToken: { status: 200 },
    mcpCallUnknown: {
      status: 404,
      check: (b) => b.errors?.[0]?.extensions?.code === "NOT_FOUND",
    },
    aliasTool: "list_issues",
    adminSeedForm: {
      status: 400,
      check: (b) => b.errors?.[0]?.extensions?.code === "BAD_USER_INPUT",
    },
    adminSeedMalformed: {
      status: 400,
      check: (b) => b.errors?.[0]?.extensions?.code === "BAD_USER_INPUT",
    },
    mcpCallAlias: {
      status: 400,
      check: (b) => b.errors?.[0]?.extensions?.code === "BAD_USER_INPUT",
    },
    mcpCallForm: {
      status: 400,
      check: (b) => b.errors?.[0]?.extensions?.code === "BAD_USER_INPUT",
    },
    mcpCallMalformed: {
      status: 400,
      check: (b) => b.errors?.[0]?.extensions?.code === "BAD_USER_INPUT",
    },
    pomeHealthKeys: ["fidelity", "ok", "twin", "version"],
    // `{}` is a valid Linear seed (defaults applied), so admin/seed commits a
    // real before/after state delta on the tape.
    adminSeedTape: "delta-object",
    unknownSession: {
      status: 501,
      check: (b) => b.fidelity === "unsupported",
    },
    // Root session mount (`mountSessionAtRoot`) hits the auth wall first.
    unknownRoot: { status: 401 },
  },
};

function checkBody(expectation, body, label) {
  if (expectation.check) assert.ok(expectation.check(body ?? {}), `${label}: body shape — got ${JSON.stringify(body)}`);
}

/**
 * What each vendor actually puts on an auth-refusal envelope, and the
 * 403 body the twin's admin gate must answer with.
 *
 * ── HOW THIS WAS OBTAINED ─────────────────────────────────────────────────
 *
 * All five vendors were probed live on 2026-08-13, twice each: once with
 * `Authorization: Bearer <deliberately invalid>` and once with no
 * `Authorization` header at all. Read-only endpoints, nothing created:
 * `api.github.com/user`, `slack.com/api/auth.test`, `api.stripe.com/v1/customers`,
 * `gmail.googleapis.com/gmail/v1/users/me/profile`,
 * `api.linear.app/graphql` (`{ viewer { id } }`).
 *
 * ⚠️ ONE of the five sends `documentation_url`. GitHub. The other four send no
 * such key anywhere in the body, which is why `docsUrl: null` below is an
 * assertion and not a "not measured" — it says the twin must not invent one.
 * All five used to, because the 401/403 defaults in `@pome-sh/sdk`
 * carried `documentation_url: ""`, and gmail + linear were reaching that
 * default on their admin 403.
 *
 * The `docsUrl` github does send is the GENERIC one on every 401 (8/8)
 * — authentication fails before dispatch, so there is no operation to name, and
 * the twin's admin route is twin-only for the same reason.
 */
const AUTH_ENVELOPE = {
  github: {
    docsUrl: "https://docs.github.com/rest",
    adminForbidden: {
      message: "Forbidden",
      documentation_url: "https://docs.github.com/rest",
      status: "403",
    },
  },
  slack: {
    docsUrl: null,
    adminForbidden: { ok: false, error: "restricted_action" },
  },
  stripe: {
    docsUrl: null,
    adminForbidden: {
      error: { type: "invalid_request_error", code: "forbidden", message: "Forbidden" },
    },
  },
  gmail: {
    docsUrl: null,
    adminForbidden: {
      error: {
        code: 403,
        message: "Forbidden",
        errors: [{ message: "Forbidden", domain: "global", reason: "forbidden" }],
        status: "PERMISSION_DENIED",
      },
    },
  },
  linear: {
    docsUrl: null,
    adminForbidden: {
      errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN", http: { status: 403 } } }],
    },
  },
};

/** Every `documentation_url` anywhere in a body, however deeply nested. */
function collectDocumentationUrls(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectDocumentationUrls(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "documentation_url") found.push(item);
      else collectDocumentationUrls(item, found);
    }
  }
  return found;
}

/**
 * The cross-twin half of the auth contract: a twin may carry its OWN vendor's
 * `documentation_url` and no other twin's, and a twin whose vendor sends none
 * must send none — not `""`, not a nested one, not GitHub's.
 *
 * Recursive rather than a top-level key check on purpose: gmail's and linear's
 * bodies are nested, so a leak into `error.documentation_url` would be
 * invisible to a shallow read.
 */
function assertVendorDocsUrl(name, body, label) {
  const expected = AUTH_ENVELOPE[name].docsUrl;
  const found = collectDocumentationUrls(body ?? {});
  if (expected === null) {
    assert.deepEqual(
      found,
      [],
      `${label}: ${name}'s vendor sends no documentation_url on an auth refusal, so the twin must not — got ${JSON.stringify(body)}`
    );
    return;
  }
  assert.deepEqual(
    found,
    [expected],
    `${label}: ${name}'s vendor sends exactly one documentation_url (${expected}) — got ${JSON.stringify(body)}`
  );
}

/**
 * The per-twin contract suite. `label` distinguishes multiple runs against
 * the same twin name (e.g. the sdk-booted proof entry).
 */
export function contractSuite(twin, exp, label = twin.name) {
  describe(`contract: ${label}`, () => {
    let t;
    let jwt;

    before(async () => {
      t = await spawnTwin(twin); // asserts /healthz 200 within the 3s bound
      jwt = mintSessionJwt({ sid: SID });
    });
    after(async () => {
      await t?.close();
    });

    it("GET /healthz → 200 with the frozen shape (ok, twin, implementation, tools, runtime)", () => {
      const h = t.healthz;
      assert.equal(h.ok, true);
      assert.equal(h.twin, twin.name);
      assert.equal(typeof h.implementation, "string");
      assert.equal(typeof h.tools, "number");
      assert.ok(h.tools > 0, "advertises at least one MCP tool");
      if (exp.healthzFidelity !== undefined) assert.equal(h.fidelity, exp.healthzFidelity);
      for (const key of exp.healthzExtras ?? []) assert.ok(key in h, `healthz carries ${key}`);
      for (const key of ["package", "version", "git_sha", "build_time"]) {
        assert.equal(typeof h.runtime?.[key], "string", `runtime.${key} is a string`);
      }
    });

    it("POST /admin/reset from loopback → 200 {ok:true} (no bearer required)", async () => {
      const res = await req(t.base, "/admin/reset", { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(res.json?.ok, true);
    });

    it(`POST /admin/seed with a garbage body → ${exp.adminSeedGarbage.status} (frozen per-twin validation behavior)`, async () => {
      const res = await req(t.base, "/admin/seed", { method: "POST", body: { definitely: "not-a-seed" } });
      assert.equal(res.status, exp.adminSeedGarbage.status);
      checkBody(exp.adminSeedGarbage, res.json, "admin/seed garbage");
    });

    it("GET /s/:sid/_pome/health|state|events with a valid session JWT → 200", async () => {
      const health = await req(t.base, sPath("/_pome/health"), { token: jwt });
      assert.equal(health.status, 200);
      assert.equal(health.json?.ok, true);
      assert.equal(health.json?.twin, twin.name);

      const state = await req(t.base, sPath("/_pome/state"), { token: jwt });
      assert.equal(state.status, 200);
      assert.ok(state.json && typeof state.json === "object" && !Array.isArray(state.json), "state is a JSON object");

      const events = await req(t.base, sPath("/_pome/events"), { token: jwt });
      assert.equal(events.status, 200);
      assert.ok(Array.isArray(events.json), "events is a JSON array");
    });

    it(`GET /s/:sid/healthz → ${exp.sessionHealthz.status} (frozen; stripe has no per-session healthz)`, async () => {
      const res = await req(t.base, sPath("/healthz"), { token: jwt });
      assert.equal(res.status, exp.sessionHealthz.status);
      if (res.status === 200) {
        assert.equal(res.json?.ok, true);
        assert.equal(res.json?.sid, SID);
      }
    });

    it("MCP surface: tools list matches healthz.tools; JSON-RPC initialize 200; GET /mcp 405", async () => {
      const tools = await req(t.base, sPath("/mcp/tools"), { token: jwt });
      assert.equal(tools.status, 200);
      assert.ok(Array.isArray(tools.json?.tools));
      assert.equal(tools.json.tools.length, t.healthz.tools, "healthz.tools equals the MCP tool list length");

      const init = await req(t.base, sPath("/mcp"), {
        method: "POST",
        token: jwt,
        headers: { accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "contract-suite", version: "0" } },
        },
      });
      assert.equal(init.status, 200);
      assert.equal(init.json?.jsonrpc, "2.0");
      assert.equal(typeof init.json?.result?.serverInfo?.name, "string");

      const get = await req(t.base, sPath("/mcp"), { token: jwt });
      assert.equal(get.status, 405, "stateless-mode GET /mcp is 405");
    });

    it("POST /s/:sid/mcp/call with an unknown tool → frozen per-twin error envelope", async () => {
      const res = await req(t.base, sPath("/mcp/call"), {
        method: "POST",
        token: jwt,
        body: { tool: "definitely_not_a_tool", arguments: {} },
      });
      assert.equal(res.status, exp.mcpCallUnknown.status);
      checkBody(exp.mcpCallUnknown, res.json, "mcp/call unknown tool");
    });

    it("auth matrix: no token / garbage bearer / wrong-sid JWT / expired JWT / raw token", async () => {
      const noAuth = await req(t.base, sPath("/_pome/state"));
      assert.equal(noAuth.status, exp.noAuth.status);
      checkBody(exp.noAuth, noAuth.json, "no auth");

      const garbage = await req(t.base, sPath("/_pome/state"), { token: "garbage" });
      assert.equal(garbage.status, 401);

      const wrongSid = await req(t.base, sPath("/_pome/state"), { token: mintSessionJwt({ sid: "other-sid" }) });
      assert.equal(wrongSid.status, exp.wrongSid.status);
      checkBody(exp.wrongSid, wrongSid.json, "wrong sid");

      const expired = await req(t.base, sPath("/_pome/state"), { token: mintSessionJwt({ sid: SID, expSeconds: -60 }) });
      assert.equal(expired.status, exp.expired.status);
      checkBody(exp.expired, expired.json, "expired");

      const raw = await fetch(`${t.base}${sPath("/_pome/state")}`, {
        headers: { Authorization: mintSessionJwt({ sid: SID }) },
      });
      assert.equal(raw.status, exp.rawToken.status, "raw (prefix-less) bearer behavior is frozen per twin");

      // The same four refusals, read for ONE leaf across all five
      // twins: `documentation_url` is GitHub's key and only GitHub's vendor
      // sends it. This ran green while every twin was emitting
      // `documentation_url: ""` from the shared SDK default, which is exactly
      // the leak it now catches; see AUTH_ENVELOPE above for the measurements.
      for (const [label, body] of [
        ["no auth", noAuth.json],
        ["garbage bearer", garbage.json],
        ["wrong sid", wrongSid.json],
        ["expired", expired.json],
      ]) {
        assertVendorDocsUrl(twin.name, body, label);
      }
    });


    it(`POST /admin/seed body-parsing corners are frozen (form-encoded → ${exp.adminSeedForm.status}, malformed JSON → ${exp.adminSeedMalformed.status})`, async () => {
      const form = await fetch(`${t.base}/admin/seed`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "seed=whatever",
      });
      const formBody = await form.json().catch(() => ({}));
      assert.equal(form.status, exp.adminSeedForm.status);
      checkBody(exp.adminSeedForm, formBody, "admin/seed form-encoded");

      const malformed = await fetch(`${t.base}/admin/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{oops",
      });
      const malformedBody = await malformed.json().catch(() => ({}));
      assert.equal(malformed.status, exp.adminSeedMalformed.status);
      checkBody(exp.adminSeedMalformed, malformedBody, "admin/seed malformed JSON");
    });

    it("legacy /mcp/call body corners are frozen (alias keys, form encoding, malformed JSON)", async () => {
      const alias = await fetch(`${t.base}${sPath("/mcp/call")}`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ name: exp.aliasTool, params: {} }),
      });
      const aliasBody = await alias.json().catch(() => ({}));
      assert.equal(alias.status, exp.mcpCallAlias.status, "mcp/call {name, params} alias");
      checkBody(exp.mcpCallAlias, aliasBody, "mcp/call alias");

      const form = await fetch(`${t.base}${sPath("/mcp/call")}`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/x-www-form-urlencoded" },
        body: `tool=${exp.aliasTool}`,
      });
      const formBody = await form.json().catch(() => ({}));
      assert.equal(form.status, exp.mcpCallForm.status, "mcp/call form-encoded");
      checkBody(exp.mcpCallForm, formBody, "mcp/call form");

      const malformed = await fetch(`${t.base}${sPath("/mcp/call")}`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: "{oops",
      });
      const malformedBody = await malformed.json().catch(() => ({}));
      assert.equal(malformed.status, exp.mcpCallMalformed.status, "mcp/call malformed JSON");
      checkBody(exp.mcpCallMalformed, malformedBody, "mcp/call malformed");
    });

    it("GET /s/:sid/_pome/health carries the exact frozen key set", async () => {
      const res = await req(t.base, sPath("/_pome/health"), { token: jwt });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json ?? {}).sort(), exp.pomeHealthKeys);
    });

    it("tape shape: /_pome/state fetches are never recorded; admin/seed tape presence is frozen", async () => {
      await req(t.base, sPath("/_pome/state"), { token: jwt });
      await req(t.base, "/admin/seed", { method: "POST", body: {} });
      const events = await req(t.base, sPath("/_pome/events"), { token: jwt });
      const list = Array.isArray(events.json) ? events.json : [];
      const eventPath = (e) => String(e.request_path ?? e.path ?? e.method ?? "");
      assert.ok(!list.some((e) => eventPath(e).includes("_pome/state")), "no recorder event for /_pome/state fetches");
      const seedEvents = list.filter((e) => eventPath(e).includes("admin/seed"));
      if (exp.adminSeedTape === "none") {
        assert.equal(seedEvents.length, 0, "admin/seed is not recorded on this twin");
      } else {
        assert.ok(seedEvents.length > 0, "admin/seed is recorded on this twin");
        const last = seedEvents[seedEvents.length - 1];
        if (exp.adminSeedTape === "delta-object") {
          assert.ok(last.state_delta !== null && typeof last.state_delta === "object", "admin/seed event carries a state_delta object");
        } else {
          assert.equal(last.state_delta, null, "admin/seed event carries state_delta:null");
        }
      }
    });

    it("bearer with an unknown API key → frozen per-twin 401 envelope", { skip: !exp.unknownApiKey }, async () => {
      const res = await req(t.base, sPath("/_pome/state"), { token: "sk_test_pome_nonexistent" });
      assert.equal(res.status, exp.unknownApiKey.status);
      checkBody(exp.unknownApiKey, res.json, "unknown api key");
    });

    it("unknown session route → 501 unsupported envelope; unknown root route frozen", async () => {
      const unknown = await req(t.base, sPath("/definitely/not/a/route"), { token: jwt });
      assert.equal(unknown.status, exp.unknownSession.status);
      checkBody(exp.unknownSession, unknown.json, "unknown session route");

      const root = await req(t.base, "/definitely-not-a-route");
      assert.equal(root.status, exp.unknownRoot.status);
    });
  });
}

/** TWIN_ADMIN_TOKEN switches /admin/* to token auth (403 without/with-wrong header). */
export function adminGateCase(twin, label = twin.name) {
  it(`${label}: TWIN_ADMIN_TOKEN switches /admin/* to token auth (403 without/with-wrong header)`, async () => {
    const t = await spawnTwin(twin, { env: { TWIN_ADMIN_TOKEN: "contract-admin-token" } });
    try {
      const missing = await req(t.base, "/admin/reset", { method: "POST" });
      assert.equal(missing.status, 403);
      const wrong = await req(t.base, "/admin/reset", { method: "POST", headers: { "X-Admin-Token": "nope" } });
      assert.equal(wrong.status, 403);

      // The BODY, not just the status. This gate lives in
      // `@pome-sh/sdk` and is shared by all five twins, so its default could
      // never be vendor-shaped: it answered github's
      // `{message:"Forbidden", documentation_url:""}` on every twin that had
      // not declared its own, which was github, gmail and linear. Each twin
      // declares one now, and the whole body is asserted so a declaration that
      // drops a sibling key (gmail's `errors[]`, linear's `extensions.http`)
      // cannot pass on the leaf that moved.
      for (const [label, res] of [["missing header", missing], ["wrong token", wrong]]) {
        assert.deepEqual(
          res.json,
          AUTH_ENVELOPE[twin.name].adminForbidden,
          `${label}: ${twin.name}'s admin-gate 403 body is its OWN vendor's envelope`
        );
        assertVendorDocsUrl(twin.name, res.json, `admin 403 (${label})`);
      }
      const right = await req(t.base, "/admin/reset", { method: "POST", headers: { "X-Admin-Token": "contract-admin-token" } });
      assert.equal(right.status, 200);
      assert.equal(right.json?.ok, true);
    } finally {
      await t.close();
    }
  });
}

/**
 * Boot-secret contract: a non-loopback bind with no env-injected
 * TWIN_AUTH_SECRET self-generates a 32-byte hex secret, persists it at the
 * compose-era location (POME_TWIN_DATA_DIR overrides `.pome-data/<twin>`),
 * prints it once to stdout, and reuses it on reboot. An env-injected secret
 * always wins, and a failed generation still refuses to boot.
 */
export function bootGuardCase(twin, label = twin.name) {
  const nonLoopback = (dataDir, extra = {}) => ({
    env: {
      [twin.hostEnv]: "0.0.0.0",
      TWIN_AUTH_SECRET: "",
      POME_TWIN_DATA_DIR: dataDir,
      ...extra,
    },
  });

  it(`${label}: self-generates TWIN_AUTH_SECRET on a non-loopback bind and reuses it on reboot`, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "pome-contract-secret-"));
    try {
      // First boot: generates, persists, prints once, and serves bearer
      // traffic signed with the generated secret.
      const t1 = await spawnTwin(twin, nonLoopback(dataDir));
      let secret;
      try {
        secret = (await readFile(path.join(dataDir, "secret"), "utf8")).trim();
        assert.match(secret, /^[0-9a-f]{64}$/, "persisted secret is 32-byte hex");
        assert.ok(t1.output().includes(secret), "first boot prints the generated secret to stdout");
        const health = await req(t1.base, sPath("/_pome/health"), { token: mintSessionJwt({ sid: SID, secret }) });
        assert.equal(health.status, 200, "a JWT minted with the persisted secret authenticates");
      } finally {
        await t1.close();
      }

      // Second boot: reuses the persisted secret — no regeneration, no reprint.
      const t2 = await spawnTwin(twin, nonLoopback(dataDir));
      try {
        const persisted = (await readFile(path.join(dataDir, "secret"), "utf8")).trim();
        assert.equal(persisted, secret, "second boot does not regenerate the secret");
        assert.ok(!t2.output().includes(secret), "second boot does not reprint the secret value");
        const health = await req(t2.base, sPath("/_pome/health"), { token: mintSessionJwt({ sid: SID, secret }) });
        assert.equal(health.status, 200, "the reused secret still authenticates");
      } finally {
        await t2.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it(`${label}: an env-injected TWIN_AUTH_SECRET always wins over a persisted one`, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "pome-contract-secret-"));
    try {
      const persisted = "f".repeat(64);
      await writeFile(path.join(dataDir, "secret"), `${persisted}\n`);
      const t = await spawnTwin(twin, nonLoopback(dataDir, { TWIN_AUTH_SECRET: AUTH_SECRET }));
      try {
        const env = await req(t.base, sPath("/_pome/health"), { token: mintSessionJwt({ sid: SID }) });
        assert.equal(env.status, 200, "the env-injected secret authenticates");
        const file = await req(t.base, sPath("/_pome/health"), { token: mintSessionJwt({ sid: SID, secret: persisted }) });
        assert.equal(file.status, 401, "the persisted secret is ignored when env is set");
        const onDisk = (await readFile(path.join(dataDir, "secret"), "utf8")).trim();
        assert.equal(onDisk, persisted, "the persisted file is left untouched");
      } finally {
        await t.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it(`${label}: still refuses to boot when the secret can be neither read nor generated`, async () => {
    const blocker = await mkdtemp(path.join(tmpdir(), "pome-contract-secret-"));
    try {
      await writeFile(path.join(blocker, "not-a-dir"), "");
      const { code, output } = await spawnTwinRaw(twin, {
        [twin.hostEnv]: "0.0.0.0",
        PORT: "0",
        TWIN_AUTH_SECRET: "",
        POME_TWIN_DATA_DIR: path.join(blocker, "not-a-dir", "nested"),
      });
      assert.notEqual(code, 0, "process exits non-zero");
      assert.match(output, /TWIN_AUTH_SECRET/, "error names the missing secret");
    } finally {
      await rm(blocker, { recursive: true, force: true });
    }
  });
}
