#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for scripts/ci/fetch-pinned-release.sh and
// scripts/ci/assert-hardened-cdn-fetches.mjs (F-1489).
//
// Two halves, and the second is the one that matters. A gate that has only
// ever reported "all clear" on the tree it shipped with is a gate nobody has
// seen fail — the F-1230 grep-based coverage check was defeated three separate
// times by shapes its author was sure it caught. So every rule here is
// exercised against a PLANTED violation in a scratch `.github/workflows` tree
// and asserted to red, by name:
//
//   - a `run:` block curling a release CDN outside the hardened helper
//   - a fetch whose target the resolver cannot work out (must red, not pass)
//   - a `uses:` action with no row in the classification table
//   - a table row that contradicts itself, or an exemption with no residual
//   - a binary-installing action used as ONE step
//   - a repeated group whose LAST attempt is `continue-on-error` (fail-open)
//   - a repeated group whose attempts disagree on `with:` (the cosign-release
//     hazard) or on `uses:`
//   - a repeated group whose gating `if:` skips an earlier attempt
//   - the whole gate, end to end, over a scratch tree
//   - the vacuous-green dead guards
//
// The helper half drives the real shell script against a local server that
// 503s on demand: retry-then-succeed, exhaustion failing closed with the CDN
// HOST in the message, and a good download with a wrong sha256 still refused.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HELPER,
  MIN_ATTEMPTS,
  findFetchesInScript,
  findParseDisagreements,
  findTableDefects,
  findUnhardenedActionGroups,
  findUnhardenedRunFetches,
  findActionRefsByLine,
  hostOf,
  isLoopback,
  loadTable,
  main,
} from "./assert-hardened-cdn-fetches.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(HERE, "fetch-pinned-release.sh");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertNames(problems, needle, msg) {
  assert(
    problems.some((p) => p.includes(needle)),
    `${msg}\n  expected a problem naming ${JSON.stringify(needle)}, got:\n    ${problems.join("\n    ") || "(none)"}`,
  );
}

function withScratchRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "hardened-cdn-fetches-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "scripts", "ci"), { recursive: true });
  // main() refuses to run without the hardened path it points every workflow
  // at, so the scratch tree carries a stand-in.
  writeFileSync(join(root, HELPER), "#!/usr/bin/env bash\nexit 0\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const wf = (steps) => `name: planted
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

/** A step group in the shape the gate demands, so fixtures can perturb ONE thing. */
function goodGroup({ ref = "vendor/installer@aaaa", withBlock = "          pin: 'v1'", last = {} } = {}) {
  const attempt = (n, id, cond, escapable, block) =>
    `      - name: install ${n}
        id: ${id}
${cond ? `        if: \${{ ${cond} }}\n` : ""}        uses: ${ref}
${escapable ? "        continue-on-error: true\n" : ""}        with:
${block}`;
  return [
    attempt(1, "inst_1", null, true, withBlock),
    attempt(2, "inst_2", "steps.inst_1.outcome == 'failure'", true, withBlock),
    attempt(
      3,
      "inst_3",
      last.cond ?? "steps.inst_1.outcome == 'failure' && steps.inst_2.outcome == 'failure'",
      last.escapable ?? false,
      last.withBlock ?? withBlock,
    ),
  ].join("\n");
}

const TABLE = {
  actions: {
    "vendor/installer": {
      fetchesFromCdn: true,
      hardening: "repeat-attempts",
      why: "fixture: pulls a binary",
    },
    "vendor/inert": { fetchesFromCdn: false, hardening: "not-needed", why: "fixture: pulls nothing" },
  },
};

// ---------------------------------------------------------------------------
// Shape (a): remote fetches in `run:` blocks.
// ---------------------------------------------------------------------------

// PLANTED FAILURE — a raw curl at a release CDN. This is the shape the two
// hand-copied install loops had before F-1489, and the shape a third copy
// would have.
withScratchRoot(
  {
    "planted.yml": wf(`      - name: Install thing
        run: |
          set -euo pipefail
          curl -sSfL https://evil-cdn.example.com/thing/releases/download/v1/thing.tar.gz -o /tmp/thing.tar.gz`),
  },
  (root) => {
    const { problems } = findUnhardenedRunFetches(root);
    assertNames(problems, "evil-cdn.example.com", "a raw curl at a release CDN must red");
    assertNames(problems, "planted.yml", "the offending file must be named");
  },
);

// PLANTED FAILURE — the same fetch behind a variable the resolver cannot see
// (set from `env:` rather than in the block). An unresolvable target must be
// treated as REMOTE; the alternative is a gate that is silenced by an
// indirection.
withScratchRoot(
  {
    "planted.yml": wf(`      - name: Install thing
        env:
          TOOL_URL: https://evil-cdn.example.com/thing.tar.gz
        run: |
          curl -sSfL "$TOOL_URL" -o /tmp/thing.tar.gz`),
  },
  (root) => {
    const { problems } = findUnhardenedRunFetches(root);
    assertNames(problems, "unresolvable target", "a fetch the resolver cannot follow must red, not pass");
  },
);

// The same fetch routed through the hardened helper is clean.
withScratchRoot(
  {
    "ok.yml": wf(`      - name: Install thing
        run: |
          bash ${HELPER} thing "https://cdn.example.com/thing.tar.gz" "$SHA" /tmp/thing.tar.gz`),
  },
  (root) => {
    const { problems, hardened } = findUnhardenedRunFetches(root);
    assert(problems.length === 0, `the hardened path must not red: ${problems.join("; ")}`);
    assert(hardened.length === 1, "the helper call site must be counted for the dead guard");
  },
);

// A loopback health poll is not a CDN fetch and must not red — including the
// `:${port}` form, which a digits-only port strip reads as a remote host.
withScratchRoot(
  {
    "smoke.yml": wf(`      - name: Wait for healthz
        run: |
          curl -fsS http://127.0.0.1:3333/healthz >/dev/null 2>&1
          curl -fsS "http://127.0.0.1:\${port}/healthz" >/dev/null 2>&1
          curl -fsS "http://localhost:\${{ env.PORT }}/healthz" >/dev/null 2>&1`),
  },
  (root) => {
    const { problems } = findUnhardenedRunFetches(root);
    assert(problems.length === 0, `loopback polls must not red: ${problems.join("; ")}`);
  },
);

assert(isLoopback("http://127.0.0.1:${port}/x"), "an expansion in the port must not hide loopback");
assert(isLoopback("http://[::1]:8080/x"), "bracketed IPv6 loopback");
assert(!isLoopback("https://github.com/o/r/releases/download/v1/x.tar.gz"), "a release CDN is not loopback");
assert(hostOf("https://user@github.com:443/x") === "github.com", "userinfo and port are stripped");
assert(findFetchesInScript("echo curling is fine\n# curl https://x.example/y\n").length === 0, "prose is not a fetch");
assert(findFetchesInScript("wget https://x.example/y").length === 1, "wget counts");
assert(findFetchesInScript("gh release download v1 -R o/r").length === 1, "gh release download counts");

// ---------------------------------------------------------------------------
// Shape (b): the classification table.
// ---------------------------------------------------------------------------

// PLANTED FAILURE — a brand new binary-installing action lands and nobody
// classifies it. This is the "a new one that does not reds CI" property.
withScratchRoot(
  {
    "planted.yml": wf(`      - uses: brandnew/tool-installer@0123456789abcdef0123456789abcdef01234567 # v1.2.3`),
  },
  (root) => {
    const problems = findTableDefects(TABLE, findActionRefsByLine(root));
    assertNames(problems, "brandnew/tool-installer", "an unclassified action must red");
    assertNames(problems, "cdn-fetch-actions.json", "the message must say where to classify it");
  },
);

// Rows that contradict themselves, and an exemption with no residual.
{
  const problems = findTableDefects(
    {
      actions: {
        "a/lies": { fetchesFromCdn: true, hardening: "not-needed", why: "x" },
        "b/decorates": { fetchesFromCdn: false, hardening: "repeat-attempts", why: "x" },
        "c/silent": { fetchesFromCdn: true, hardening: "step-is-the-check", why: "x" },
        "d/unexplained": { fetchesFromCdn: false, hardening: "not-needed", why: "  " },
        "e/nonsense": { fetchesFromCdn: true, hardening: "sprinkle-hope", why: "x" },
      },
    },
    new Map(),
  );
  assertNames(problems, "a/lies", "fetches-from-CDN + not-needed must red");
  assertNames(problems, "b/decorates", "hardening on a row that fetches nothing must red");
  assertNames(problems, "residual", "step-is-the-check with no residual must red");
  assertNames(problems, "d/unexplained", "an empty `why` must red");
  assertNames(problems, "e/nonsense", "an unknown hardening value must red");
}

// The shipped table must itself be internally consistent — the gate's own
// input is not exempt from the gate's own rules.
assert(findTableDefects(loadTable(), new Map()).length === 0, "scripts/ci/cdn-fetch-actions.json is inconsistent");

// ---------------------------------------------------------------------------
// Shape (b): the repeated-attempt group.
// ---------------------------------------------------------------------------

assert(MIN_ATTEMPTS === 3, "the F-1494 pattern is 2 escapable attempts + 1 fatal one");

// PLANTED FAILURE — the exact state twin-image.yml's syft step was in.
withScratchRoot(
  { "planted.yml": wf(`      - uses: vendor/installer@aaaa\n        with:\n          pin: 'v1'`) },
  (root) => {
    const { problems } = findUnhardenedActionGroups(root, TABLE);
    assertNames(problems, "appears 1 time(s)", "a single-step binary install must red");
    assertNames(problems, "dies on the first 5xx", "the message must say why one step is not enough");
  },
);

// PLANTED FAILURE — three attempts, but the last one can be escaped. That is
// fail-OPEN: a permanently dead CDN would let an unsigned image through.
withScratchRoot({ "planted.yml": wf(goodGroup({ last: { escapable: true } })) }, (root) => {
  const { problems } = findUnhardenedActionGroups(root, TABLE);
  assertNames(problems, "LAST vendor/installer attempt is `continue-on-error: true`", "a fail-open group must red");
});

// PLANTED FAILURE — the cosign-release hazard: one copy drifts off the pin.
withScratchRoot(
  { "planted.yml": wf(goodGroup({ last: { withBlock: "          pin: 'v3'" } })) },
  (root) => {
    const { problems } = findUnhardenedActionGroups(root, TABLE);
    assertNames(problems, "disagree on their `with:` inputs", "attempts with different inputs must red");
    assertNames(problems, "cosign-release", "the message must name the hazard it exists for");
  },
);

// PLANTED FAILURE — one attempt pinned to a different build of the action.
withScratchRoot(
  {
    "planted.yml": wf(
      goodGroup().replace("      - name: install 3\n        id: inst_3", "      - name: install 3\n        id: inst_3").replace(
        /uses: vendor\/installer@aaaa\n(?![\s\S]*uses: vendor)/,
        "uses: vendor/installer@bbbb\n",
      ),
    ),
  },
  (root) => {
    const { problems } = findUnhardenedActionGroups(root, TABLE);
    assertNames(problems, "disagree on `uses:`", "attempts on different pins must red");
  },
);

// PLANTED FAILURE — attempt 3 gates only on attempt 2. Attempt 2 is SKIPPED
// when attempt 1 succeeded, and a skipped step's outcome is `skipped`, never
// `failure` — so this chain looks right and never fires.
withScratchRoot(
  { "planted.yml": wf(goodGroup({ last: { cond: "steps.inst_2.outcome == 'failure'" } })) },
  (root) => {
    const { problems } = findUnhardenedActionGroups(root, TABLE);
    assertNames(problems, "steps.inst_1.outcome == 'failure'", "a chain skipping an earlier attempt must red");
  },
);

// The shape the gate demands is clean, and an unclassified-but-inert action
// alongside it does not manufacture a group.
withScratchRoot({ "ok.yml": wf(`${goodGroup()}\n      - uses: vendor/inert@cccc`) }, (root) => {
  const { problems, groups } = findUnhardenedActionGroups(root, TABLE);
  assert(problems.length === 0, `the correct shape must not red: ${problems.join("; ")}`);
  assert(groups.length === 1, `expected exactly one group, got ${groups.join(", ")}`);
  const { missed, extra } = findParseDisagreements(root);
  assert(missed.length === 0 && extra.length === 0, `the two reads disagree: ${missed} / ${extra}`);
});

// ---------------------------------------------------------------------------
// The whole gate, end to end.
// ---------------------------------------------------------------------------

function mainThrows(files, table, needle, msg) {
  withScratchRoot(files, (root) => {
    let err = null;
    try {
      main(root, table);
    } catch (e) {
      err = e;
    }
    assert(err !== null, `${msg} — main() returned instead of throwing`);
    assert(err.message.includes(needle), `${msg}\n  expected ${JSON.stringify(needle)} in:\n${err.message}`);
  });
}

// A tree that is otherwise correct, plus one planted raw curl.
mainThrows(
  {
    "ok.yml": wf(
      `${goodGroup()}\n      - name: Install thing\n        run: |\n          bash ${HELPER} thing "https://cdn.example.com/t.tgz" "$SHA" /tmp/t.tgz`,
    ),
    "planted.yml": wf(`      - name: Install other\n        run: |\n          curl -sSfL https://evil-cdn.example.com/o.tgz -o /tmp/o.tgz`),
  },
  TABLE,
  "evil-cdn.example.com",
  "the assembled gate must red on a planted raw fetch",
);

// Dead guards: a tree with a correct group but nothing using the hardened
// helper means shape (a) checked nothing, and must refuse to report green.
mainThrows({ "ok.yml": wf(goodGroup()) }, TABLE, "Refusing to report a vacuous green", "no helper call site must red");

// A tree whose actions are all inert means the repeated-attempt half checked
// nothing.
mainThrows(
  {
    "ok.yml": wf(
      `      - uses: vendor/inert@cccc\n      - name: Install thing\n        run: |\n          bash ${HELPER} thing "https://cdn.example.com/t.tgz" "$SHA" /tmp/t.tgz`,
    ),
  },
  TABLE,
  "vacuous green",
  "no CDN-fetching action must red",
);

// ---------------------------------------------------------------------------
// scripts/ci/fetch-pinned-release.sh itself.
// ---------------------------------------------------------------------------

const BODY = "pretend binary\n";
const GOOD_SHA = createHash("sha256").update(BODY).digest("hex");

// Deliberately `spawn` + await, NOT spawnSync: the 503 server below lives in
// THIS process, and spawnSync blocks the event loop, so curl would connect,
// wait for a response node cannot deliver until the child exits, and deadlock
// until --max-time. That is a two-minute hang per case with no useful output.
function runHelper(url, sha, { attempts = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fetch-pinned-release-"));
  const dest = join(dir, "artifact");
  const child = spawn("bash", [HELPER_PATH, "fixture-tool", url, sha, dest], {
    env: {
      ...process.env,
      FETCH_PINNED_RELEASE_ATTEMPTS: String(attempts),
      FETCH_PINNED_RELEASE_SLEEP_UNIT: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolvePromise) => {
    child.on("close", (status) => {
      let content = null;
      try {
        content = readFileSync(dest, "utf8");
      } catch {
        /* the fetch never landed; that is the assertion's business, not ours */
      }
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ status, stdout, stderr, content });
    });
  });
}

const failuresLeft = { "/flaky": 2 };
const server = createServer((req, res) => {
  const path = req.url ?? "/";
  if (path === "/always503") {
    res.writeHead(503).end("degraded");
    return;
  }
  if (path === "/flaky" && failuresLeft["/flaky"] > 0) {
    failuresLeft["/flaky"] -= 1;
    res.writeHead(503).end("degraded");
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" }).end(BODY);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // A transient 5xx cannot fail the fetch on the first attempt — F-1489's
  // first done-when, measured rather than asserted in a comment.
  const flaky = await runHelper(`${base}/flaky`, GOOD_SHA);
  assert(flaky.status === 0, `two 503s then a 200 must succeed, got ${flaky.status}\n${flaky.stderr}`);
  assert(flaky.content === BODY, "the retried fetch must land the real bytes");
  assert(
    `${flaky.stdout}`.includes("only on attempt 3"),
    `a flaky-but-passing run must SAY so, got: ${flaky.stdout}`,
  );

  // A genuinely unavailable CDN fails closed, naming what could not be
  // fetched and from where — not `exit code 1`.
  const dead = await runHelper(`${base}/always503`, GOOD_SHA, { attempts: 2 });
  assert(dead.status !== 0, "a permanently 503ing CDN must fail closed");
  assert(dead.stderr.includes("::error::"), "the failure must be an annotated error");
  assert(dead.stderr.includes("fixture-tool"), "the message must name the tool");
  assert(dead.stderr.includes("127.0.0.1"), "the message must name the CDN host that would not answer");
  assert(dead.stderr.includes("after 2 attempts"), "the message must say how many attempts were spent");
  assert(dead.stderr.includes("Failing closed"), "the message must say the refusal is deliberate");

  // The verification is unconditional: a perfectly successful download with
  // the wrong hash is still refused. A hash checked with `|| true` would pass
  // this one.
  const wrong = await runHelper(`${base}/ok`, "0".repeat(64));
  assert(wrong.status !== 0, "a sha256 mismatch must fail the fetch");
  assert(wrong.stderr.includes("sha256 mismatch"), `expected a named mismatch, got: ${wrong.stderr}`);
  assert(wrong.stderr.includes(GOOD_SHA), "the mismatch message must show what was actually fetched");

  const ok = await runHelper(`${base}/ok`, GOOD_SHA);
  assert(ok.status === 0, `a good fetch must pass: ${ok.stderr}`);
  assert(ok.stdout.includes("verified sha256"), "a passing fetch must say it verified");
} finally {
  server.close();
}

console.log("assert-hardened-cdn-fetches.test.mjs: all assertions passed");
