#!/usr/bin/env node
/**
 * Regression coverage for scripts/ci/decide-publish.sh (F-949).
 *
 * Mocks `npm` on PATH so every registry answer is exercised without a network:
 * unpublished (E404 ⇒ publish from a 0.0.0 baseline), unchanged (skip), ahead
 * (publish), BEHIND (hard fail — the floor check that stops retagging `latest`
 * backwards), and 401/403/5xx (hard fail — an auth or transport error must
 * never be read as "nothing published yet", which would bypass the floor
 * check). The 401 case is the one GitHub Packages actually produces for a
 * package that exists but the token cannot read, so it is the reason this
 * distinction is load-bearing rather than theoretical.
 *
 * Also asserts the registry argument is passed through as `--registry` for the
 * GitHub Packages caller and NOT passed for the npmjs callers, and that
 * release.yml wires the jobs up so a GitHub Packages failure cannot block the
 * two npmjs publishes.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/decide-publish.sh");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

/**
 * Run decide-publish.sh with a mocked npm.
 * `answer` is a bash snippet that stands in for `npm view`'s behaviour.
 */
function run({ answer, localVersion, registry }) {
  const dir = mkdtempSync(join(tmpdir(), "decide-publish-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: localVersion }));
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(dir, "argv.txt")}"\n${answer}\n`,
    );
    chmodSync(npm, 0o755);

    const githubOutput = join(dir, "github-output.txt");
    writeFileSync(githubOutput, "");
    const result = spawnSync(
      "bash",
      [SCRIPT, "@pome-sh/thing", "manifest.json", "thing", ...(registry ? [registry] : [])],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: githubOutput },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      output: readFileSync(githubOutput, "utf8").trim(),
      argv: readFileSync(join(dir, "argv.txt"), "utf8").trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const E404 = `echo "npm error code E404" >&2
echo 'npm error 404 Not Found - GET https://npm.pkg.github.com/@pome-sh%2fthing - npm package "thing" does not exist under owner "pome-sh"' >&2
exit 1`;
const E401 = `echo "npm error code E401" >&2
echo "npm error 401 Unauthorized - GET https://npm.pkg.github.com/@pome-sh%2fthing" >&2
exit 1`;
const E403 = `echo "npm error code E403" >&2
echo "npm error 403 Forbidden - GET https://npm.pkg.github.com/@pome-sh%2fthing" >&2
exit 1`;
const SERVER_ERROR = `echo "npm error code E500" >&2
echo "npm error 500 Internal Server Error" >&2
exit 1`;

console.log("decide-publish.sh");

// A package the registry has never seen must publish, not fail. This is the
// first-ever-publish path for @pome-sh/wire on GitHub Packages.
{
  const r = run({ answer: E404, localVersion: "0.2.1" });
  check("E404 (never published) ⇒ publishes from a 0.0.0 baseline", r.status === 0 && r.output === "thing=true", `status=${r.status} output=${r.output}`);
  check("E404 reports the 0.0.0 baseline in the log", r.stdout.includes("0.0.0"), r.stdout);
}

// Unchanged ⇒ skip.
{
  const r = run({ answer: `echo "0.2.1"`, localVersion: "0.2.1" });
  check("same version ⇒ skip", r.status === 0 && r.output === "thing=false", `status=${r.status} output=${r.output}`);
}

// Ahead ⇒ publish.
{
  const r = run({ answer: `echo "0.2.0"`, localVersion: "0.2.1" });
  check("local ahead of registry ⇒ publish", r.status === 0 && r.output === "thing=true", `status=${r.status} output=${r.output}`);
}

// Behind ⇒ hard fail. Publishing would retag `latest` backwards.
{
  const r = run({ answer: `echo "9.9.9"`, localVersion: "0.2.1" });
  check("local BEHIND registry ⇒ hard fail", r.status !== 0, `status=${r.status}`);
  check("behind-fail writes no output (job must not proceed)", r.output === "", `output=${r.output}`);
  check("behind-fail explains the retag risk", r.stdout.includes("retag latest backwards"), r.stdout);
}

// Multi-digit ordering: `sort -V` must not compare 0.2.10 as lower than 0.2.9.
{
  const r = run({ answer: `echo "0.2.9"`, localVersion: "0.2.10" });
  check("0.2.10 counts as ahead of 0.2.9 (version sort, not lexical)", r.status === 0 && r.output === "thing=true", `status=${r.status} output=${r.output}`);
}

// Auth / transport failures must NOT be read as "unpublished".
for (const [label, answer] of [
  ["401 (GitHub Packages, token cannot read an existing package)", E401],
  ["403", E403],
  ["500", SERVER_ERROR],
]) {
  const r = run({ answer, localVersion: "0.2.1" });
  check(`${label} ⇒ hard fail, never a 0.0.0 baseline`, r.status !== 0 && r.output === "", `status=${r.status} output=${r.output}`);
  check(`${label} does not claim "unchanged" or publish`, !r.output.includes("true"), r.output);
}

// The registry argument must reach npm as --registry, and must be absent for npmjs.
{
  const gh = run({ answer: `echo "0.2.0"`, localVersion: "0.2.1", registry: "https://npm.pkg.github.com" });
  check(
    "registry argument is passed as --registry",
    gh.argv.includes("--registry https://npm.pkg.github.com"),
    gh.argv,
  );
  const npmjs = run({ answer: `echo "0.2.0"`, localVersion: "0.2.1" });
  check("no registry argument ⇒ npm's default registry, no --registry flag", !npmjs.argv.includes("--registry"), npmjs.argv);
}

// Argument validation.
{
  const dir = mkdtempSync(join(tmpdir(), "decide-publish-args-"));
  try {
    const r = spawnSync("bash", [SCRIPT, "only-one-arg"], { cwd: dir, encoding: "utf8" });
    check("too few arguments ⇒ usage error", r.status === 2, `status=${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The wiring assertion: a GitHub Packages outage must not block the npmjs
// publishes. `publish` depends on `plan` (npmjs only) and `publish-wire` on
// `plan-wire` (GitHub Packages only) — never the other way round.
console.log("\nrelease.yml wiring");
{
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const jobOf = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    if (start === -1) return "";
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n  \w[\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  const plan = jobOf("plan");
  const planWire = jobOf("plan-wire");
  const publish = jobOf("publish");
  const publishWire = jobOf("publish-wire");

  // A regex rather than `.includes("npm.pkg.github.com")`: this is a text
  // search over workflow YAML, not URL-host validation, and the `.includes`
  // spelling trips CodeQL's js/incomplete-url-substring-sanitization heuristic
  // — which is a real bug pattern when you are checking an actual URL, and a
  // false positive here. Saying it as a pattern match says what it is.
  const READS_GITHUB_PACKAGES = /npm\.pkg\.github\.com/;

  check("all four jobs exist", [plan, planWire, publish, publishWire].every(Boolean));
  check(
    "plan (npmjs) does not read GitHub Packages",
    !READS_GITHUB_PACKAGES.test(plan),
    "a GitHub Packages read in `plan` would let a GH outage block the npmjs publishes",
  );
  check("plan-wire reads GitHub Packages", READS_GITHUB_PACKAGES.test(planWire));
  check("publish needs plan only", /needs:\s*plan\s*$/m.test(publish) && !publish.includes("plan-wire"));
  check("publish-wire needs plan-wire only", publishWire.includes("needs: plan-wire"));
  // Inspect the actual publish command line, not the surrounding prose — the
  // comments above it legitimately mention both `--access public` and npmjs.
  const wirePublishCommand = publishWire
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("npm publish"));
  check("publish-wire has an `npm publish` command", Boolean(wirePublishCommand), publishWire);
  check(
    "publish-wire publishes to GitHub Packages explicitly (belt and braces with publishConfig)",
    wirePublishCommand?.includes("--registry https://npm.pkg.github.com"),
    wirePublishCommand,
  );
  check(
    "publish-wire never passes --access public (not a GitHub Packages concept)",
    !wirePublishCommand?.includes("--access"),
    wirePublishCommand,
  );
  check(
    "publish-wire publishes only the wire workspace",
    wirePublishCommand?.includes("-w @pome-sh/wire"),
    wirePublishCommand,
  );
  check("plan-wire has packages: read", planWire.includes("packages: read"));
  check("publish-wire has packages: write", publishWire.includes("packages: write"));

  // F-1520 — the dispatch that closes the re-pin deadlock (RELEASING.md /
  // AGENTS.md P8) must fire once after either publish lane succeeds, never
  // before, and never mask a real publish failure by swallowing its own.
  const dispatch = jobOf("dispatch-allocate-version");
  check("dispatch-allocate-version job exists", Boolean(dispatch));
  check(
    "it needs exactly publish and publish-wire — not plan/plan-wire, so a plan-side failure cannot skip it transitively",
    /needs:\s*\[publish,\s*publish-wire\]/.test(dispatch),
    dispatch,
  );
  check(
    "its `if:` is an OR over both jobs' .result — a partly-skipped matrix must not suppress it",
    dispatch.includes("needs.publish.result == 'success' || needs.publish-wire.result == 'success'"),
    dispatch,
  );
  // Without a status-check function in the `if:`, GitHub requires every job in
  // `needs:` to have SUCCEEDED — and one of the two publish lanes is skipped on
  // almost every release (each fires only when its own registry's version moved).
  // The OR above would then never be reached: the job is dropped for depending on
  // a skipped lane, and reads as an innocent "skipped" while the re-pin never
  // happens. This is the one edit that turns this whole job back into decoration,
  // so it is asserted rather than commented.
  check(
    "its `if:` carries a status-check function (!cancelled()), or a skipped publish lane silently drops the job",
    /!cancelled\(\)/.test(dispatch.split("\n").find((line) => line.trim().startsWith("if:")) ?? ""),
    dispatch,
  );
  check(
    "it mints the pome-ops-push app token, the same action pinned SHA as allocate-version.yml's own mint step",
    dispatch.includes("actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1") &&
      dispatch.includes("secrets.OPS_APP_ID") &&
      dispatch.includes("secrets.OPS_APP_PRIVATE_KEY"),
    dispatch,
  );
  check(
    "the dispatch step uses the minted app token and never the ambient GITHUB_TOKEN",
    /GH_TOKEN:\s*\$\{\{\s*steps\.app-token\.outputs\.token/.test(dispatch) &&
      !/GH_TOKEN:\s*\$\{\{\s*(secrets\.GITHUB_TOKEN|github\.token)/.test(dispatch),
    dispatch,
  );
  check(
    "no continue-on-error anywhere in the job — a failed dispatch must red loudly, not hide behind a green job",
    !dispatch.includes("continue-on-error"),
    dispatch,
  );

  // It POSTs a repository_dispatch, NOT a workflow_dispatch. `gh workflow run`
  // hits POST /repos/…/actions/workflows/{id}/dispatches, which GitHub gates on
  // `actions: write` — a scope the pome-ops-push installation does not have, so
  // that spelling 403s on every release. `gh api … /dispatches` is the
  // `contents: write` endpoint, which it does have.
  const dispatchCommand = dispatch
    .split("\n")
    // The command is a one-line `run:`, so the key is stripped rather than
    // assumed away — comment lines still begin with `#` and cannot match.
    .map((line) => line.trim().replace(/^run:\s*/, ""))
    .find((line) => line.startsWith("gh "));
  check("the job has a `gh` dispatch command", Boolean(dispatchCommand), dispatch);
  check(
    "it POSTs repository_dispatch, never `gh workflow run` (that endpoint needs actions: write, which the app lacks)",
    dispatchCommand?.startsWith("gh api") &&
      /--method POST/.test(dispatchCommand) &&
      /repos\/\$\{\{ github\.repository \}\}\/dispatches/.test(dispatchCommand),
    dispatchCommand,
  );

  // The event_type and allocate-version.yml's `types:` are two halves of one
  // wire, typed in two files. A mismatch is not an error anywhere: the POST
  // answers 204 and starts no run — the silent no-op this whole job exists to
  // avoid — so they are asserted against each other rather than each against a
  // literal spelled here twice.
  const eventType = dispatchCommand?.match(/-f\s+event_type=([\w.-]+)/)?.[1];
  check("the dispatch names an event_type", Boolean(eventType), dispatchCommand);
  const allocate = readFileSync(join(ROOT, ".github/workflows/allocate-version.yml"), "utf8");
  const dispatchTypes = allocate.match(/\n {2}repository_dispatch:\n {4}types:\s*\[([^\]]*)\]/);
  check(
    "allocate-version.yml has a repository_dispatch trigger with an explicit `types:` list — never a bare trigger accepting every event anyone POSTs",
    Boolean(dispatchTypes),
    "expected `repository_dispatch:` followed by `types: [...]` in allocate-version.yml",
  );
  check(
    `allocate-version.yml listens for exactly the event release.yml sends (${eventType ?? "?"})`,
    Boolean(eventType) &&
      (dispatchTypes?.[1] ?? "")
        .split(",")
        .map((t) => t.trim())
        .includes(eventType),
    `release.yml sends \`${eventType}\`, allocate-version.yml accepts \`${dispatchTypes?.[1] ?? "nothing"}\``,
  );

  // A repository_dispatch payload has no `head_commit`, so allocate-version.yml's
  // `[release-bump]` guard cannot read the marker on that event — and the tip it
  // is dispatched FROM is always a `[release-bump]` commit. The guard therefore
  // has to be scoped to `push`, or the dispatched run either skips outright (a
  // dispatch that achieves nothing) or passes only by null-coercion.
  check(
    "allocate-version.yml's [release-bump] guard is scoped to `push`, so the dispatched run is not skipped by a marker it cannot read",
    /if:\s*\$\{\{\s*github\.event_name\s*!=\s*'push'\s*\|\|\s*!contains\(github\.event\.head_commit\.message,\s*'\[release-bump\]'\)\s*\}\}/.test(
      allocate,
    ),
    "expected a job-level `if:` of the form `github.event_name != 'push' || !contains(github.event.head_commit.message, '[release-bump]')`",
  );

  // The race the dispatch would otherwise lose. `planExampleRepins` only re-pins
  // to a version the registry already serves, and an E404 is indistinguishable
  // from "never published" — so if the publish job returns before propagation,
  // the dispatched run no-ops and the drift persists with no later run to retry
  // it. The publish job must therefore prove visibility before this job runs.
  check(
    "the publish job waits for the registry to serve what it published, with a staleness-forcing read",
    /npm view "\$\{PKG\}@\$\{version\}"[^\n]*--prefer-online/.test(publish),
    publish,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll decide-publish.sh checks passed.");
