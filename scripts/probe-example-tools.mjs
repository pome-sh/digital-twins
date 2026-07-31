#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1152 example twin-tool probe gate.
//
// `examples/pr-summary-agent` and `examples/pr-summary-review` each exposed
// exactly one comment tool, `comment_on_pull_request`, wrapping
// `add_issue_comment` at the pull request's number. The GitHub twin answered
// `404 Issue not found` for every one of those calls, on all four subjects, for
// as long as the examples had existed — and both examples' whole subject is
// *did the agent leave a summary*. F-1151 fixed the twin. Nothing had noticed,
// because the two older example gates each stop short of a twin call:
//
//   scripts/typecheck-examples.mjs — compiles each example. A tool whose
//     arguments are well-typed and whose endpoint 404s is green.
//   scripts/smoke-examples.mjs     — launches each example and fails on a
//     crash-on-load. It exits before any tool runs, deliberately, because a
//     real run needs a model.
//
// This gate closes that gap without a model: boot each example's declared twins
// in-process on the example's OWN task seed, then invoke every tool the example
// registers once with fixture arguments and fail if the twin refused.

/**
 * Hand each declared twin its slice of a task seed.
 *
 * Single-twin examples ship a FLAT seed (`{_meta, users, repositories, …}`);
 * multi-twin examples ship a per-twin ENVELOPE (`{github: {…}, slack: {…}}`).
 * A seed matching neither shape is a hard error rather than a fallback: reading
 * an envelope as a flat seed compiles the whole envelope into one twin's world
 * and nothing complains, which is the silent overwrite F-987 fixed in the seed
 * compiler.
 */
export function splitSeed(seed, twinIds) {
  const keys = Object.keys(seed ?? {});
  const envelopeKeys = keys.filter((key) => isTwinLike(key));

  if (envelopeKeys.length > 0) {
    const extra = envelopeKeys.filter((key) => !twinIds.includes(key));
    if (extra.length > 0) {
      throw new Error(
        `seed is a per-twin envelope carrying [${envelopeKeys.join(", ")}] but the example ` +
          `declares twins [${twinIds.join(", ")}] — unknown: [${extra.join(", ")}]`,
      );
    }
    const missing = twinIds.filter((id) => !envelopeKeys.includes(id));
    if (missing.length > 0) {
      throw new Error(
        `seed is a per-twin envelope but has no slice for declared twin(s): ${missing.join(", ")}`,
      );
    }
    return Object.fromEntries(twinIds.map((id) => [id, seed[id]]));
  }

  if (twinIds.length !== 1) {
    throw new Error(
      `example declares twins [${twinIds.join(", ")}] but the seed is a flat seed ` +
        `(top-level keys: ${keys.join(", ")}) — a multi-twin example needs a per-twin envelope`,
    );
  }
  return { [twinIds[0]]: seed };
}

// The first-party twin ids. Kept as a literal rather than read from
// config/first-party-twins.json so splitSeed stays a pure function over its
// arguments; check-first-party-twin-registration.mjs already guards that list.
const TWIN_IDS = ["github", "slack", "stripe", "gmail", "linear"];
function isTwinLike(key) {
  return TWIN_IDS.includes(key);
}

/**
 * Fill a manifest `config` template with the URLs of the twins just booted.
 *
 * The three frameworks the examples use want different config shapes
 * (`{mcpUrl, token}`, `{ghUrl, ghToken, slackUrl, slackToken}`,
 * `{restUrl, authToken}`), so the manifest declares the shape and the parent
 * substitutes: `$<twin>.rest`, `$<twin>.mcp`, `$token`. An unresolvable token
 * is an error — a silently-undefined URL would make every probe fail for the
 * wrong reason.
 */
export function resolveConfig(template, ctx) {
  const out = {};
  for (const [key, value] of Object.entries(template ?? {})) {
    out[key] = typeof value === "string" && value.startsWith("$") ? resolveToken(value, ctx) : value;
  }
  return out;
}

function resolveToken(token, ctx) {
  if (token === "$token") return ctx.token;
  const match = /^\$([a-z]+)\.(rest|mcp)$/.exec(token);
  if (!match) throw new Error(`unresolvable config token ${token}`);
  const [, twin, surface] = match;
  const booted = ctx.twins[twin];
  if (!booted) {
    throw new Error(
      `unresolvable config token ${token}: twin "${twin}" was not booted ` +
        `(booted: ${Object.keys(ctx.twins).join(", ") || "none"})`,
    );
  }
  return booted[surface];
}
