// SPDX-License-Identifier: Apache-2.0
//
// no-catch-and-continue gate (F-745 / D4) — §3.A code-health, SDK ENGINE ONLY.
//
// `packages/sdk` is the twin engine: the recorder, auth, MCP JSON-RPC, and
// server plumbing every hosted twin runs on. A `catch` that logs-and-continues
// (or silently swallows) here is how a mutation gets recorded as a success, a
// forged token slips past bearer auth, or a half-written trace is served as
// clean. So every statement-level `catch` clause body in the engine must do
// ONE of three things — no exceptions the reviewer has to trust:
//
//   • `throw`   — rethrow (possibly wrapped); the failure keeps propagating.
//   • `return`  — hand back an explicit error response / envelope, or a
//                 DOCUMENTED sentinel (`undefined` / `null`) the caller checks.
//   • `reject(` — settle the surrounding Promise as failed.
//
// A catch body that does none of these is "catch-and-continue": execution falls
// out of the block and keeps going as if nothing broke. That is the exact bug
// class this gate forbids.
//
// ALLOWLIST (D4) — target EMPTY, currently TWO entries. F-745's plan assumed
// every engine catch would satisfy the rule literally; two do not, because they
// handle the error by ASSIGNING an explicit error result to an outer-scoped
// variable and FALLING THROUGH to a single shared record()/return below the
// try/catch, rather than exiting from inside the clause:
//
//   • mcp-jsonrpc.ts (handleToolsCall) — the catch builds the JSON-RPC error
//     envelope (status/responseBody/toolError/mcpResult) that the function
//     then records and returns; it mirrors the sibling `if (!tool)` branch,
//     which assigns the same four variables. Making the catch `return` would
//     force duplicating the shared record()+return.
//   • failure-injection.ts (before_handler) — the catch sets the optional
//     request-body snapshot to null (the value it records) when the body can't
//     be re-read; the same read-optional-default-null shape recorder.ts already
//     factors into a `try { return … } catch { return null }` helper.
//
// Both are genuine error handling, NOT log-and-continue/empty swallows, so they
// are listed here (keyed `relpath:line`) rather than papered over. To reach
// true zero-allowlist a reviewer can extract the mcp result into a helper that
// returns the outcome, and reuse recorder.ts's read-or-null helper in
// failure-injection — then delete these two lines. NOTE: the keys are line
// numbers; if either file is edited above the catch, update the line here.
//
// SCOPE — deliberately narrow, to stay a zero-false-positive structural gate:
//
//   • Only `packages/sdk/src/**/*.ts` (the engine). Twins, the CLI, and
//     shared-types are out of scope for THIS gate (barrel-policy + file-size
//     health live in scripts/lint-code-health.mjs; shared-types is F-754).
//   • Only STATEMENT try/catch. Promise `.catch(cb)` handlers are a different
//     construct with their own idioms (e.g. `.json().catch(() => ({}))` in
//     parity.ts is a legitimate default-on-parse-fail) and are NOT flagged.
//     The `\bcatch\b\s*(\(...\))?\s*\{` shape only matches a catch *clause*,
//     never a `.catch(` method call (the `.` before it fails the `\b`... — and
//     the method form is `catch(` with an arg list, not `catch {` / `catch (e) {`).
//
// The keyword scan runs against a comment-and-literal-STRIPPED copy of the
// source (line/block comments, single/double/template strings, and regex
// literals are blanked to spaces, newlines preserved) so:
//   • a comment that says the word "catch" / "return" / "throw" never trips or
//     satisfies the gate (there are several: index.ts, server.ts, ...), and
//   • a brace, backtick, or quote inside a string/regex can't desync the
//     brace matcher.
// Stripping preserves byte offsets 1:1, so reported line numbers are exact.
//
// LIMITATIONS (honest): this is a structural scanner, not a data-flow analyzer.
// A body that contains `return` inside a NESTED try/catch counts for the OUTER
// catch too — acceptable: the requirement is that the body has a definite exit
// path, and a nested handler that itself throws/returns provides one. A body
// that computes an error result and falls through to a shared `return` after
// the try/catch would read as compliant even though the `return` is outside the
// clause; the engine doesn't do this, and the gate favors a rule a reviewer can
// verify by eye over a heuristic that guesses intent.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The engine surface this gate governs (relative to the repo root).
const SCAN_DIR = "packages/sdk/src";

// File extensions to scan. The engine is authored in TypeScript.
const SCANNED_EXT_RE = /\.ts$/;

// Directory names skipped at ANY depth. node_modules/dist are build/install
// output; test/fixtures dirs legitimately embed catch-and-continue snippets as
// gate fixtures (this file's own unit test does exactly that in a tmp dir).
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "test", "tests", "__fixtures__", "fixtures"]);

// ALLOWLIST (D4): `relpath:line` of a catch clause that is a reviewed,
// documented exception. See the module header for why each is here and how to
// remove it. Target: EMPTY. Fix (or refactor) the catch; don't grow this list.
const ALLOWLIST = new Set([
  "packages/sdk/src/mcp-jsonrpc.ts:182",
  "packages/sdk/src/failure-injection.ts:163",
]);

// A catch clause body must contain at least one of these to prove it has a
// definite failure-exit path (matched against stripped source).
const EXIT_PATTERNS = [/\bthrow\b/, /\breturn\b/, /\breject\s*\(/];

// Matches a STATEMENT catch clause header up to (and including) its opening
// brace: `catch {`, `catch (e) {`, `catch (e: unknown) {`. The `\bcatch\b`
// never matches `.catch(` (method call): that form has no `{` after the arg
// list, and the `(` opens an argument list, not an optional binding.
const CATCH_CLAUSE_RE = /\bcatch\b\s*(?:\([^)]*\))?\s*\{/g;

/**
 * Scan the SDK engine for catch-and-continue clauses. Returns a list of
 * human-readable violation strings (empty when the engine is clean).
 * @param {string} root Absolute path to the pome-twins repo root.
 * @returns {Promise<string[]>}
 */
export async function findViolations(root) {
  const violations = [];
  const dir = join(root, SCAN_DIR);
  if (existsSync(dir) && (await stat(dir)).isDirectory()) {
    await walk(dir, root, violations);
  }
  return violations;
}

async function walk(dir, root, violations) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walk(full, root, violations);
    } else if (entry.isFile() && SCANNED_EXT_RE.test(entry.name)) {
      await scanFile(full, root, violations);
    }
  }
}

async function scanFile(file, root, violations) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const source = await readFile(file, "utf8");
  const stripped = stripCommentsAndLiterals(source);

  CATCH_CLAUSE_RE.lastIndex = 0;
  let match;
  while ((match = CATCH_CLAUSE_RE.exec(stripped)) !== null) {
    // Index of the `{` that opens the clause body (end of the matched header).
    const openBrace = match.index + match[0].length - 1;
    const body = extractBraceBlock(stripped, openBrace);
    if (body === null) continue; // unbalanced (truncated file) — nothing to judge
    if (EXIT_PATTERNS.some((re) => re.test(body))) continue;
    const line = lineNumberAt(stripped, match.index);
    if (ALLOWLIST.has(`${rel}:${line}`)) continue;
    violations.push(
      `${rel}:${line}: catch clause body does not throw, return, or reject — a catch-and-continue in the twin engine silently swallows the failure and keeps executing. Rethrow it, return an error response/envelope (or a documented undefined/null sentinel), or reject the surrounding Promise.`,
    );
  }
}

/**
 * Return the substring strictly inside the braces starting at `openIndex`
 * (which must point at a `{`), matching nesting. Returns null if unbalanced.
 */
function extractBraceBlock(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Blank out comments, string/template literals, and regex literals — replacing
 * their characters with spaces and preserving newlines — so byte offsets stay
 * 1:1 with the source and the brace/keyword scan sees only real code tokens.
 *
 * A single character-level state machine. Regex-vs-division is disambiguated by
 * the previous significant character (a `/` starts a regex only where a value
 * cannot already have appeared).
 */
function stripCommentsAndLiterals(src) {
  const out = new Array(src.length);
  let i = 0;
  let prevSig = ""; // last emitted significant (non-whitespace) source char
  const n = src.length;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = src[k] === "\n" ? "\n" : " ";
  };
  const keep = (k) => {
    out[k] = src[k];
    if (!/\s/.test(src[k])) prevSig = src[k];
  };

  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";

    // Line comment.
    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment.
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    // String / template literal.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      prevSig = quote; // a literal is a value; a following `/` is division
      i = j;
      continue;
    }
    // Regex literal — only where a `/` cannot be a division operator.
    if (ch === "/" && regexAllowedAfter(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // regex can't span lines — bail, treat as not-regex
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        // consume trailing flags (a-z)
        while (j < n && /[a-z]/i.test(src[j])) j++;
        blank(i, j);
        prevSig = "/"; // the regex is a value
        i = j;
        continue;
      }
      // Not actually a regex (unterminated on the line) — treat `/` as code.
    }

    keep(i);
    i++;
  }

  return out.join("");
}

/**
 * A `/` begins a regex literal (not division) when the previous significant
 * character is empty (start of input) or a punctuator after which a value —
 * not a binary operand — is expected. After an identifier, number, `)`, `]`,
 * `}`, or `.` a `/` is division.
 */
function regexAllowedAfter(prevSig) {
  if (prevSig === "") return true;
  return "([{,;:!&|?=+-*%<>~^".includes(prevSig);
}

// Run as a script (not when imported by the test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await findViolations(root);
  if (violations.length > 0) {
    console.error("no-catch-and-continue gate FAILED — the SDK engine has catch-and-continue clauses:\n");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nEvery catch in packages/sdk must throw, return an error response/envelope (or a documented undefined/null sentinel), or reject the surrounding Promise. Swallowing a failure in the twin engine records broken state as success.",
    );
    process.exit(1);
  }
  console.log("no-catch-and-continue gate passed — every SDK-engine catch has a definite failure-exit path.");
}
