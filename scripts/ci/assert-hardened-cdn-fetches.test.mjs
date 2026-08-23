#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for scripts/ci/fetch-pinned-release.sh and
// scripts/ci/assert-hardened-cdn-fetches.mjs.
//
// Two halves, and the second is the one that matters. A gate that has only
// ever reported "all clear" on the tree it shipped with is a gate nobody has
// seen fail — an earlier grep-based coverage check was defeated three separate
// times by shapes its author was sure it caught. So every rule here is
// exercised against a PLANTED violation in a scratch `.github/workflows` tree
// and asserted to red, by name:
//
//   - a `run:` block curling a release CDN outside the hardened helper
//   - a fetch whose target the resolver cannot work out (must red, not pass)
//   - a `run:` block writing to a container registry outside the hardened push
//     helper, and a registry READ that must NOT red
//   - a `run:` block invoking cosign outside the hardened sign helper,
//     the READ subcommands included — unlike shape (c), a failed read here
//     happens AFTER publication
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
// The helper half drives all three real shell scripts. `fetch-pinned-release.sh`
// runs against a local server that 503s on demand: retry-then-succeed,
// exhaustion failing closed with the CDN HOST in the message, and a good
// download with a wrong sha256 still refused. `push-scanned-image.sh` runs
// against a fake `docker` that reproduces the observed GHCR answer — every layer
// `Pushed`, then `unknown blob` — and, separately, a push that exits 0 while
// the manifest is never committed. `sign-image-digests.sh` runs against a fake
// `cosign` that reproduces the signing failure — `DENIED: denied` off the GHCR token
// endpoint, injectable per subcommand, so the case that actually happened (both
// tags pushed, signed and attested, dead on `verify-attestation`'s READ) is a
// fixture rather than a paragraph.
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
  PUSH_HELPER,
  SIGN_HELPER,
  findFetchesInScript,
  findParseDisagreements,
  findRegistryWritesInScript,
  findSigningCallsInScript,
  findTableDefects,
  findUnhardenedActionGroups,
  findUnhardenedRegistryWrites,
  findUnhardenedRunFetches,
  findUnhardenedSigningCalls,
  findActionRefsByLine,
  hostOf,
  isLoopback,
  loadTable,
  main,
} from "./assert-hardened-cdn-fetches.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(HERE, "fetch-pinned-release.sh");
const PUSH_HELPER_PATH = join(HERE, "push-scanned-image.sh");
const SIGN_HELPER_PATH = join(HERE, "sign-image-digests.sh");

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
  // main() refuses to run without the hardened paths it points every workflow
  // at, so the scratch tree carries a stand-in for each.
  writeFileSync(join(root, HELPER), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(root, PUSH_HELPER), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(root, SIGN_HELPER), "#!/usr/bin/env bash\nexit 0\n");
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
// hand-copied install loops had before the ladder landed, and the shape a third copy
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
// Shape (c): registry WRITES in `run:` blocks.
//
// `Push scanned image` was one bare `docker push` with no retry, sitting
// between two `uses:` installs that had both been given three-attempt ladders.
// On 2026-08-14 GHCR answered `unknown blob` after every
// layer had reported `Pushed`, the stripe leg died, and `stripe-bbf27bf` did
// not exist — which failed four consecutive twin-snapshot-verify runs and
// opened pome-cloud#752, because nothing re-ran that step for four days.
// ---------------------------------------------------------------------------

// PLANTED FAILURE — the exact shape twin-image.yml's push step had.
withScratchRoot(
  {
    "planted.yml": wf(`      - name: Push scanned image
        run: |
          printf '%s\\n' "$TAGS" | while IFS= read -r tag; do
            docker push "$tag"
          done`),
  },
  (root) => {
    const { problems } = findUnhardenedRegistryWrites(root);
    assertNames(problems, "docker push", "an unretried registry write must red");
    assertNames(problems, PUSH_HELPER, "the message must say where the hardened path is");
    assertNames(problems, "planted.yml", "the offending file must be named");
  },
);

// PLANTED FAILURE — the other two ways a workflow commits a manifest to a
// registry. Naming only `docker push` would leave a gate that a one-line
// rewrite walks around.
withScratchRoot(
  {
    "planted.yml": wf(`      - name: Fan out
        run: |
          docker manifest push ghcr.io/o/r:v1
          docker buildx imagetools create -t ghcr.io/o/r:v1 ghcr.io/o/r@sha256:aa`),
  },
  (root) => {
    const { problems } = findUnhardenedRegistryWrites(root);
    assertNames(problems, "docker manifest push", "a manifest push is a registry write");
    assertNames(problems, "imagetools create", "a manifest-list write is a registry write");
  },
);

// A registry READ is not a write. `docker buildx imagetools inspect` is the
// exact call pome-cloud's resolve-image-digest.ts makes and the one
// sign-image-digests.sh makes per tag; a gate that red on it would be a gate
// someone deletes.
withScratchRoot(
  {
    "reads.yml": wf(`      - name: Look, do not touch
        run: |
          docker pull ghcr.io/o/r:v1
          docker buildx imagetools inspect ghcr.io/o/r:v1 --format '{{.Manifest.Digest}}'`),
  },
  (root) => {
    const { problems } = findUnhardenedRegistryWrites(root);
    assert(problems.length === 0, `a registry read must not red: ${problems.join("; ")}`);
  },
);

// The same push routed through the hardened helper is clean, and counts for
// the dead guard below.
withScratchRoot(
  {
    "ok.yml": wf(`      - name: Push scanned image
        env:
          IMAGE_TAGS: \${{ steps.meta.outputs.tags }}
        run: bash ${PUSH_HELPER}`),
  },
  (root) => {
    const { problems, hardened } = findUnhardenedRegistryWrites(root);
    assert(problems.length === 0, `the hardened push path must not red: ${problems.join("; ")}`);
    assert(hardened.length === 1, "the helper call site must be counted for the dead guard");
  },
);

assert(findRegistryWritesInScript("# docker push ghcr.io/o/r:v1\n").length === 0, "a commented-out push is not a push");
assert(findRegistryWritesInScript("echo 'docker pushes images'").length === 0, "prose is not a push");
assert(findRegistryWritesInScript("docker push ghcr.io/o/r:v1").length === 1, "a bare push counts");

// ---------------------------------------------------------------------------
// Shape (d): cosign calls in `run:` blocks.
//
// With shapes (a) and (c) closed, the sign/attest/verify step was the last
// unretried GHCR interaction on the publish path — a single step at
// twin-image.yml:344 with no attempt siblings, sitting between an SBOM fetch
// and a cosign install that both have three-attempt ladders. On 2026-08-18 a
// degraded GHCR answered `DENIED: denied` off its token endpoint and killed the
// stripe leg of run 32144441622 on `verify-attestation` — AFTER both tags were
// pushed, signed and attested. A red job over a correct, published artifact.
// ---------------------------------------------------------------------------

// PLANTED FAILURE — the WRITE half, inline. This is the shape the sign step
// had before the signing leg was hardened.
withScratchRoot(
  {
    "planted.yml": wf(`      - name: Sign pushed image digests
        run: |
          cosign sign --yes "$REF"
          cosign attest --yes --predicate sbom.json --type spdx "$REF"`),
  },
  (root) => {
    const { problems } = findUnhardenedSigningCalls(root);
    assertNames(problems, "cosign sign", "an unretried cosign sign must red");
    assertNames(problems, "cosign attest", "an unretried cosign attest must red");
    assertNames(problems, SIGN_HELPER, "the message must say where the hardened path is");
    assertNames(problems, "planted.yml", "the offending file must be named");
  },
);

// PLANTED FAILURE — the READ half. This is the one that separates shape (d)
// from shape (c), where reads are deliberately exempt: a `docker pull` that
// fails publishes nothing, but `cosign verify-attestation` runs AFTER the push
// step has published every tag, so its failure reds a job over an artifact that
// is already public. A shape (d) that copied (c)'s exemption would miss the
// exact call that broke.
withScratchRoot(
  {
    "planted.yml": wf(`      - name: Verify what we signed
        run: |
          cosign verify --certificate-oidc-issuer "$ISSUER" "$REF" >/dev/null
          cosign verify-attestation --type spdx "$REF" >/dev/null`),
  },
  (root) => {
    const { problems } = findUnhardenedSigningCalls(root);
    assertNames(problems, "cosign verify", "an unretried cosign verify must red");
    assertNames(problems, "cosign verify-attestation", "the call that actually broke must red");
    assertNames(
      problems,
      "already published",
      "the message must say why a READ is in scope here when it is not in shape (c)",
    );
  },
);

// The same signing routed through the hardened helper is clean, and counts for
// the dead guard below.
withScratchRoot(
  {
    "ok.yml": wf(`      - name: Sign pushed image digests
        env:
          IMAGE_TAGS: \${{ steps.meta.outputs.tags }}
        run: |
          bash ${SIGN_HELPER} "Signed digests" twin.spdx.json`),
  },
  (root) => {
    const { problems, hardened } = findUnhardenedSigningCalls(root);
    assert(problems.length === 0, `the hardened sign path must not red: ${problems.join("; ")}`);
    assert(hardened.length === 1, "the helper call site must be counted for the dead guard");
  },
);

assert(findSigningCallsInScript("# cosign sign --yes $REF\n").length === 0, "a commented-out sign is not a sign");
assert(findSigningCallsInScript("echo 'cosign signs digests'").length === 0, "prose is not a sign");
assert(findSigningCallsInScript("cosign sign --yes $REF").length === 1, "a bare sign counts");
// Every cosign subcommand in this tree reaches GHCR, so the finder is not a
// list of the four the sign script happens to run today: `cosign copy` is a
// registry-to-registry write and `cosign triangulate` a read, and a shape (d)
// that enumerated subcommands would be walked around by either.
assert(findSigningCallsInScript("cosign copy ghcr.io/o/r:v1 ghcr.io/o/r:v2").length === 1, "copy counts");
assert(findSigningCallsInScript("cosign triangulate ghcr.io/o/r:v1").length === 1, "triangulate counts");

// `cosign` is also an English word in this tree, which `docker push` is not:
// twin-image.yml's install ladder annotates all three attempts with an `echo`
// naming the binary. A prefix rule like shape (a)'s and (c)'s reads those two
// lines as unhardened invocations and reds the repo on its own prose — measured,
// not imagined: it did, on the first run of this gate.
for (const prose of [
  `echo "::warning::cosign install attempt 1 failed. sigstore/cosign-installer fetches cosign from github.com/sigstore/cosign/releases"`,
  `echo "::error::could not install cosign after 3 attempts. sigstore/cosign-installer fetches the pinned cosign v2.6.4 binary from the sigstore release CDN"`,
]) {
  assert(findSigningCallsInScript(prose).length === 0, `an echo naming cosign is not a cosign call: ${prose}`);
}

// …and the positions a REAL call hides in are still calls, so the tightening
// above did not buy its precision by going blind.
assert(findSigningCallsInScript('if cosign verify "$REF"; then :; fi').length === 1, "a guarded call counts");
assert(findSigningCallsInScript('out="$(cosign triangulate "$REF")"').length === 1, "a substituted call counts");
assert(findSigningCallsInScript("COSIGN_EXPERIMENTAL=1 cosign sign $REF").length === 1, "an assignment prefix counts");
assert(findSigningCallsInScript("docker build . && cosign sign $REF").length === 1, "a call after && counts");

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

assert(MIN_ATTEMPTS === 3, "the retry pattern is 2 escapable attempts + 1 fatal one");

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
      // Only the LAST attempt's pin is moved: the negative lookahead makes the
      // regex bind to the final `uses:` in the group, so the group disagrees
      // with itself rather than being uniformly on a different pin.
      goodGroup().replace(
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

// One call site per hardened path, so a fixture that is meant to red on ONE
// planted violation is not instead answered by a dead guard.
const HARDENED_STEPS = `      - name: Install thing
        run: |
          bash ${HELPER} thing "https://cdn.example.com/t.tgz" "$SHA" /tmp/t.tgz
      - name: Push scanned image
        run: bash ${PUSH_HELPER}
      - name: Sign pushed image digests
        run: bash ${SIGN_HELPER} "Signed digests" twin.spdx.json`;

// A tree that is otherwise correct, plus one planted raw curl.
mainThrows(
  {
    "ok.yml": wf(`${goodGroup()}\n${HARDENED_STEPS}`),
    "planted.yml": wf(`      - name: Install other\n        run: |\n          curl -sSfL https://evil-cdn.example.com/o.tgz -o /tmp/o.tgz`),
  },
  TABLE,
  "evil-cdn.example.com",
  "the assembled gate must red on a planted raw fetch",
);

// The same, for shape (c): an unretried registry write must reach the assembled
// gate, not just the finder.
mainThrows(
  {
    "ok.yml": wf(`${goodGroup()}\n${HARDENED_STEPS}`),
    "planted.yml": wf(`      - name: Publish\n        run: |\n          docker push ghcr.io/o/r:v1`),
  },
  TABLE,
  "docker push ghcr.io/o/r:v1",
  "the assembled gate must red on a planted raw registry write",
);

// The same, for shape (d): an inline cosign call must reach the assembled gate.
mainThrows(
  {
    "ok.yml": wf(`${goodGroup()}\n${HARDENED_STEPS}`),
    "planted.yml": wf(`      - name: Sign\n        run: |\n          cosign sign --yes ghcr.io/o/r@sha256:aa`),
  },
  TABLE,
  "cosign sign --yes ghcr.io/o/r@sha256:aa",
  "the assembled gate must red on a planted inline cosign call",
);

// Dead guards: a tree with a correct group but nothing using the hardened
// helper means shape (a) checked nothing, and must refuse to report green.
mainThrows({ "ok.yml": wf(goodGroup()) }, TABLE, "Refusing to report a vacuous green", "no helper call site must red");

// The same guard for shape (c): if no workflow pushes an image through the
// hardened path, the registry-write half checked nothing.
mainThrows(
  {
    "ok.yml": wf(
      `${goodGroup()}\n      - name: Install thing\n        run: |\n          bash ${HELPER} thing "https://cdn.example.com/t.tgz" "$SHA" /tmp/t.tgz\n      - name: Sign\n        run: bash ${SIGN_HELPER} "t" t.json`,
    ),
  },
  TABLE,
  PUSH_HELPER,
  "no hardened registry-write call site must red",
);

// And for shape (d): with the sign step deleted rather than hardened, the
// signing half checked nothing. This is the guard that keeps that fix from
// being quietly reverted into a green gate.
mainThrows(
  {
    "ok.yml": wf(
      `${goodGroup()}\n      - name: Install thing\n        run: |\n          bash ${HELPER} thing "https://cdn.example.com/t.tgz" "$SHA" /tmp/t.tgz\n      - name: Push scanned image\n        run: bash ${PUSH_HELPER}`,
    ),
  },
  TABLE,
  SIGN_HELPER,
  "no hardened signing call site must red",
);

// A tree whose actions are all inert means the repeated-attempt half checked
// nothing.
mainThrows(
  {
    "ok.yml": wf(`      - uses: vendor/inert@cccc\n${HARDENED_STEPS}`),
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
  // A transient 5xx cannot fail the fetch on the first attempt — the ladder's
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

// ---------------------------------------------------------------------------
// scripts/ci/push-scanned-image.sh itself.
//
// Driven against a fake `docker` on PATH rather than a real registry: the
// failure to reproduce is GHCR accepting every layer and then refusing the
// manifest PUT, which no local registry offers on demand. State lives in files
// so the counters survive the separate `docker` invocations one retry ladder
// makes.
// ---------------------------------------------------------------------------

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_DOCKER_STATE:?}"
# take <file> — succeeds (and spends one) while that file's budget is positive.
take() {
  n=0
  if [ -f "$1" ]; then n="$(cat "$1")"; fi
  if [ "$n" -gt 0 ]; then printf '%s' "$((n - 1))" > "$1"; return 0; fi
  return 1
}
if [ "\${1:-}" = "push" ]; then
  tag="$2"
  slug="\${tag//[^A-Za-z0-9]/_}"
  echo "$tag" >> "\${state}/pushes"
  echo "5f70bf18a086: Pushed"
  if take "\${state}/pushfail_\${slug}"; then
    # The observed answer from GHCR: every layer reports Pushed, then the manifest
    # PUT is refused because the registry cannot see a blob it just accepted.
    echo "unknown blob" >&2
    exit 1
  fi
  # A push that exits 0 having committed nothing is the other half of the same
  # fault, and the one a bare exit-code check cannot see.
  if ! take "\${state}/nomanifest_\${slug}"; then
    : > "\${state}/manifest_\${slug}"
  fi
  exit 0
fi
if [ "\${1:-}" = "buildx" ] && [ "\${2:-}" = "imagetools" ] && [ "\${3:-}" = "inspect" ]; then
  tag="$4"
  slug="\${tag//[^A-Za-z0-9]/_}"
  echo "$tag" >> "\${state}/inspects"
  # A degraded GHCR refuses the manifest READ as readily as the manifest PUT —
  # A \`DENIED: denied\` off the token endpoint arrives here too. Only the
  # sign suite below sets this budget; the push cases above leave it unset,
  # where \`take\` on a missing file is a no-op.
  if take "\${state}/inspectfail_\${slug}"; then
    echo "ERROR: GET https://ghcr.io/token?scope=repository:pome-sh/twins:pull&service=ghcr.io: DENIED: denied" >&2
    exit 1
  fi
  if [ -f "\${state}/manifest_\${slug}" ]; then
    echo "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    exit 0
  fi
  # The literal shape resolve-image-digest.ts reports on the tag that was never
  # committed.
  echo "ERROR: \${tag}: not found" >&2
  exit 1
fi
echo "fake docker: unexpected invocation: $*" >&2
exit 127
`;

// Asserted against as part of a whole sentence the script emits, never as a bare
// `stderr.includes("ghcr.io")`: the latter is the weaker assertion (the host
// appearing anywhere satisfies it, including in a tag the script merely echoed)
// and CodeQL reads it as `js/incomplete-url-substring-sanitization`, which is a
// false positive here but a fair complaint about the assertion.
const REGISTRY = "ghcr.io";
const ROLLING = `${REGISTRY}/pome-sh/twins:stripe`;
// The per-commit tag docker/metadata-action emits LAST, and the one
// pome-cloud's resolve-image-digest.ts looks up.
const PER_COMMIT = `${REGISTRY}/pome-sh/twins:stripe-bbf27bf`;

/**
 * The clause of a fail-closed message that lists what DID land, or "" when the
 * script printed no such clause.
 *
 * Needed because the two real tags are prefix-related — `…:stripe` is a
 * substring of `…:stripe-bbf27bf` — so a bare
 * `stderr.includes(ROLLING)` is satisfied by the FAILING tag being named and
 * passes with the landed list deleted outright. Measured: deleting it from
 * either helper left this suite green until this split was introduced.
 */
const landedClause = (stderr, label) => stderr.split(label)[1] ?? "";

function runPush(tags, plan = {}, { attempts = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "push-scanned-image-"));
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  for (const [tag, spec] of Object.entries(plan)) {
    const slug = tag.replace(/[^A-Za-z0-9]/g, "_");
    if (spec.pushFailures) writeFileSync(join(state, `pushfail_${slug}`), String(spec.pushFailures));
    if (spec.manifestMisses) writeFileSync(join(state, `nomanifest_${slug}`), String(spec.manifestMisses));
  }
  const child = spawn("bash", [PUSH_HELPER_PATH], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IMAGE_TAGS: tags,
      FAKE_DOCKER_STATE: state,
      // `attempts: null` leaves the knob unset, which is how the case below
      // measures the PRODUCTION budget rather than one the test chose.
      ...(attempts === null ? {} : { PUSH_SCANNED_IMAGE_ATTEMPTS: String(attempts) }),
      PUSH_SCANNED_IMAGE_SLEEP_UNIT: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolvePromise) => {
    child.on("close", (status) => {
      let pushes = [];
      try {
        pushes = readFileSync(join(state, "pushes"), "utf8").split("\n").filter(Boolean);
      } catch {
        /* nothing was pushed; that is the assertion's business, not ours */
      }
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ status, stdout, stderr, pushes });
    });
  });
}

// The PRODUCTION retry budget, pinned. Every other case here passes its own
// `attempts`, so on its own this suite would stay green with the default
// silently cut to 1 — which is the state the incident was reporting. Measured by
// leaving the knob unset: four faults must be survivable and the fifth must not.
{
  const survives = await runPush(PER_COMMIT, { [PER_COMMIT]: { pushFailures: 4 } }, { attempts: null });
  assert(survives.status === 0, `the default budget must survive 4 faults, got ${survives.status}`);
  assert(survives.pushes.length === 5, `4 faults then a good push is 5 attempts, got ${survives.pushes.length}`);
  const exhausts = await runPush(PER_COMMIT, { [PER_COMMIT]: { pushFailures: 5 } }, { attempts: null });
  assert(exhausts.status !== 0, "the default budget must be spent by 5 faults, not open-ended");
  assert(exhausts.stderr.includes("after 5 attempts"), `expected a 5-attempt budget, got: ${exhausts.stderr}`);
}

// The first done-when, measured rather than asserted in a comment: a
// single `unknown blob` no longer fails the leg.
{
  const flaky = await runPush(`${ROLLING}\n${PER_COMMIT}`, { [PER_COMMIT]: { pushFailures: 1 } });
  assert(flaky.status === 0, `one \`unknown blob\` then a good push must succeed, got ${flaky.status}\n${flaky.stderr}`);
  assert(
    flaky.pushes.filter((t) => t === PER_COMMIT).length === 2,
    `the failed tag must be pushed again, got ${flaky.pushes.join(", ")}`,
  );
  assert(
    `${flaky.stdout}${flaky.stderr}`.includes("only on attempt 2"),
    `a flaky-but-passing push must SAY so, got: ${flaky.stdout}${flaky.stderr}`,
  );
  assert(
    flaky.stdout.includes(`published and verified 2 tag(s) to ${REGISTRY}`),
    `a passing push must say what it published and where, got: ${flaky.stdout}`,
  );
}

// A push that exits 0 while the registry commits no manifest is the fault an
// exit-code check cannot see — and the one that would hand the sign step a tag
// that resolves to nothing. It must count as a failed attempt and be retried.
{
  const late = await runPush(PER_COMMIT, { [PER_COMMIT]: { manifestMisses: 1 } });
  assert(late.status === 0, `a manifest committed on the retry must pass, got ${late.status}\n${late.stderr}`);
  assert(late.pushes.length === 2, `the uncommitted push must be retried, got ${late.pushes.join(", ")}`);
}

// The two faults are NOT reported as one. Both end in "this tag does not
// resolve", and the retry treats them the same — but the run log has to say
// which happened, because "the registry refused the manifest" is a re-run and
// "the push exited 0 and committed nothing" is a read of the code. Collapsing
// them (`docker push || true`, and let the read-back decide) keeps every other
// assertion here green while destroying that distinction.
// Keyed on the SCRIPT's own words, never on `unknown blob` — the fake docker
// prints that itself, so an assertion on it would pass no matter what this
// script concluded.
{
  const refused = await runPush(PER_COMMIT, { [PER_COMMIT]: { pushFailures: 1 } });
  assert(
    refused.stderr.includes("exited non-zero"),
    `a push the registry refused must be named as such, got: ${refused.stderr}`,
  );
  const uncommitted = await runPush(PER_COMMIT, { [PER_COMMIT]: { manifestMisses: 1 } });
  assert(
    uncommitted.stderr.includes("exited 0"),
    `a push that committed nothing must be named as such, got: ${uncommitted.stderr}`,
  );
  assert(
    !uncommitted.stderr.includes("exited non-zero"),
    `the two faults must not share one message, got: ${uncommitted.stderr}`,
  );
}

// The second done-when. A registry that never commits fails the step, by
// name — and the per-commit tag pome-cloud resolves is left absent, which is
// the "reports not found rather than resolving a partial manifest" half.
{
  const dead = await runPush(PER_COMMIT, { [PER_COMMIT]: { pushFailures: 99 } }, { attempts: 2 });
  assert(dead.status !== 0, "a registry that never accepts the manifest must fail the step");
  assert(dead.stderr.includes("::error::"), "the failure must be an annotated error");
  assert(dead.stderr.includes(PER_COMMIT), "the message must name the tag that could not be published");
  assert(
    dead.stderr.includes(`to ${REGISTRY} after 2 attempts`),
    `the message must name the registry that would not answer, got: ${dead.stderr}`,
  );
  assert(dead.stderr.includes("after 2 attempts"), "the message must say how many attempts were spent");
  assert(dead.stderr.includes("Failing closed"), "the message must say the refusal is deliberate");
  assert(dead.pushes.length === 2, `exactly the attempt budget must be spent, got ${dead.pushes.join(", ")}`);
}

// The half-published case, which is the reason the per-commit tag is pushed
// LAST. When an earlier tag exhausts its attempts the script must STOP: pushing
// on would publish a per-commit tag whose predecessor never landed, and that
// tag is the one pome-cloud resolves and pome-cloud's gate expects to be
// signed. The tags that DID land are named, because the sign/attest step never
// runs after this failure — so they are published and unsigned.
{
  const partial = await runPush(`${ROLLING}\n${PER_COMMIT}`, { [ROLLING]: { pushFailures: 99 } }, { attempts: 2 });
  assert(partial.status !== 0, "an exhausted tag must fail the step");
  assert(
    !partial.pushes.includes(PER_COMMIT),
    `no tag may be pushed after an exhausted one, got ${partial.pushes.join(", ")}`,
  );
}

{
  const partial = await runPush(
    `${ROLLING}\n${PER_COMMIT}`,
    { [PER_COMMIT]: { pushFailures: 99 } },
    { attempts: 2 },
  );
  assert(partial.status !== 0, "an exhausted tag must fail the step");
  assert(
    /not signed|unsigned/i.test(partial.stderr),
    `the message must say the landed tag is unsigned, got: ${partial.stderr}`,
  );
  assert(
    landedClause(partial.stderr, "Already published and NOT signed").includes(ROLLING),
    `the message must name the tag that DID land, in the landed clause, got: ${partial.stderr}`,
  );
}

// A push of zero tags is not a successful push. `steps.meta.outputs.tags` is
// empty on a metadata-action misconfiguration, and an empty loop exits 0 —
// which reads as "published" while nothing was. Asserted in both shapes,
// because they are refused by two different guards: an empty variable never
// enters the loop, while a variable holding only blank lines enters it and
// pushes nothing.
for (const [label, tags] of [
  ["empty", ""],
  ["blank lines only", "\n \n"],
]) {
  const none = await runPush(tags);
  assert(none.status !== 0, `a ${label} IMAGE_TAGS must fail rather than read as a publish`);
  assert(none.stderr.includes("IMAGE_TAGS"), `the ${label} message must name the input, got: ${none.stderr}`);
  assert(none.pushes.length === 0, "nothing may be pushed when there is nothing to push");
}

// The ordinary case: every tag lands, each is verified to resolve, and the run
// log records the digest — the same digest pome-cloud will resolve.
{
  const ok = await runPush(`${ROLLING}\n\n${PER_COMMIT}\n`);
  assert(ok.status === 0, `a clean push must pass: ${ok.stderr}`);
  assert(
    ok.pushes.join(",") === `${ROLLING},${PER_COMMIT}`,
    `every tag must be pushed once, in order, got ${ok.pushes.join(", ")}`,
  );
  assert(ok.stdout.includes("sha256:1111"), "the resolved digest must reach the run log");
  assert(!/::warning::/.test(`${ok.stdout}${ok.stderr}`), "a clean push must not warn about degradation");
}

// ---------------------------------------------------------------------------
// scripts/ci/sign-image-digests.sh itself.
//
// Driven against a fake `cosign` alongside the fake `docker` above. The fault
// to reproduce is a registry that authenticates fine for one call and answers
// `DENIED: denied` for the next, which no local registry offers on demand —
// and which, unlike the push fault, strikes AFTER every tag is public.
// ---------------------------------------------------------------------------

const FAKE_COSIGN = `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_COSIGN_STATE:?}"
op="\${1:?}"
# cosign always takes the image ref LAST, on every subcommand this script runs.
for ref in "$@"; do :; done
tag="\${ref%@*}"
slug="\${tag//[^A-Za-z0-9]/_}"
echo "\${op} \${ref}" >> "\${state}/cosign"
take() {
  n=0
  if [ -f "$1" ]; then n="$(cat "$1")"; fi
  if [ "$n" -gt 0 ]; then printf '%s' "$((n - 1))" > "$1"; return 0; fi
  return 1
}
if take "\${state}/cosignfail_\${op}_\${slug}"; then
  # Verbatim from run 32144441622 on 2026-08-18, the stripe leg. Both tags were
  # pushed, signed and attested before this answer arrived on the READ.
  echo "Error: GET https://ghcr.io/token?scope=repository:pome-sh/twins:pull&service=ghcr.io: DENIED: denied" >&2
  exit 1
fi
exit 0
`;

const SIGN_OPS = ["sign", "attest", "verify", "verify-attestation"];

/**
 * `plan` is keyed by TAG, like runPush's — `{ [tag]: { inspect, sign, attest,
 * verify, "verify-attestation" } }`, each a count of consecutive faults. Keyed
 * per tag rather than per subcommand so the half-verified case below can fault
 * the SECOND tag only, which is the state the fail-closed message has to
 * describe.
 */
function runSign(tags, plan = {}, { attempts = 3, sbom = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sign-image-digests-"));
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "cosign"), FAKE_COSIGN, { mode: 0o755 });
  const sbomFile = join(dir, "twin.spdx.json");
  if (sbom) writeFileSync(sbomFile, "{}\n");
  const output = join(dir, "github_output");
  const summary = join(dir, "github_step_summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  // Every tag reaching this script has already been pushed AND read back by
  // push-scanned-image.sh, so its manifest exists unless a case says otherwise.
  for (const tag of tags.split("\n").map((t) => t.trim()).filter(Boolean)) {
    writeFileSync(join(state, `manifest_${tag.replace(/[^A-Za-z0-9]/g, "_")}`), "");
  }
  for (const [tag, spec] of Object.entries(plan)) {
    const slug = tag.replace(/[^A-Za-z0-9]/g, "_");
    if (spec.inspect) writeFileSync(join(state, `inspectfail_${slug}`), String(spec.inspect));
    for (const op of SIGN_OPS) {
      if (spec[op]) writeFileSync(join(state, `cosignfail_${op}_${slug}`), String(spec[op]));
    }
  }
  const child = spawn("bash", [SIGN_HELPER_PATH, "Signed twin-stripe image digests", sbomFile], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IMAGE_TAGS: tags,
      GITHUB_REPOSITORY: "pome-sh/digital-twins",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      FAKE_DOCKER_STATE: state,
      FAKE_COSIGN_STATE: state,
      // `attempts: null` leaves the knob unset, which is how the case below
      // measures the PRODUCTION budget rather than one the test chose.
      ...(attempts === null ? {} : { SIGN_IMAGE_DIGESTS_ATTEMPTS: String(attempts) }),
      SIGN_IMAGE_DIGESTS_SLEEP_UNIT: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolvePromise) => {
    child.on("close", (status) => {
      const read = (p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return "";
        }
      };
      const calls = read(join(state, "cosign")).split("\n").filter(Boolean);
      const inspects = read(join(state, "inspects")).split("\n").filter(Boolean);
      const result = { status, stdout, stderr, calls, inspects, output: read(output), summary: read(summary) };
      rmSync(dir, { recursive: true, force: true });
      resolvePromise(result);
    });
  });
}

const opsFor = (calls, ref) => calls.filter((c) => c.endsWith(` ${ref}`)).map((c) => c.split(" ")[0]);

// The PRODUCTION retry budget, pinned — the same guard runPush carries, for the
// same reason: every other case here passes its own `attempts`, so the default
// could be cut to 1 with this suite still green. It must also be the SAME
// budget as push-scanned-image.sh's, so the publish path has one number.
{
  const survives = await runSign(PER_COMMIT, { [PER_COMMIT]: { "verify-attestation": 4 } }, { attempts: null });
  assert(survives.status === 0, `the default budget must survive 4 faults, got ${survives.status}\n${survives.stderr}`);
  const exhausts = await runSign(PER_COMMIT, { [PER_COMMIT]: { "verify-attestation": 5 } }, { attempts: null });
  assert(exhausts.status !== 0, "the default budget must be spent by 5 faults, not open-ended");
  assert(exhausts.stderr.includes("after 5 attempts"), `expected a 5-attempt budget, got: ${exhausts.stderr}`);
  // …and the SAME budget, read out of both scripts. The publish path having one
  // number to reason about is a claim both headers make; two knobs is exactly
  // how that claim rots.
  const knob = (path, name) => new RegExp(`\\$\\{${name}:-(\\d+)\\}`).exec(readFileSync(path, "utf8"))?.[1] ?? null;
  for (const [what, sign, push] of [
    ["attempt budget", "SIGN_IMAGE_DIGESTS_ATTEMPTS", "PUSH_SCANNED_IMAGE_ATTEMPTS"],
    ["backoff unit", "SIGN_IMAGE_DIGESTS_SLEEP_UNIT", "PUSH_SCANNED_IMAGE_SLEEP_UNIT"],
  ]) {
    const a = knob(SIGN_HELPER_PATH, sign);
    const b = knob(PUSH_HELPER_PATH, push);
    assert(a !== null && a === b, `the sign and push ${what} must be one number, got ${a} vs ${b}`);
  }
}

// The signing leg's first done-when, one case per GHCR interaction the script makes. A
// `DENIED` on ANY of them is the registry being degraded, not a verdict about
// the artifact, so none may fail the leg on the first answer.
for (const op of SIGN_OPS) {
  const flaky = await runSign(PER_COMMIT, { [PER_COMMIT]: { [op]: 1 } });
  assert(flaky.status === 0, `one DENIED on \`cosign ${op}\` must not fail the leg, got ${flaky.status}\n${flaky.stderr}`);
  const ops = opsFor(flaky.calls, `${PER_COMMIT}@sha256:1111111111111111111111111111111111111111111111111111111111111111`);
  assert(
    ops.filter((o) => o === op).length === 2,
    `\`cosign ${op}\` must be retried, got ${ops.join(", ")}`,
  );
  // Keyed on the "landed only on attempt N" line specifically, not on any
  // `::warning::`: the retry itself warns before sleeping, so a bare
  // `/::warning::/` stays green with the succeeded-late notice deleted — and
  // that notice is the whole signal that GHCR is degrading before the day it
  // is total, which is how the incident went unnoticed for four days.
  assert(
    `${flaky.stdout}${flaky.stderr}`.includes("landed only on attempt 2"),
    `a flaky-but-passing \`cosign ${op}\` must SAY so, got: ${flaky.stdout}${flaky.stderr}`,
  );
}

// The digest READ is a GHCR interaction too, and the first one this script
// makes — an unretried `imagetools inspect` would fail the leg before cosign
// is ever reached, leaving the retry ladder below it unreachable.
{
  const flaky = await runSign(PER_COMMIT, { [PER_COMMIT]: { inspect: 1 } });
  assert(flaky.status === 0, `one DENIED on the digest read must not fail the leg, got ${flaky.status}\n${flaky.stderr}`);
  assert(flaky.inspects.length === 2, `the digest read must be retried, got ${flaky.inspects.join(", ")}`);
}

// The signing leg's second done-when. Exhaustion still fails closed — but by the time
// anything here fails, push-scanned-image.sh has already published every tag,
// so the message has to say which operation ran out, on which ref, and what
// state that leaves public. `##[error]The process failed with exit code 1` is
// exactly the message that made 2026-08-18 read like a broken twin.
{
  const dead = await runSign(PER_COMMIT, { [PER_COMMIT]: { "verify-attestation": 99 } }, { attempts: 2 });
  assert(dead.status !== 0, "a registry that never answers the verify must fail the step");
  assert(dead.stderr.includes("::error::"), "the failure must be an annotated error");
  assert(dead.stderr.includes(PER_COMMIT), "the message must name the ref that could not be verified");
  assert(dead.stderr.includes("verify-attestation"), "the message must name the operation that ran out");
  assert(dead.stderr.includes("after 2 attempts"), "the message must say how many attempts were spent");
  assert(dead.stderr.includes("Failing closed"), "the message must say the refusal is deliberate");
  assert(
    /already published/i.test(dead.stderr),
    `the message must say the tag is already public — that is the whole difference from a push failure, got: ${dead.stderr}`,
  );
  assert(
    opsFor(dead.calls, `${PER_COMMIT}@sha256:1111111111111111111111111111111111111111111111111111111111111111`).filter(
      (o) => o === "verify-attestation",
    ).length === 2,
    "exactly the attempt budget must be spent",
  );
}

// "Names what landed", measured. Two tags, the second unverifiable: the first
// is signed, attested AND verified, and a human reading this failure has to
// know that — re-running is safe, and the twin is not broken.
{
  const partial = await runSign(
    `${ROLLING}\n${PER_COMMIT}`,
    { [PER_COMMIT]: { "verify-attestation": 99 } },
    { attempts: 2 },
  );
  assert(partial.status !== 0, "an exhausted operation must fail the step");
  assert(
    partial.stderr.includes("signed") && partial.stderr.includes("attested"),
    `the message must say how far the failing ref got, got: ${partial.stderr}`,
  );
  // `${ROLLING}@` and not `${ROLLING}`: the failing ref is `…:stripe-bbf27bf@…`,
  // which contains `…:stripe` but not `…:stripe@`.
  assert(
    landedClause(partial.stderr, "Signed, attested and verified:").includes(`${ROLLING}@`),
    `the message must name the ref that IS fully verified, in the landed clause, got: ${partial.stderr}`,
  );
}

// The distinct partial states are not collapsed into one word. A ref that could
// not be SIGNED is published-and-unsigned; a ref that could not be VERIFIED is
// published, signed and attested. Those are different re-run decisions, and a
// message that said "not signed" for both would misdirect on the one that
// actually happens.
{
  const unsigned = await runSign(PER_COMMIT, { [PER_COMMIT]: { sign: 99 } }, { attempts: 2 });
  assert(/not.{0,20}signed|unsigned/i.test(unsigned.stderr), `a ref that never signed must say so, got: ${unsigned.stderr}`);
  const unverified = await runSign(PER_COMMIT, { [PER_COMMIT]: { "verify-attestation": 99 } }, { attempts: 2 });
  assert(
    /signed and attested/i.test(unverified.stderr),
    `a ref that signed and attested but could not verify must say so, got: ${unverified.stderr}`,
  );
  assert(
    !/unsigned/i.test(unverified.stderr),
    `a signed ref must not be reported as unsigned, got: ${unverified.stderr}`,
  );
}

// An empty IMAGE_TAGS is refused rather than read as a signing of zero refs —
// the same guard push-scanned-image.sh carries, for the same reason.
for (const [label, tags] of [
  ["empty", ""],
  ["blank lines only", "\n \n"],
]) {
  const none = await runSign(tags);
  assert(none.status !== 0, `a ${label} IMAGE_TAGS must fail rather than read as a signing`);
  assert(none.calls.length === 0, "nothing may be signed when there is nothing to sign");
}

// A CRLF-flavoured tag list is signed as the tags the registry knows, not as
// `<tag>\r`. Untrimmed, a whitespace bug of OURS spends the full ladder — five
// attempts and 50s of backoff per operation — and then fails closed blaming a
// degraded GHCR, which is the most expensive possible way to be wrong.
{
  const crlf = await runSign(`${ROLLING}\r\n${PER_COMMIT}\r`);
  assert(crlf.status === 0, `a CRLF tag list must sign cleanly, got ${crlf.status}\n${crlf.stderr}`);
  const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  assert(
    opsFor(crlf.calls, `${ROLLING}@${digest}`).join(",") === SIGN_OPS.join(","),
    `the trimmed ref must be the one signed, got ${crlf.calls.join(" | ")}`,
  );
  assert(!/::warning::/.test(`${crlf.stdout}${crlf.stderr}`), "a trimmed tag must not cost a retry");
}

// A missing SBOM predicate is refused before anything is signed: an attestation
// over a file that is not there is not an attestation.
{
  const noSbom = await runSign(PER_COMMIT, {}, { sbom: false });
  assert(noSbom.status !== 0, "a missing SBOM predicate must fail the step");
  assert(noSbom.calls.length === 0, "nothing may be signed without the predicate");
}

// The ordinary case: every ref is signed, attested and both-ways verified
// exactly once, the digests reach `signed_digests` for the step that consumes
// them, and a clean run does not cry degradation.
{
  const ok = await runSign(`${ROLLING}\n\n${PER_COMMIT}\n`);
  assert(ok.status === 0, `a clean sign must pass: ${ok.stderr}`);
  const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  for (const tag of [ROLLING, PER_COMMIT]) {
    assert(
      opsFor(ok.calls, `${tag}@${digest}`).join(",") === SIGN_OPS.join(","),
      `${tag} must be signed, attested and verified once each, got ${opsFor(ok.calls, `${tag}@${digest}`).join(", ")}`,
    );
  }
  assert(ok.output.includes(`${PER_COMMIT}@${digest}`), `the signed digest must reach GITHUB_OUTPUT, got: ${ok.output}`);
  assert(ok.summary.includes(`${ROLLING}@${digest}`), `the run summary must list what was signed, got: ${ok.summary}`);
  assert(!/::warning::/.test(`${ok.stdout}${ok.stderr}`), "a clean sign must not warn about degradation");
}

console.log("assert-hardened-cdn-fetches.test.mjs: all assertions passed");
