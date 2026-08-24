#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for scripts/capture-mcp-tools-list.mjs.
//
// No network, no `go`, no clone: every case here drives the producer through
// its injected `readSubstrate` seam, or through `--offline`, which re-derives
// meta + canonical from the COMMITTED raw.json. The committed raw.json IS the
// fixture of the upstream response — a second copy of the same bytes under
// scripts/fixtures/ would be one more thing to drift.
//
// The block that matters most is "the guard fires": a --check that
// has never been watched go red is not a guard. Each of the four ways a
// golden can be wrong — edited raw, edited canonical, edited meta provenance,
// hand-typed sha — gets its own red here.
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
// Silence the producer's own stderr in the guard-fires block: those reds are the
// assertion, not a failure of this suite.
const SILENT = { log: quiet, err: quiet };

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "f1326-"));
  cpSync(join(ROOT, "config/mcp-capture-sources.json"), join(dir, "config/mcp-capture-sources.json"), {
    recursive: true,
  });
  cpSync(join(ROOT, "fixtures/mcp-tools-list"), join(dir, "fixtures/mcp-tools-list"), { recursive: true });
  return dir;
}


/**
 * A sandbox whose source table carries one SYNTHETIC uncaptured twin.
 *
 * The last three deferred twins are captured, so `sources.twins` now has no
 * `capture: false` row at all. The guards below cover the not-captured path —
 * the recorded-reason gate and the declared-configuration round-trip — and if
 * they simply iterated the real table they would now iterate NOTHING and report
 * the same green as a satisfied guard. That is this repo's vacuous-green rule,
 * and the
 * fix is a fixture rather than a weakened assertion: the behaviour is still
 * reachable the moment a sixth twin is added deferred, so it stays tested.
 */
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

// ── the declared source table ───────────────────────────────────────────────
// Adding a twin is a data edit, never a new `case:`. The gate
// on that is that nothing in the producer enumerates twin ids.
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

  // This producer's entry guard follows the sanctioned form (positive
  // assertion: THIS file's guard really is process.argv[1] vs.
  // import.meta.url, not just "not import.meta.main" — a guard rewritten into
  // some other broken shape would still pass an absence check). The absence
  // of a bare `import.meta.main` ANYWHERE under scripts/**/contract/** —
  // including in this file — is asserted repo-wide by
  // scripts/lint/rules/import-meta-main.mjs, which subsumes what
  // used to be a second, narrower copy of that same assertion here: two
  // checks asserting one property in different places is the shape D5 warns
  // about, and the repo-wide one covers strictly more (every file, not just
  // this producer) with no hand-kept list of which files to watch.
  //
  // Two independent, ORDER-INDEPENDENT assertions, one per side. The single
  // regex these replace was `/process\.argv\[1\][\s\S]{0,120}import\.meta\.url/`,
  // which encodes source ORDER rather than the guard: this guard was rewritten
  // into the sanctioned realpath-both-sides form, which declares the
  // `import.meta.url` const first, and the old regex failed on a guard that had
  // just been made strictly STRONGER.
  //
  // Deliberately still a text match and NOT the repo-wide gate's AST
  // classifier, tempting as reusing it is: `findEntryGuardRealpathGaps` lives
  // in `import-meta-main.mjs`, which imports `typescript`, and
  // THIS test runs in ci.yml's CHEAP block, which has no `npm ci`. Importing it
  // here crashes the job with ERR_MODULE_NOT_FOUND — a dependency-free test
  // must stay dependency-free. The AST version of this property is asserted
  // repo-wide in the heavy block, over this file among all the others.
  assert(
    /realpathSync\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)/.test(producerText),
    "the CLI entry guard realpaths its own side (realpathSync(fileURLToPath(import.meta.url)))"
  );
  assert(
    /realpathSync\(\s*resolve\(\s*process\.argv\[1\]\s*\)\s*\)/.test(producerText),
    "the CLI entry guard realpaths the argv0 side (realpathSync(resolve(process.argv[1])))"
  );
}

// ── every capturable source declares the configuration it assumed ───────────
// "A capture without one FAILS rather than defaulting." The failure has to be
// at load, not at write: a producer that defaults is a producer that records a
// configuration nobody chose.
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

// ── A credential adds a token, not an adapter ───────────────────────────────
// live-wire-oauth and live-wire-unauth must resolve to the SAME reader. If they
// ever diverge, "a token, not an adapter" stops being true and nobody finds out
// until the next credentialed capture.
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

// ── derivation: sha is computed, never carried ──────────────────────────────
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

  // A capture whose sha was hand-typed cannot survive: derivation ignores any
  // sha present on the source table.
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

// ── substrate + configuration round-trip into meta.json ─────────────────────
// One case per adapter, driven off the REAL committed source table so a twin
// whose configuration stops reaching meta.json reds here.
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

// ── the committed goldens are what the producer derives ─────────────────────
{
  const code = await runCapture({ repoRoot: ROOT, check: true, offline: true, ...SILENT });
  assert(code === 0, "`--check --offline` is green against the committed goldens");
}

// ── the guard fires ─────────────────────────────────────────────────────────
// Four independent edits, four reds, and nothing written back.
{
  const sources = loadSources({ repoRoot: ROOT });
  const captured = Object.entries(sources.twins).filter(([, s]) => s.capture);
  assert(captured.length > 0, "at least one twin is captured (otherwise the guard guards nothing)");

  for (const [twin] of captured) {
    // 1. canonical edited
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
    // 2. raw edited (canonical + sha both stop matching)
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
    // 3. meta provenance edited — the substrate claim itself
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
    // 4. sha hand-typed to something plausible
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

  // 5. a not-captured / deferred twin whose recorded reason no longer matches
  //    the table is a red too — an unexplained `not-captured` is the failure
  //    mode this ticket exists to avoid.
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

  // 7. the DEFERRED twins' declared configuration is the thing a credentialed
  //    capture will assume, so it has to be recorded and gated exactly like a
  //    captured twin's. Without this, someone could change which header
  //    Slack's future capture sends, or which env var holds its token, and
  //    every gate would stay green.
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

  // 6. a missing golden is a red, not a silent skip.
  {
    const dir = sandbox();
    const [twin] = captured[0];
    rmSync(goldenPaths({ repoRoot: dir, sources, twin }).canonical);
    const code = await runCapture({ repoRoot: dir, check: true, offline: true, ...SILENT });
    assert(code !== 0, `${twin}: --check reds when a golden file is missing`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── --check never writes, even when it would be green ───────────────────────
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

// ── write mode round-trips through an injected substrate reader ─────────────
// The write path is exercised without a socket: the fake reader stands in for
// whichever adapter the substrate names.
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

// ── --offline WRITES the re-derivation, and cannot forge a capture ───────────
//
// The mode exists because `configuration` is prose about a capture that is
// copied into two derived files, and three of the five sources sit behind
// one-shot OAuth grants — so without it, a corrected sentence about slack's
// golden means either minting a fresh Slack grant or hand-editing the goldens.
//
// What has to stay true is that it re-states what a capture MEANT and never
// what it FOUND. Both halves get a red of their own below: the derived fields
// still come from the committed raw bytes, and `captureDate` does not move.
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

  // The edit alone reds the gate — the whole reason the mode has to exist.
  const stale = await runCapture({ repoRoot: dir, sourcesPath: cfgPath, check: true, offline: true, ...SILENT });
  assert(stale !== 0, "--check reds while the source table's configuration and the goldens disagree");

  const code = await runCapture({
    repoRoot: dir,
    sourcesPath: cfgPath,
    // A date that is nothing like the committed one, so carrying it is visible.
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

// ── --offline has nothing to re-derive FROM, and says so rather than inventing ──
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
  // An undated golden cannot be re-derived either: `today` belongs to a run
  // that read a substrate, and stamping it here would reset any staleness
  // clock without anybody having contacted the vendor.
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

// ── every capturable source states what its capture COVERS ──────────────────
//
// The field is required at load, beside `configuration` itself. linear's golden
// was captured under a read-only grant, declared no completeness class, and
// pome-cloud's promotion-gate went on to report six write tools that
// mcp.linear.app really serves as tools the twin had invented — the fabricated
// finding that lane must never produce.
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
    // The flattering default a missing field would otherwise mean.
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

// ── a substrate read that comes back malformed fails loudly ─────────────────
// Four shapes an upstream read can come back wrong in. Each must refuse to
// become a golden: an empty listing written as a golden is the worst outcome
// available here, because it reads as "the vendor serves nothing" and turns
// every tool a twin has into a divergence.
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

// ── a deferred oauth row is CAPTURE-READY, not merely declared ───────────────
// The whole content of "a token, not an adapter" is that the errand
// is one env var away. It was not: slack and linear declared no
// `protocolVersion`, which `loadSources` requires on every capturable source, so
// flipping `capture` threw `must declare protocolVersion` before opening a
// socket — a schema error, read by whoever had just finished an OAuth flow, in
// the one moment they have every reason to blame their own credential.
//
// Asserted over EVERY deferred oauth row rather than the two that exist today,
// so a sixth twin added the same way is caught by this file and not by a human
// mid-errand.
{
  const table = JSON.parse(readFileSync(join(ROOT, "config/mcp-capture-sources.json"), "utf8"));
  // Every oauth row, captured or deferred. All three are captured, so keying
  // this on `!row.capture` would now select NOTHING and report the same green as
  // a satisfied guard — the shape the flip-throws bug hid behind in the first
  // place. The durable invariant is the one that made the flip safe: an oauth
  // row carries the two fields a capture needs, whether or not it is capturing
  // today.
  //
  // Named `gatedSources`, not `oauth`: CodeQL's `js/clear-text-logging` treats a
  // binding whose IDENTIFIER matches an auth keyword as a sensitive source, and
  // this suite's `assert()` helper ends in `console.error`. Nothing here holds a
  // secret — the source table stores env var NAMES, never values — but a
  // name-based heuristic cannot know that, and a suppression comment would sit
  // there long after anyone remembers why.
  const gatedSources = Object.entries(table.twins).filter(([, row]) => row.substrate === "live-wire-oauth");
  assert(gatedSources.length > 0, "the source table has live-wire-oauth rows for this guard to cover");
  for (const [twin, row] of gatedSources) {
    assert(Boolean(row.authTokenEnv), `${twin}: an oauth row names the env var that carries its token`);
    assert(
      Boolean(row.protocolVersion),
      `${twin}: an oauth row declares protocolVersion — without it, flipping \`capture\` throws a SCHEMA ` +
        `error before the socket opens, at whoever has just finished an OAuth flow`
    );

    // …and a row that is NOT capturing must be one env var away from capturing.
    // Proven by flipping it, on a deep copy, for real.
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

// ── the recorded refusal is RETIRED by the capture that supersedes it ────────
// pome-cloud's `loadUpstreamMcpGolden` resolves `<twin>.status.json` FIRST and
// never looks at the raw/meta beside it. Nothing used to delete that file, so
// The first credentialed capture would have committed a real golden while
// the lane went on publishing "401 missing_token" — the errand landing and
// reading as though it had not, with nothing red anywhere.
{
  const sources = loadSources({ repoRoot: ROOT });
  const twin = Object.keys(sources.twins).find((id) => sources.twins[id].capture);

  // (a) --check reds when both artefacts exist, and says which one wins.
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

  // (b) a real capture deletes it, so the commit cannot land half-applied.
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

// ── SET-BUT-BLANK is not UNSET ──────────────────────────────────────────────
// A value blanked in the secret store must not reach a runner and read
// as "no credential configured" — the operator who blanked it and the operator
// who never set it need different instructions. `if (!token)` said "is not set"
// for both, and let whitespace through entirely: `Bearer    ` went on the wire
// and came back as the VENDOR's 401, which reads as a bad token and sends
// whoever just minted one back through the OAuth flow.
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

// ── the Streamable HTTP transport may frame the answer as SSE ───────────────
// MCP lets a server answer a POST with either a JSON body or an SSE stream, and
// both are correct. Measured 2026-08-09: gmail, slack and stripe answer
// application/json; LINEAR answers SSE. Before this, `JSON.parse` on the wire
// bytes threw "the substrate did not answer JSON" — a message that reads like a
// broken endpoint or a bad token rather than a framing nothing handled.
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

  // A heartbeat or a `ping` BEFORE the real message must not be mistaken for the
  // answer: the first event carrying `result` or `error` wins, not the first
  // event that parses.
  const withNoise =
    `event: ping\ndata: {"jsonrpc":"2.0","method":"ping"}\n\n` + `event: message\ndata: ${payload}\n\n`;
  assert(unwrapEventStream(withNoise) === payload, "a leading ping event is skipped, not returned as the answer");

  // Multi-line data is one payload, per the SSE spec.
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

// ── the framing is DECLARED and then CHECKED, never inferred ────────────────
// `configuration` is copied verbatim into meta.json and `--check --offline`
// re-derives it with no substrate to observe, so a framing filled in from the
// live response would make the offline gate disagree with the online capture.
// Declaring it keeps the gate deterministic AND makes a vendor that silently
// switches transport framing a loud failure instead of a silent re-shape.
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
