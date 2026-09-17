#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for markdown-size. Every case asserts the RED direction: a rule that
// has quietly stopped failing prints the same line as one with nothing to report.
// Cases that need a git index init one; the rule scans tracked files only.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureTree } from "../harness.mjs";
import { FILE_BYTE_LIMIT, PROSE_LINE_LIMIT } from "./markdown-size.mjs";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../../lint.mjs");
const SMALL = "# ok\n\nA short page.\n";
const exactBytes = (limit) => {
  const line = `${"x".repeat(80)}\n`;
  const n = Math.floor(limit / line.length);
  return line.repeat(n) + "y".repeat(limit - n * line.length);
};

const REQUIRED = {
  "AGENTS.md": SMALL,
  "README.md": SMALL,
  "CONTRIBUTING.md": SMALL,
  "CONTRACT.md": SMALL,
  "SECURITY.md": SMALL,
  "docs/ok.md": SMALL,
  "cli/README.md": SMALL,
  "packages/README.md": SMALL,
  "packages/sdk/README.md": SMALL,
  "skills/README.md": SMALL,
  "skills/pome/README.md": SMALL,
};

const tree = (overrides = {}) =>
  Object.fromEntries(
    Object.entries({ ...REQUIRED, ...overrides }).filter(([, body]) => body !== undefined),
  );

function initGit(root, untracked = []) {
  execFileSync("git", ["init", "-b", "main", "--template="], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  for (const rel of untracked) {
    execFileSync("git", ["rm", "--cached", "-f", "--", rel], { cwd: root, stdio: "ignore" });
  }
}

function runCase({ files, untracked, git = true }) {
  const root = fixtureTree(files, "markdown-size-");
  if (git) initGit(root, untracked);
  const result = spawnSync(process.execPath, [RUNNER, "markdown-size", "--root", root], {
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const cases = [
  {
    name: "a front-door tree under both budgets passes",
    files: tree(),
    expect: "green",
  },
  {
    name: "a tracked file over the byte budget is a violation, named with its size",
    files: tree({ "AGENTS.md": `${"x".repeat(FILE_BYTE_LIMIT + 1)}\n` }),
    expect: "red",
    contains: ["AGENTS.md", `${FILE_BYTE_LIMIT + 2} bytes exceeds ${FILE_BYTE_LIMIT}`],
  },
  {
    name: "a file at exactly the byte budget passes",
    files: tree({ "AGENTS.md": exactBytes(FILE_BYTE_LIMIT) }),
    expect: "green",
  },
  {
    name: "a prose line over the column budget is a violation, named with its line",
    files: tree({ "AGENTS.md": `# Title\n\n${"x".repeat(PROSE_LINE_LIMIT + 1)}\n` }),
    expect: "red",
    contains: [`AGENTS.md:3: ${PROSE_LINE_LIMIT + 1} columns exceeds ${PROSE_LINE_LIMIT}-column prose`],
  },
  {
    name: "a prose line at exactly the column budget passes",
    files: tree({ "AGENTS.md": `# Title\n\n${"x".repeat(PROSE_LINE_LIMIT)}\n` }),
    expect: "green",
  },
  {
    name: "a line that is long only because of a URL is exempt",
    files: tree({
      "README.md": `# Title\n\nSee https://${"a".repeat(PROSE_LINE_LIMIT)}.example/path\n`,
    }),
    expect: "green",
  },
  {
    name: "a long prose line that merely contains a short URL is still a violation",
    files: tree({
      "README.md": `# Title\n\n${"x".repeat(PROSE_LINE_LIMIT + 1)} https://example.com\n`,
    }),
    expect: "red",
    contains: "columns exceeds",
  },
  {
    name: "a markdown table row over the column budget is exempt",
    files: tree({
      "CONTRACT.md": `# T\n\n| col | ${"x".repeat(PROSE_LINE_LIMIT)} |\n| --- | --- |\n`,
    }),
    expect: "green",
  },
  {
    name: "a pipe inside prose is not a table row",
    files: tree({
      "CONTRIBUTING.md": `# T\n\n${"x".repeat(PROSE_LINE_LIMIT - 10)} | leftover\n`,
    }),
    expect: "red",
    contains: "columns exceeds",
  },
  {
    name: "a generated changelog in the scan set is exempt even when huge",
    files: tree({
      "docs/CHANGELOG.md": `${"x".repeat(FILE_BYTE_LIMIT + 1)}\n${"y".repeat(PROSE_LINE_LIMIT + 1)}\n`,
    }),
    expect: "green",
  },
  {
    name: "an untracked Markdown file is ignored even when it exceeds both budgets",
    files: tree({
      "docs/huge.md": `${"x".repeat(FILE_BYTE_LIMIT + 1)}\n${"y".repeat(PROSE_LINE_LIMIT + 1)}\n`,
    }),
    untracked: ["docs/huge.md"],
    expect: "green",
  },
  {
    name: "a required front-door file missing from the index is RED",
    files: tree({ "AGENTS.md": undefined }),
    expect: "red",
    contains: "AGENTS.md: not tracked",
  },
  {
    name: "a required glob that matches nothing is RED",
    files: tree({ "docs/ok.md": undefined }),
    expect: "red",
    contains: "docs/*.md: no tracked file matches",
  },
  {
    name: "a --root that is not a git work tree is RED, not an empty pass",
    files: tree(),
    git: false,
    expect: "red",
    contains: "not a git work tree",
  },
];

let failures = 0;
for (const testCase of cases) {
  const { code, out } = runCase(testCase);
  const got = code === 0 ? "green" : "red";
  const problems = [];
  if (got !== testCase.expect) problems.push(`expected ${testCase.expect}, got ${got}`);
  for (const needle of [testCase.contains].flat().filter(Boolean)) {
    if (!out.includes(needle)) problems.push(`output does not match ${needle}`);
  }
  if (problems.length > 0) {
    failures += 1;
    console.error(`✗ markdown-size: ${testCase.name}`);
    for (const problem of problems) console.error(`    ${problem}`);
    console.error(out.replace(/^/gm, "    "));
  } else {
    console.log(`✓ markdown-size: ${testCase.name}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${cases.length} markdown-size case(s) failed.`);
  process.exit(1);
}
console.log(`\n${cases.length} markdown-size case(s) passed.`);
