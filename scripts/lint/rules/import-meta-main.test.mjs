#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for import-meta-main. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_ROOTS } from "../../lib/example-roots.mjs";

import {
  discoverSourceFiles,
  findBareImportMetaMain,
  findEntryGuardRealpathGaps,
  parseErrorsIn,
  scanRepo,
} from "./import-meta-main.mjs";
import { RULES } from "../rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}

// The independent control for `discoverSourceFiles`. Derived from EXAMPLE_ROOTS
// rather than re-typed, because the whole point of this arm is that the two
// derivations are independent in HOW they walk, not in WHICH roots they walk —
// a hand-copied root list here would make the arm pass by agreeing to be wrong.
const REQUIRED_ROOTS = ["scripts", "contract", "cli/src", "cli/scripts", "packages", ...EXAMPLE_ROOTS];

const REAL_SHAPES = {
  "bare member access": "if (import.meta.main) { run(); }",
  "wrapped in parens": "if ((import.meta.main)) { run(); }",
  "split across lines": "if (\n  import.meta\n    .main\n) { run(); }",
  "negated": "if (!import.meta.main) { skip(); }",
  "optional chaining": "if (import.meta?.main) { run(); }",
  "computed access, string key": 'if (import.meta["main"]) { run(); }',
  "computed access, template key": "if (import.meta[`main`]) { run(); }",
  "inside a ternary": "const mode = import.meta.main ? 'cli' : 'lib';",
  "inside an && chain": "if (ready && import.meta.main && !dryRun) { run(); }",
  "coerced": "const isEntry = Boolean(import.meta.main);",
  "destructured, no rename": "const { main } = import.meta;\nif (main) run();",
  "destructured with rename": "const { main: isMain } = import.meta;\nif (isMain) run();",
  "destructured, computed key": 'const { ["main"]: m } = import.meta;\nif (m) run();',
  "destructured via rest": "const { ...rest } = import.meta;\nif (rest.main) run();",
  "assignment-expression destructure": "let main;\n({ main } = import.meta);",
  "assignment-expression spread": "let rest;\n({ ...rest } = import.meta);",
};
for (const [label, source] of Object.entries(REAL_SHAPES)) {
  const hits = findBareImportMetaMain(source);
  assert(hits.length > 0, `a real import.meta.main reference is caught: ${label} (source: ${JSON.stringify(source)})`);
}

{
  const tsSource = [
    "interface Wiring { readonly url: string }",
    "function boot(w: Wiring): Promise<void> { return fetch(w.url).then(() => {}); }",
    "const cfg = { url: process.env.U as string } satisfies Wiring;",
    "if (import.meta.main) { await boot(cfg); }",
  ].join("\n");
  assert(parseErrorsIn(tsSource, "x.ts").length === 0, "a real .ts file parses cleanly (type syntax and all)");
  const hits = findBareImportMetaMain(tsSource, "x.ts");
  assert(hits.length === 1 && hits[0].line === 4, `a bare guard in a .ts file is caught, with its line (got ${JSON.stringify(hits)})`);
}

const FALSE_POSITIVES = {
  "line comment": "// import.meta.main\nconsole.log('ok');",
  "block comment": "/* uses import.meta.main historically */\nconsole.log('ok');",
  "string literal": "const s = 'import.meta.main';\nconsole.log(s);",
  "template literal": "const s = `guard is import.meta.main`;\nconsole.log(s);",
  "string array a generator emits": 'const lines = ["if (import.meta.main) {", "  await main();", "}"];',
  "unrelated .main property": "const config = { main: true };\nif (config.main) run();",
  "import.meta without .main": "const url = import.meta.url;\nconsole.log(url);",
  "import.meta.resolve": "if (import.meta.resolve) run();",
  "concatenated key (documented non-goal)": 'if (import.meta["ma" + "in"]) { run(); }',
};
for (const [label, source] of Object.entries(FALSE_POSITIVES)) {
  const hits = findBareImportMetaMain(source);
  assert(hits.length === 0, `not a real reference, must not red: ${label} (got ${JSON.stringify(hits)})`);
}

{
  const mixed = "// import.meta.main is banned here\nif (import.meta.main) { run(); }\nconst s = 'import.meta.main';";
  const hits = findBareImportMetaMain(mixed);
  assert(hits.length === 1, `a real reference is caught even alongside comment/string mentions (got ${hits.length})`);
}

const GUARD_GAP_CASES = {
  "bare compare, no resolve at all": {
    source: "if (fileURLToPath(import.meta.url) === process.argv[1]) { main(); }",
    kind: "no-realpath",
  },
  "resolve()-only, neither side realpath'd": {
    source: "if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { main(); }",
    kind: "no-realpath",
  },
  "resolve() on both sides, neither realpath'd": {
    source: "if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) { main(); }",
    kind: "no-realpath",
  },
  "pathToFileURL(...).href, meta on the left": {
    source: 'if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { main(); }',
    kind: "no-realpath",
  },
  "pathToFileURL(...).href, argv on the left": {
    source: "if (pathToFileURL(resolve(process.argv[1])).href === import.meta.url) { main(); }",
    kind: "no-realpath",
  },
  "one-sided realpath, argv side only": {
    source: "if (realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) { main(); }",
    kind: "one-sided-realpath",
  },
  "one-sided realpath, meta side only": {
    source: "if (resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) { main(); }",
    kind: "one-sided-realpath",
  },
  "basename compare via endsWith, meta object": {
    source: "if (import.meta.url.endsWith(basename(process.argv[1]))) main();",
    kind: "basename-comparison",
  },
  "basename compare via endsWith, argv object (reversed)": {
    source: "if (process.argv[1].endsWith(basename(import.meta.url))) main();",
    kind: "basename-comparison",
  },
  "alias-routed, neither side realpath'd (the sanctioned shape with realpath removed)": {
    source:
      'const SELF = fileURLToPath(import.meta.url);\nconst ENTRY = process.argv[1] ? resolve(process.argv[1]) : "";\nif (ENTRY === SELF) main();',
    kind: "no-realpath",
  },
  "alias-routed, argv side realpath'd only": {
    source:
      'const SELF = fileURLToPath(import.meta.url);\nconst ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";\nif (ENTRY === SELF) main();',
    kind: "one-sided-realpath",
  },
  "alias-routed, meta side realpath'd only": {
    source:
      'const SELF = realpathSync(fileURLToPath(import.meta.url));\nconst ENTRY = process.argv[1] ? resolve(process.argv[1]) : "";\nif (ENTRY === SELF) main();',
    kind: "one-sided-realpath",
  },
  "alias-routed via plain consts, no ternary": {
    source: "const E = resolve(process.argv[1]);\nconst S = fileURLToPath(import.meta.url);\nif (E === S) main();",
    kind: "no-realpath",
  },
  "process.argv.at(1) instead of [1]": {
    source: "if (resolve(process.argv.at(1)) === fileURLToPath(import.meta.url)) main();",
    kind: "no-realpath",
  },
  "import.meta.filename instead of .url": {
    source: "if (resolve(process.argv[1]) === import.meta.filename) main();",
    kind: "no-realpath",
  },
};
for (const [label, { source, kind }] of Object.entries(GUARD_GAP_CASES)) {
  const { gaps } = findEntryGuardRealpathGaps(source, "x.mjs");
  assert(
    gaps.length === 1 && gaps[0].kind === kind,
    `entry-guard gap caught with the right verdict: ${label} (got ${JSON.stringify(gaps)})`
  );
}

const GUARD_GAP_CLEAN_CASES = {
  "both sides realpath'd, direct": "if (realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) { main(); }",
  "both sides realpath'd, reversed operand order": "if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) { main(); }",
  "via SELF/ENTRY intermediate consts (the pattern this repo's fixed instances use)":
    'const SELF = realpathSync(fileURLToPath(import.meta.url));\nconst ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";\nif (ENTRY === SELF) main();',
  "namespaced fs.realpathSync on both sides":
    "if (fs.realpathSync(resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main();",
  "realpathSync.native on both sides":
    "if (realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url))) main();",
  "awaited realpath from fs/promises on both sides":
    "if ((await realpath(resolve(process.argv[1]))) === (await realpath(fileURLToPath(import.meta.url)))) main();",
  "resolve() wrapped OUTSIDE realpathSync on both sides":
    "if (resolve(realpathSync(process.argv[1])) === resolve(realpathSync(fileURLToPath(import.meta.url)))) main();",
  "no entry guard at all": "const url = import.meta.url;\nconsole.log(url, process.argv[1]);",
};
for (const [label, source] of Object.entries(GUARD_GAP_CLEAN_CASES)) {
  const { gaps } = findEntryGuardRealpathGaps(source, "x.mjs");
  assert(gaps.length === 0, `the sanctioned form is not a finding: ${label} (got ${JSON.stringify(gaps)})`);
}

{
  const clean = findEntryGuardRealpathGaps(
    'const SELF = realpathSync(fileURLToPath(import.meta.url));\nconst ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";\nif (ENTRY === SELF) main();',
    "x.mjs"
  );
  assert(clean.relations === 1 && clean.gaps.length === 0, `a sanctioned guard is COUNTED, not just un-flagged (got ${JSON.stringify(clean)})`);
  const none = findEntryGuardRealpathGaps("console.log('nothing to see');", "x.mjs");
  assert(none.relations === 0 && none.gaps.length === 0, "a file with no entry guard classifies no relation");
}

{
  const dir = mkdtempSync(join(tmpdir(), "f1481-discover-"));
  try {
    mkdirSync(join(dir, "scripts", "nested"), { recursive: true });
    mkdirSync(join(dir, "scripts", "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, "scripts", "dist"), { recursive: true });
    writeFileSync(join(dir, "scripts", "a.mjs"), "export const a = 1;\n");
    writeFileSync(join(dir, "scripts", "nested", "b.js"), "export const b = 1;\n");
    writeFileSync(join(dir, "scripts", "nested", "c.ts"), "export const c: number = 1;\n");
    writeFileSync(join(dir, "scripts", "ignore.json"), "{}\n");
    writeFileSync(join(dir, "scripts", "node_modules", "pkg", "d.js"), "module.exports = 1;\n");
    writeFileSync(join(dir, "scripts", "dist", "e.js"), "export const e = 1;\n");
    const files = discoverSourceFiles(dir, ["scripts"]).get("scripts");
    assert(files.length === 3, `discovery walks nested dirs, filters by extension, prunes node_modules/dist (got ${files.length}: ${files.join(", ")})`);
    assert(files.some((f) => f.endsWith("nested/b.js")), "discovery finds a file nested two levels down");
    assert(files.some((f) => f.endsWith("nested/c.ts")), "discovery includes .ts — the extension the live instances used");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "f1481-symlink-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "linked.mjs"), "if (import.meta.main) { run(); }\n");
    symlinkSync(join(dir, "elsewhere", "linked.mjs"), join(dir, "scripts", "linked.mjs"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "scripts", "linkeddir"));
    const files = discoverSourceFiles(dir, ["scripts"]).get("scripts");
    assert(files.length === 2, `a symlinked file AND a symlinked directory are both scanned (got ${files.length})`);
    const { findings } = scanRepo(dir, ["scripts"]);
    assert(findings.length === 2, `a bare guard behind a symlink still reds (got ${JSON.stringify(findings)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const byRoot = discoverSourceFiles(ROOT);
  for (const root of REQUIRED_ROOTS) {
    const files = byRoot.get(root);
    assert(Array.isArray(files) && files.length > 0, `the walk covers ${root}/ (got ${files ? files.length : "no entry"} files)`);
  }
  const all = [...byRoot.values()].flat();
  assert(
    all.some((f) => /(^|\/)agent-examples\/[^/]+\/src\/index\.ts$/.test(f)),
    "a bundled example's entry module is in scope — the six live instances were exactly these files"
  );
  assert(all.some((f) => f.includes("/cli/src/")), "cli/src is in scope");
  assert(!all.some((f) => f.includes("node_modules")), "the walk never descends into node_modules");
}

{
  const viaDiscovery = [...discoverSourceFiles(ROOT).values()].flat().sort();
  const findArgs = ["-L", ...REQUIRED_ROOTS];
  for (const pruned of ["node_modules", "dist", "build", ".git", "coverage", ".turbo", ".next"]) {
    findArgs.push("-name", pruned, "-prune", "-o");
  }
  findArgs.push("-type", "f", "(");
  const exts = [".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx"];
  exts.forEach((ext, i) => {
    if (i > 0) findArgs.push("-o");
    findArgs.push("-name", `*${ext}`);
  });
  findArgs.push(")", "-print");
  const viaFind = execFileSync("find", findArgs, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((p) => join(ROOT, p))
    .sort();
  const onlyWalk = viaDiscovery.filter((f) => !viaFind.includes(f));
  const onlyFind = viaFind.filter((f) => !viaDiscovery.includes(f));
  assert(
    onlyWalk.length === 0 && onlyFind.length === 0,
    `discoverSourceFiles agrees with an independently-derived file list ` +
      `(walk-only: ${JSON.stringify(onlyWalk.slice(0, 5))}, find-only: ${JSON.stringify(onlyFind.slice(0, 5))})`
  );
}

{
  const dir = mkdtempSync(join(tmpdir(), "f1481-empty-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "a.mjs"), "export const a = 1;\n");
    let threw = false;
    try {
      scanRepo(dir, ["scripts", "contract"]);
    } catch (err) {
      threw = true;
      assert(/zero files/.test(err.message) && /contract/.test(err.message), `the empty-root error names the missing root (got: ${err.message})`);
    }
    assert(threw, "a root that exists in the config but not on disk throws rather than reporting a pass");

    let threwAll = false;
    try {
      scanRepo(mkdtempSync(join(tmpdir(), "f1481-void-")), ["scripts"]);
    } catch {
      threwAll = true;
    }
    assert(threwAll, "pointing the scan at a tree with no roots at all throws");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "f1481-unparseable-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "broken-syntax.mjs"), "function ( { this is not javascript\n");
    const { findings, unparseable } = scanRepo(dir, ["scripts"]);
    assert(unparseable.length === 1 && unparseable[0].file === "scripts/broken-syntax.mjs", `a syntax error is reported as unparseable, naming the file (got ${JSON.stringify(unparseable)})`);
    assert(findings.length === 0, "a syntax error is NOT reported as a bare import.meta.main finding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "f1481-scratch-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "broken.mjs"), "// a scratch file that should never ship\nif (import.meta.main) { console.log('ran'); }\n");
    writeFileSync(join(dir, "scripts", "clean.mjs"), "// mentions import.meta.main only in prose, and in a string: 'import.meta.main'\nconsole.log('fine');\n");
    writeFileSync(join(dir, "scripts", "broken.ts"), "const n: number = 1;\nif (import.meta.main) { console.log(n); }\n");
    const { filesScanned, findings } = scanRepo(dir, ["scripts"]);
    assert(filesScanned === 3, `all three scratch files are scanned (got ${filesScanned})`);
    const named = findings.map((f) => f.file).sort();
    assert(
      findings.length === 2 && named[0] === "scripts/broken.mjs" && named[1] === "scripts/broken.ts",
      `the scan reds exactly the files with a real bare guard, naming them (got: ${JSON.stringify(findings)})`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "f1488-guard-scratch-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "one-sided.mjs"),
      'import { realpathSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nif (realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) { console.log("ran"); }\n'
    );
    writeFileSync(
      join(dir, "scripts", "no-realpath.mjs"),
      'import { resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nif (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { console.log("ran"); }\n'
    );
    writeFileSync(
      join(dir, "scripts", "basename.mjs"),
      'import { basename } from "node:path";\nif (import.meta.url.endsWith(basename(process.argv[1]))) console.log("ran");\n'
    );
    writeFileSync(
      join(dir, "scripts", "correct.mjs"),
      'import { realpathSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst SELF = realpathSync(fileURLToPath(import.meta.url));\nconst ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";\nif (ENTRY === SELF) console.log("ran");\n'
    );
    writeFileSync(
      join(dir, "scripts", "alias-broken.mjs"),
      'import { resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst SELF = fileURLToPath(import.meta.url);\nconst ENTRY = process.argv[1] ? resolve(process.argv[1]) : "";\nif (ENTRY === SELF) console.log("ran");\n'
    );
    const { filesScanned, guardGaps, guardRelations } = scanRepo(dir, ["scripts"]);
    assert(filesScanned === 5, `all five scratch files are scanned (got ${filesScanned})`);
    const byFile = new Map(guardGaps.map((g) => [g.file, g.kind]));
    assert(
      guardGaps.length === 4 && !byFile.has("scripts/correct.mjs"),
      `only the four broken files red, the correct one does not (got: ${JSON.stringify(guardGaps)})`
    );
    assert(byFile.get("scripts/one-sided.mjs") === "one-sided-realpath", "one-sided-realpath is named and classified");
    assert(byFile.get("scripts/no-realpath.mjs") === "no-realpath", "no-realpath is named and classified");
    assert(byFile.get("scripts/basename.mjs") === "basename-comparison", "a basename compare is named and classified");
    assert(byFile.get("scripts/alias-broken.mjs") === "no-realpath", "an alias-routed broken guard is named and classified");
    assert(guardRelations === 5, `every guard is classified, sanctioned ones included (got ${guardRelations})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { filesScanned, findings, unparseable, guardGaps, guardRelations } = scanRepo(ROOT);
  assert(filesScanned > 0, "the real scan covers at least one file");
  assert(findings.length === 0, `no bare import.meta.main anywhere in scope (got: ${JSON.stringify(findings)})`);
  assert(unparseable.length === 0, `every file in scope actually parses (got: ${JSON.stringify(unparseable)})`);
  assert(
    guardGaps.length === 0,
    `no un-realpath'd or basename entry guard anywhere in scope (got: ${JSON.stringify(guardGaps)})`
  );
  assert(
    guardRelations >= 12,
    `the classifier actually SEES the repo's entry guards (got ${guardRelations} classified relations; ` +
      "zero or a handful means it went blind, not that the repo is clean)"
  );
}

{
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const COMMANDS = ["npm run lint\n", "npm run lint:test\n"];

  const steps = ci.split(/\n(?=      - )/);
  for (const command of COMMANDS) {
    const owning = steps.filter((step) =>
      step.split("\n").some((line) => {
        const code = line.trim();
        return !code.startsWith("#") && `${code}\n`.includes(command);
      })
    );
    assert(owning.length === 1, `exactly one uncommented CI step runs \`${command.trim()}\` (got ${owning.length})`);
    if (owning.length !== 1) continue;
    const step = owning[0];
    const commands = step
      .split("\n")
      .map((line) => line.trim().replace(/^-\s+/, ""))
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => (line.startsWith("run:") ? line.slice("run:".length).trim() : line))
      .filter((line) => line && line !== "|" && !/^[\w-]+:(\s|$)/.test(line))
      .filter((line) => line !== "set -euo pipefail");
    if (commands.length > 1) {
      assert(
        /set -euo pipefail/.test(step),
        `the multi-command step running \`${command.trim()}\` sets a failing shell mode, so an ` +
          `earlier failure is not swallowed by the ${commands.length - 1} command(s) after it`
      );
    }
    assert(!/continue-on-error/.test(step), `the step running \`${command.trim()}\` has no continue-on-error`);
    assert(!/\bif:\s*false\b/.test(step), `the step running \`${command.trim()}\` is not disabled`);
  }

  const scopeRegex = ci.match(/'\^\((?<alts>[^']+)\)'/)?.groups?.alts ?? "";
  for (const root of REQUIRED_ROOTS) {
    const top = `${root.split("/")[0]}/`;
    assert(scopeRegex.includes(top), `the heavy-suite scope regex selects on ${top}, a root this rule scans (regex: ${scopeRegex})`);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert(pkg.scripts.lint === "node scripts/lint.mjs", "package.json declares the lint runner");
  assert(
    pkg.scripts["lint:test"] === "node scripts/lint.mjs --run-tests",
    "package.json declares the case-table runner"
  );
  const registered = RULES.find((rule) => rule.name === "import-meta-main");
  assert(registered !== undefined, "the rule is in scripts/lint/rules.mjs, so the runner reaches it");
  assert(registered?.needsInstall === true, "the rule declares needsInstall, so --offline names it as skipped");
  assert(
    typeof pkg.devDependencies?.typescript === "string",
    "the parser this rule imports is a declared root devDependency, not a hoisting accident"
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("import-meta-main: all assertions passed.");
