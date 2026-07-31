#!/usr/bin/env node
/**
 * Regression coverage for scripts/probe-example-tools.mjs (F-1152).
 *
 * The gate exists because `comment_on_pull_request` in
 * examples/pr-summary-agent and examples/pr-summary-review wrapped
 * `add_issue_comment` at a pull request's number, the GitHub twin answered
 * `404 Issue not found` for every one of those calls on all four subjects for
 * as long as the examples had existed, and both older example gates
 * (typecheck:examples, smoke:examples) were green throughout. The cases below
 * are written from that incident.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig, splitSeed } from "./probe-example-tools.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}
function assertThrows(fn, match, msg) {
  try {
    fn();
  } catch (err) {
    assert(String(err.message).includes(match), `${msg} (message was: ${err.message})`);
    return;
  }
  assert(false, `${msg} (did not throw)`);
}

// ── splitSeed ───────────────────────────────────────────────────────────────
// A single-twin example ships a FLAT seed. examples/triage-agent's is
// { _meta, users, repositories }.
{
  const flat = { _meta: { version: 1 }, users: [], repositories: [{ owner: "acme", name: "api" }] };
  const out = splitSeed(flat, ["github"]);
  assert(out.github === flat, "splitSeed hands a flat seed to the single declared twin verbatim");
}

// A multi-twin example ships a PER-TWIN ENVELOPE. Both viktor examples'
// 01-clean-merge.seed.json is exactly { github: {...}, slack: {...} }.
{
  const gh = { users: [], repositories: [] };
  const sl = { channels: [] };
  const out = splitSeed({ github: gh, slack: sl }, ["github", "slack"]);
  assert(out.github === gh, "splitSeed slices the github half of an envelope");
  assert(out.slack === sl, "splitSeed slices the slack half of an envelope");
}

// The failure this hard error exists to prevent is F-987's: a per-twin envelope
// read as a flat seed compiles the whole envelope into ONE twin's world, and
// nothing complains.
assertThrows(
  () => splitSeed({ github: {}, slack: {} }, ["github"]),
  "declares twins [github]",
  "splitSeed rejects an envelope carrying a twin the example does not declare",
);
assertThrows(
  () => splitSeed({ github: {} }, ["github", "slack"]),
  "slack",
  "splitSeed rejects an envelope missing a declared twin",
);
assertThrows(
  () => splitSeed({ _meta: {}, users: [] }, ["github", "slack"]),
  "flat seed",
  "splitSeed rejects a flat seed for a multi-twin example",
);

// ── resolveConfig ───────────────────────────────────────────────────────────
{
  const ctx = {
    twins: {
      github: { rest: "http://127.0.0.1:5001", mcp: "http://127.0.0.1:5001/s/probe/mcp" },
      slack: { rest: "http://127.0.0.1:5002", mcp: "http://127.0.0.1:5002/s/probe/mcp" },
    },
    token: "jwt-abc",
  };
  const out = resolveConfig(
    { mcpUrl: "$github.mcp", ghUrl: "$github.rest", slackUrl: "$slack.rest", token: "$token" },
    ctx,
  );
  assert(out.mcpUrl === "http://127.0.0.1:5001/s/probe/mcp", "resolveConfig fills $<twin>.mcp");
  assert(out.ghUrl === "http://127.0.0.1:5001", "resolveConfig fills $<twin>.rest");
  assert(out.slackUrl === "http://127.0.0.1:5002", "resolveConfig fills a second twin");
  assert(out.token === "jwt-abc", "resolveConfig fills $token");

  const literal = resolveConfig({ channel: "eng-alerts", max: 3 }, ctx);
  assert(literal.channel === "eng-alerts" && literal.max === 3, "resolveConfig passes non-$ values through");

  assertThrows(
    () => resolveConfig({ url: "$stripe.rest" }, ctx),
    "$stripe.rest",
    "resolveConfig rejects a token naming a twin that was not booted",
  );
  assertThrows(
    () => resolveConfig({ url: "$github.graphql" }, ctx),
    "$github.graphql",
    "resolveConfig rejects an unknown surface on a booted twin",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("probe-example-tools: all assertions passed.");
