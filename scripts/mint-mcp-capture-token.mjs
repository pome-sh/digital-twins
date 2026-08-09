#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1329 — mint a one-shot bearer for an OAuth-gated MCP `tools/list` capture.
//
// ── WHY THIS IS A SCRIPT AND NOT A RUNBOOK ─────────────────────────────────
//
// The three grants this ticket needs are authorization-code + PKCE flows, and a
// hand-run PKCE flow is where a runbook's accuracy goes to die: the verifier has
// to survive between two commands, the challenge is base64url of a SHA-256 of
// the verifier's ASCII (not of its bytes decoded), `state` has to be checked,
// and the redirect must match the registration byte for byte. Every one of those
// is a silent failure that looks like a bad credential. So the flow is code, the
// code is reviewed, and the runbook is three lines long.
//
// ── THIS TOKEN IS NOT A SECRET TO KEEP ─────────────────────────────────────
//
// `scripts/capture-mcp-tools-list.mjs` is deliberately off-cron and CI runs it
// `--check --offline`, so nothing automated ever reads these tokens. They are
// one-shot: mint, capture, commit the golden, revoke. Storing one in a secret
// store would buy nothing and would manufacture F-1104 — a lane that quietly
// stopped running behind a page that kept publishing — because all three vendors
// issue expiring access tokens.
//
// So the token is written to a 0600 file under the system temp dir and NEVER
// printed. Printing it would put it in the terminal scrollback, the shell
// history of whatever consumed it, and any session transcript.
//
// ── WHAT THE SCOPES DECIDE ─────────────────────────────────────────────────
//
// Not just what the token may do — WHAT THE LISTING CONTAINS. Stripe's own docs
// removed `--tools` with "Tool permissions are now controlled by your Restricted
// API Key", and Slack's MCP page lists its scopes per tool. So a read-only grant
// can return a SHORTER tool list than a real examinee's agent sees, and a golden
// captured that way makes the lane report the twin's write tools as
// `mcp-tool-twin-only` — a CRITICAL asserting the twin invented a capability
// that actually exists. That is a fabricated finding, the one thing the lane
// must never produce.
//
// Hence `--scopes` is explicit and required-by-default rather than defaulted to
// something safe-sounding: capture under the scope set an examinee would carry,
// and record it. `--scopes` also makes the invariance check cheap — mint twice,
// capture twice, diff. If the listings match, say so in the source table's
// `configuration` and the question is closed for good.
//
// Usage:
//   node scripts/mint-mcp-capture-token.mjs linear
//   node scripts/mint-mcp-capture-token.mjs stripe
//   node scripts/mint-mcp-capture-token.mjs slack --client-id … --client-secret … --scopes "a,b,c"
//
// It prints the env var to run the capture with, and the path to read it from.
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-vendor facts, all probed 2026-08-09 rather than remembered.
 *
 * `register` is null for slack because Slack's MCP page says outright: "We do
 * not support SSE-based connections or Dynamic Client Registration at this
 * time." Its `.well-known/oauth-authorization-server` confirms it — no
 * `registration_endpoint`, and `token_endpoint_auth_method` is
 * `client_secret_post`, i.e. bring your own app.
 */
const VENDORS = {
  linear: {
    envVar: "POME_LINEAR_MCP_TOKEN",
    authorize: "https://mcp.linear.app/authorize",
    token: "https://mcp.linear.app/token",
    register: "https://mcp.linear.app/register",
    resource: "https://mcp.linear.app/mcp",
    port: 16735,
    defaultScopes: "read",
  },
  stripe: {
    envVar: "POME_STRIPE_MCP_TOKEN",
    authorize: "https://access.stripe.com/mcp/oauth2/authorize",
    token: "https://access.stripe.com/mcp/oauth2/token",
    register: "https://access.stripe.com/mcp/oauth2/register",
    resource: "https://mcp.stripe.com",
    port: 16736,
    // Stripe's metadata publishes no `scopes_supported`; its DCR response comes
    // back with `scope: "mcp"`, which is what it grants.
    defaultScopes: "mcp",
  },
  slack: {
    envVar: "POME_SLACK_MCP_TOKEN",
    authorize: "https://slack.com/oauth/v2_user/authorize",
    token: "https://slack.com/api/oauth.v2.user.access",
    register: null,
    resource: "https://mcp.slack.com/mcp",
    port: 16737,
    defaultScopes: null, // must be stated: see the header on what scopes decide
    // SLACK REFUSES AN http:// REDIRECT, INCLUDING ON LOCALHOST. Its OAuth page:
    // "The `redirect_uri` must use HTTPS … A Redirect URL must also use HTTPS",
    // with no localhost exception, and the examples mark `http://` and
    // `http://…:8080` as BAD. Registering `http://127.0.0.1:…` therefore fails
    // at app-configuration time — before any of this runs — and the error names
    // the redirect rather than anything about MCP.
    //
    // So this callback is served over TLS with a throwaway self-signed cert,
    // which is what makes `https://localhost:<port>/oauth/callback` a legal
    // Redirect URL to register. The browser will interrupt once with a
    // certificate warning; that is expected, and the cert is generated fresh per
    // run into the temp dir. linear and stripe both accepted the plain-http
    // loopback at registration (probed 2026-08-09), so they do not pay for this.
    tls: true,
    redirectHost: "localhost",
  },
};

/** A throwaway localhost cert, so the loopback callback can be served over TLS. */
function selfSignedCert() {
  const dir = tmpdir();
  const key = join(dir, `pome-mcp-cb-key-${process.pid}.pem`);
  const cert = join(dir, `pome-mcp-cb-cert-${process.pid}.pem`);
  try {
    execFileSync(
      "openssl",
      // prettier-ignore
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
       "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
       "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
      { stdio: "ignore" }
    );
  } catch (err) {
    throw new Error(
      `could not generate a localhost certificate with \`openssl\` (${err.message}). Slack refuses an ` +
        `http:// redirect, so the callback has to be served over TLS.`
    );
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function parseArgv(argv) {
  const [vendor, ...rest] = argv;
  const opts = { vendor };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument \`${key}\``);
    opts[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[++i];
  }
  return opts;
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * RFC 7636 S256. The challenge is the SHA-256 of the verifier's ASCII
 * characters, base64url-encoded — hashing the base64url-DECODED bytes instead is
 * the classic silent mismatch, and the vendor answers `invalid_grant`, which
 * reads as a bad code rather than a bad challenge.
 */
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

async function registerClient(vendor, redirectUri) {
  const res = await fetch(vendor.register, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "pome-fidelity-mcp-capture",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    throw new Error(`dynamic client registration failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** Serve exactly one callback, then stop. Returns the query it was called with. */
function awaitCallback(vendor) {
  const { port, tls } = vendor;
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem">` +
          (err
            ? `<h2>Authorization refused</h2><p><code>${err}: ${url.searchParams.get("error_description") ?? ""}</code></p>`
            : `<h2>Authorized.</h2><p>Close this tab and return to the terminal.</p>`) +
          `</body>`
      );
      server.close();
      if (err) reject(new Error(`${err}: ${url.searchParams.get("error_description") ?? "(no description)"}`));
      else resolve({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
    };
    const server = tls ? createHttpsServer(selfSignedCert(), handler) : createHttpServer(handler);
    server.on("error", (e) =>
      reject(new Error(`cannot listen on 127.0.0.1:${port} (${e.code}) — the redirect URI is registered against this exact port`))
    );
    server.listen(port, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("timed out after 5 minutes waiting for the browser redirect"));
    }, 300_000).unref();
  });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const vendor = VENDORS[opts.vendor];
  if (!vendor) {
    throw new Error(`usage: mint-mcp-capture-token.mjs <${Object.keys(VENDORS).join("|")}> [--scopes …]`);
  }

  const scopes = opts.scopes ?? vendor.defaultScopes;
  if (!scopes) {
    throw new Error(
      `${opts.vendor}: --scopes is required. The grant's scopes decide WHAT THE LISTING CONTAINS, not just ` +
        `what the token may do, so there is no safe default — see this file's header.`
    );
  }

  const scheme = vendor.tls ? "https" : "http";
  const host = vendor.redirectHost ?? "127.0.0.1";
  const redirectUri = `${scheme}://${host}:${vendor.port}/oauth/callback`;
  let clientId = opts.clientId;
  let clientSecret = opts.clientSecret;
  if (!clientId) {
    if (!vendor.register) {
      throw new Error(
        `${opts.vendor} does not support dynamic client registration, so --client-id (and --client-secret) ` +
          `are required. Create the app first; see SECRETS.md.`
      );
    }
    ({ clientId, clientSecret } = await registerClient(vendor, redirectUri));
    console.log(`registered a client: ${clientId}`);
  }

  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const authUrl = new URL(vendor.authorize);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.split(/[,\s]+/).filter(Boolean).join(vendor === VENDORS.slack ? "," : " "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // RFC 8707. Linear's metadata advertises `resource`; sending it everywhere is
    // harmless and is what binds the token to the MCP resource rather than to the
    // vendor's whole API.
    resource: vendor.resource,
  })) {
    authUrl.searchParams.set(k, v);
  }

  console.log(`\nOpen this and approve (it should open by itself):\n\n  ${authUrl}\n`);
  spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();

  const cb = await awaitCallback(vendor);
  if (cb.state !== state) {
    throw new Error("state mismatch — the redirect did not come from the request this process started");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: cb.code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (clientSecret) form.set("client_secret", clientSecret);
  const res = await fetch(vendor.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await res.json().catch(() => ({}));

  // Slack answers HTTP 200 with `{ok:false}` on failure — checking res.ok alone
  // would hand a golden capture an `undefined` bearer and blame the vendor's 401.
  const token = body.access_token ?? body.authed_user?.access_token;
  if (!res.ok || body.ok === false || !token) {
    throw new Error(`token exchange failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }

  const out = join(tmpdir(), `pome-mcp-token-${opts.vendor}`);
  writeFileSync(out, token, { mode: 0o600 });
  chmodSync(out, 0o600);

  const granted = body.scope ?? body.authed_user?.scope ?? "(not reported)";
  console.log(`\n  granted scopes : ${granted}`);
  console.log(`  expires_in     : ${body.expires_in ?? "(not reported — treat as short-lived)"}`);
  console.log(`  token written  : ${out} (0600, never printed)\n`);
  console.log(`Capture with it, without putting it in your shell history:\n`);
  console.log(`  ${vendor.envVar}="$(cat ${out})" node scripts/capture-mcp-tools-list.mjs --twin ${opts.vendor}\n`);
  console.log(`Then RECORD the granted scopes above in config/mcp-capture-sources.json's`);
  console.log(`\`configuration\` for this twin — a capture under a different grant is a different upstream.`);
  console.log(`Then delete ${out} and revoke the grant.\n`);
}

main().catch((err) => {
  console.error(`\nmint-mcp-capture-token: ${err.message}\n`);
  process.exit(1);
});
