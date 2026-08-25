#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for check-packages-scripts-wired. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-packages-scripts-wired.mjs");

function write(root, relPath, contents) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), "scripts-wired-"));
  for (const [relPath, contents] of Object.entries(files)) write(root, relPath, contents);
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

let failures = 0;
function check(name, files, { expect, contains }) {
  const { code, out } = runAgainst(files);
  const got = code === 0 ? "green" : "red";
  const problems = [];
  if (got !== expect) problems.push(`expected ${expect}, got ${got}`);
  if (contains && !out.includes(contains)) problems.push(`output missing ${JSON.stringify(contains)}`);
  if (problems.length > 0) {
    failures += 1;
    console.error(`✗ ${name}\n  ${problems.join("\n  ")}\n${out.replace(/^/gm, "    ")}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const pkgJson = (name, scripts) => JSON.stringify({ name, scripts });

check(
  "wired check:foo passes",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run check:foo -w @pome-sh/alpha\n",
  },
  { expect: "green" }
);

check(
  "unwired check:foo reds, naming it",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

check(
  "unwired script with an inline pome:unwired-ok exemption passes and prints the reason",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "validate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok(validate:foo): manual dev tool, needs a live credential CI lacks\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "manual dev tool, needs a live credential CI lacks" }
);

check(
  "unwired non-prefixed script (smoke) IS flagged — the vocabulary is not a prefix list",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { smoke: "node scripts/smoke.mjs" }),
    "packages/alpha/scripts/smoke.mjs": "console.log('ok');\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "smoke"' }
);

check(
  "unwired bare 'test' (no colon) is not flagged",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { test: "vitest run" }),
  },
  { expect: "green" }
);

check(
  "reached only from a root script (root aggregate) passes",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/aggregate.mjs": "execSync('npm run gate:foo -w @pome-sh/alpha');\n",
  },
  { expect: "green" }
);

check(
  "a marker with no reason text is rejected, not satisfied by the next line",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "validate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok(validate:foo):\nimport { readFileSync } from 'node:fs';\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "validate:foo"' }
);

check(
  "a marker with a whitespace-only reason is rejected",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "validate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok(validate:foo):   \nconst x = 1;\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "validate:foo"' }
);

check(
  "a marker in another package's file does not exempt this script",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "validate:foo": "node ../beta/scripts/other.mjs && node scripts/foo.mjs",
    }),
    "packages/alpha/scripts/foo.mjs": "console.log('no marker here');\n",
    "packages/beta/scripts/other.mjs": "// pome:unwired-ok(validate:foo): beta's own good reason\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "validate:foo"' }
);

check(
  "a marker naming a DIFFERENT script does not exempt this one",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "fixture:mcp": "node scripts/adopt.mjs",
      "gate:mcp-fixture": "node scripts/adopt.mjs --check",
    }),
    "packages/alpha/scripts/adopt.mjs": "// pome:unwired-ok(fixture:mcp): write half; the verdict half is gate:mcp-fixture\n",
    ".github/workflows/ci.yml": "run: npm run fixture:mcp -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:mcp-fixture"' }
);

check(
  "the gate's own file is not corpus — its docstrings cannot wire anything",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/check-packages-scripts-wired.test.mjs": "// npm run check:foo -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

check(
  "a commented-out CI invocation is NOT wiring",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "      # disabled, flaky: npm run gate:foo -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:foo"' }
);

check(
  "a prefix-named sibling is not wired by the longer script's line",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "gate:mcp": "node scripts/mcp.mjs",
      "gate:mcp-fixture": "node scripts/fixture.mjs",
    }),
    "packages/alpha/scripts/mcp.mjs": "console.log('ok');\n",
    "packages/alpha/scripts/fixture.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run gate:mcp-fixture -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:mcp"' }
);

check(
  "a prefix-named package is not wired by the longer package's line",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run gate:foo -w @pome-sh/alpha-legacy\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:foo"' }
);

check(
  "no packages/ directory is a hard failure, not a green 0-script scan",
  { "README.md": "not a repo root\n" },
  { expect: "red", contains: "must run from the repo root" }
);

check(
  "a write mode whose file a wired sibling already runs needs no marker",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "fixture:mcp": "node scripts/adopt.mjs",
      "gate:mcp-fixture": "node scripts/adopt.mjs --check",
    }),
    "packages/alpha/scripts/adopt.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run gate:mcp-fixture -w @pome-sh/alpha\n",
  },
  { expect: "green", contains: "wired sibling runs with --check" }
);

check(
  "another package's wired --check does not cover this package's write half",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "fixture:mcp": "node scripts/adopt.mjs" }),
    "packages/alpha/scripts/adopt.mjs": "console.log('ok');\n",
    "packages/beta/package.json": pkgJson("@pome-sh/beta", {
      "fixture:mcp": "node scripts/adopt.mjs",
      "gate:mcp-fixture": "node scripts/adopt.mjs --check",
    }),
    "packages/beta/scripts/adopt.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml":
      "        run: npm run gate:mcp-fixture -w @pome-sh/beta\n        run: npm run fixture:mcp -w @pome-sh/beta\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "fixture:mcp"' }
);

check(
  "a wired sibling with --watch does not cover an unwired check",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "check:foo": "node scripts/foo.mjs",
      "dev:foo": "node scripts/foo.mjs --watch",
    }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run dev:foo -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

check(
  "a JSDoc ` *` line mentioning the command is NOT wiring",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/other.mjs": "/**\n * Usage: npm run check:foo -w @pome-sh/alpha\n */\nexport const x = 1;\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

check(
  "a workspace flag after `--` is not wiring — npm selects no workspace",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run check:foo -- -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

for (const [label, line] of [
  ["workspace before the script name", "        run: npm run -w @pome-sh/alpha check:foo\n"],
  ["--workspace= form", "        run: npm run check:foo --workspace=@pome-sh/alpha\n"],
  ["--workspace space form", "        run: npm run --workspace @pome-sh/alpha check:foo\n"],
  ["npm run-script", "        run: npm run-script check:foo -w @pome-sh/alpha\n"],
]) {
  check(
    `wired via ${label} counts as wired`,
    {
      "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
      "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
      ".github/workflows/ci.yml": line,
    },
    { expect: "green" }
  );
}

check(
  "wired cli/package.json check passes",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "node scripts/foo.mjs" }),
    "cli/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run gate:foo -w @pome-sh/cli\n",
  },
  { expect: "green" }
);

check(
  "unwired cli/package.json check reds, naming it",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "node scripts/foo.mjs" }),
    "cli/scripts/foo.mjs": "console.log('ok');\n",
  },
  { expect: "red", contains: '@pome-sh/cli "gate:foo"' }
);

check(
  "unwired cli/package.json script with a marker passes",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "node scripts/foo.mjs" }),
    "cli/scripts/foo.mjs": "// pome:unwired-ok(gate:foo): manual dev tool\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "manual dev tool" }
);

check(
  "cli/package.json's 'pome' runtime alias is not flagged",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { pome: "node dist/src/cli/main.js" }),
  },
  { expect: "green" }
);

check(
  "an orphan cli/scripts/ file invoked by no script and imported by nothing reds by path",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { build: "tsup" }),
    "cli/scripts/orphan.mjs": "console.log('nothing calls this');\n",
  },
  { expect: "red", contains: "cli/scripts/orphan.mjs" }
);

check(
  "an orphan cli/scripts/ file with a pome:unwired-ok(<path>) marker passes",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { build: "tsup" }),
    "cli/scripts/orphan.mjs":
      "// pome:unwired-ok(scripts/orphan.mjs): spawned via a resolved path, not a literal invocation\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "spawned via a resolved path" }
);

check(
  "a file invoked by a lifecycle script (prepublishOnly) is not treated as an orphan",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { prepublishOnly: "node scripts/assert.mjs" }),
    "cli/scripts/assert.mjs": "console.log('ok');\n",
  },
  { expect: "green" }
);

check(
  "a cli/scripts/ file imported by a sibling is not its own orphan entry",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "tsx scripts/foo.ts" }),
    ".github/workflows/ci.yml": "run: npm run gate:foo -w @pome-sh/cli\n",
    "cli/scripts/foo.ts": 'import { helper } from "./lib.js";\nhelper();\n',
    "cli/scripts/lib.ts": "export function helper() {}\n",
  },
  { expect: "green" }
);

check(
  "cli/'s own write mode is covered by its wired --check sibling",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", {
      "emit:foo": "node scripts/foo.mjs",
      "check:foo": "node scripts/foo.mjs --check",
    }),
    "cli/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run check:foo -w @pome-sh/cli\n",
  },
  { expect: "green", contains: "wired sibling runs with --check" }
);

check(
  "a repo with no cli/ directory is unaffected",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run check:foo -w @pome-sh/alpha\n",
  },
  { expect: "green" }
);

check(
  "a commented-out sibling import does not exempt the file it names",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "tsx scripts/foo.ts" }),
    ".github/workflows/ci.yml": "run: npm run gate:foo -w @pome-sh/cli\n",
    "cli/scripts/foo.ts": '// import { helper } from "./lib.js";\nconsole.log("ok");\n',
    "cli/scripts/lib.ts": "export function helper() {}\n",
  },
  { expect: "red", contains: "cli/scripts/lib.ts" }
);

check(
  "cli declared a workspace but contributing zero entries is a hard failure",
  {
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "cli"] }),
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {}),
  },
  { expect: "red", contains: "denominator is EMPTY" }
);

check(
  "a root manifest that does not declare cli is not held to the cli floor",
  {
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {}),
  },
  { expect: "green" }
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll check-packages-scripts-wired cases passed.");
