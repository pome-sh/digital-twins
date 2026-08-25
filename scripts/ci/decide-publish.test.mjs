#!/usr/bin/env node
//
// Asserts a 401 from GitHub Packages is never read as "unpublished" (which would
// bypass the never-publish-behind-latest floor) and that the two registry lanes
// cannot block each other.
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

{
  const r = run({ answer: E404, localVersion: "0.2.1" });
  check("E404 (never published) ⇒ publishes from a 0.0.0 baseline", r.status === 0 && r.output === "thing=true", `status=${r.status} output=${r.output}`);
  check("E404 reports the 0.0.0 baseline in the log", r.stdout.includes("0.0.0"), r.stdout);
}

{
  const r = run({ answer: `echo "0.2.1"`, localVersion: "0.2.1" });
  check("same version ⇒ skip", r.status === 0 && r.output === "thing=false", `status=${r.status} output=${r.output}`);
}

{
  const r = run({ answer: `echo "0.2.0"`, localVersion: "0.2.1" });
  check("local ahead of registry ⇒ publish", r.status === 0 && r.output === "thing=true", `status=${r.status} output=${r.output}`);
}

{
  const r = run({ answer: `echo "9.9.9"`, localVersion: "0.2.1" });
  check("local BEHIND registry ⇒ hard fail", r.status !== 0, `status=${r.status}`);
  check("behind-fail writes no output (job must not proceed)", r.output === "", `output=${r.output}`);
  check("behind-fail explains the retag risk", r.stdout.includes("retag latest backwards"), r.stdout);
}

{
  const r = run({ answer: `echo "0.2.9"`, localVersion: "0.2.10" });
  check("0.2.10 counts as ahead of 0.2.9 (version sort, not lexical)", r.status === 0 && r.output === "thing=true", `status=${r.status} output=${r.output}`);
}

for (const [label, answer] of [
  ["401 (GitHub Packages, token cannot read an existing package)", E401],
  ["403", E403],
  ["500", SERVER_ERROR],
]) {
  const r = run({ answer, localVersion: "0.2.1" });
  check(`${label} ⇒ hard fail, never a 0.0.0 baseline`, r.status !== 0 && r.output === "", `status=${r.status} output=${r.output}`);
  check(`${label} does not claim "unchanged" or publish`, !r.output.includes("true"), r.output);
}

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

{
  const dir = mkdtempSync(join(tmpdir(), "decide-publish-args-"));
  try {
    const r = spawnSync("bash", [SCRIPT, "only-one-arg"], { cwd: dir, encoding: "utf8" });
    check("too few arguments ⇒ usage error", r.status === 2, `status=${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  const dispatchCommand = dispatch
    .split("\n")
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

  check(
    "allocate-version.yml's [release-bump] guard is scoped to `push`, so the dispatched run is not skipped by a marker it cannot read",
    /if:\s*\$\{\{\s*github\.event_name\s*!=\s*'push'\s*\|\|\s*!contains\(github\.event\.head_commit\.message,\s*'\[release-bump\]'\)\s*\}\}/.test(
      allocate,
    ),
    "expected a job-level `if:` of the form `github.event_name != 'push' || !contains(github.event.head_commit.message, '[release-bump]')`",
  );

  check(
    "the publish job waits for the registry to serve what it published, with a staleness-forcing read",
    /npm view "\$\{PKG\}@\$\{version\}"[^\n]*--prefer-online/.test(publish),
    publish,
  );

  const extractor = publish.match(/node -p '(const v=JSON\.parse[^']*)'/)?.[1];
  check("the version extractor is findable in the wait step", Boolean(extractor), publish);
  if (extractor) {
    const evaluate = (input) =>
      spawnSync(process.execPath, ["-p", extractor], {
        input,
        encoding: "utf8",
        env: { ...process.env, PKG: "@pome-sh/thing" },
      });
    for (const [label, input] of [
      ["npm 11.5.1's flat shape", '{"@pome-sh/thing":"0.9.9"}'],
      ["npm 12's nested shape", '{"@pome-sh/thing":{"version":"0.9.9"}}'],
    ]) {
      const r = evaluate(input);
      check(
        `the version extractor reads ${label}`,
        r.status === 0 && r.stdout.trim() === "0.9.9",
        `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr?.split("\n")[0]}`,
      );
    }
    const r = evaluate('{"@pome-sh/thing":{"nope":true}}');
    check(
      "the version extractor throws on a shape it does not recognise, rather than yielding undefined",
      r.status !== 0 && /no version for @pome-sh\/thing/.test(r.stderr ?? ""),
      `status=${r.status} stderr=${(r.stderr ?? "").split("\n").slice(0, 3).join(" | ")}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll decide-publish.sh checks passed.");
