#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Captures each twin's vendor tools/list bytes. `--offline --check` re-derives meta
// and canonical from the committed raw.json, so it reds on a hand-edited golden or
// a hand-typed sha without touching the network.
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

async function readLiveWire(source) {
  const headers = { ...(source.configuration.requestHeaders ?? {}) };
  if (source.substrate === SUBSTRATE_OAUTH) {
    const envName = source.authTokenEnv;
    if (!envName) {
      throw new Error(`${source.twin}: substrate ${SUBSTRATE_OAUTH} requires \`authTokenEnv\` on the source table`);
    }
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

export const COMPLETENESS_CLASSES = Object.freeze(["exact", "subset-of-remote", "credential-scoped"]);

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

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

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
      const retired = existsSync(paths.status);
      rmSync(paths.status, { force: true });
      const toolCount = JSON.parse(golden.meta).liveToolCount;
      log(
        `${twin}: ${source.substrate} — ` +
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

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("capture-mcp-tools-list.mjs")) {
  throw new Error(`capture-mcp-tools-list.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  process.exit(await runCapture(parseArgv(process.argv.slice(2))));
}
