// SPDX-License-Identifier: Apache-2.0
//
// packages/sdk only. Every statement-level catch body must throw, return, or
// reject; anything else is catch-and-continue, which is how a mutation gets
// recorded as a success. Scans a literal-stripped copy so prose cannot satisfy it.
// A conditional exit is accepted by design — deciding every branch needs
// control-flow analysis. The allowlist is keyed by content fingerprint, not line.

const SCAN_DIR = "packages/sdk/src";

const SKIP_DIRS = ["node_modules", "dist", "build", ".git", "coverage", "test", "tests", "__fixtures__", "fixtures"];

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

const EXIT_PATTERNS = [
  /(^|[^.\w$])throw(?![\w$])/,
  /(^|[^.\w$])return(?![\w$])/,
  /(^|[^.\w$])reject\s*\(/,
];

const CATCH_KEYWORD_RE = /(^|[^.\w$])catch(?![\w$])/g;

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

const NESTED_FN_RE = /=>\s*\{|(^|[^.\w$])function(?![\w$])/g;

function maskNestedFunctionBodies(body) {
  const out = body.split("");
  NESTED_FN_RE.lastIndex = 0;
  let m;
  while ((m = NESTED_FN_RE.exec(body)) !== null) {
    let open = -1;
    if (m[0].startsWith("=>")) {
      open = m.index + m[0].length - 1; // the `{` ending the arrow match
    } else {
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

const VALUE_TOKEN = " value";

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

function regexAllowedAfter(token) {
  if (token === "") return true;
  if (token === VALUE_TOKEN) return false;
  if (REGEX_PRECEDING_KEYWORDS.has(token)) return true;
  return token.length === 1 && "([{,;:!&|?=+-*%<>~^".includes(token);
}

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

function stripCommentsAndLiterals(src) {
  const n = src.length;
  const out = new Array(n);
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
    }

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
