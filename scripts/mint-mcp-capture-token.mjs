#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Mints a vendor OAuth token for a live MCP capture. Per-vendor quirks below were
// probed, not remembered — re-probe before trusting them.
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VENDORS = {
  linear: {
    envVar: "POME_LINEAR_MCP_TOKEN",
    authorize: "https://mcp.linear.app/authorize",
    token: "https://mcp.linear.app/token",
    register: "https://mcp.linear.app/register",
    resource: "https://mcp.linear.app/mcp",
    port: 16735,
    defaultScopes: null, // must be stated: see the header on what scopes decide
  },
  stripe: {
    envVar: "POME_STRIPE_MCP_TOKEN",
    authorize: "https://access.stripe.com/mcp/oauth2/authorize",
    token: "https://access.stripe.com/mcp/oauth2/token",
    register: "https://access.stripe.com/mcp/oauth2/register",
    resource: "https://mcp.stripe.com",
    port: 16736,
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
    tls: true,
    redirectHost: "localhost",
  },
};

function selfSignedCert() {
  const dir = tmpdir();
  const key = join(dir, `pome-mcp-cb-key-${process.pid}.pem`);
  const cert = join(dir, `pome-mcp-cb-cert-${process.pid}.pem`);
  try {
    execFileSync(
      "openssl",
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
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(
        `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem">` +
          (err
            ? `<h2>Authorization refused.</h2><p>The reason is printed in your terminal.</p>`
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
