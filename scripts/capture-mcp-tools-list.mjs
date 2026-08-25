#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The capture producer for upstream MCP `tools/list`.
//
// C1's note on the parent ticket: "what is missing is a producer, not an
// engine." This is the producer. It freezes, per twin, the tool listing the
// VENDOR serves, so the divergence lane has something real to compare a twin
// against. It is deliberately NOT on a cron: goldens are refreshed on purpose
// and reviewed as a diff. There is no staleness alarm over them yet.
//
// Three things are load-bearing:
//
// 1. THE SOURCE TABLE IS DATA. Every twin, its substrate, and the exact
//    configuration that substrate was read under live in
//    `config/mcp-capture-sources.json`. Nothing in this file names a twin.
//    Adding one is a data edit, because the alternative — a switch over twin
//    ids — is the rot that produced the same bug twice: a
//    hand-kept list that stops covering its subject while the gate reading it
//    stays green.
//
// 2. THE CONFIGURATION IS RECORDED, AND A CAPTURE WITHOUT ONE FAILS. Upstream
//    surfaces are not uniform. The remote GitHub server serves a DIFFERENT set
//    at /mcp/ (44 tools, the `default` toolset) than at /mcp/x/all (85). An
//    adapter that read the union would report 41 coverage gaps for tools no
//    examinee of ours can call, and a lane reporting
//    divergence that is not real is worse than one honestly reporting
//    not-compared. So the toolset the capture assumed is declared, pinned, and
//    copied verbatim into meta.json — and a source with no declared
//    configuration is rejected at load rather than defaulted.
//
// 3. `rawFileSha256` IS COMPUTED, NEVER CARRIED. Any sha on the source table
//    or in a committed meta.json is ignored and recomputed from the bytes.
//
// Modes:
//   (no flag)          capture from the substrate and WRITE the goldens
//   --check            capture from the substrate, compare, write NOTHING,
//                      exit non-zero on any difference
//   --check --offline  re-derive meta + canonical from the COMMITTED raw.json
//                      and compare. No network, no toolchain: this is the
//                      shape CI runs, and it is what catches a hand-edited
//                      golden or a hand-typed sha.
//   --offline          the same re-derivation, WRITTEN. See below.
//
// ── WHY --offline HAS A WRITE MODE ─────────────────────────────────────────
//
// `configuration` is prose about a capture, and it is copied verbatim into
// meta.json and canonical.json — so a sentence added to the source table moves
// two golden files. Three of the five sources sit behind ONE-SHOT OAuth grants
// that are minted, used once, and revoked (SECRETS.md is explicit that storing
// one would be a defect). Without this mode, correcting a sentence about
// slack's golden would mean minting a fresh Slack grant and re-reading the
// vendor — so in practice it would mean editing the two goldens BY HAND, which
// is the one thing `--check` exists to catch.
//
// It cannot forge a capture, and the two reasons are structural rather than
// promised. raw.json is this mode's INPUT: every derived field — the tool
// names, the count, both shas — still comes from the bytes the vendor sent, so
// the mode can restate what a capture meant and can never restate what it
// FOUND. And `captureDate` is carried from the committed meta.json, exactly as
// `--check` carries it, so a re-derivation cannot make an old reading look like
// a fresh one. A staleness alarm is downstream of that date; a mode that
// stamped today would reset the alarm without contacting anybody.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCES = "config/mcp-capture-sources.json";

const SUBSTRATE_UNAUTH = "live-wire-unauth";
const SUBSTRATE_OAUTH = "live-wire-oauth";
const SUBSTRATE_OSS = "oss-source";
const SUBSTRATE_NONE = "not-captured";

/**
 * The provenance contract. Every field here must be present in a meta.json for
 * the golden to be usable: a listing whose endpoint, protocol version, capture
 * date, substrate or assumed configuration is missing cannot be argued with.
 */
export const REQUIRED_META_FIELDS = [
  "twin",
  "substrate",
  "endpoint",
  "method",
  "protocol",
  "protocolVersion",
  "captureDate",
  "rawFileSha256",
  "canonicalFileSha256",
  "liveToolCount",
  "liveToolOrder",
  "configuration",
];

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── adapters ────────────────────────────────────────────────────────────────
// `live-wire-oauth` is the SAME reader as `live-wire-unauth` plus a bearer, so
// An OAuth-gated substrate adds a token to the source table, not an adapter to
// this file. The
// test asserts the two entries hold the identical function reference, because
// "same code path" is only true for as long as nobody forks it.

/** Unauthenticated (or bearer-authenticated) JSON-RPC POST against the vendor endpoint. */
async function readLiveWire(source) {
  const headers = { ...(source.configuration.requestHeaders ?? {}) };
  if (source.substrate === SUBSTRATE_OAUTH) {
    const envName = source.authTokenEnv;
    if (!envName) {
      throw new Error(`${source.twin}: substrate ${SUBSTRATE_OAUTH} requires \`authTokenEnv\` on the source table`);
    }
    // BLANK AND ABSENT ARE DIFFERENT FACTS, AND SO IS WHITESPACE.
    //
    // A value blanked in the secret store must not reach
    // a runner as an empty string and READ AS "no credential configured" — the
    // operator who blanked it and the operator who never set it need different
    // instructions. The previous guard was `if (!token)` with the message "is
    // not set", which fails closed for `""` (right) while naming the wrong cause
    // (wrong), and lets `"   "` through entirely: a whitespace-only value is
    // truthy, so `Bearer    ` went on the wire and came back as the vendor's own
    // 401. That reads as "your token is bad" and sends whoever just minted one
    // back to the OAuth flow, when the fault is in the secret store.
    const raw = process.env[envName];
    if (raw === undefined) {
      throw new Error(
        `${source.twin}: ${envName} is not set. Refusing to fall back to an unauthenticated read — ` +
          `the golden would silently record a different surface than the one declared.`
      );
    }
    const token = raw.trim();
    if (token === "") {
      throw new Error(
        `${source.twin}: ${envName} is SET BUT BLANK (${raw.length} character(s), all whitespace). ` +
          `This is not the same as unset: something wrote an empty value, so look in the secret store ` +
          `rather than re-running the OAuth flow. Refusing to fall back to an unauthenticated read.`
      );
    }
    headers.authorization = `Bearer ${token}`;
  }
  const body = JSON.stringify(
    source.configuration.requestBody ?? { jsonrpc: "2.0", id: 1, method: source.method }
  );
  const res = await fetch(source.endpoint, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${source.twin}: ${source.endpoint} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  // The framing is a DECLARED assumption that is then CHECKED, never a derived
  // value copied into the golden. `configuration` is copied verbatim into
  // meta.json and `--check --offline` re-derives meta from the committed
  // raw.json with no substrate to observe, so a field filled in from the live
  // response would make the offline gate disagree with the online capture.
  // Declaring it keeps the gate deterministic AND makes a vendor that silently
  // switches framing a loud failure rather than a silent re-shape.
  const observed = isEventStream(text) ? "text/event-stream" : "application/json";
  const declared = source.configuration.responseFraming ?? "application/json";
  if (observed !== declared) {
    throw new Error(
      `${source.twin}: the source table declares responseFraming "${declared}" but ${source.endpoint} ` +
        `answered "${observed}". Either the vendor changed its transport framing or the declaration is wrong; ` +
        `both change what this capture means, so it stops here.`
    );
  }
  return { rawText: unwrapEventStream(text) };
}

const isEventStream = (text) => /^(event|data|id|retry):/m.test(text.trimStart().split("\n", 1)[0] ?? "");

/**
 * MCP's Streamable HTTP transport lets a server answer a POST with EITHER a JSON
 * body or an SSE stream, and the two are both correct. Measured 2026-08-09:
 * gmail, slack and stripe answer `application/json`; **linear answers SSE**
 * (`event: message` / `data: {…}`), so `JSON.parse` on the wire bytes throws and
 * the twin's capture fails with "the substrate did not answer JSON" — a message
 * that reads like a broken endpoint or a bad token rather than a framing the
 * reader never handled.
 *
 * The `data:` payload is unwrapped and stored as `raw.json`, and this is the one
 * place the golden is not byte-verbatim from the wire. That is deliberate and it
 * is declared: `raw.json` must be a `tools/list` envelope, because
 * `parseMcpToolTable` on the pome-cloud side parses it and hashes it, and a
 * golden nothing can read is not a golden. The framing is recorded in the
 * capture's `configuration.responseFraming` instead, so the fact is kept rather
 * than lost.
 *
 * Per RFC 8895/the SSE spec a single event's `data:` may span several lines, and
 * a stream may carry several events. The first event that parses to a JSON-RPC
 * object carrying `result` or `error` wins — a heartbeat or a `ping` before the
 * real message must not be mistaken for the answer.
 */
export function unwrapEventStream(text) {
  if (!isEventStream(text)) return text;
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) return data;
  }
  throw new Error(
    "the endpoint answered text/event-stream but no event carried a JSON-RPC result or error. " +
      `First 200 bytes: ${text.slice(0, 200)}`
  );
}

function requireBinary(bin, versionArgs, why) {
  try {
    execFileSync(bin, versionArgs, { stdio: "ignore" });
  } catch {
    throw new Error(`\`${bin}\` is not runnable on this machine. ${why}`);
  }
}

/**
 * Build the vendor's public server from a pinned commit and ask it. This is the
 * only faithful read of a surface whose live endpoint is credential-gated: the
 * server's own inventory answers `tools/list`, so the capture is whatever the
 * pinned code actually serves under the pinned flags — not a hand transcription
 * of a Go slice, and not the union of every toolset.
 */
async function readOssSource(source) {
  const spec = source.source;
  requireBinary(
    "git",
    ["--version"],
    "The oss-source adapter clones the vendor's public repository at a pinned commit."
  );
  requireBinary("go", ["version"], "The oss-source adapter builds the vendor's public server from source.");

  const root = process.env.POME_MCP_CAPTURE_CACHE ?? join(homedir(), ".cache/pome/mcp-capture");
  const checkout = join(root, `${source.twin}-${spec.commit.slice(0, 12)}`);
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(checkout, ".git"))) {
    execFileSync("git", ["init", "--quiet", checkout], { stdio: "inherit" });
    execFileSync("git", ["-C", checkout, "remote", "add", "origin", spec.repo], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", spec.commit], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--force", spec.commit], { stdio: "inherit" });

  const bin = join(checkout, ".capture-bin");
  execFileSync("go", ["build", "-o", bin, spec.package], { cwd: checkout, stdio: "inherit" });

  const rawText = await driveStdioToolsList(bin, source);
  return { rawText };
}

/** Speak MCP over stdio to a freshly built server and return its `tools/list` line verbatim. */
function driveStdioToolsList(bin, source) {
  const args = source.configuration.serverArgs ?? [];
  const env = { ...process.env, ...(source.configuration.serverEnv ?? {}) };
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`${source.twin}: the built server did not answer tools/list within 60s`));
    }, 60_000);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    let buffered = "";
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString();
      let nl;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 0) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 1, method: source.method });
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(line);
          return;
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: source.protocolVersion,
        capabilities: {},
        clientInfo: { name: "pome-capture-mcp-tools-list", version: "1" },
      },
    });
  });
}

const SUBSTRATES = {
  [SUBSTRATE_UNAUTH]: { capturable: true, read: readLiveWire },
  [SUBSTRATE_OAUTH]: { capturable: true, read: readLiveWire },
  [SUBSTRATE_OSS]: { capturable: true, read: readOssSource },
  [SUBSTRATE_NONE]: { capturable: false, read: null },
};

/**
 * The substrate vocabulary this producer accepts, exported so the other
 * validator of the same field can be checked against it.
 *
 * `packages/sdk/src/mcp-tool-fixture.ts` validates `substrate` on the
 * PER-TWIN tool-table fixtures. Two validators of one field name, in
 * two languages, in two trees, with no import between them is how a vocabulary
 * forks without anyone noticing — and the divergence lane has to read both
 * trees. The SDK's
 * enum is required to be a superset of this list; its
 * `substrate-vocabulary.test.ts` imports this array and asserts it.
 */
export const KNOWN_SUBSTRATES = Object.freeze(Object.keys(SUBSTRATES));

export function adapterFor(substrate) {
  const adapter = SUBSTRATES[substrate];
  if (!adapter) {
    throw new Error(
      `unknown substrate \`${substrate}\` — known substrates are ${Object.keys(SUBSTRATES).join(", ")}`
    );
  }
  return adapter;
}

/**
 * The vocabulary of `configuration.completeness` — the relation between the
 * listing this producer CAPTURED and the listing an examinee's own client
 * reaches. The source table's `$comment` defines each class; this array is what
 * makes declaring one non-optional.
 *
 * A GOLDEN THAT STATES NO CLASS STILL MAKES A CLAIM — it just makes it silently,
 * and the consumer supplies the missing half. pome-cloud's promotion-gate
 * criterion 9 refuses a twin for serving a tool the golden does not declare, and
 * its own reasoning turns on this field: it is sound against `exact`, and against
 * `subset-of-remote` only because github's golden ENUMERATES its delta from the
 * remote with written evidence. An undeclared class has already cost us one
 * false report: linear's golden was captured under a read-only grant, said
 * nothing about completeness, and the gate reported six write tools that
 * mcp.linear.app really
 * serves — `save_issue`, `save_comment`, `delete_comment`, `create_issue_label`,
 * `save_project`, `save_document` — as tools twin-linear had invented. Fabricated
 * findings are the one thing that lane must never produce.
 *
 * So it is required at LOAD, beside `configuration` itself and for the same
 * reason: an unstated assumption about what a capture covers fails here rather
 * than defaulting to the flattering answer.
 */
export const COMPLETENESS_CLASSES = Object.freeze(["exact", "subset-of-remote", "credential-scoped"]);

// ── the declared source table ───────────────────────────────────────────────

export function loadSources({ repoRoot = REPO_ROOT, sourcesPath, table } = {}) {
  const parsed = table ?? JSON.parse(readFileSync(sourcesPath ?? join(repoRoot, DEFAULT_SOURCES), "utf8"));
  if (typeof parsed.goldenDir !== "string" || !parsed.goldenDir) {
    throw new Error("source table: `goldenDir` must be a non-empty string");
  }
  if (!parsed.twins || typeof parsed.twins !== "object") {
    throw new Error("source table: `twins` must be an object keyed by twin id");
  }
  const twins = {};
  for (const [twin, declared] of Object.entries(parsed.twins)) {
    const source = { twin, ...declared };
    const adapter = adapterFor(source.substrate);
    if (source.capture) {
      if (!adapter.capturable) {
        throw new Error(`${twin}: substrate \`${source.substrate}\` cannot be captured`);
      }
      const config = source.configuration;
      if (!config || typeof config !== "object" || Object.keys(config).length === 0) {
        throw new Error(
          `${twin}: a capturable source must declare the \`configuration\` it assumed. ` +
            `A capture with no recorded configuration is an unstated assumption about which ` +
            `deployment was read — it fails here rather than defaulting.`
        );
      }
      if (!COMPLETENESS_CLASSES.includes(config.completeness)) {
        throw new Error(
          `${twin}: a capturable source must declare \`configuration.completeness\` as one of ` +
            `${COMPLETENESS_CLASSES.join(", ")} (got ${JSON.stringify(config.completeness)}). ` +
            `A consumer that reports a tool as twin-only is asserting the vendor does not serve it, ` +
            `which this golden can only support if it says what it covers.`
        );
      }
      for (const field of ["endpoint", "method", "protocol", "protocolVersion"]) {
        if (!source[field]) throw new Error(`${twin}: a capturable source must declare \`${field}\``);
      }
      if (source.substrate === SUBSTRATE_OSS) {
        for (const field of ["repo", "commit", "package"]) {
          if (!source.source?.[field]) {
            throw new Error(`${twin}: substrate ${SUBSTRATE_OSS} must pin \`source.${field}\``);
          }
        }
      }
    } else if (!source.reason) {
      throw new Error(
        `${twin}: a twin that is not captured must record \`reason\`. ` +
          `An unexplained absence is indistinguishable from an oversight.`
      );
    }
    twins[twin] = source;
  }
  return { goldenDir: parsed.goldenDir, twins };
}

export function goldenPaths({ repoRoot = REPO_ROOT, sources, twin }) {
  const dir = join(repoRoot, sources.goldenDir);
  return {
    dir,
    raw: join(dir, `${twin}.raw.json`),
    meta: join(dir, `${twin}.meta.json`),
    canonical: join(dir, `${twin}.canonical.json`),
    status: join(dir, `${twin}.status.json`),
  };
}

// ── derivation ──────────────────────────────────────────────────────────────

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * raw.json verbatim, canonical.json derived from it, meta.json derived from
 * both. Nothing here reads the committed files, so a golden can never be
 * "confirmed" by the copy of itself that is already on disk.
 */
export function deriveGolden({ source, rawText, captureDate }) {
  if (!captureDate) throw new Error(`${source.twin}: a capture must be dated`);
  let envelope;
  try {
    envelope = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`${source.twin}: the substrate did not answer JSON (${err.message})`);
  }
  if (envelope.error) {
    throw new Error(`${source.twin}: the substrate answered a JSON-RPC error: ${JSON.stringify(envelope.error)}`);
  }
  const tools = envelope.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`${source.twin}: the substrate answered no \`result.tools\` array`);
  }
  const names = tools.map((tool) => tool.name);
  const rawFileSha256 = sha256(rawText);

  const provenance = {
    twin: source.twin,
    substrate: source.substrate,
    endpoint: source.endpoint,
    method: source.method,
    protocol: source.protocol,
    protocolVersion: source.protocolVersion,
    captureDate,
    rawFileSha256,
    liveToolCount: names.length,
    liveToolOrder: names,
    configuration: source.configuration,
    ...(source.source ? { source: source.source } : {}),
  };

  const canonical = pretty({
    meta: {
      ...provenance,
      derivedFrom: `${source.twin}.raw.json`,
      derivation: "result.tools verbatim, upstream order preserved; only whitespace differs from raw.json",
    },
    jsonrpc: envelope.jsonrpc,
    id: envelope.id,
    result: envelope.result,
  });

  const meta = pretty({
    ...provenance,
    canonicalFileSha256: sha256(canonical),
    files: {
      raw: `${source.twin}.raw.json`,
      canonical: `${source.twin}.canonical.json`,
    },
  });

  return { raw: rawText, meta, canonical };
}

/**
 * The record for a twin this producer does NOT capture. A twin honestly marked
 * not-captured is an acceptable outcome; a twin silently missing from the
 * golden directory is not, because a consumer cannot tell it from an oversight.
 *
 * `configuration` and `authTokenEnv` are written here for the same reason they
 * are written into a captured meta.json. A deferred twin's declared
 * configuration is the thing a credentialed capture will ASSUME — it is the whole
 * content of "a token, not an adapter" — so leaving it out of the
 * recorded artefact would let someone change what that capture reads while
 * this gate stayed green.
 */
export function deriveStatus({ source }) {
  return pretty({
    twin: source.twin,
    substrate: source.substrate,
    captured: false,
    status: source.substrate === SUBSTRATE_NONE ? SUBSTRATE_NONE : "deferred",
    endpoint: source.endpoint,
    reason: source.reason,
    ...(source.deferredTo ? { deferredTo: source.deferredTo } : {}),
    ...(source.authTokenEnv ? { authTokenEnv: source.authTokenEnv } : {}),
    ...(source.configuration ? { configuration: source.configuration } : {}),
    ...(source.evidence ? { evidence: source.evidence } : {}),
    ...(source.revisitWhen ? { revisitWhen: source.revisitWhen } : {}),
    consumerContract:
      "The divergence lane must report this twin as not-compared. It must never report it as zero coverage.",
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

function compareFile(path, produced) {
  if (!existsSync(path)) return `missing: ${path}`;
  return readFileSync(path, "utf8") === produced ? null : `differs: ${path}`;
}

export async function runCapture(options = {}) {
  const {
    repoRoot = REPO_ROOT,
    sourcesPath,
    check = false,
    offline = false,
    twins,
    today = new Date().toISOString().slice(0, 10),
    readSubstrate,
    log = console.log,
    err = console.error,
  } = options;

  const sources = loadSources({ repoRoot, sourcesPath });
  const ids = twins ?? Object.keys(sources.twins);
  const problems = [];

  for (const twin of ids) {
    const source = sources.twins[twin];
    if (!source) {
      problems.push(`${twin}: not declared in ${sourcesPath ?? DEFAULT_SOURCES}`);
      continue;
    }
    const paths = goldenPaths({ repoRoot, sources, twin });
    mkdirSync(paths.dir, { recursive: true });

    if (!source.capture) {
      const produced = deriveStatus({ source });
      if (check) {
        const diff = compareFile(paths.status, produced);
        if (diff) problems.push(`${twin}: ${diff}`);
        else log(`${twin}: ${source.substrate} — ${source.deferredTo ?? "not captured"} (recorded)`);
      } else {
        writeFileSync(paths.status, produced);
        log(`${twin}: ${source.substrate} — wrote ${twin}.status.json`);
      }
      continue;
    }

    let rawText;
    try {
      if (offline) {
        if (!existsSync(paths.raw)) throw new Error(`missing committed golden ${paths.raw}`);
        rawText = readFileSync(paths.raw, "utf8");
      } else {
        const read = readSubstrate ?? ((s) => adapterFor(s.substrate).read(s));
        ({ rawText } = await read(source));
      }
    } catch (err) {
      problems.push(`${twin}: substrate read failed — ${err.message}`);
      continue;
    }

    let captureDate = today;
    if (check || offline) {
      // The date is a fact about the COMMITTED capture, so `--check` must not
      // red merely because the calendar moved — and an `--offline` re-derivation,
      // which reads the same committed bytes and contacts nobody, must not move
      // it either. `today` belongs to a run that actually read the substrate.
      //
      // KNOWN AND UNAVOIDABLE: this makes captureDate self-referential. The
      // gate reads the date out of the committed meta.json and feeds it back
      // into the derivation, so a forgery that is CONSISTENT across meta.json
      // and canonical.json — edit both, recompute both shas — passes. Offline
      // there is nothing to corroborate it against: the bytes cannot say when
      // they were fetched. Every other field is derived from the raw response
      // and so cannot be forged this way; captureDate is the one that can.
      //
      // This matters to a staleness alarm that reads meta.captureDate
      // is reading the one field in the golden that this gate cannot check.
      // It should date a golden from git history (the commit that last touched
      // <twin>.raw.json) and treat the JSON field as a label, not evidence.
      let committed;
      try {
        committed = JSON.parse(readFileSync(paths.meta, "utf8"));
      } catch {
        problems.push(`${twin}: missing or unreadable ${paths.meta}`);
        continue;
      }
      if (!committed.captureDate) {
        problems.push(
          `${twin}: committed meta.json has no captureDate, and neither --check nor --offline reads a ` +
            `substrate that could date this golden. Re-capture it from the substrate instead.`
        );
        continue;
      }
      captureDate = committed.captureDate;
    }

    let golden;
    try {
      golden = deriveGolden({ source, rawText, captureDate });
    } catch (err) {
      problems.push(`${twin}: ${err.message}`);
      continue;
    }

    if (check) {
      const diffs = [
        compareFile(paths.raw, golden.raw),
        compareFile(paths.meta, golden.meta),
        compareFile(paths.canonical, golden.canonical),
      ].filter(Boolean);
      // A LEFTOVER status.json SILENTLY BEATS THE GOLDEN BESIDE IT.
      //
      // pome-cloud's `loadUpstreamMcpGolden` resolves `<twin>.status.json`
      // FIRST and returns not-compared without ever looking at raw/meta — the
      // recorded refusal is meant to outrank a file that simply is not there.
      // This producer only ever WRITES status.json; nothing deletes it when
      // a twin became capturable. So the first credentialed capture of slack,
      // linear or stripe would commit a real golden and the lane would go on
      // publishing "401 missing_token", with no red anywhere. That is the whole
      // credentialed capture landing and reading as if it had not.
      if (existsSync(paths.status)) {
        problems.push(
          `${twin}: both a golden and ${twin}.status.json exist. Every consumer resolves the status file ` +
            `first, so the golden beside it is dead bytes. Delete ${twin}.status.json in the same commit ` +
            `that lands the capture.`
        );
      }
      if (diffs.length > 0) problems.push(...diffs.map((d) => `${twin}: ${d}`));
      else if (problems.length === 0)
        log(`${twin}: ${source.substrate} — golden matches (${JSON.parse(golden.meta).liveToolCount} tools)`);
    } else {
      writeFileSync(paths.raw, golden.raw);
      writeFileSync(paths.meta, golden.meta);
      writeFileSync(paths.canonical, golden.canonical);
      // Retire the recorded refusal in the same step that supersedes it, so the
      // capture cannot land half-applied. `force` makes this a no-op for a twin
      // that was always capturable.
      const retired = existsSync(paths.status);
      rmSync(paths.status, { force: true });
      const toolCount = JSON.parse(golden.meta).liveToolCount;
      log(
        `${twin}: ${source.substrate} — ` +
          // An --offline run says what it did NOT do, because the two modes
          // write the same three files and only one of them contacted a vendor.
          (offline
            ? `re-derived ${toolCount} tools from the committed ${twin}.raw.json — nothing was read from ` +
              `${source.endpoint}, and captureDate stays ${captureDate}`
            : `wrote ${toolCount} tools`) +
          (retired ? ` (and retired ${twin}.status.json — commit the deletion)` : "")
      );
    }
  }

  if (problems.length > 0) {
    err(`\ncapture-mcp-tools-list: ${problems.length} problem(s)`);
    for (const problem of problems) err(`  ${problem}`);
    if (check) {
      err(
        "\nNothing was written. Re-run without --check to refresh the goldens, and review the diff:\n" +
          "a change here is a change in what the vendor serves."
      );
    }
    return 1;
  }
  return 0;
}

function parseArgv(argv) {
  const opts = { twins: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--offline") opts.offline = true;
    else if (arg === "--twin") (opts.twins ??= []).push(argv[++i]);
    else if (arg === "--sources") opts.sourcesPath = argv[++i];
    else throw new Error(`unknown argument \`${arg}\` (usage: [--check] [--offline] [--twin <id>] [--sources <path>])`);
  }
  return opts;
}

// Run as a script (not when imported by the test).
//
// This compares argv against the module URL rather than reading the `main`
// flag off `import.meta`, and that is deliberate, not stylistic. This gate
// runs in ci.yml's always-on block, which sits ABOVE `actions/setup-node`
// (a step itself gated on the heavy suite), so it executes on whatever Node
// the runner image ships. That flag landed in Node 24.2 / 22.16; on anything
// older it reads `undefined`, this block never runs, and the gate exits 0
// having checked nothing — the exact vacuous green the rest of this file
// exists to prevent. The two scripts in this repo that do read that flag both
// run after setup-node@24 in the heavy block, so they have a floor this one
// does not. A test asserts the flag stays out of here.
// Realpath'd on both sides — node resolves symlinks before deriving
// `import.meta.url`, so a bare `pathToFileURL(resolve(...))` of argv[1]
// misses through a symlinked checkout (a worktree, or macOS's symlinked
// `/tmp`) in the same silent shape, and a guard miss while invoked
// as this file throws rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("capture-mcp-tools-list.mjs")) {
  throw new Error(`capture-mcp-tools-list.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  process.exit(await runCapture(parseArgv(process.argv.slice(2))));
}
