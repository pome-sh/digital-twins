#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// 470 lines of hand-rolled lexer, so most of this table is about the lexer
// rather than the rule: the cases that matter are the ones where a naive scan
// gets it backwards. A `.catch()` promise handler is not a catch clause and a
// regex literal's unbalanced brace is not a block delimiter (both false reds,
// and a rule with false reds gets deleted); an exit inside a function DEFINED
// in the catch body does not exit the catch, and a template literal must not
// swallow the code inside its `${}` (both false greens, which is worse).
//
// Folded in from `cli/test/unit/no-catch-and-continue.test.ts`, a vitest suite
// that asserted the same predicate from a third place.

import { defineCases } from "../harness.mjs";

const SRC = "packages/sdk/src/thing.ts";
/** The reviewed assign-and-fall-through shape the allowlist exists for. */
const FALL_THROUGH = (assignment) =>
  [
    `export async function f() {`,
    `  let toolError = null;`,
    `  let status = 200;`,
    `  try {`,
    `    status = await risky();`,
    `  } catch (err) {`,
    `    ${assignment}`,
    `    status = 500;`,
    `  }`,
    `  record(status, toolError);`,
    `  return status;`,
    `}`,
  ].join("\n");

const wrap = (body) => `export async function run() {\n  try {\n    await work();\n  } catch (err) {\n${body}\n  }\n}\n`;

defineCases("no-catch", [
  {
    name: "a catch that rethrows passes",
    files: { [SRC]: wrap("    throw err;") },
    expect: "green",
  },
  {
    name: "a catch that returns an error envelope passes",
    files: { [SRC]: wrap("    return { ok: false, error: String(err) };") },
    expect: "green",
  },
  {
    name: "a catch that rejects passes",
    files: { [SRC]: wrap("    reject(err);") },
    expect: "green",
  },
  {
    name: "a catch that swallows is a violation, named with its line",
    files: { [SRC]: wrap("    console.warn(err);") },
    expect: "red",
    contains: [`${SRC}:4`, "does not throw, return, or reject"],
  },
  {
    name: "a bare `catch {}` with no binding is still a catch clause",
    files: { [SRC]: `export function run() {\n  try { work(); } catch { }\n}\n` },
    expect: "red",
    contains: "does not throw, return, or reject",
  },
  {
    // A `.catch()` promise handler is not a statement catch clause. A false red
    // here is how the rule gets deleted.
    name: "a `.catch()` promise handler is not a catch clause",
    files: { [SRC]: `export const run = () => work().catch((err) => log(err));\n` },
    expect: "green",
  },
  {
    // The exit is inside a callback DEFINED in the catch body, so it does not
    // exit the catch. This is the false-green a naive token scan produces.
    name: "an exit inside a nested function does not count as the catch's exit",
    files: { [SRC]: wrap("    queue.push(() => { throw err; });") },
    expect: "red",
    contains: "does not throw, return, or reject",
  },
  {
    // Only `packages/sdk/src` is the engine surface this rule governs.
    name: "a swallowing catch outside the SDK engine is out of scope",
    files: { "packages/twin-x/src/thing.ts": wrap("    console.warn(err);") },
    expect: "green",
  },
  {
    name: "the SDK's own test tree is out of scope",
    files: { "packages/sdk/src/test/thing.ts": wrap("    console.warn(err);") },
    expect: "green",
  },
  {
    name: "the word `catch` in a comment or a string is not a catch clause",
    files: { [SRC]: `// a catch here\nexport const s = "catch that";\nexport const t = \`catch\`;\n` },
    expect: "green",
  },
  {
    name: "a `.catch(function () {})` handler is excluded by the dot too",
    files: { [SRC]: `export const run = () => work().catch(function (err) { log(err); });\n` },
    expect: "green",
  },
  {
    // A nested template must not desync the brace matcher.
    name: "nested template literals do not desync the lexer",
    files: {
      [SRC]: [
        `export function f(x) {`,
        "  const s = `a${`b${x}c`}d`;",
        `  try {`,
        `    return risky(s);`,
        `  } catch {`,
        `    return undefined;`,
        `  }`,
        `}`,
      ].join("\n"),
    },
    expect: "green",
  },
  {
    // ...and must not hide the code inside its own `${}` either.
    name: "a catch-and-continue INSIDE a template ${} expression is still seen",
    files: {
      [SRC]: [
        "export const s = `v${(() => {",
        `  try {`,
        `    return risky();`,
        `  } catch (e) {`,
        `    console.error(e);`,
        `  }`,
        `  return 0;`,
        "})()}w`;",
      ].join("\n"),
    },
    expect: "red",
    contains: "does not throw, return, or reject",
  },
  {
    // An unbalanced `}` inside a regex literal would desync a brace matcher that
    // did not strip regexes after a keyword.
    name: "a regex literal's braces do not desync the lexer",
    files: {
      [SRC]: [
        `export function f(s) {`,
        `  if (s === "x") return /a{2}/.test(s);`,
        `  if (s === "y") return /^}/.test(s);`,
        `  try {`,
        `    return risky(s);`,
        `  } catch {`,
        `    return false;`,
        `  }`,
        `}`,
      ].join("\n"),
    },
    expect: "green",
  },
  {
    // `throw` must be the KEYWORD: `gen.throw(e)` is a property call that does
    // not exit the catch.
    name: "a `.throw` property call is not an exit",
    files: { [SRC]: wrap("    gen.throw(err);") },
    expect: "red",
    contains: "does not throw, return, or reject",
  },
  {
    name: "`throwaway` and `returnValue` identifiers are not exits",
    files: { [SRC]: wrap("    const throwaway = 1;\n    const returnValue = 2;\n    log(throwaway, returnValue);") },
    expect: "red",
    contains: "does not throw, return, or reject",
  },
  {
    name: "a top-level throw after a nested function definition still counts",
    files: { [SRC]: wrap("    queue.push(() => log(err));\n    throw err;") },
    expect: "green",
  },
  {
    name: "a destructured catch binding is still a catch clause",
    files: { [SRC]: `export function run() {\n  try { work(); } catch ({ message }) { log(message); }\n}\n` },
    expect: "red",
    contains: "does not throw, return, or reject",
  },
  {
    // The allowlist is keyed by file AND a body fingerprint, not a line number:
    // the same fall-through shape in the RIGHT file with the fingerprint passes.
    name: "allowlist: a fingerprint match in the named file passes",
    files: { "packages/sdk/src/mcp-jsonrpc.ts": FALL_THROUGH('toolError = err instanceof Error ? err.message : "x";') },
    expect: "green",
  },
  {
    name: "allowlist: the same shape in another file is still flagged",
    files: { "packages/sdk/src/other.ts": FALL_THROUGH("toolError = String(err);") },
    expect: "red",
    contains: "packages/sdk/src/other.ts",
  },
]);
