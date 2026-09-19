#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for readme-readability. Every case asserts the RED direction: a rule
// that has quietly stopped failing prints the same line as one with nothing to
// report. Cases init a git index; the rule scans the tracked README only.
//
// The pairs matter more than the singles. "at the limit passes" beside "one over
// is red" is what proves the comparison is the one documented, and the three
// not-prose cases (link href, backticks, table row) are what keep the budget
// from quietly taxing markup that costs no screen width.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureTree } from "../harness.mjs";
import {
  CODE_COLUMN_LIMIT,
  PROSE_CHAR_LIMIT,
  RENDERED_LINE_COLUMNS,
} from "./readme-readability.mjs";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../../lint.mjs");

const page = (body) => `# Pome Digital Twins\n\n${body}\n`;
const words = (n) => {
  // "word word word …" trimmed to exactly n characters, so a case can sit one
  // character either side of the budget without counting by hand.
  const filler = "word ".repeat(Math.ceil(n / 5));
  return filler.slice(0, n).trimEnd().padEnd(n, "x");
};

function runCase({ files, tracked = true, git = true }) {
  const root = fixtureTree(files, "readme-readability-");
  if (git) {
    execFileSync("git", ["init", "-b", "main", "--template="], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    if (!tracked) {
      execFileSync("git", ["rm", "--cached", "-f", "--", "README.md"], { cwd: root, stdio: "ignore" });
    }
  }
  const result = spawnSync(process.execPath, [RUNNER, "readme-readability", "--root", root], {
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const cases = [
  {
    name: "a short page with a narrow code block passes",
    files: { "README.md": page("A short walkthrough.\n\n```bash\nnpx @pome-sh/cli@latest twin start github\n```") },
    expect: "green",
  },
  {
    name: "a code line one column over the limit is red, named with its width",
    files: {
      "README.md": page("Prose.\n\n```text\n" + "x".repeat(CODE_COLUMN_LIMIT + 1) + "\n```"),
    },
    expect: "red",
    contains: [`${CODE_COLUMN_LIMIT + 1} columns in a code block`, "README.md:6"],
  },
  {
    name: "a code line at exactly the limit passes",
    files: { "README.md": page("Prose.\n\n```text\n" + "x".repeat(CODE_COLUMN_LIMIT) + "\n```") },
    expect: "green",
  },
  {
    name: "the fence line itself is not measured as code",
    files: { "README.md": page("Prose.\n\n```" + "j".repeat(CODE_COLUMN_LIMIT + 10) + "\nshort\n```") },
    expect: "green",
  },
  {
    name: "a wide code line inside a <details> is still red — the gate does not stop at the fold",
    files: {
      "README.md": page(
        "<details>\n<summary>More</summary>\n\n```text\n" + "x".repeat(CODE_COLUMN_LIMIT + 5) + "\n```\n\n</details>",
      ),
    },
    expect: "red",
    contains: "columns in a code block",
  },
  {
    name: "a paragraph one character over the budget is red, named with its rendered length",
    files: { "README.md": page(words(PROSE_CHAR_LIMIT + 1)) },
    expect: "red",
    contains: [`${PROSE_CHAR_LIMIT + 1} rendered characters`, `budget (${PROSE_CHAR_LIMIT})`],
  },
  {
    name: "a paragraph at exactly the budget passes",
    files: { "README.md": page(words(PROSE_CHAR_LIMIT)) },
    expect: "green",
  },
  {
    name: "a paragraph split across source lines is measured as one rendered paragraph",
    files: { "README.md": page(`${words(PROSE_CHAR_LIMIT)}\nand more text here`) },
    expect: "red",
    contains: "rendered characters",
  },
  {
    name: "a list item is prose too, and each item is measured on its own",
    files: { "README.md": page(`- ${words(PROSE_CHAR_LIMIT + 1)}\n- ${words(20)}`) },
    expect: "red",
    contains: "rendered characters",
  },
  {
    name: "two short paragraphs that only exceed the budget when joined both pass",
    files: { "README.md": page(`${words(PROSE_CHAR_LIMIT)}\n\n${words(PROSE_CHAR_LIMIT)}`) },
    expect: "green",
  },
  {
    name: "a link href costs no screen width and is not charged to the budget",
    files: {
      "README.md": page(`${words(PROSE_CHAR_LIMIT - 10)} [docs](https://docs.pome.sh/a/very/long/path/that/renders/as/nothing)`),
    },
    expect: "green",
  },
  {
    name: "backticks and bold markers are not charged to the budget",
    files: { "README.md": page(`\`${words(PROSE_CHAR_LIMIT - 4)}\` **ok**`) },
    expect: "green",
  },
  {
    name: "a nested tag is stripped whole — one pass would leave <span> behind",
    files: {
      "README.md": page(`<<span>span>${words(PROSE_CHAR_LIMIT)}`),
    },
    expect: "green",
  },
  {
    name: "a fence line with trailing text does not close the block — later code is still code",
    files: {
      "README.md": page("Prose.\n\n```markdown\n```js\n" + "x".repeat(CODE_COLUMN_LIMIT + 10) + "\n```"),
    },
    expect: "red",
    contains: `${CODE_COLUMN_LIMIT + 10} columns in a code block`,
  },
  {
    name: "a paragraph wrapped in <p> pays the budget — HTML is measured by what it paints",
    files: { "README.md": page(`<p align="center">${words(PROSE_CHAR_LIMIT + 1)}</p>`) },
    expect: "red",
    contains: `${PROSE_CHAR_LIMIT + 1} rendered characters`,
  },
  {
    name: "HTML that paints no text still separates blocks — an <img> alt is not prose",
    files: {
      "README.md": page(`<p align="center">\n  <img src="x.svg" alt="${words(PROSE_CHAR_LIMIT + 50)}">\n</p>`),
    },
    expect: "green",
  },
  {
    name: "an inline tag on a continuation line stays in its paragraph",
    files: { "README.md": page(`${words(PROSE_CHAR_LIMIT - 20)}\n<code>tail</code> and a few more words here`) },
    expect: "red",
    contains: "rendered characters",
  },
  {
    name: "a block-level tag starts a new paragraph instead of joining the last one",
    files: { "README.md": page(`${words(200)}\n<p>${words(200)}</p>`) },
    expect: "green",
  },
  {
    name: "an HTML comment paints nothing and is not charged",
    files: { "README.md": page(`<!-- ${words(PROSE_CHAR_LIMIT + 100)} -->`) },
    expect: "green",
  },
  {
    name: "a table row is a record, not prose",
    files: {
      "README.md": page(`| Twin | Notes |\n| --- | --- |\n| GitHub | ${words(PROSE_CHAR_LIMIT + 50)} |`),
    },
    expect: "green",
  },
  {
    name: "a long heading is not prose",
    files: { "README.md": page(`## ${words(PROSE_CHAR_LIMIT + 50)}`) },
    expect: "green",
  },
  {
    name: "the reported line estimate uses the measured rendered-line width",
    files: { "README.md": page(words(RENDERED_LINE_COLUMNS * 5)) },
    expect: "red",
    contains: "is about 5 lines",
  },
  {
    name: "a README missing from the index is RED, not a silent pass",
    files: { "README.md": page("Short.") },
    tracked: false,
    expect: "red",
    contains: "README.md is not tracked",
  },
  {
    name: "a --root that is not a git work tree is RED, not an empty pass",
    files: { "README.md": page("Short.") },
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
    console.error(`✗ readme-readability: ${testCase.name}`);
    for (const problem of problems) console.error(`    ${problem}`);
    console.error(out.replace(/^/gm, "    "));
  } else {
    console.log(`✓ readme-readability: ${testCase.name}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${cases.length} readme-readability case(s) failed.`);
  process.exit(1);
}
console.log(`\n${cases.length} readme-readability case(s) passed.`);
