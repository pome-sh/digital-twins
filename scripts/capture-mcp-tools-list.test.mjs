#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for capture-mcp-tools-list. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPLETENESS_CLASSES,
  REQUIRED_META_FIELDS,
  adapterFor,
  deriveGolden,
  deriveStatus,
  goldenPaths,
  loadSources,
  runCapture,
  sha256,
  unwrapEventStream,
} from "./capture-mcp-tools-list.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}
async function assertRejects(fn, match, msg) {
  try {
    await fn();
  } catch (err) {
    assert(String(err.message).includes(match), `${msg} (message was: ${err.message})`);
    return;
  }
  assert(false, `${msg} (did not throw)`);
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

const quiet = () => {};
const SILENT = { log: quiet, err: quiet };

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "f1326-"));
  cpSync(join(ROOT, "config/mcp-capture-sources.json"), join(dir, "config/mcp-capture-sources.json"), {
    recursive: true,
  });
  cpSync(join(ROOT, "fixtures/mcp-tools-list"), join(dir, "fixtures/mcp-tools-list"), { recursive: true });
  return dir;
}

function sandboxWithDeferredTwin() {
  const dir = sandbox();
  const twin = "deferred-probe";
  const cfgPath = join(dir, "config/mcp-capture-sources.json");
  const table = JSON.parse(readFileSync(cfgPath, "utf8"));
  const source = {
    twin,
    substrate: "live-wire-oauth",
    capture: false,
    endpoint: "https://mcp.example.invalid/mcp",
    method: "tools/list",
    protocol: "JSON-RPC 2.0 over HTTP",
    protocolVersion: "2025-06-18",
    authTokenEnv: "DEFERRED_PROBE_TOKEN",
    reason: "OAuth-gated, and nobody has minted a grant for this fixture.",
    deferredTo: "a follow-up capture errand",
    configuration: { auth: "bearer", requestHeaders: { "content-type": "application/json" } },
  };
  const { twin: _omit, ...declared } = source;
  table.twins[twin] = declared;
  writeFileSync(cfgPath, `${JSON.stringify(table, null, 2)}\n`);
  const sources = loadSources({ sourcesPath: cfgPath });
  writeFileSync(goldenPaths({ repoRoot: dir, sources, twin }).status, deriveStatus({ source }));
  return { dir, twin, source, sources };
}

{
  const sources = loadSources({ repoRoot: ROOT });
  const ids = Object.keys(sources.twins);
  assert(ids.length >= 5, `source table declares every first-party twin (got ${ids.join(", ")})`);
  for (const id of ["gmail", "github", "stripe", "slack", "linear"]) {
    assert(ids.includes(id), `source table declares ${id}`);
  }

  const producerText = readFileSync(join(ROOT, "scripts/capture-mcp-tools-list.mjs"), "utf8");
  for (const id of ["gmail", "github", "stripe", "slack", "linear"]) {
    assert(
      !new RegExp(`["'\`]${id}["'\`]`).test(producerText),
      `the producer does not name the twin "${id}" — adding a twin must be a data edit`
    );
  }

  assert(
    /realpathSync\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)/.test(producerText),
    "the CLI entry guard realpaths its own side (realpathSync(fileURLToPath(import.meta.url)))"
  );
  assert(
    /realpathSync\(\s*resolve\(\s*process\.argv\[1\]\s*\)\s*\)/.test(producerText),
    "the CLI entry guard realpaths the argv0 side (realpathSync(resolve(process.argv[1])))"
  );
}

{
  assertThrows(
    () =>
      loadSources({
        repoRoot: ROOT,
        table: {
          goldenDir: "fixtures/mcp-tools-list",
          twins: { acme: { substrate: "live-wire-unauth", capture: true, endpoint: "https://x/mcp" } },
        },
      }),
    "configuration",
    "a capturable source with no `configuration` is rejected"
  );
  assertThrows(
    () =>
      loadSources({
        repoRoot: ROOT,
        table: {
          goldenDir: "fixtures/mcp-tools-list",
          twins: {
            acme: { substrate: "live-wire-unauth", capture: true, endpoint: "https://x/mcp", configuration: {} },
          },
        },
      }),
    "configuration",
    "a capturable source with an EMPTY `configuration` is rejected"
  );
  assertThrows(
    () =>
      loadSources({
        repoRoot: ROOT,
        table: {
          goldenDir: "fixtures/mcp-tools-list",
          twins: { acme: { substrate: "invented-substrate", capture: true, configuration: { a: 1 } } },
        },
      }),
    "substrate",
    "an unknown substrate is rejected rather than silently skipped"
  );
  assertThrows(
    () =>
      loadSources({
        repoRoot: ROOT,
        table: {
          goldenDir: "fixtures/mcp-tools-list",
          twins: { acme: { substrate: "not-captured", capture: false } },
        },
      }),
    "reason",
    "a not-captured twin must say WHY"
  );
}

{
  assert(
    adapterFor("live-wire-oauth").read === adapterFor("live-wire-unauth").read,
    "live-wire-oauth and live-wire-unauth share one reader"
  );
  await assertRejects(
    () =>
      adapterFor("live-wire-oauth").read({
        twin: "acme",
        endpoint: "https://example.invalid/mcp",
        substrate: "live-wire-oauth",
        authTokenEnv: "TOKEN_THAT_IS_NOT_SET",
        configuration: { auth: "bearer" },
      }),
    "TOKEN_THAT_IS_NOT_SET",
    "the oauth reader refuses to fall back to an unauthenticated request"
  );
}

{
  const rawText = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [{ name: "b_tool" }, { name: "a_tool" }] },
  });
  const source = {
    twin: "acme",
    substrate: "live-wire-unauth",
    endpoint: "https://example.invalid/mcp",
    method: "tools/list",
    protocol: "JSON-RPC 2.0 over HTTP",
    protocolVersion: "2025-03-26",
    configuration: { auth: "none" },
  };
  const golden = deriveGolden({ source, rawText, captureDate: "2026-08-06" });
  const meta = JSON.parse(golden.meta);
  const canonical = JSON.parse(golden.canonical);

  assert(golden.raw === rawText, "raw.json is the upstream bytes verbatim");
  assert(meta.rawFileSha256 === sha256(rawText), "rawFileSha256 is computed from the raw bytes");
  assert(meta.canonicalFileSha256 === sha256(golden.canonical), "canonicalFileSha256 is computed");
  for (const field of REQUIRED_META_FIELDS) {
    assert(meta[field] !== undefined, `meta.json carries the provenance field \`${field}\``);
  }
  assert(meta.liveToolCount === 2, "liveToolCount comes from the response, not the table");
  assert(
    JSON.stringify(meta.liveToolOrder) === JSON.stringify(["b_tool", "a_tool"]),
    "liveToolOrder preserves upstream order (it is a fact about the deployment)"
  );
  assert(
    JSON.stringify(canonical.result) === JSON.stringify(JSON.parse(rawText).result),
    "canonical.result is the raw result, verbatim"
  );

  const tampered = deriveGolden({
    source: { ...source, rawFileSha256: "0".repeat(64) },
    rawText,
    captureDate: "2026-08-06",
  });
  assert(
    JSON.parse(tampered.meta).rawFileSha256 === sha256(rawText),
    "a sha declared on the source table is ignored — it is always recomputed"
  );
}

{
  const sources = loadSources({ repoRoot: ROOT });
  for (const [twin, source] of Object.entries(sources.twins)) {
    if (!source.capture) continue;
    const paths = goldenPaths({ repoRoot: ROOT, sources, twin });
    const rawText = readFileSync(paths.raw, "utf8");
    const committed = JSON.parse(readFileSync(paths.meta, "utf8"));
    const meta = JSON.parse(
      deriveGolden({ source, rawText, captureDate: committed.captureDate }).meta
    );
    assert(meta.substrate === source.substrate, `${twin}: substrate round-trips into meta.json`);
    assert(
      JSON.stringify(meta.configuration) === JSON.stringify(source.configuration),
      `${twin}: the configuration the adapter assumed round-trips into meta.json`
    );
    assert(
      Object.keys(meta.configuration).length > 0,
      `${twin}: the recorded configuration is not empty`
    );
  }
}

{
  const code = await runCapture({ repoRoot: ROOT, check: true, offline: true, ...SILENT });
  assert(code === 0, "`--check --offline` is green against the committed goldens");
}

{
  const sources = loadSources({ repoRoot: ROOT });
  const captured = Object.entries(sources.twins).filter(([, s]) => s.capture);
  assert(captured.length > 0, "at least one twin is captured (otherwise the guard guards nothing)");

  for (const [twin] of captured) {
    {
      const dir = sandbox();
      const paths = goldenPaths({ repoRoot: dir, sources, twin });
      const canonical = JSON.parse(readFileSync(paths.canonical, "utf8"));
      canonical.result.tools.push({ name: "a_tool_nobody_can_call" });
      writeFileSync(paths.canonical, `${JSON.stringify(canonical, null, 2)}\n`);
      const before = readFileSync(paths.canonical, "utf8");
      const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
      assert(code !== 0, `${twin}: --check reds when canonical.json gains a tool`);
      assert(readFileSync(paths.canonical, "utf8") === before, `${twin}: --check wrote nothing`);
      rmSync(dir, { recursive: true, force: true });
    }
    {
      const dir = sandbox();
      const paths = goldenPaths({ repoRoot: dir, sources, twin });
      const raw = JSON.parse(readFileSync(paths.raw, "utf8"));
      raw.result.tools.pop();
      writeFileSync(paths.raw, JSON.stringify(raw));
      const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
      assert(code !== 0, `${twin}: --check reds when raw.json loses a tool`);
      rmSync(dir, { recursive: true, force: true });
    }
    {
      const dir = sandbox();
      const paths = goldenPaths({ repoRoot: dir, sources, twin });
      const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
      meta.substrate = "live-wire-unauth-but-actually-invented";
      writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
      const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
      assert(code !== 0, `${twin}: --check reds when meta.json misstates the substrate`);
      rmSync(dir, { recursive: true, force: true });
    }
    {
      const dir = sandbox();
      const paths = goldenPaths({ repoRoot: dir, sources, twin });
      const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
      meta.rawFileSha256 = "f".repeat(64);
      writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
      const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
      assert(code !== 0, `${twin}: --check reds when rawFileSha256 is hand-typed`);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const { dir, twin, sources: sandboxSources } = sandboxWithDeferredTwin();
    const paths = goldenPaths({ repoRoot: dir, sources: sandboxSources, twin });
    const status = JSON.parse(readFileSync(paths.status, "utf8"));
    status.reason = "no reason given";
    writeFileSync(paths.status, `${JSON.stringify(status, null, 2)}\n`);
    const code = await runCapture({
      repoRoot: dir,
      sourcesPath: join(dir, "config/mcp-capture-sources.json"),
      twins: [twin],
      check: true,
      offline: true,
      ...SILENT,
    });
    assert(code !== 0, `${twin}: --check reds when the recorded not-captured reason is edited away`);
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { dir: statusDir, twin, source, sources: sandboxSources } = sandboxWithDeferredTwin();
    const paths = goldenPaths({ repoRoot: statusDir, sources: sandboxSources, twin });
    const status = JSON.parse(readFileSync(paths.status, "utf8"));
    if (source.configuration) {
      assert(
        JSON.stringify(status.configuration) === JSON.stringify(source.configuration),
        `${twin}: the declared configuration round-trips into ${twin}.status.json`
      );
    }
    if (source.authTokenEnv) {
      assert(status.authTokenEnv === source.authTokenEnv, `${twin}: authTokenEnv round-trips into the status file`);
    }

    for (const mutate of [
      (s) => {
        s.configuration = { ...s.configuration, auth: "none" };
      },
      (s) => {
        s.authTokenEnv = "SOMETHING_ELSE";
      },
      (s) => {
        s.configuration = {
          ...s.configuration,
          requestHeaders: { ...s.configuration?.requestHeaders, "content-type": "text/plain" },
        };
      },
    ]) {
      const mutated = { ...source, configuration: { ...source.configuration } };
      mutate(mutated);
      if (JSON.stringify(deriveStatus({ source: mutated })) === JSON.stringify(deriveStatus({ source }))) {
        assert(false, `${twin}: a change to the declared capture configuration left the status file identical`);
      }
      const { dir, sources: mutSources } = sandboxWithDeferredTwin();
      writeFileSync(goldenPaths({ repoRoot: dir, sources: mutSources, twin }).status, deriveStatus({ source: mutated }));
      const code = await runCapture({
        repoRoot: dir,
        sourcesPath: join(dir, "config/mcp-capture-sources.json"),
        twins: [twin],
        check: true,
        offline: true,
        ...SILENT,
      });
      assert(code !== 0, `${twin}: --check reds when the recorded capture configuration is changed`);
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(statusDir, { recursive: true, force: true });
  }

  {
    const dir = sandbox();
    const [twin] = captured[0];
    rmSync(goldenPaths({ repoRoot: dir, sources, twin }).canonical);
    const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
    assert(code !== 0, `${twin}: --check reds when a golden file is missing`);
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = sandbox();
  const sources = loadSources({ repoRoot: dir });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);
  const paths = goldenPaths({ repoRoot: dir, sources, twin });
  const before = ["raw", "meta", "canonical"].map((k) => readFileSync(paths[k], "utf8"));
  const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
  assert(code === 0, "sandbox copy of the goldens is green");
  const after = ["raw", "meta", "canonical"].map((k) => readFileSync(paths[k], "utf8"));
  assert(JSON.stringify(before) === JSON.stringify(after), "--check left every golden byte-identical");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = sandbox();
  const sources = loadSources({ repoRoot: dir });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);
  const paths = goldenPaths({ repoRoot: dir, sources, twin });
  const rawText = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "only_tool" }] } });

  const code = await runCapture({
    repoRoot: dir,
    twins: [twin],
    today: "2026-01-02",
    readSubstrate: async () => ({ rawText }),
    ...SILENT,
  });
  assert(code === 0, "write mode succeeds against an injected reader");
  assert(readFileSync(paths.raw, "utf8") === rawText, "write mode wrote the reader's bytes verbatim");
  const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  assert(meta.captureDate === "2026-01-02", "write mode stamps the capture date");
  assert(meta.liveToolCount === 1, "write mode recomputed liveToolCount");
  assert(meta.rawFileSha256 === sha256(rawText), "write mode recomputed the sha");

  const recheck = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
  assert(recheck === 0, "what write mode produced is what --check accepts");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = sandbox();
  const sources = loadSources({ repoRoot: dir });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);
  const cfgPath = join(dir, "config/mcp-capture-sources.json");
  const paths = goldenPaths({ repoRoot: dir, sources, twin });
  const rawBefore = readFileSync(paths.raw, "utf8");
  const committedDate = JSON.parse(readFileSync(paths.meta, "utf8")).captureDate;

  const table = JSON.parse(readFileSync(cfgPath, "utf8"));
  table.twins[twin].configuration.matchesExaminee = "re-stated by an offline re-derivation, not by a capture";
  writeFileSync(cfgPath, `${JSON.stringify(table, null, 2)}\n`);

  const stale = await runCapture({ repoRoot: dir, sourcesPath: cfgPath, check: true, offline: true, ...SILENT });
  assert(stale !== 0, "--check reds while the source table's configuration and the goldens disagree");

  const code = await runCapture({
    repoRoot: dir,
    sourcesPath: cfgPath,
    today: "2099-12-31",
    offline: true,
    ...SILENT,
  });
  assert(code === 0, "--offline write mode re-derives every golden with no substrate");

  const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  assert(
    meta.captureDate === committedDate,
    `--offline write mode carries the committed captureDate (${committedDate}), never today's`
  );
  assert(readFileSync(paths.raw, "utf8") === rawBefore, "--offline write mode left raw.json byte-identical");
  assert(meta.rawFileSha256 === sha256(rawBefore), "--offline write mode re-hashed the committed bytes");
  assert(
    meta.configuration.matchesExaminee === "re-stated by an offline re-derivation, not by a capture",
    "--offline write mode carried the edited configuration into meta.json"
  );

  const recheck = await runCapture({ repoRoot: dir, sourcesPath: cfgPath, check: true, offline: true, ...SILENT });
  assert(recheck === 0, "what --offline write mode produced is what --check --offline accepts");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = sandbox();
  const sources = loadSources({ repoRoot: dir });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);
  const paths = goldenPaths({ repoRoot: dir, sources, twin });

  rmSync(paths.raw);
  const code = await runCapture({ repoRoot: dir, twins: [twin], offline: true, ...SILENT });
  assert(code !== 0, "--offline write mode reds when there is no committed raw.json to re-derive from");
  assert(!existsSync(paths.raw), "--offline write mode did not invent a raw.json");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = sandbox();
  const sources = loadSources({ repoRoot: dir });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);
  const paths = goldenPaths({ repoRoot: dir, sources, twin });
  const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  delete meta.captureDate;
  writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);

  const code = await runCapture({ repoRoot: dir, twins: [twin], today: "2099-12-31", offline: true, ...SILENT });
  assert(code !== 0, "--offline write mode reds on a golden whose meta.json carries no captureDate");
  assert(
    !JSON.parse(readFileSync(paths.meta, "utf8")).captureDate,
    "--offline write mode did not date an undated golden from the calendar"
  );
  rmSync(dir, { recursive: true, force: true });
}

{
  const sources = loadSources({ repoRoot: ROOT });
  for (const [id, source] of Object.entries(sources.twins)) {
    if (!source.capture) continue;
    assert(
      COMPLETENESS_CLASSES.includes(source.configuration.completeness),
      `${id}: the committed source table declares a completeness class (got ${JSON.stringify(
        source.configuration.completeness
      )})`
    );
  }

  const table = JSON.parse(readFileSync(join(ROOT, "config/mcp-capture-sources.json"), "utf8"));
  const capturable = Object.keys(table.twins).find((id) => table.twins[id].capture);
  for (const [label, value] of [
    ["absent", undefined],
    ["an unknown class", "probably-fine"],
    ["the empty string", ""],
  ]) {
    const mutated = structuredClone(table);
    if (value === undefined) delete mutated.twins[capturable].configuration.completeness;
    else mutated.twins[capturable].configuration.completeness = value;
    assertThrows(
      () => loadSources({ table: mutated }),
      "completeness",
      `loadSources refuses a capturable source whose completeness is ${label}`
    );
  }
}

{
  const sources = loadSources({ repoRoot: ROOT });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);
  const cases = [
    ["a JSON-RPC error envelope", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601 } })],
    ["an empty tools array", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })],
    ["a result with no tools key", JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })],
    ["a body that is not JSON", "<html>502 Bad Gateway</html>"],
  ];
  for (const [label, rawText] of cases) {
    const dir = sandbox();
    const paths = goldenPaths({ repoRoot: dir, sources, twin });
    const before = readFileSync(paths.raw, "utf8");
    const code = await runCapture({
      repoRoot: dir,
      twins: [twin],
      readSubstrate: async () => ({ rawText }),
      ...SILENT,
    });
    assert(code !== 0, `${label} is not written as a golden`);
    assert(readFileSync(paths.raw, "utf8") === before, `${label} left the committed raw.json untouched`);
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const table = JSON.parse(readFileSync(join(ROOT, "config/mcp-capture-sources.json"), "utf8"));
  const gatedSources = Object.entries(table.twins).filter(([, row]) => row.substrate === "live-wire-oauth");
  assert(gatedSources.length > 0, "the source table has live-wire-oauth rows for this guard to cover");
  for (const [twin, row] of gatedSources) {
    assert(Boolean(row.authTokenEnv), `${twin}: an oauth row names the env var that carries its token`);
    assert(
      Boolean(row.protocolVersion),
      `${twin}: an oauth row declares protocolVersion — without it, flipping \`capture\` throws a SCHEMA ` +
        `error before the socket opens, at whoever has just finished an OAuth flow`
    );

    const flipped = JSON.parse(JSON.stringify(table));
    flipped.twins[twin].capture = true;
    delete flipped.twins[twin].reason;
    try {
      loadSources({ table: flipped });
    } catch (err) {
      assert(false, `${twin}: flipping \`capture\` must not throw — a credential is a token, not a schema edit (${err.message})`);
    }
  }
}

{
  const sources = loadSources({ repoRoot: ROOT });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);

  {
    const dir = sandbox();
    const paths = goldenPaths({ repoRoot: dir, sources, twin });
    writeFileSync(paths.status, `${JSON.stringify({ twin, captured: false, reason: "stale" }, null, 2)}\n`);
    const code = await runCapture({ repoRoot: dir, twins: [twin], check: true, offline: true, ...SILENT });
    assert(code !== 0, "a golden sitting beside a leftover status.json fails --check");
    let named = false;
    await runCapture({
      repoRoot: dir,
      twins: [twin],
      check: true,
      offline: true,
      log: quiet,
      err: (line) => {
        if (String(line).includes(`${twin}.status.json`)) named = true;
      },
    });
    assert(named, "the failure names the status file to delete, not just 'a difference'");
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = sandbox();
    const paths = goldenPaths({ repoRoot: dir, sources, twin });
    const rawText = readFileSync(paths.raw, "utf8");
    writeFileSync(paths.status, `${JSON.stringify({ twin, captured: false, reason: "stale" }, null, 2)}\n`);
    const code = await runCapture({
      repoRoot: dir,
      twins: [twin],
      readSubstrate: async () => ({ rawText }),
      ...SILENT,
    });
    assert(code === 0, "the capture itself succeeds");
    assert(!existsSync(paths.status), "a successful capture retires the status file it supersedes");
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const ENV = "BLANK_PROBE";
  const source = {
    twin: "acme",
    endpoint: "https://example.invalid/mcp",
    substrate: "live-wire-oauth",
    authTokenEnv: ENV,
    configuration: { auth: "bearer" },
  };
  const read = () => adapterFor("live-wire-oauth").read(source);

  delete process.env[ENV];
  await assertRejects(read, "is not set", "an ABSENT token says 'is not set'");

  for (const [label, value] of [["empty string", ""], ["whitespace only", "   \t "]]) {
    process.env[ENV] = value;
    await assertRejects(read, "SET BUT BLANK", `a ${label} is reported as SET BUT BLANK, not as unset`);
    await assertRejects(read, "secret store", `a ${label} points at the secret store, not the OAuth flow`);
  }
  delete process.env[ENV];
}

{
  const envelope = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "get_issue" }] } };
  const payload = JSON.stringify(envelope);

  assert(unwrapEventStream(payload) === payload, "a plain JSON body is returned untouched");
  assert(
    unwrapEventStream(`event: message\ndata: ${payload}\n\n`) === payload,
    "a single SSE event is unwrapped to its data payload"
  );
  assert(
    unwrapEventStream(`data: ${payload}\r\n\r\n`) === payload,
    "CRLF-framed SSE is unwrapped (the spec allows either line ending)"
  );

  const withNoise =
    `event: ping\ndata: {"jsonrpc":"2.0","method":"ping"}\n\n` + `event: message\ndata: ${payload}\n\n`;
  assert(unwrapEventStream(withNoise) === payload, "a leading ping event is skipped, not returned as the answer");

  const split = `event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":[{"name":"get_issue"}]}}\n\n`;
  assert(
    JSON.parse(unwrapEventStream(split)).result.tools.length === 1,
    "a data payload split across several `data:` lines is rejoined"
  );

  assertThrows(
    () => unwrapEventStream("event: message\ndata: not json\n\n"),
    "no event carried a JSON-RPC result or error",
    "an SSE stream with no usable event fails loudly rather than returning garbage"
  );
}

{
  const envelope = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "t" }] } });
  const realFetch = globalThis.fetch;
  const serve = (body) => {
    globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
  const source = (framing) => ({
    twin: "acme",
    substrate: "live-wire-unauth",
    endpoint: "https://example.invalid/mcp",
    method: "tools/list",
    configuration: { auth: "none", ...(framing ? { responseFraming: framing } : {}) },
  });
  try {
    serve(`event: message\ndata: ${envelope}\n\n`);
    await assertRejects(
      () => adapterFor("live-wire-unauth").read(source(undefined)),
      'declares responseFraming "application/json"',
      "an undeclared SSE response is refused, not silently unwrapped"
    );
    const ok = await adapterFor("live-wire-unauth").read(source("text/event-stream"));
    assert(ok.rawText === envelope, "a declared SSE response is unwrapped to the envelope");

    serve(envelope);
    await assertRejects(
      () => adapterFor("live-wire-unauth").read(source("text/event-stream")),
      'answered "application/json"',
      "a vendor that STOPS using SSE is a loud failure too — the declaration is checked both ways"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (failures > 0) {
  console.error(`\ncapture-mcp-tools-list.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("capture-mcp-tools-list.test.mjs: all assertions passed");
