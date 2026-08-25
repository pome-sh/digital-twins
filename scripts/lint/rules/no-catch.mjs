// SPDX-License-Identifier: Apache-2.0
//
// no-catch — SDK engine only.
//
// `packages/sdk` is the twin engine: the recorder, auth, MCP JSON-RPC, and
// server plumbing every hosted twin runs on. A `catch` that logs-and-continues
// (or silently swallows) here is how a mutation gets recorded as a success, a
// forged token slips past bearer auth, or a half-written trace is served as
// clean. So every statement-level `catch` clause body in the engine must do
// ONE of three things — no exceptions the reviewer has to trust:
//
//   • `throw`   — the KEYWORD (a `.throw(…)` property call, e.g. on a
//                 generator, does NOT count — nor does an identifier like
//                 `throwaway`); the failure keeps propagating.
//   • `return`  — the KEYWORD (`returnValue` / `.return(` do not count): hand
//                 back an explicit error response / envelope, or a DOCUMENTED
//                 sentinel (`undefined` / `null`) the caller checks.
//   • `reject(` — a BARE `reject(…)` call (not `.reject(`): settle the
//                 surrounding Promise as failed.
//
// A catch body that does none of these is "catch-and-continue": execution falls
// out of the block and keeps going as if nothing broke. That is the exact bug
// class this gate forbids.
//
// ALLOWLIST — target EMPTY, currently TWO entries. Both handle the error by
// assigning an explicit error result to an outer-scoped variable and falling
// through to a single shared record()/return below the try/catch, rather than
// exiting from inside the clause:
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
// Both are genuine error handling, not log-and-continue, so they are listed
// rather than papered over. Entries are keyed by FILE plus a CONTENT
// FINGERPRINT — a distinctive substring that must appear in that catch clause's
// whitespace-normalized, literal-stripped body — never by line number, so an
// entry survives edits elsewhere in the file and cannot be satisfied by an
// unrelated catch. To reach zero entries, extract the
// mcp result into a helper that returns the outcome, and reuse recorder.ts's
// read-or-null helper in failure-injection — then delete the two entries.
//
// SCOPE — deliberately narrow, to stay a zero-false-positive structural gate:
//
//   • Only `packages/sdk/src/**/*.ts` (the engine). Twins, the CLI, and
//     the wire/contract barrels are out of scope for THIS gate (barrel-policy
//     + file-size health live in scripts/lint/rules/file-size.mjs).
//   • Only STATEMENT try/catch. Promise `.catch(cb)` handlers are a different
//     construct with their own idioms (e.g. `.json().catch(() => ({}))` in
//     parity.ts is a legitimate default-on-parse-fail) and are NOT flagged.
//     The finder requires the character before `catch` to be neither `.` nor
//     an identifier character, then an OPTIONAL balanced-paren binding (plain
//     `catch {`, `catch (e) {`, destructured `catch ({ message }) {`), then a
//     `{` — so `.catch(cb)` (dotted) and any bare `catch(…)` call whose
//     argument list is not followed by a block are never treated as a clause.
//
// The scan runs against a comment-and-literal-STRIPPED copy of the source, so a
// comment or string saying "catch" / "return" / "throw" can neither trip nor
// satisfy the gate, and a brace or quote inside a literal cannot desync the
// brace matcher. One mode-stack state machine handles comments, quoted strings,
// template literals with full `${}` nesting (template text blanked, code inside
// an expression kept and scanned), and regex literals detected by the preceding
// TOKEN rather than the previous character — so `return /a{2}/` is stripped and
// its braces cannot corrupt brace matching while `a / b` stays division.
// Blanked spans are replaced character-for-character with spaces, newlines
// preserved, so byte offsets and reported line numbers stay exact.
//
// NESTED FUNCTIONS DON'T COUNT: before the exit scan, the bodies of function
// expressions DEFINED inside the catch clause (`=> { … }` arrow blocks and
// `function [name](…) { … }` expressions) are masked out. A `return` inside
// `catch (e) { const f = () => { return; }; log(e); }` exits f when f is later
// CALLED — it is not an exit path of the catch clause itself, so that clause
// is flagged. A top-level `throw`/`return`/`reject(` after such a definition
// still counts. (A nested statement try/catch is NOT masked: its handler runs
// inline at the catch's own level, so an exit there is a real exit path.)
//
// LIMITATIONS. This is a structural scanner, not a data-flow analyzer, and a
// CONDITIONAL exit is accepted by design:
//   catch (err) { if (shouldRethrow(err)) throw err; console.error(err); }
// passes, because an exit token exists at the clause's own level even though the
// else-path falls through. Deciding whether EVERY branch exits needs full
// control-flow analysis, which is out of scope for a dependency-free
// pre-`npm ci` lint; a conditional swallow is deliberate, visible, reviewable
// code whose semantics belong to the PR reviewer.
//
// Concise method shorthand in an object literal inside a catch body is not
// masked — only arrow blocks and `function` expressions are. A body that
// computes an error result and falls through to a shared `return` after the
// try/catch reads as a violation even when legitimate; that shape is what the
// fingerprint allowlist is for. The regex-versus-division heuristic can misread
// a degenerate `a++ / b` as a regex start. The gate favours a rule a reviewer
// can verify by eye over a full parser.

// The engine surface this rule governs (relative to the repo root).
const SCAN_DIR = "packages/sdk/src";

// Directory names skipped at ANY depth. node_modules/dist are build/install
// output; test/fixtures dirs legitimately embed catch-and-continue snippets as
// fixtures (this rule's own case table does exactly that in a tmp dir).
const SKIP_DIRS = ["node_modules", "dist", "build", ".git", "coverage", "test", "tests", "__fixtures__", "fixtures"];

// ALLOWLIST: reviewed, documented assign-and-fall-through exceptions.
// `file` is the repo-root-relative path; `bodyIncludes` is a distinctive
// substring that must appear in the catch clause's whitespace-normalized,
// literal-stripped body. See the module header for why each is here and how
// to remove it. Target: EMPTY. Fix (or refactor) the catch; don't grow this.
const ALLOWLIST = [
  {
    file: "packages/sdk/src/mcp-jsonrpc.ts",
    bodyIncludes: "toolError = err instanceof Error",
  },
  {
    file: "packages/sdk/src/failure-injection.ts",
    bodyIncludes: "requestBody = null",
  },
];

// A catch clause body must contain at least one of these to prove it has a
// definite failure-exit path (matched against the stripped body AFTER nested
// function-expression bodies are masked — see maskNestedFunctionBodies).
// `throw` and `return` must be the KEYWORD — not preceded by `.` (property
// access such as `gen.throw(e)`) and not a prefix of a longer identifier
// (`throwaway`, `returnValue`). `reject(` must be a bare call, not `.reject(`.
const EXIT_PATTERNS = [
  /(^|[^.\w$])throw(?![\w$])/,
  /(^|[^.\w$])return(?![\w$])/,
  /(^|[^.\w$])reject\s*\(/,
];

// Candidate catch KEYWORDS: `catch` not preceded by `.` or an identifier char
// (excludes `.catch(` promise handlers and identifiers like `mycatch`), not
// followed by an identifier char (excludes `catchAll`). Whether a candidate is
// a real catch CLAUSE is decided structurally by findCatchBodyBrace().
const CATCH_KEYWORD_RE = /(^|[^.\w$])catch(?![\w$])/g;

/**
 * Every catch-and-continue clause in one file. Returns human-readable violation
 * strings (empty when the file is clean). Exported for the rule's case table.
 * @param {string} rel Repo-root-relative path, used in the message.
 * @param {string} source The file's contents.
 * @returns {string[]}
 */
export function findViolationsIn(rel, source) {
  const violations = [];
  const stripped = stripCommentsAndLiterals(source);

  CATCH_KEYWORD_RE.lastIndex = 0;
  let match;
  while ((match = CATCH_KEYWORD_RE.exec(stripped)) !== null) {
    const kwIndex = match.index + match[1].length;
    const openBrace = findCatchBodyBrace(stripped, kwIndex + "catch".length);
    if (openBrace === -1) continue; // not a statement catch clause
    const body = extractBraceBlock(stripped, openBrace);
    if (body === null) continue; // unbalanced (truncated file) — nothing to judge
    // An exit inside a function DEFINED in the catch body doesn't exit the
    // catch — mask nested function bodies before looking for exit tokens.
    const exitScanText = maskNestedFunctionBodies(body);
    if (EXIT_PATTERNS.some((re) => re.test(exitScanText))) continue;
    const normalizedBody = body.replace(/\s+/g, " ").trim();
    if (ALLOWLIST.some((a) => a.file === rel && normalizedBody.includes(a.bodyIncludes))) continue;
    const line = lineNumberAt(stripped, kwIndex);
    violations.push(
      `${rel}:${line}: catch clause body does not throw, return, or reject — a catch-and-continue in the twin engine silently swallows the failure and keeps executing. Rethrow it, return an error response/envelope (or a documented undefined/null sentinel), or reject the surrounding Promise.`,
    );
  }
  return violations;
}

/**
 * Given the index just past a candidate `catch` keyword, decide whether it is
 * a statement catch CLAUSE and return the index of the `{` opening its body,
 * or -1. Accepts an optional balanced-paren binding — `catch {`, `catch (e) {`,
 * `catch ({ message }) {`, `catch (e: unknown) {` — with nested parens/braces
 * inside the binding handled by paren counting.
 */
function findCatchBodyBrace(text, from) {
  const n = text.length;
  let i = from;
  while (i < n && /\s/.test(text[i])) i++;
  if (text[i] === "(") {
    let depth = 0;
    while (i < n) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    while (i < n && /\s/.test(text[i])) i++;
  }
  return text[i] === "{" ? i : -1;
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

// Openers of nested function-expression bodies inside a (stripped) catch body:
// an arrow block `=> {` (the `{` may follow whitespace), or a `function`
// KEYWORD (`function (…) {`, `function name(…) {`, `function* (…) {`) — same
// non-dot/non-identifier guard as the other keyword matchers.
const NESTED_FN_RE = /=>\s*\{|(^|[^.\w$])function(?![\w$])/g;

/**
 * Blank the bodies of function expressions defined INSIDE a catch clause body
 * (arrow `=> { … }` blocks and `function [name](…) { … }` expressions), brace-
 * matched, so an exit token inside them is not credited to the catch clause
 * itself: that code runs only if the function is later called. The masked text
 * is used ONLY for exit detection; the unmasked body still drives allowlist
 * fingerprinting. Input is stripped source, so literal braces can't mislead
 * the matcher. Nested functions inside an already-masked block are skipped by
 * resuming the scan past the block.
 */
function maskNestedFunctionBodies(body) {
  const out = body.split("");
  NESTED_FN_RE.lastIndex = 0;
  let m;
  while ((m = NESTED_FN_RE.exec(body)) !== null) {
    let open = -1;
    if (m[0].startsWith("=>")) {
      open = m.index + m[0].length - 1; // the `{` ending the arrow match
    } else {
      // `function` keyword: skip optional `*`, optional name, then require a
      // balanced-paren parameter list followed by `{`.
      let j = m.index + m[0].length;
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] === "*") {
        j++;
        while (j < body.length && /\s/.test(body[j])) j++;
      }
      while (j < body.length && /[\w$]/.test(body[j])) j++; // optional name
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] !== "(") continue;
      let depth = 0;
      while (j < body.length) {
        if (body[j] === "(") depth++;
        else if (body[j] === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] !== "{") continue;
      open = j;
    }
    // Brace-match the function body and blank its interior.
    let depth = 0;
    let close = -1;
    for (let k = open; k < body.length; k++) {
      if (body[k] === "{") depth++;
      else if (body[k] === "}") {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close === -1) continue; // unbalanced — leave as-is
    for (let k = open + 1; k < close; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
    NESTED_FN_RE.lastIndex = close; // resume past the masked block
  }
  return out.join("");
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

// Marker token: a string/template/regex literal just ended — it is a VALUE, so
// a following `/` is division, never a regex start. (Contains a space, so it
// can never collide with a real token.)
const VALUE_TOKEN = " value";

// Keywords after which a `/` begins a regex literal (a value is expected next,
// not a binary operand).
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "instanceof",
  "new",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * A `/` begins a regex literal (not division) when the previous significant
 * TOKEN is: nothing (start of input / start of a `${}` expression), a keyword
 * from REGEX_PRECEDING_KEYWORDS, or an opening punctuator / operator. After an
 * identifier, a number, a closing bracket, `.`, or a just-ended literal
 * (VALUE_TOKEN), a `/` is division.
 */
function regexAllowedAfter(token) {
  if (token === "") return true;
  if (token === VALUE_TOKEN) return false;
  if (REGEX_PRECEDING_KEYWORDS.has(token)) return true;
  return token.length === 1 && "([{,;:!&|?=+-*%<>~^".includes(token);
}

/**
 * From `src[start] === "/"` presumed to open a regex literal, return the index
 * just past the closing `/` and its flags, or -1 if no closing `/` on the same
 * line (then it wasn't a regex). Char classes may contain unescaped `/`.
 */
function scanRegexEnd(src, start) {
  const n = src.length;
  let j = start + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return -1; // regex literals can't span lines
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++; // trailing flags
      return j;
    }
    j++;
  }
  return -1;
}

/**
 * Blank out comments, string literals, template-literal TEXT, and regex
 * literals — replacing their characters with spaces, preserving newlines — so
 * byte offsets stay 1:1 with the source and the brace/keyword scan sees only
 * real code tokens. Code inside template `${}` expressions is KEPT (and
 * scanned), with a mode stack tracking arbitrary template/expression nesting;
 * the `${` and its matching `}` are blanked so output braces stay balanced.
 */
function stripCommentsAndLiterals(src) {
  const n = src.length;
  const out = new Array(n);
  // Mode stack: { type: "template" } while inside template TEXT;
  // { type: "expr", depth } while inside a `${ … }` expression (depth counts
  // nested code braces so the `}` that closes the `${` is identified exactly).
  const stack = [];
  let word = ""; // identifier/keyword/number token being accumulated
  let prevToken = ""; // last completed significant token ("" at start)

  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = src[k] === "\n" ? "\n" : " ";
  };
  const endWord = () => {
    if (word !== "") {
      prevToken = word;
      word = "";
    }
  };
  const noteValue = () => {
    endWord();
    prevToken = VALUE_TOKEN;
  };
  const currentToken = () => (word !== "" ? word : prevToken);

  let i = 0;
  while (i < n) {
    const mode = stack.length > 0 ? stack[stack.length - 1] : null;

    // ── Template TEXT: blank everything until `` ` `` (pop) or `${` (push expr).
    if (mode !== null && mode.type === "template") {
      const ch = src[i];
      if (ch === "\\") {
        blank(i, Math.min(n, i + 2));
        i += 2;
        continue;
      }
      if (ch === "`") {
        blank(i, i + 1);
        stack.pop();
        noteValue(); // the whole template is a value
        i++;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        blank(i, i + 2); // blank `${` — its matching `}` is blanked on pop
        stack.push({ type: "expr", depth: 0 });
        endWord();
        prevToken = ""; // expression starts fresh: a leading `/` is a regex
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    // ── CODE (top level, or inside a `${}` expression).
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote || src[j] === "\n") {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      noteValue();
      i = j;
      continue;
    }
    if (ch === "`") {
      blank(i, i + 1);
      stack.push({ type: "template" });
      endWord();
      i++;
      continue;
    }
    if (mode !== null && mode.type === "expr" && ch === "}" && mode.depth === 0) {
      blank(i, i + 1); // the `}` closing the `${` — keep output braces balanced
      stack.pop();
      noteValue(); // back in template text; the interpolation was a value
      i++;
      continue;
    }
    if (ch === "/" && regexAllowedAfter(currentToken())) {
      const j = scanRegexEnd(src, i);
      if (j !== -1) {
        blank(i, j);
        noteValue();
        i = j;
        continue;
      }
      // No closing `/` on the line — not a regex after all; fall through.
    }

    // Plain code character: keep it, update expr brace depth + token tracking.
    if (mode !== null && mode.type === "expr") {
      if (ch === "{") mode.depth++;
      else if (ch === "}") mode.depth--;
    }
    out[i] = ch;
    if (/[A-Za-z0-9_$]/.test(ch)) word += ch;
    else if (/\s/.test(ch)) endWord();
    else {
      endWord();
      prevToken = ch;
    }
    i++;
  }

  return out.join("");
}

export default {
  name: "no-catch",
  describe: "every catch in the SDK engine throws, returns an error, or rejects",
  check(ctx) {
    const violations = [];
    // `mustExist: false`, as the predecessor's `existsSync` guard was.
    for (const file of ctx.files({ dirs: [SCAN_DIR], ext: [".ts"], skip: SKIP_DIRS, mustExist: false })) {
      violations.push(...findViolationsIn(ctx.rel(file), ctx.read(file)));
    }
    return {
      violations,
      summary: "every SDK-engine catch has a definite failure-exit path",
      hint:
        "Every catch in packages/sdk must throw, return an error response/envelope (or a\n" +
        "documented undefined/null sentinel), or reject the surrounding Promise. Swallowing a\n" +
        "failure in the twin engine records broken state as success.",
    };
  },
};
