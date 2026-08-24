#!/usr/bin/env node
/**
 * Regression coverage for scripts/probe-example-tools.mjs.
 *
 * The gate exists because `comment_on_pull_request` in
 * agent-examples/pr-summary-agent and agent-examples/pr-summary-review wrapped
 * `add_issue_comment` at a pull request's number, the GitHub twin answered
 * `404 Issue not found` for every one of those calls on all four subjects for
 * as long as the examples had existed, and both older example gates
 * (gate:examples, smoke:examples) were green throughout. The cases below
 * are written from that incident.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotateFromTape,
  deriveSeedFacts,
  discoverExamplesWithSeeds,
  assertManifestEntry,
  discoverSeeds,
  evaluateProbeRun,
  formatFindings,
  freePort,
  PROBE_SECRET,
  resolveArgs,
  resolveConfig,
  runGate,
  splitSeed,
  withWireRuntime,
} from "./probe-example-tools.mjs";

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
// Mirrors cli/src/task/parseTask.ts. Envelope-iff-multi-twin, decided from the
// declared twin list alone — never by sniffing the seed shape.
//
// A single-twin example ships a FLAT seed. agent-examples/triage-agent's is
// { _meta, users, repositories }.
{
  const flat = { _meta: { version: 1 }, users: [], repositories: [{ owner: "acme", name: "api" }] };
  const out = splitSeed(flat, ["github"]);
  assert(out.github.repositories === flat.repositories, "splitSeed hands a flat seed to the single declared twin");
  // Not politeness: the gmail twin's seed schema is strict and rejects `_meta`.
  assert(!("_meta" in out.github), "splitSeed strips the _meta envelope before the twin's schema sees it");
}

// A multi-twin example ships a PER-TWIN ENVELOPE. Both viktor examples'
// 01-clean-merge.seed.json is exactly { github: {...}, slack: {...} }.
{
  const gh = { _meta: { version: 1 }, users: [], repositories: [] };
  const sl = { channels: [] };
  const out = splitSeed({ github: gh, slack: sl }, ["github", "slack"]);
  assert(out.github.repositories === gh.repositories, "splitSeed slices the github half of an envelope");
  assert(!("_meta" in out.github), "splitSeed strips _meta from an envelope slice too");
  assert(out.slack.channels === sl.channels, "splitSeed slices the slack half of an envelope");
}

// Envelope keys are a SUBSET of the declared twins: a twin with no key falls
// back to its own default world, which `serve()` reads as `seed: undefined`.
{
  const out = splitSeed({ github: { repositories: [] } }, ["github", "slack"]);
  assert(out.slack === undefined, "a declared twin absent from the envelope falls back to its default seed");
}

// A key that is not a declared twin is a loud error.
assertThrows(
  () => splitSeed({ github: {}, slack: {} }, ["github", "gmail"]),
  "slack",
  "splitSeed rejects an envelope key the example does not declare",
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

// ── deriveSeedFacts / resolveArgs ───────────────────────────────────────────
// The load-bearing half of the ticket: probe arguments come off the seed
// itself, never a hand-written literal, so a sixth viktor seed needs no new
// fixture and a repo with no PR/issue/file simply yields no bucket for it.
{
  const slice = {
    repositories: [
      {
        owner: "acme",
        name: "widgets",
        default_branch: "main",
        files: [{ path: "widget.py", branch: "main", content: "x" }],
        issues: [{ number: 4, title: "an issue" }],
        pull_requests: [{ number: 2, title: "a pr" }],
      },
    ],
  };
  const facts = deriveSeedFacts(slice);
  assert(facts.repo.owner === "acme" && facts.repo.name === "widgets", "deriveSeedFacts reads the first repo");
  assert(facts.pr.number === 2, "deriveSeedFacts reads the first PR's number");
  assert(facts.issue.number === 4, "deriveSeedFacts reads the first issue's number");
  assert(facts.file.path === "widget.py" && facts.file.ref === "main", "deriveSeedFacts reads the first file + default_branch");

  // `$file.ref` is the branch the FILE names, falling back to default_branch
  // only when it names none. All 20 shipped seeds happen to list a
  // default-branch file first; a seed whose first file lives on a feature
  // branch would otherwise be probed at `path@main` and the 404 would be
  // reported as "the twin refuses get_file_contents".
  const featureBranchFile = deriveSeedFacts({
    repositories: [{ owner: "acme", name: "widgets", default_branch: "main", files: [{ path: "new.py", branch: "add-thing" }] }],
  });
  assert(featureBranchFile.file.ref === "add-thing", "deriveSeedFacts prefers the first file's own branch over default_branch");

  assert(Object.keys(deriveSeedFacts(undefined)).length === 0, "deriveSeedFacts is empty for a twin with no seed slice");
  assert(
    Object.keys(deriveSeedFacts({ repositories: [] })).length === 0,
    "deriveSeedFacts is empty when the slice has no repositories",
  );

  // triage-agent's seeds carry issues but no pull_requests — deriveSeedFacts
  // must not invent a `pr` bucket, or a probe template asking for `$pr.number`
  // would silently resolve to `undefined` instead of failing loudly.
  const noPr = deriveSeedFacts({
    repositories: [{ owner: "acme", name: "api", issues: [{ number: 1 }], pull_requests: [] }],
  });
  assert(noPr.pr === undefined, "deriveSeedFacts omits the pr bucket when the repo has none");
  assert(noPr.issue.number === 1, "deriveSeedFacts still reads the issue bucket");

  // `$pr.last_number` is the subject `merge-agent`'s request_changes probe
  // wants: its seed is 01-identity-spoof and the SECOND pull request is the
  // impersonator's. Hand-writing `2` is what this ticket removed; for the 18
  // seeds with exactly one PR it collapses to the same number.
  const twoPrs = deriveSeedFacts({
    repositories: [{ owner: "a", name: "b", pull_requests: [{ number: 1 }, { number: 2 }] }],
  });
  assert(twoPrs.pr.number === 1 && twoPrs.pr.last_number === 2, "deriveSeedFacts exposes the first AND the last PR number");
  assert(facts.pr.last_number === 2 && facts.pr.number === 2, "a single-PR seed's first and last PR are the same");

  const resolved = resolveArgs(
    { owner: "$repo.owner", repo: "$repo.name", pull_number: "$pr.number", body: "literal probe." },
    facts,
  );
  assert(
    resolved.owner === "acme" && resolved.repo === "widgets" && resolved.pull_number === 2,
    "resolveArgs fills $repo.* and $pr.number from the derived facts",
  );
  assert(resolved.body === "literal probe.", "resolveArgs passes a non-$ literal through unchanged");

  assert(
    resolveArgs({ issue_number: "$issue.number" }, noPr).issue_number === 1,
    "resolveArgs resolves $issue.number when the seed has an issue",
  );
  assertThrows(
    () => resolveArgs({ pull_number: "$pr.number" }, noPr),
    "pr.number",
    "resolveArgs rejects $pr.number against a seed with no pull_requests",
  );
  assertThrows(() => resolveArgs({ x: "$repo.unknown_field" }, facts), "repo.unknown_field", "resolveArgs rejects an unknown field on a known bucket");
  assertThrows(() => resolveArgs({ x: "$notabucket.field" }, facts), "$notabucket.field", "resolveArgs rejects an unknown token shape");
}

// ── the merge exemption is DERIVED from the seed, not a map keyed by filename ─
// `03-failing-ci` fails a required status check on purpose so a real GitHub
// 409s the merge. The old shape was `expect_status_by_seed: {"<filename>": 409}`
// — a hand-kept list of instances, which is the shape D5 exists to remove: it
// goes stale in silence when the seed is renamed or deleted, and a NEW seed
// with failing CI has to be added to it by hand. `$pr.merge_blocked` is read
// off the seed, so both directions are automatic.
{
  const withFailing = deriveSeedFacts({
    repositories: [
      { owner: "a", name: "b", pull_requests: [{ number: 1, statuses: [{ context: "ci/test", state: "failure" }] }] },
    ],
  });
  assert(withFailing.pr.merge_blocked === true, "a failing required status check derives merge_blocked");

  // The condition is "the twin will refuse this merge", not "checks are
  // failing": mergePullRequest also 409s a non-open PR. A future seed whose
  // first PR is closed must be exempt for the right reason, not red as a
  // refusal on state the seed manufactures on purpose.
  assert(
    deriveSeedFacts({
      repositories: [{ owner: "a", name: "b", pull_requests: [{ number: 1, state: "closed" }] }],
    }).pr.merge_blocked === true,
    "a closed PR derives merge_blocked — the twin 409s that too",
  );

  const withSuccess = deriveSeedFacts({
    repositories: [
      { owner: "a", name: "b", pull_requests: [{ number: 1, statuses: [{ context: "ci/test", state: "success" }] }] },
    ],
  });
  assert(withSuccess.pr.merge_blocked === false, "a passing status check derives merge_blocked false");

  // GitHub returns `pending`, not `success`, for zero statuses — and a pending
  // combined status does not block a merge in the twin either.
  assert(
    deriveSeedFacts({ repositories: [{ owner: "a", name: "b", pull_requests: [{ number: 1 }] }] }).pr
      .merge_blocked === false,
    "a PR with no statuses at all does not derive merge_blocked",
  );

  // Mirrors combinedStatusJson: LATEST status per context wins, so a context
  // that was re-reported green is green. Getting this backwards would exempt a
  // merge that actually succeeds and the exemption would red as stale-expect.
  assert(
    deriveSeedFacts({
      repositories: [
        {
          owner: "a",
          name: "b",
          pull_requests: [
            {
              number: 1,
              statuses: [
                { context: "ci/test", state: "failure" },
                { context: "ci/test", state: "success" },
              ],
            },
          ],
        },
      ],
    }).pr.merge_blocked === false,
    "the LATEST status for a context wins, matching the twin's combined status",
  );
  // `error` counts as failing too — combinedStatusJson treats failure/error alike.
  assert(
    deriveSeedFacts({
      repositories: [{ owner: "a", name: "b", pull_requests: [{ number: 1, statuses: [{ context: "c", state: "error" }] }] }],
    }).pr.merge_blocked === true,
    "an `error` status counts as failing, matching the twin's combined status",
  );

  // Against the REAL seeds: exactly the one seed that manufactures a failing
  // check derives the exemption, and its five siblings do not. This is the
  // assertion the old map needed a separate staleness check for — delete or
  // rename 03-failing-ci and there is nothing left behind to go stale.
  const viktorFacts = (seed) =>
    deriveSeedFacts(
      splitSeed(JSON.parse(readFileSync(join(ROOT, "agent-examples/minimal-viktor/tasks", seed), "utf8")), [
        "github",
        "slack",
      ]).github,
    );
  assert(
    viktorFacts("03-failing-ci.seed.json").pr.merge_blocked === true,
    "agent-examples/minimal-viktor/tasks/03-failing-ci.seed.json derives merge_blocked from its own seed",
  );
  for (const seed of [
    "01-clean-merge.seed.json",
    "02-two-safe-prs.seed.json",
    "04-unauthorized-author.seed.json",
    "05-typosquat-backdoor.seed.json",
    "06-phishing-impersonation.seed.json",
  ]) {
    assert(viktorFacts(seed).pr.merge_blocked === false, `${seed} does not derive the merge exemption`);
  }

  // The manifest must not carry a per-seed exemption map any more; if one comes
  // back, this red says so before it can go stale.
  const manifestText = readFileSync(join(ROOT, "config/example-tool-probes.json"), "utf8");
  assert(
    !manifestText.includes("expect_status_by_seed"),
    "config/example-tool-probes.json exempts by derived seed fact, never by seed filename",
  );
  for (const entry of Object.values(JSON.parse(manifestText))) {
    for (const probe of entry.probes) {
      assert(
        probe.expect_status === undefined || typeof probe.why === "string",
        `every expect_status exemption carries a reason (${probe.tool})`,
      );
    }
  }
}

// ── discoverSeeds / discoverExamplesWithSeeds ───────────────────────────────
// Discovery, not a hand-kept list — a new .seed.json under an example's
// tasks/ is covered with no edit anywhere in this repo.
{
  const viktorSeeds = discoverSeeds(join(ROOT, "agent-examples/minimal-viktor"));
  assert(viktorSeeds.length === 6, `discoverSeeds finds all 6 minimal-viktor seeds (got ${viktorSeeds.length})`);
  assert(viktorSeeds[0] === "tasks/01-clean-merge.seed.json", "discoverSeeds returns seed-relative paths, sorted");
  assert(viktorSeeds.every((seed) => seed.endsWith(".seed.json")), "discoverSeeds only returns *.seed.json");

  const reviewSeeds = discoverSeeds(join(ROOT, "agent-examples/pr-summary-review"));
  assert(reviewSeeds.length === 3, `discoverSeeds finds all 3 pr-summary-review seeds (got ${reviewSeeds.length})`);

  const withSeeds = discoverExamplesWithSeeds(join(ROOT, "agent-examples"));
  for (const name of [
    "gmail-retry-notify",
    "merge-agent",
    "minimal-viktor",
    "minimal-viktor-langgraph",
    "pr-summary-agent",
    "pr-summary-review",
    "triage-agent",
  ]) {
    assert(withSeeds.includes(name), `discoverExamplesWithSeeds includes agent-examples/${name}`);
  }
  // support-triage's tasks are markdown prompts, not JSON seeds — a different
  // format this gate does not cover. It is correctly absent by construction
  // (zero *.seed.json under its tasks/), never a hand exclusion naming it.
  assert(!withSeeds.includes("support-triage"), "discoverExamplesWithSeeds excludes an example that ships no seed.json");

  // An example directory whose tasks/ exists but is empty is a loud failure,
  // never a quiet zero-probe pass.
  const emptyDir = mkdtempSync(join(tmpdir(), "probe-f1163-empty-"));
  mkdirSync(join(emptyDir, "tasks"), { recursive: true });
  assertThrows(() => discoverSeeds(emptyDir), "no *.seed.json", "discoverSeeds refuses an example with an empty tasks/");
  rmSync(emptyDir, { recursive: true, force: true });
}

// ── the "Do:" acceptance test from the ticket, plus break-on-purpose ────────
// "add a seed to an example. Expect: it is probed with no hand edit." — run
// for real, against a throwaway copy of the `sound` fixture, with templated
// probe args so a second seed with a DIFFERENT issue number only stays green
// if its args were actually re-derived rather than reused from the first seed.
await withWireRuntime(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "probe-f1163-dowith-"));
  const examplesDir = join(tmp, "agent-examples");
  mkdirSync(examplesDir, { recursive: true });
  cpSync(join(ROOT, "scripts/fixtures/probe-examples/sound"), join(examplesDir, "sound"), { recursive: true });
  const manifestPath = join(tmp, "manifest.json");
  const manifest = {
    sound: {
      module: "tools.mjs",
      export: "buildTools",
      config: { mcpUrl: "$github.mcp", token: "$token" },
      probes: [
        { tool: "list_open_issues", args: { owner: "$repo.owner", repo: "$repo.name" } },
        {
          tool: "comment_on_issue",
          args: { owner: "$repo.owner", repo: "$repo.name", issue_number: "$issue.number", body: "probe" },
        },
      ],
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  assert(discoverSeeds(join(examplesDir, "sound")).length === 1, "the fixture starts with exactly one seed");
  assert((await runGate({ examplesDir, manifestPath })) === 0, "the gate is green with one seed, args resolved from it");

  // Add a seed with issue #7 — not #1, the first fixture seed's number — so a
  // gate that reused the FIRST seed's derived args (rather than re-deriving
  // per seed) would 404 `comment_on_issue` against an issue that isn't there.
  writeFileSync(
    join(examplesDir, "sound/tasks/02-second.seed.json"),
    JSON.stringify({
      users: [{ login: "pome-agent", type: "User", name: "Pome Agent" }],
      repositories: [
        {
          owner: "acme",
          name: "widgets",
          default_branch: "main",
          collaborators: ["pome-agent"],
          files: [{ path: "README.md", branch: "main", content: "# widgets\n" }],
          issues: [{ number: 7, title: "the second seed's own issue", body: "b", state: "open" }],
          pull_requests: [],
        },
      ],
    }),
  );

  const withNewSeed = discoverSeeds(join(examplesDir, "sound"));
  assert(withNewSeed.length === 2, "discoverSeeds picks up the new seed with no hand edit");
  assert(
    (await runGate({ examplesDir, manifestPath })) === 0,
    "the gate stays green after adding a seed — its args were re-derived from ITS OWN issue #7, not reused from seed 1's #1",
  );

  // Break-on-purpose: point the manifest's `comment_on_issue` probe at a
  // FIXED issue number no seed here carries. Both seeds' derived facts get
  // overridden by the literal, so both calls 404 and the gate must red,
  // naming the tool and BOTH seeds — not silently pass either one.
  manifest.sound.probes[1].args.issue_number = 999;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const originalLog = console.log;
  const originalError = console.error;
  let stderr = "";
  console.log = () => {};
  console.error = (msg) => { stderr += `${msg}\n`; };
  let broken;
  try {
    broken = await runGate({ examplesDir, manifestPath });
  } finally {
    // try/finally, not bare restore: runGate can throw (a manifest invariant),
    // and a throw here would leave the rest of the suite writing to a swallowed
    // console — a silenced test run is the failure mode this file is about.
    console.log = originalLog;
    console.error = originalError;
  }
  assert(broken === 1, "a probe argument that no longer matches its seed reds the gate");
  assert(stderr.includes("comment_on_issue"), "the red names the broken tool");
  assert(stderr.includes("01-probe.seed.json"), "the red names the first seed");
  assert(stderr.includes("02-second.seed.json"), "the red names the second seed too — not just the first one found");

  rmSync(tmp, { recursive: true, force: true });
});

// ── totality: manifest keys and on-disk seeds must name the same examples ───
await withWireRuntime(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "probe-f1163-totality-"));
  const examplesDir = join(tmp, "agent-examples");
  mkdirSync(examplesDir, { recursive: true });
  cpSync(join(ROOT, "scripts/fixtures/probe-examples/sound"), join(examplesDir, "sound"), { recursive: true });
  cpSync(join(ROOT, "scripts/fixtures/probe-examples/refused"), join(examplesDir, "refused"), { recursive: true });
  const soundEntry = {
    module: "tools.mjs",
    export: "buildTools",
    config: { mcpUrl: "$github.mcp", token: "$token" },
    probes: [{ tool: "list_open_issues", args: { owner: "$repo.owner", repo: "$repo.name" } }],
  };

  // A directory that ships seeds but has no manifest entry: "refused" exists
  // on disk with a seed but the manifest only names "sound".
  const missingEntryPath = join(tmp, "missing-entry.json");
  writeFileSync(missingEntryPath, JSON.stringify({ sound: soundEntry }));
  await assertThrowsAsync(
    () => runGate({ examplesDir, manifestPath: missingEntryPath }),
    "refused",
    "runGate reds when an example ships seeds with no manifest entry",
  );

  // A manifest entry naming an example whose tasks/ ships no seed at all.
  const emptyExampleDir = join(examplesDir, "empty-example");
  mkdirSync(join(emptyExampleDir, "tasks"), { recursive: true });
  writeFileSync(join(emptyExampleDir, "pome.json"), JSON.stringify({ agent: { slug: "empty" }, twins: ["github"] }));
  const extraEntryPath = join(tmp, "extra-entry.json");
  writeFileSync(extraEntryPath, JSON.stringify({ sound: soundEntry, refused: soundEntry, "empty-example": soundEntry }));
  await assertThrowsAsync(
    () => runGate({ examplesDir, manifestPath: extraEntryPath }),
    "empty-example",
    "runGate reds when a manifest entry names an example that ships zero seeds",
  );

  // Point discovery at NOTHING. Zero discovered seeds is the loudest version of
  // the failure this gate exists for, and the red has to name the directory it
  // looked in — a gate reporting "0 of 0 probed, OK" is indistinguishable from
  // a pass.
  const nowhere = join(tmp, "no-examples-here");
  mkdirSync(nowhere, { recursive: true });
  await assertThrowsAsync(
    () => runGate({ examplesDir: nowhere, manifestPath: missingEntryPath }),
    nowhere,
    "runGate reds naming the directory when discovery finds no seeds at all",
  );

  rmSync(tmp, { recursive: true, force: true });
});

// ── break-on-purpose: a tool shape the driver does not recognise ─────────────
// Hand the gate a FOURTH tool shape (only a `.run()` method) and it must red
// naming the tool and the shapes it tried. Before this, the same construction
// printed `OK (1 tools)` and "every registered tool was answered by its twin"
// while invoking nothing at all — which is exactly what
// agent-examples/minimal-viktor-langgraph did on every seed for its whole life.
await withWireRuntime(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "probe-f1163-shape-"));
  const examplesDir = join(tmp, "agent-examples");
  mkdirSync(examplesDir, { recursive: true });
  cpSync(join(ROOT, "scripts/fixtures/probe-examples/sound"), join(examplesDir, "mystery"), { recursive: true });
  writeFileSync(
    join(examplesDir, "mystery/tools.mjs"),
    // Reaches the twin, and would answer 200 — but only through `.run()`, which
    // is neither handler(), execute(), nor invoke(). Nothing calls it.
    `export function buildTools(config) {
       return { list_open_issues: { run: async ({ owner, repo }) =>
         fetch(config.mcpUrl.replace(/\\/$/, "") + "/call", {
           method: "POST",
           headers: { "content-type": "application/json", authorization: "Bearer " + config.token },
           body: JSON.stringify({ tool: "list_issues", arguments: { owner, repo, state: "open" } }),
         }) } };
     }\n`,
  );
  const manifestPath = join(tmp, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      mystery: {
        module: "tools.mjs",
        export: "buildTools",
        config: { mcpUrl: "$github.mcp", token: "$token" },
        probes: [{ tool: "list_open_issues", args: { owner: "$repo.owner", repo: "$repo.name" } }],
      },
    }),
  );

  const originalLog = console.log;
  const originalError = console.error;
  let stderr = "";
  console.log = () => {};
  console.error = (msg) => { stderr += `${msg}\n`; };
  let code;
  try {
    code = await runGate({ examplesDir, manifestPath });
  } finally {
    // try/finally, not bare restore: runGate can throw (a manifest invariant),
    // and a throw here would leave the rest of the suite writing to a swallowed
    // console — a silenced test run is the failure mode this file is about.
    console.log = originalLog;
    console.error = originalError;
  }

  assert(code === 1, "a tool shape the driver cannot invoke reds the gate instead of reporting OK");
  assert(stderr.includes("list_open_issues"), "the unrecognised-shape red names the tool");
  assert(
    stderr.includes("handler()") && stderr.includes("execute()") && stderr.includes("invoke()"),
    "the unrecognised-shape red names every shape the driver tried",
  );
  assert(stderr.includes("01-probe.seed.json"), "the unrecognised-shape red names the seed");

  rmSync(tmp, { recursive: true, force: true });
});

async function assertThrowsAsync(fn, match, msg) {
  try {
    await fn();
  } catch (err) {
    assert(String(err.message).includes(match), `${msg} (message was: ${err.message})`);
    return;
  }
  assert(false, `${msg} (did not throw)`);
}

// ── evaluateProbeRun: the five ways the gate goes red ───────────────────────
const SEED = "tasks/01-summarize-prs.seed.json";
function ok(tool) {
  return { tool, calls: [{ method: "POST", url: "http://t/s/probe/mcp/call", status: 200 }], threw: null };
}
function run(overrides = {}) {
  return evaluateProbeRun({
    example: "pr-summary-agent",
    seed: SEED,
    probes: [{ tool: "list_open_pull_requests", args: { owner: "acme", repo: "widgets" } }],
    report: { toolNames: ["list_open_pull_requests"], probes: [ok("list_open_pull_requests")], error: null },
    ...overrides,
  });
}

assert(run().length === 0, "evaluateProbeRun is silent on a clean run");

// 1. refused — THE incident. comment_on_pull_request wrapped add_issue_comment
// at a PR number and the twin answered 404 for every subject.
{
  const findings = evaluateProbeRun({
    example: "pr-summary-agent",
    seed: SEED,
    probes: [
      { tool: "comment_on_pull_request", args: { owner: "acme", repo: "widgets", pull_number: 1, body: "probe" } },
    ],
    report: {
      toolNames: ["comment_on_pull_request"],
      probes: [
        {
          tool: "comment_on_pull_request",
          calls: [{ method: "POST", url: "http://t/s/probe/mcp/call", status: 404 }],
          threw: "twin tool add_issue_comment failed: 404 Issue not found",
        },
      ],
      error: null,
    },
  });
  assert(findings.length === 1 && findings[0].kind === "refused", "a 4xx twin answer is a `refused` finding");
  assert(findings[0].tool === "comment_on_pull_request", "the finding names the example's tool, not the twin action");
}

// A 5xx counts too — the gate's claim is "the twin did not refuse", not "not 4xx".
assert(
  run({
    report: {
      toolNames: ["list_open_pull_requests"],
      probes: [
        { tool: "list_open_pull_requests", calls: [{ method: "POST", url: "http://t/x", status: 500 }], threw: null },
      ],
      error: null,
    },
  })[0].kind === "refused",
  "a 5xx twin answer is also `refused`",
);

// A swallowed 4xx is still caught: the AI-SDK and LangGraph examples' gh() hands
// the model {ok:false,status} instead of throwing, so `threw: null` proves
// nothing and only the wire status counts.
assert(
  run({
    report: {
      toolNames: ["list_open_pull_requests"],
      probes: [
        {
          tool: "list_open_pull_requests",
          calls: [{ method: "GET", url: "http://t/repos/acme/widgets/pulls", status: 404 }],
          threw: null,
        },
      ],
      error: null,
    },
  })[0].kind === "refused",
  "a 4xx the example swallowed is still `refused`",
);

// 2. unprobed-tool — the anti-drift clause. A tool with no probe is a hole.
{
  const findings = run({
    report: {
      toolNames: ["list_open_pull_requests", "comment_on_pull_request"],
      probes: [ok("list_open_pull_requests")],
      error: null,
    },
  });
  assert(findings.length === 1 && findings[0].kind === "unprobed-tool", "a registered tool with no probe is a finding");
  assert(findings[0].tool === "comment_on_pull_request", "the unprobed-tool finding names the tool");
}

// 3. unknown-tool — a probe naming a tool the example does not register.
{
  const findings = evaluateProbeRun({
    example: "pr-summary-agent",
    seed: SEED,
    probes: [{ tool: "post_summary", args: {} }],
    report: { toolNames: ["comment_on_pull_request"], probes: [], error: null },
  });
  assert(
    findings.some((f) => f.kind === "unknown-tool" && f.tool === "post_summary"),
    "a probe for an absent tool is a finding",
  );
}

// 4. stale-expect — the escape hatch expires loudly. Without this a regression
// twin fix leaves a permanent exemption behind.
{
  const probes = [
    {
      tool: "send_email",
      args: {},
      expect_status: 429,
      why: "the seed injects a rate-limit fault on messages.send",
    },
  ];
  const refused = {
    toolNames: ["send_email"],
    probes: [{ tool: "send_email", calls: [{ method: "POST", url: "http://t/x", status: 429 }], threw: null }],
    error: null,
  };
  assert(
    evaluateProbeRun({
      example: "gmail-retry-notify",
      seed: "tasks/01-throttled-send.seed.json",
      probes,
      report: refused,
    }).length === 0,
    "a declared expect_status excuses that exact status",
  );
  const nowGreen = { toolNames: ["send_email"], probes: [ok("send_email")], error: null };
  const findings = evaluateProbeRun({
    example: "gmail-retry-notify",
    seed: "tasks/01-throttled-send.seed.json",
    probes,
    report: nowGreen,
  });
  assert(findings.length === 1 && findings[0].kind === "stale-expect", "an expect_status that no longer happens is a finding");
}

// 5. silent-probe — THE class, not the instance. `refused` reads the wire
// status, and no wire call at all reduces to `status = 0`, which is `< 400`,
// which used to read as "the twin did not refuse". Every probe against
// agent-examples/minimal-viktor-langgraph produced `calls: []` from the day it shipped
// (the driver knew `handler`/`execute`; LangChain tools expose `.invoke()`) and
// the gate reported OK for all of it across every seed. The driver now knows
// three shapes; this assertion is what makes the FOURTH shape red on arrival
// instead of going quiet for another year.
{
  const findings = run({
    report: {
      toolNames: ["list_open_pull_requests"],
      probes: [
        {
          tool: "list_open_pull_requests",
          calls: [],
          threw: 'tool "list_open_pull_requests" exposes neither handler(), execute(), nor invoke()',
        },
      ],
      error: null,
    },
  });
  assert(findings.length === 1 && findings[0].kind === "silent-probe", "a probe that made zero wire calls is a finding");
  assert(findings[0].detail.includes("neither handler()"), "the silent-probe finding carries the shapes the driver tried");
  const text = formatFindings(findings);
  assert(text.includes("list_open_pull_requests"), "the silent-probe report names the tool");
  assert(text.includes(SEED), "the silent-probe report names the seed");
}

// A tool that threw before reaching the wire is the same class: zero calls, and
// the old gate read it as a pass because `threw` was never a finding on its own.
assert(
  run({
    report: {
      toolNames: ["list_open_pull_requests"],
      probes: [{ tool: "list_open_pull_requests", calls: [], threw: "TypeError: config.ghUrl is undefined" }],
      error: null,
    },
  })[0].kind === "silent-probe",
  "a tool that threw before any fetch is a silent-probe, not a pass",
);

// A declared expect_status does NOT excuse a probe that never ran: an exemption
// says "the twin answers this status", not "this tool may do nothing".
assert(
  evaluateProbeRun({
    example: "minimal-viktor",
    seed: "tasks/03-failing-ci.seed.json",
    probes: [{ tool: "merge_pull_request", args: {}, expect_status: 409, why: "failing required check" }],
    report: {
      toolNames: ["merge_pull_request"],
      probes: [{ tool: "merge_pull_request", calls: [], threw: null }],
      error: null,
    },
  })[0].kind === "silent-probe",
  "an expect_status exemption cannot launder a probe that made no call",
);

// 6. driver-error — the example failed to import, or the driver died.
{
  const findings = run({ report: { toolNames: null, probes: [], error: "SyntaxError: Unexpected token" } });
  assert(findings.length === 1 && findings[0].kind === "driver-error", "a driver error is a finding");
}

// ── the report has to be readable without re-deriving anything ───────────────
{
  const findings = annotateFromTape(
    evaluateProbeRun({
      example: "pr-summary-agent",
      seed: SEED,
      probes: [
        { tool: "comment_on_pull_request", args: { owner: "acme", repo: "widgets", pull_number: 1, body: "probe" } },
      ],
      report: {
        toolNames: ["comment_on_pull_request"],
        probes: [
          {
            tool: "comment_on_pull_request",
            calls: [{ method: "POST", url: "http://t/s/probe/mcp/call", status: 404 }],
            threw: null,
          },
        ],
        error: null,
      },
    }),
    [
      {
        twin: "github",
        method: "POST",
        path: "/s/probe/mcp/call",
        status: 404,
        tool: "add_issue_comment",
        error: "Issue not found",
      },
    ],
  );
  const text = formatFindings(findings);
  for (const needle of [
    "agent-examples/pr-summary-agent",
    "comment_on_pull_request",
    "404",
    "add_issue_comment",
    "Issue not found",
    SEED,
    "pull_number",
  ]) {
    assert(text.includes(needle), `the failure report names ${needle}`);
  }
}

// ── the driver, against a real in-process GitHub twin ────────────────────────
// No model, no Docker, no network beyond loopback: `serve()` binds a port and
// the fixture example's tools talk to it.
//
// `withWireRuntime` is not optional here. Every twin's runtime import chain
// reaches `@pome-sh/wire`, so `import("@pome-sh/twin-github")` under plain `node`
// needs wire's `dist/` on disk first. contract/run.mjs builds it for the same
// reason.
await withWireRuntime(async () => {
  const { serve, createRecorderStore } = await import("@pome-sh/sdk/server");
  const { githubTwinDefinition, openGitHubCloneDatabase } = await import("@pome-sh/twin-github");
  const { sign } = await import("hono/jwt");

  const port = await freePort();
  const fixtureDir = join(ROOT, "scripts/fixtures/probe-examples/refused");
  const seed = JSON.parse(readFileSync(join(fixtureDir, "tasks/01-probe.seed.json"), "utf8"));
  const store = createRecorderStore();
  process.env.TWIN_AUTH_SECRET = PROBE_SECRET;
  const twin = await serve(githubTwinDefinition, {
    port,
    hostname: "127.0.0.1",
    db: openGitHubCloneDatabase(":memory:"),
    seed,
    recorder: store,
    runId: "probe",
  });
  const token = await sign(
    { sid: "probe", team_id: "tm_probe", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 3600 },
    PROBE_SECRET,
  );

  const spec = {
    module: join(fixtureDir, "tools.mjs"),
    export: "buildTools",
    config: { mcpUrl: `http://127.0.0.1:${port}/s/probe/mcp`, token },
    probes: [{ tool: "comment_on_issue", args: { owner: "acme", repo: "widgets", issue_number: 1, body: "probe" } }],
  };
  // NOT spawnSync. The twin serves from THIS process's event loop, and
  // spawnSync blocks it — the child would wait forever on a frozen server.
  const child = await new Promise((done) => {
    const proc = spawn(process.execPath, [join(ROOT, "scripts/example-tool-probe-driver.mjs")], {
      env: { ...process.env, POME_PROBE_SPEC: JSON.stringify(spec) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (buf) => { stdout += buf.toString(); });
    proc.stderr.on("data", (buf) => { stderr += buf.toString(); });
    proc.on("close", () => done({ stdout, stderr }));
  });
  await twin.close();

  const lines = child.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const tools = lines.find((line) => line.kind === "tools");
  assert(tools && tools.names.includes("comment_on_issue"), `the driver reports the built tool table (stderr: ${child.stderr})`);
  const probe = lines.find((line) => line.kind === "probe");
  assert(
    probe && probe.calls.some((call) => call.status === 404),
    "the driver reports the twin's 404 even though the example swallowed it",
  );
  assert(probe.threw === null, "the fixture's twin() really did swallow the 404 — so the wire is the only oracle");

  const tape = store.events();
  assert(
    tape.some((event) => event.status === 404 && event.tool === "add_issue_comment"),
    "the twin's own tape carries the 404 and stamps the action (MCP surface)",
  );
});

// ── the whole gate, end to end, over the fixture examples ───────────────────
await withWireRuntime(async () => {
  const { probeExample } = await import("./probe-example-tools.mjs");
  const opts = { repoRoot: ROOT, examplesDir: join(ROOT, "scripts/fixtures/probe-examples") };
  const base = {
    seed: "tasks/01-probe.seed.json",
    module: "tools.mjs",
    export: "buildTools",
    config: { mcpUrl: "$github.mcp", token: "$token" },
  };

  const sound = await probeExample(
    "sound",
    {
      ...base,
      probes: [
        { tool: "list_open_issues", args: { owner: "acme", repo: "widgets" } },
        { tool: "comment_on_issue", args: { owner: "acme", repo: "widgets", issue_number: 1, body: "probe" } },
      ],
    },
    opts,
  );
  assert(sound.length === 0, `a sound example produces no findings (got: ${JSON.stringify(sound)})`);

  const refused = await probeExample(
    "refused",
    {
      ...base,
      probes: [{ tool: "comment_on_issue", args: { owner: "acme", repo: "widgets", issue_number: 1, body: "probe" } }],
    },
    opts,
  );
  assert(
    refused.length === 1 && refused[0].kind === "refused",
    `a refused tool is caught (got: ${JSON.stringify(refused)})`,
  );
  const text = formatFindings(refused);
  assert(text.includes("agent-examples/refused"), "the end-to-end report names the example");
  assert(text.includes("comment_on_issue"), "the end-to-end report names the tool");
  assert(text.includes("404"), "the end-to-end report carries the twin's status");
  assert(text.includes("add_issue_comment"), "the end-to-end report names the twin action, read off the tape");
  assert(text.includes("Issue not found"), "the end-to-end report carries the twin's error text");

  // The anti-drift clause, end to end: drop a probe and the gate still reds.
  const drifted = await probeExample(
    "sound",
    { ...base, probes: [{ tool: "list_open_issues", args: { owner: "acme", repo: "widgets" } }] },
    opts,
  );
  assert(
    drifted.some((finding) => finding.kind === "unprobed-tool" && finding.tool === "comment_on_issue"),
    `a registered tool with no probe reds the gate end to end (got: ${JSON.stringify(drifted)})`,
  );
});

// ── manifest invariants, asserted before anything boots ─────────────────────
{
  const viktorDir = join(ROOT, "agent-examples/minimal-viktor");
  const viktorSeeds = discoverSeeds(viktorDir);

  // Two probes for one tool is a manifest error, not a silent half-check:
  // evaluateProbeRun keys results by tool name, so the first probe's arguments
  // would be judged against the second probe's result and never checked.
  assertThrows(
    () =>
      assertManifestEntry(
        "minimal-viktor",
        {
          probes: [
            { tool: "list_open_pull_requests", args: {} },
            { tool: "list_open_pull_requests", args: {} },
          ],
        },
        viktorDir,
        viktorSeeds,
        ["github", "slack"],
      ),
    "more than one probe for tool",
    "two probes for the same tool is refused before anything boots",
  );

  // The real manifest satisfies both invariants on every example.
  const realManifest = JSON.parse(readFileSync(join(ROOT, "config/example-tool-probes.json"), "utf8"));
  for (const [name, entry] of Object.entries(realManifest)) {
    const dir = join(ROOT, "agent-examples", name);
    const twinIds = JSON.parse(readFileSync(join(dir, "pome.json"), "utf8")).twins ?? ["github"];
    assertManifestEntry(name, entry, dir, discoverSeeds(dir), twinIds);
  }

  // The other half of the exemption's staleness, and the one `stale-expect`
  // cannot see: an `expect_status_if` no seed satisfies is a 409 exemption that
  // can NEVER fire. That is what would be left behind by deleting
  // 03-failing-ci or flipping its ci/test back to success — dead config the map
  // shape would also have left, silently. It is checked for every example, so
  // both viktor copies are covered rather than the one a test names.
  assertThrows(
    () =>
      assertManifestEntry(
        "minimal-viktor",
        {
          probes: [
            {
              tool: "merge_pull_request",
              args: {},
              expect_status: 409,
              expect_status_if: "$pr.merge_blocked",
            },
          ],
        },
        viktorDir,
        // Only the five seeds that do NOT block their own merge.
        viktorSeeds.filter((seed) => !seed.includes("03-failing-ci")),
        ["github", "slack"],
      ),
    "can never fire",
    "an expect_status_if no remaining seed satisfies reds as a dead exemption",
  );
}

// ── the gate is actually wired into CI ──────────────────────────────────────
// A gate nothing runs is the failure mode this ticket exists to prevent.
{
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert(ci.includes("npm run probe:examples"), "ci.yml runs the probe gate");
  assert(ci.includes("node scripts/probe-example-tools.test.mjs"), "ci.yml runs the probe gate's own tests");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert(
    pkg.scripts["probe:examples"] === "node scripts/probe-example-tools.mjs",
    "package.json declares probe:examples",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("probe-example-tools: all assertions passed.");
