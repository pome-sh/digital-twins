// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isMultiTwinSeedEnvelope, MOUNTED_TWINS } from "../contract/index.js";
import { createHostedClient, perTwinReturnedByCloud } from "../hosted/client.js";
import type { TwinName } from "../twin/registry.js";
import {
  parseSeedFileText,
  readSeedFileText,
  seedsForTwins,
  soleTwinOf,
  twinsNamedBy,
} from "../twin/seedFile.js";
import type { CreateSessionResponse } from "../types/shared.js";
import {
  HostedAuthError,
  HostedDiscardRefusedError,
  HostedOrchError,
  HostedQuotaError,
} from "../hosted/errors.js";
import { resolveRunAgentIdentity } from "./agent-identity.js";
import { resolveCredentials } from "./credentials.js";
import { DEFAULT_DASHBOARD_URL } from "./defaults.js";

// Defensive append: the server's per_twin.mcp_url has been observed missing
// the `/mcp` suffix that agents need to mount the MCP transport (F19). The
// standalone `pome twin start` path already appends `/mcp` in `cli/main.ts`;
// mirror that here so agents reading the printed value get a working MCP URL
// regardless of which side ships the fix first.
export function ensureMcpSuffix(url: string): string {
  return /\/mcp\/?$/.test(url) ? url : `${url.replace(/\/$/, "")}/mcp`;
}

// Multi-twin (M3): the CLI's ad-hoc session allowlist IS the shared mounted-twin
// set. Repeated `--twin` flags stand up a multi-twin session in one call.
//
// `MOUNTED_TWINS` is the single place a twin is named. A second list here reads
// as a second source of truth, which is how `sandbox create --help` spent a
// release advertising four twins while this validator already accepted five.
const ALLOWED_TWINS = new Set<string>(MOUNTED_TWINS);

/** The twins `--twin` accepts, in mounted order.
 *
 *  `sandbox create` renders THIS as its `--twin` help (`cli/src/cli/main.ts`),
 *  so the sentence a reader browses `--help` for and the code that rejects their
 *  typo cannot name different sets. Before it did: help was a hand-written
 *  `github | stripe | slack | gmail`, and `linear` mounted, booted and served its
 *  whole surface without ever appearing there. Deriving is the fix rather than
 *  adding the one missing word, because the sixth twin has the same problem. */
export const SESSION_TWIN_NAMES: readonly string[] = [...ALLOWED_TWINS];

function redactSession(res: CreateSessionResponse): Record<string, unknown> {
  const pcIn = res.provider_credentials;
  const pcOut: Record<string, unknown> = {};
  if (pcIn.github) {
    pcOut.github = { ...pcIn.github, token: "***redacted***" };
  }
  if (pcIn.stripe) {
    pcOut.stripe = { ...pcIn.stripe, api_key: "***redacted***" };
  }
  if (pcIn.slack) {
    pcOut.slack = { ...pcIn.slack, token: "***redacted***" };
  }
  return {
    session_id: res.session_id,
    session_token: res.session_token ? "***redacted***" : res.session_id,
    twin_url: res.twin_url,
    expires_at: res.expires_at,
    openapi_url: res.openapi_url,
    per_twin: res.per_twin,
    provider_credentials: pcOut,
    agent_token: "***redacted***",
  };
}

function formatEnvExport(res: CreateSessionResponse, twins: string[]): string {
  const lines: string[] = [
    `# Pome hosted sandbox — treat as secret. Twins: ${twins.join(", ")}`,
    `export POME_AUTH_TOKEN=${JSON.stringify(res.agent_token)}`,
    `export POME_SESSION_ID=${JSON.stringify(res.session_id)}`,
    // Legacy single-endpoint URL (= the primary twin's api_url). Kept for
    // agents written against the pre-multi-twin contract.
    `export POME_TWIN_URL=${JSON.stringify(res.twin_url)}`,
    `export POME_TWIN_NAMES=${JSON.stringify(twins.join(","))}`,
  ];
  // Only trust per_twin.mcp_url when the cloud actually returned per_twin —
  // the schema synthesizes mcp.pome.sh entries for old-cloud bodies, and those
  // hosts don't serve MCP. Otherwise derive <api_url>/mcp (the legacy shape).
  const fromCloud = perTwinReturnedByCloud(res);
  // Multi-twin (M3): one POME_<TWIN>_{REST,MCP}_URL pair per twin, plus the
  // provider-specific credential line. Loops per_twin so a github+slack session
  // emits distinct endpoints for each.
  for (const twin of twins) {
    const upper = twin.toUpperCase();
    const pt = res.per_twin?.[twin];
    if (pt?.api_url) {
      const mcpUrl = fromCloud ? ensureMcpSuffix(pt.mcp_url) : ensureMcpSuffix(pt.api_url);
      lines.push(`export POME_${upper}_REST_URL=${JSON.stringify(pt.api_url)}`);
      lines.push(
        `export POME_${upper}_MCP_URL=${JSON.stringify(mcpUrl)}`,
      );
    }
    if (twin === "github") {
      const gh = res.provider_credentials.github;
      if (gh) {
        lines.push(`export POME_GITHUB_TOKEN=${JSON.stringify(gh.token)}`);
      }
    } else if (twin === "stripe") {
      const st = res.provider_credentials.stripe;
      if (st) {
        lines.push(`export POME_STRIPE_API_KEY=${JSON.stringify(st.api_key)}`);
      }
      if (pt?.api_url) {
        lines.push(`export POME_STRIPE_API_BASE=${JSON.stringify(pt.api_url)}`);
      }
    } else if (twin === "slack") {
      // The twin proxy verifies only the session JWT (agent_token) as bearer —
      // the provider-specific Slack credential is NOT accepted at the proxy
      // (same rationale as the Stripe api-key line in the hosted runner). So
      // the agent's Slack bearer is the JWT, not provider_credentials.slack.token.
      lines.push(`export POME_SLACK_TOKEN=${JSON.stringify(res.agent_token)}`);
    } else if (twin === "gmail") {
      // Gmail auth remains Pome-owned. The provider alias is the same session
      // JWT as POME_AUTH_TOKEN; no provider_credentials.gmail is minted.
      lines.push(`export POME_GMAIL_TOKEN=${JSON.stringify(res.agent_token)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Normalize one-or-more `--twin` flags into a validated, de-duped twin list.
 *  Repeated flags stand up an ad-hoc multi-twin session; each is validated
 *  against MOUNTED_TWINS for a friendly error before the round-trip. */
export function normalizeSessionTwins(raw: string[]): string[] {
  const twins = raw.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  for (const twin of twins) {
    if (!ALLOWED_TWINS.has(twin)) {
      throw new Error(
        `Unknown twin "${twin}". Supported: ${[...ALLOWED_TWINS].join(", ")}.`,
      );
    }
  }
  const deduped = [...new Set(twins)];
  if (deduped.length === 0) {
    throw new Error(
      `No twin specified. Pass --twin <name> (repeat for multi-twin). Supported: ${[...ALLOWED_TWINS].join(", ")}.`,
    );
  }
  return deduped;
}

/**
 * Resolve `--seed <path>` into the twin list and the `seed` the wire wants.
 *
 * THE RULE does not move (`cli/src/contract/seed-envelope.ts`): a create-session
 * `seed` is a per-twin envelope IFF the session has more than one twin, decided
 * from `twins` alone. So the file the user wrote and the body we POST are not
 * the same shape, and this is the only place that translates between them — a
 * one-twin sandbox seeded from an envelope sends the FLAT seed.
 *
 * The twin's own `parseSeed` runs HERE, before the round trip. That is the same
 * parser the pod runs, and without it a seed the pod refuses comes back as
 * `503 Failed to spawn twin pod` twelve seconds later (F-1688) with nothing
 * naming the field.
 */
export async function resolveSessionSeed(
  seedPath: string,
  requestedTwins: string[],
): Promise<{ twins: string[]; seed: unknown }> {
  const raw = readSeedFileText(seedPath, "pome sandbox create --seed");
  const origin = `--seed ${seedPath}`;
  const file = parseSeedFileText(raw, origin);

  // An envelope naming exactly one twin already says which twin the sandbox is
  // for, so `--twin` becomes optional rather than a second place to say it.
  const sole = soleTwinOf(file);
  if (requestedTwins.length === 0 && sole === undefined) {
    // `normalizeSessionTwins`'s "No twin specified" never mentions the seed, so
    // it reads as if `--twin` were simply forgotten. Same two sentences
    // `resolveStandaloneTwin` prints for `twin start`, with `--twin` in place of
    // the positional: `pome twin new-seed <twin>` writes a FLAT file for one
    // twin, and a flat seed names no twin by design.
    const named = twinsNamedBy(file);
    throw new Error(
      named.length === 0
        ? `${origin} is a flat seed, so it does not name a twin. Pass the name: pome sandbox create --twin <${SESSION_TWIN_NAMES.join("|")}> --seed ${seedPath}`
        : `${origin} names ${named.length} twins (${named.join(", ")}), so it does not say which the sandbox is for. Pass the name: ${named.map((twin) => `--twin ${twin}`).join(" ")} --seed ${seedPath}`,
    );
  }
  const twins = normalizeSessionTwins(
    requestedTwins.length > 0 ? requestedTwins : [sole!],
  );

  // `normalizeSessionTwins` has already rejected anything outside MOUNTED_TWINS,
  // and `scripts/lint/rules/first-party-twins.mjs` is the standing gate that
  // MOUNTED_TWINS and the registry's TWIN_NAME_LIST name the same five — so this
  // narrowing is checked, just not by the type system.
  const byTwin = await seedsForTwins(file, twins as TwinName[], origin);
  return {
    twins,
    seed: isMultiTwinSeedEnvelope(twins) ? byTwin : byTwin[twins[0]!],
  };
}

export async function runSessionCreate(opts: {
  apiBaseUrl: string;
  /** One-or-more twins. Repeated `--twin` flags stand up a multi-twin session.
   *  May be empty when `seedPath` names exactly one twin. */
  twins: string[];
  json: boolean;
  secretsFile?: string;
  /** `--seed <path>`: the sandbox starts from this seed instead of each twin's
   *  default. Same file `pome twin start --seed` takes. */
  seedPath?: string;
}): Promise<void> {
  const resolvedSeed =
    opts.seedPath === undefined
      ? undefined
      : await resolveSessionSeed(opts.seedPath, opts.twins);
  const twins = resolvedSeed?.twins ?? normalizeSessionTwins(opts.twins);

  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const client = createHostedClient({
    baseUrl: creds.apiBaseUrl,
    apiKey: creds.apiKey,
  });
  const identity = await resolveRunAgentIdentity({
    startDir: process.cwd(),
    apiBaseUrl: creds.apiBaseUrl,
  });

  const session = await client.createSession({
    twins,
    taskSource: "# ..\n",
    idempotencyKey: randomUUID(),
    agentId: identity.agentId,
    agentVersion: identity.agentVersion,
    ...(resolvedSeed ? { seed: resolvedSeed.seed } : {}),
  });

  if (opts.secretsFile) {
    await writeSecretsFile(opts.secretsFile, formatEnvExport(session, twins));
    console.error(`Wrote sandbox secrets to ${opts.secretsFile} (mode 0600).`);
  }

  if (opts.json) {
    const payload = redactSession(session);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.error(`Sandbox: ${session.session_id}`);
  console.error(`Expires: ${session.expires_at}`);
  // Same reason the standalone twin prints a Seed line: once it is running,
  // every seeded twin looks seeded.
  if (opts.seedPath !== undefined) {
    console.error(`Seed: ${opts.seedPath} (replaces the default for ${twins.join(", ")}).`);
  }
  // Multi-twin (M3): print one API/MCP line per twin so a github+slack session
  // shows both endpoints. Falls back to the legacy bare twin_url on an older
  // cloud that only ships it.
  let printedAny = false;
  const mcpFromCloud = perTwinReturnedByCloud(session);
  for (const twin of twins) {
    const pt = session.per_twin?.[twin];
    if (pt) {
      const label = twins.length > 1 ? `${twin} ` : "";
      // Synthesized per_twin entries carry an mcp.pome.sh host that doesn't
      // serve MCP — derive <api_url>/mcp unless the cloud returned per_twin.
      const mcpUrl = mcpFromCloud ? ensureMcpSuffix(pt.mcp_url) : ensureMcpSuffix(pt.api_url);
      console.error(`${label}API: ${pt.api_url}`);
      console.error(`${label}MCP: ${mcpUrl}`);
      printedAny = true;
    }
  }
  if (!printedAny) {
    // The un-disambiguated single endpoint: a response that ships twin_url
    // without per-twin bases has exactly one twin to point at.
    console.error(`Twin URL: ${session.twin_url}`);
  }
  console.error("Secrets redacted.");
  // Concrete deep-link, not "open the Twins page" — copyable straight into a
  // browser.
  console.error(`Dashboard: ${DEFAULT_DASHBOARD_URL}/twins/${session.session_id}`);
}

async function writeSecretsFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

export type SessionListStateFilter =
  | "running"
  | "ready"
  | "done"
  | "expired"
  | "all";

// F25 — server returns mixed vocab ("ready" for boot-complete, "running"
// for active, plus "done" / "expired"). The dashboard says "Running" for
// both "ready" and "running". Normalize on the CLI so users grepping
// state across surfaces see one word. Free-form passthrough for unknown
// values so we don't hide a new server state behind an undefined map.
function displayState(serverState: string): string {
  if (serverState === "ready") return "running";
  return serverState;
}

// F24 — `--state running` is the default (sane first-run output). `all`
// disables filtering. The other values map 1:1 to server vocab; we accept
// "running" in input and translate it to "ready"/"running" matching.
function matchesStateFilter(
  serverState: string,
  filter: SessionListStateFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "running") return serverState === "ready" || serverState === "running";
  return serverState === filter;
}

export async function runSessionList(opts: {
  apiBaseUrl: string;
  limit: number;
  json: boolean;
  state: SessionListStateFilter;
}): Promise<void> {
  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const client = createHostedClient({
    baseUrl: creds.apiBaseUrl,
    apiKey: creds.apiKey,
  });
  // Request more than `limit` from the server so client-side state
  // filtering still leaves us with a useful page. Cap to avoid runaway
  // payloads.
  const fetchLimit = opts.state === "all" ? opts.limit : Math.min(opts.limit * 4, 200);
  const all = await client.listSessions({ limit: fetchLimit });
  const filtered = all.filter((r) => matchesStateFilter(r.state, opts.state));
  const rows = filtered.slice(0, opts.limit);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    const scope = opts.state === "all" ? "any" : `state=${opts.state}`;
    console.error(`No sandboxes returned (${scope}).`);
    return;
  }
  for (const r of rows) {
    console.error(
      `${r.id}\t${displayState(r.state)}\t${r.twins.join(",")}\texpires ${r.expires_at}`,
    );
  }
}

export async function runSessionStop(opts: {
  apiBaseUrl: string;
  sessionId: string;
  /** Confirm destroying a session whose run has not been graded.
   *  Off by default — a human-typed destructive command gets the refusal
   *  printed instead of silently discarding the evidence. */
  discard?: boolean;
}): Promise<void> {
  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const client = createHostedClient({
    baseUrl: creds.apiBaseUrl,
    apiKey: creds.apiKey,
  });
  try {
    await client.deleteSession(opts.sessionId, false, {
      discard: opts.discard === true,
    });
  } catch (err) {
    if (err instanceof HostedDiscardRefusedError) {
      console.error(
        `Refused to stop ${err.sessionId}: it is still open (${err.state}), so its ` +
          `run has not been graded — Pome creates the run row at finalize, and ` +
          `stopping now discards it.`,
      );
      if (err.taskName) console.error(`  Task: ${err.taskName}`);
      console.error(`  Open for ${err.openSeconds}s.`);
      console.error(
        `  To keep the run, finalize it instead. To discard it anyway: ` +
          `pome sandbox stop ${err.sessionId} --discard`,
      );
    }
    throw err;
  }
  console.error(`Stopped sandbox ${opts.sessionId}.`);
}

/** Empty string means "already fully reported — print nothing more". Only
 *  `HostedDiscardRefusedError` returns it today: `runSessionStop` above just
 *  printed the complete multi-line refusal (session, task, open time, the
 *  `--discard` escape hatch), so falling through to `err.message` here would
 *  either duplicate that or, when the server omits `error.message`, print a
 *  bare blank line. Callers must skip printing when this returns "". */
export function friendlyHostedError(err: unknown): string {
  if (err instanceof HostedDiscardRefusedError) {
    return "";
  }
  if (err instanceof HostedAuthError) {
    return `${err.message} · Run \`pome login\` or set a valid POME_API_KEY.`;
  }
  if (err instanceof HostedQuotaError) {
    return `${err.message} · Quota or billing limit — check your team plan in the dashboard.`;
  }
  if (err instanceof HostedOrchError) {
    const m = err.message;
    if (/422|validation/i.test(m)) {
      return `${m} · Check twin name and request body.`;
    }
    if (/503|spawn/i.test(m)) {
      return `${m} · Control plane could not start the sandbox — retry later.`;
    }
    return m;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
