#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for scripts/lint-no-bare-import-meta-main.mjs
// (extended for the realpath-both-sides entry-guard shape).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Every root the gate must cover, and one real file under each. */
const REQUIRED_ROOTS = ["scripts", "contract", "cli/src", "cli/scripts", "packages", "agent-examples"];

// ── findBareImportMetaMain: every real shape must red ───────────────────────
// Formatting cannot hide it: a line break, parens, optional chaining, negation,
// computed access, or a destructure straight off `import.meta` (with or without
// a rename) all have to be caught — exactly the forms a naive regex misses.
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
  // `...rest` hands the whole object over, so `rest.main` is reachable and the
  // guard is just as broken — the shape must not slip through as "no `main`".
  "destructured via rest": "const { ...rest } = import.meta;\nif (rest.main) run();",
  "assignment-expression destructure": "let main;\n({ main } = import.meta);",
  "assignment-expression spread": "let rest;\n({ ...rest } = import.meta);",
};
for (const [label, source] of Object.entries(REAL_SHAPES)) {
  const hits = findBareImportMetaMain(source);
  assert(hits.length > 0, `a real import.meta.main reference is caught: ${label} (source: ${JSON.stringify(source)})`);
}

// The live instances the first cut could not see were `.ts`, so the parser
// must read TypeScript syntax — not merely "not crash" on it. A JS-only parser
// fails on the type annotations here and would report the file as unparseable
// (or as clean), which is the silent skip this gate exists to prevent.
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

// ── the false positives a grep would produce, which parsing must not ────────
const FALSE_POSITIVES = {
  "line comment": "// import.meta.main\nconsole.log('ok');",
  "block comment": "/* uses import.meta.main historically */\nconsole.log('ok');",
  "string literal": "const s = 'import.meta.main';\nconsole.log(s);",
  "template literal": "const s = `guard is import.meta.main`;\nconsole.log(s);",
  // A generator that builds source text out of lines exactly like this emits
  // data, not a guard, and must stay green.
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

// A file mixing a real reference with a comment/string mention of the same text
// must still be caught by the real one.
{
  const mixed = "// import.meta.main is banned here\nif (import.meta.main) { run(); }\nconst s = 'import.meta.main';";
  const hits = findBareImportMetaMain(mixed);
  assert(hits.length === 1, `a real reference is caught even alongside comment/string mentions (got ${hits.length})`);
}

// ── findEntryGuardRealpathGaps: the realpath shapes, each its own verdict ───
// The sanctioned replacement for bare `import.meta.main` — comparing
// `process.argv[1]` against `import.meta.url` — has its own silent-skip shape
// when either side is not realpath'd. Node resolves symlinks before deriving
// `import.meta.url`, so an unresolved argv0 disagrees through a symlinked
// checkout and the guard falls false. Every shape a live instance shipped
// must red, tagged with which shape it is; the sanctioned form must not.
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
  // The shape that matters most, because it is the shape every FIXED instance
  // in this repo uses: argv0 and import.meta.url reach the comparison through
  // SELF/ENTRY consts. A checker that only searches the comparison's own
  // operands sees `ENTRY === SELF`, classifies no relation, and reports the
  // whole repo clean while seeing none of its guards — the vacuous pass this
  // milestone keeps re-shipping. Reverting the realpath on either side of the
  // sanctioned form must red.
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
  // Spellings of the same two reads. A gate asserting a PROPERTY has to cover
  // the spellings of that property, not only the ones that happened to ship.
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

// The sanctioned form — both sides realpath'd, no basename() anywhere — is
// NOT a finding, whether the leaves sit directly in the comparison or behind
// the SELF/ENTRY intermediate consts every fixed instance in this repo uses.
//
// The `fs.realpathSync` / `realpathSync.native` / `await realpath` rows are
// false-RED coverage, not padding: they are all the same act as the bare
// identifier, and a gate that reds three correct spellings out of four is a
// gate that gets deleted rather than obeyed.
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

// `relations` counts what the walk CLASSIFIED, sanctioned guards included. It
// exists so an empty `gaps` can be told apart from a blind checker: those two
// read identically in a CI log, and only one of them is a pass.
{
  const clean = findEntryGuardRealpathGaps(
    'const SELF = realpathSync(fileURLToPath(import.meta.url));\nconst ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";\nif (ENTRY === SELF) main();',
    "x.mjs"
  );
  assert(clean.relations === 1 && clean.gaps.length === 0, `a sanctioned guard is COUNTED, not just un-flagged (got ${JSON.stringify(clean)})`);
  const none = findEntryGuardRealpathGaps("console.log('nothing to see');", "x.mjs");
  assert(none.relations === 0 && none.gaps.length === 0, "a file with no entry guard classifies no relation");
}

// ── discoverSourceFiles: a directory walk, not a hand-kept list ─────────────
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

// `isDirectory()`/`isFile()` on a dirent are both FALSE for a symlink, so a
// walk keyed off the dirent alone silently skips a symlinked script — a skip
// that reads as a pass. This is the shape the gate itself is about.
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

// ── the scan roots cannot silently narrow ──────────────────────────────────
// This gate's own history is the argument for this assertion: one fix landed for
// `contract/run.mjs`, the same bug survived ten lines away under `scripts/`,
// and this gate's first cut then covered only those two roots while six live
// instances sat in `agent-examples/*/src/*.ts`. A root dropping out of the walk must
// red here rather than quietly stop being covered.
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

// Independent second derivation of the same file set, using `find` rather than
// the gate's own walk. If discovery silently stopped recursing (or started
// skipping an extension or a root) this comparison — not a hardcoded count — is
// what reds, so the floor moves with the tree. `-L` follows symlinks, matching
// the walk's statSync, so the two share no blind spot.
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

// ── scanRepo: an empty root is a hard failure, PER ROOT ────────────────────
// An aggregate floor is satisfied by `scripts/` alone, so relocating any other
// root would leave it unscanned while the gate still printed a pass.
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

    // And the aggregate case: nothing anywhere.
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

// ── an unparseable file is its own category, not a fake guard ──────────────
// typescript RECOVERS from syntax errors rather than throwing, so without an
// explicit diagnostics read an unreadable file scans "clean" — a skip that
// reads as a pass. It must also not be reported as a broken entry guard, which
// sends the reader looking for a guard that does not exist.
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

// ── scanRepo: break-on-purpose against a scratch fixture ───────────────────
// The break-on-purpose case, as an assertion: add a bare guard to
// a scratch file, and the scan must red naming that exact file — while a
// sibling that only MENTIONS the string must not.
{
  const dir = mkdtempSync(join(tmpdir(), "f1481-scratch-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "broken.mjs"), "// a scratch file that should never ship\nif (import.meta.main) { console.log('ran'); }\n");
    writeFileSync(join(dir, "scripts", "clean.mjs"), "// mentions import.meta.main only in prose, and in a string: 'import.meta.main'\nconsole.log('fine');\n");
    // The `.ts` half of the same break, since that is where the live ones were.
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

// ── scanRepo: realpath break-on-purpose, one scratch file per shape ───────
// The break-on-purpose matrix: a one-sided-realpath guard, a
// no-realpath guard, and a basename guard added to a scratch script each red
// naming that exact file; a correct both-sides-realpath'd guard next to them
// does not.
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
    // The regression for the blind spot itself: the sanctioned SELF/ENTRY
    // shape with its realpath removed. This is what a future author writes
    // when they copy a fixed sibling and drop a call, and it is the shape the
    // gate saw nothing at all in before.
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
    // The correct file's guard is COUNTED even though it is not a finding —
    // five files, five guards, so the relation floor sees all of them.
    assert(guardRelations === 5, `every guard is classified, sanctioned ones included (got ${guardRelations})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the shipped repo is clean ────────────────────────────────────────────
// The regression that matters most: what would have caught
// scripts/probe-twin-endpoints.mjs and the six examples shipping a bare
// guard, and the ten entry-guard-realpath instances plus the two
// basename ones.
{
  const { filesScanned, findings, unparseable, guardGaps, guardRelations } = scanRepo(ROOT);
  assert(filesScanned > 0, "the real scan covers at least one file");
  assert(findings.length === 0, `no bare import.meta.main anywhere in scope (got: ${JSON.stringify(findings)})`);
  assert(unparseable.length === 0, `every file in scope actually parses (got: ${JSON.stringify(unparseable)})`);
  assert(
    guardGaps.length === 0,
    `no un-realpath'd or basename entry guard anywhere in scope (got: ${JSON.stringify(guardGaps)})`
  );
  // The floor on the assertion above, and the whole reason `guardRelations`
  // exists. `guardGaps.length === 0` over the real repo is satisfied both by
  // "every guard realpaths both sides" and by "the classifier recognized no
  // guard at all", and the second is how a floor can ship
  // dead. The repo has one guard per runnable script; the twelve that were fixed
  // ones alone put the count above 12, so a bound well under the real number
  // reds on a classifier going blind without reding on someone deleting a
  // script.
  assert(
    guardRelations >= 12,
    `the classifier actually SEES the repo's entry guards (got ${guardRelations} classified relations; ` +
      "zero or a handful means it went blind, not that the repo is clean)"
  );
}

// ── the rule is actually wired into CI, in a step that can fail ────────────
// Asserting `ci.includes("npm run lint")` is satisfied by a COMMENTED-OUT line,
// by the command sitting in a job that never runs, and by `set -euo pipefail`
// appearing anywhere else in the file (it appears in the scope step at the top).
// Locate the OWNING step and assert on that.
//
// The commands here are the RUNNER's, not this rule's: consolidation means this
// rule has no npm script and no CI step of its own. What still has to hold is
// that the runner runs somewhere it can fail, and — because this rule needs
// `typescript` and is therefore skipped by `--offline` — that the run covering
// it is the one with NO `--offline`. A repo where only the offline invocation
// survived would skip this rule entirely while every other assertion here
// stayed green.
{
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  // Newline-terminated so `npm run lint` does not also match
  // `npm run lint -- --offline` or `npm run lint:test`.
  const COMMANDS = ["npm run lint\n", "npm run lint:test\n"];

  // Steps start at a `      - ` list item within a job's `steps:`.
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
    // The property is that a failure REACHES the step's conclusion, not that any
    // particular shell line is present. Which check proves that depends on the
    // step's shape, so derive the shape rather than assuming one:
    //
    //   one command   → the step's exit code IS the command's (Actions runs
    //                   `bash -e {0}`), so nothing can swallow it.
    //   many commands → an earlier failure is swallowed by the commands after
    //                   it unless the block sets a failing shell mode.
    //
    // Asserting `set -euo pipefail` unconditionally would demand a shell line
    // that does nothing on a one-command step, which is how this assertion read
    // when every command in the heavy suite shared one 60-line block.
    // Text, not YAML, deliberately — same reason the search above is textual: a
    // commented-out command has to stay visible. `run: <cmd>` contributes its
    // inline tail; a `run: |` block contributes each of its lines; every other
    // mapping key (`name:`, `if:`, `env:`, `with:`) contributes nothing.
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

  // It lives behind the heavy gate (it needs `npm ci` for the parser), so the
  // scope regex MUST classify a diff to any scanned root as heavy — otherwise
  // the rule is path-filtered away from the very changes that could trip it.
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
  // The registry is a list of static imports rather than a glob, so an
  // unregistered rule is not a rule that runs quietly — it is one that does not
  // run at all, and `--offline` has to NAME it as skipped rather than drop it.
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
