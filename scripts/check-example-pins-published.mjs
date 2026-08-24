// SPDX-License-Identifier: Apache-2.0
//
// `agent-examples/*` pins a PUBLISHED `@pome-sh/*` version on purpose
// (`agent-examples/support-triage` documents why in `gate-examples.mjs`'s
// header: it is `npx degit`-fetchable as a standalone subtree, so a `file:`
// link out of its own directory would break its `npm install`). Nothing
// watched that pin drift out from under the sibling workspace version twice
// (#308 off 0.2.5, then off 0.3.1 — the second time dragging the retired
// `@pome-sh/shared-types` back into the example's install graph as a runtime
// dependency — two schema identities in one process, in the one example that
// exists to demonstrate
// a correctly-joined trace).
//
// `workspace-pins.mjs` cannot own this: it runs OFFLINE
// before `npm ci`, and its rule ("a `@pome-sh/*` dep must resolve to the
// workspace") is the wrong rule for a pin that is published on purpose. This
// gate needs the registry, so it lives where `agent-examples/*` are already
// installed — `gate-examples.mjs` already runs `npm ci` per example in
// CI's heavy (networked) job — rather than standing up a second CI mechanism.
//
// THE RULE, in two parts:
//   1. If the sibling WORKSPACE version is published to the registry, the
//      example's pin must equal it exactly. A published sibling version is
//      the only artifact anyone could have meant to pin, so any other exact
//      value is drift.
//   2. If the workspace version is NOT yet published (the ordinary cloud-first
//      state — `packages/` bumps and merges before its release job runs),
//      that is a named, counted SKIP, never a silent pass and never treated as
//      a violation.
//
// A registry answer that is neither "found" nor "genuinely unpublished" (a
// 401, a 5xx, a timeout, a rate limit) is a HARD FAILURE, not a skip — treating
// it as unpublished would let a transient registry outage wave through a real
// drift. This mirrors `scripts/ci/decide-publish.sh`'s own stance: `npm view`
// exiting non-zero with `E404` in its stderr means "not found", anything else
// means "ask again", and only the former may stand in for "unpublished".
//
// Only EXACT semver pins can be COMPARED against the registry. But "cannot be
// compared" must never mean "silently uncounted" — that is the D5 failure shape
// this gate exists to close, and the first draft of it had exactly that hole:
// discovery `continue`d past every non-exact pin, so re-pinning
// `agent-examples/support-triage` to `^0.3.3` made its watch evaporate while the
// report still printed a clean pass. (It only reddened at all because
// support-triage happens to own the sole exact pin in the tree, so the
// zero-eligible-pins floor caught it by arithmetic accident; add one more
// exact pin anywhere under `agent-examples/*` and the range pin goes silent.)
//
// So every `@pome-sh/*` dep that HAS a workspace sibling is classified, and all
// three classes are reported:
//   - `exact`       — an exact semver: this gate's subject, checked against the
//                     registry below.
//   - `linked`      — `file:`/`link:`: resolves from the source next to it and
//                     cannot reach a registry at all, so it cannot swap in a
//                     stale published artifact. Out of scope on purpose, but
//                     COUNTED and named, so the report never claims a
//                     denominator it does not have.
//   - `unwatchable` — anything else (a caret/tilde/range, `"*"`, a dist-tag,
//                     `npm:`): resolves FROM the registry, so it carries the
//                     very risk this gate watches for, yet has no single
//                     version to compare. That is a VIOLATION, not a skip.
//                     A pin nobody can check must not read as a pin nobody
//                     needs to check.
//
// Discovery, not a list: every `agent-examples/*/package.json`, walked fresh each
// run, is the corpus — so a new example shipping its own published pin is
// covered with no edit here.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadWorkspaceMembers } from "./lib/workspace-members.mjs";

// Prerelease/build metadata included: `0.4.0-rc.1` is an exact, registry-
// resolvable version, and rejecting it would drop the first rc into
// `unwatchable` with advice ("re-pin to 0.4.0-rc.1") that names the value it
// already has — an unfixable red.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// `../foo` with no protocol is a directory dep to npm exactly as `file:../foo`
// is; classing it `unwatchable` would red a legitimate local link while telling
// the author it "resolves from the registry", which is false.
const WORKSPACE_LINK = /^(?:file:|link:|\.{1,2}[\\/])/;
const SCOPE = "@pome-sh/";
const INSTALL_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Every `@pome-sh/*` dep under `agent-examples/*` that has a same-named sibling among
 * the root workspace members, classified into `exact` / `linked` /
 * `unwatchable` (see this file's header for why all three are reported and none
 * is dropped). One walk, so the three classes cannot disagree about what a
 * sibling is. Discovered fresh each run, never a hand-kept list of examples or
 * packages.
 */
export function discoverExampleSiblingDeps(repoRoot) {
  const examplesDir = join(repoRoot, "agent-examples");
  const siblingsByName = new Map(
    loadWorkspaceMembers(repoRoot).map((member) => [member.manifest.name, member]),
  );

  const exact = [];
  const linked = [];
  const unwatchable = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const pkgPath = join(examplesDir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const field of INSTALL_FIELDS) {
      for (const [dep, pin] of Object.entries(pkg[field] ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = siblingsByName.get(dep);
        if (!sibling) continue; // no workspace sibling to compare a published pin against
        const record = { example: name, field, dep, pin, workspaceVersion: sibling.manifest.version };
        if (EXACT_VERSION.test(pin)) exact.push(record);
        else if (WORKSPACE_LINK.test(pin)) linked.push(record);
        else unwatchable.push(record);
      }
    }
  }
  return { exact, linked, unwatchable };
}

/**
 * `npm view <name>@<version> version` against the real registry. Returns
 * `{ status: "published" }`, `{ status: "unpublished" }` (E404 — genuinely no
 * such version), or `{ status: "error", detail }` for anything else (auth,
 * network, rate-limit, 5xx) — the same three-way split
 * `scripts/ci/decide-publish.sh` draws, because only an E404 may stand in for
 * "not published yet".
 *
 * The `timeout` is load-bearing, not decoration: without it a registry that
 * accepts the connection and then stalls hangs this call indefinitely (npm's
 * own `fetch-timeout` defaults to five minutes PER attempt, times its retries),
 * so a degraded registry stalls the whole heavy job instead of answering. A
 * killed call has no `E404` in its stderr, so it lands in `error` — the
 * conservative side, and the same side a 401 or a 5xx lands on.
 *
 * `--prefer-online` forces npm's staleness check instead of accepting a cached
 * packument, and it is load-bearing on the write side: both the workflow
 * that calls this and the one that publishes restore npm's HTTP cache via
 * `setup-node`'s `cache: npm`, keyed on the root lockfile — which a release
 * commit changes, so the run immediately BEFORE a publish takes the miss and
 * saves a fresh cache whose adapter packument predates that publish. The
 * dispatched re-pin run then restores it, and inside the packument's max-age
 * `npm view <pkg>@<just-published>` answers E404 — indistinguishable, by design,
 * from "never published", so `planExampleRepins` skips the pin it exists to fix
 * and no later run retries. A read that is allowed to answer from cache cannot
 * prove a version is absent.
 *
 * Retried, because "any non-E404 answer is a hard failure" puts the REQUIRED
 * `typecheck-test` check behind a third-party registry: one transient 5xx or
 * ECONNRESET would red it. `ci.yml`'s own actionlint install carries a
 * five-attempt loop for exactly this reason, with a comment recording three
 * 503s during this PR's review. An `E404` returns immediately — it is a real
 * answer, not a failure to get one — so retrying never delays the ordinary
 * unpublished path.
 */
export function defaultNpmView(name, version, { attempts = 3, delayMs = 2000 } = {}) {
  let lastDetail = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execFileSync("npm", ["view", `${name}@${version}`, "version", "--prefer-online"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 60_000,
      });
      return { status: "published" };
    } catch (err) {
      const stderr = String(err.stderr ?? err.message ?? "");
      if (/\bE404\b/.test(stderr)) return { status: "unpublished" };
      lastDetail = stderr.trim() || String(err);
      // Synchronous backoff: this whole gate is sync (`execFileSync`), so there
      // is no event loop to await on.
      if (attempt < attempts && delayMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt);
      }
    }
  }
  return { status: "error", detail: lastDetail, attempts };
}

/**
 * Apply the rule to a discovered pin list. `npmView` is injectable so the
 * regression suite can exercise all three registry outcomes without a
 * network.
 *
 * Returns:
 *   - `violations`: pin !== workspace version, where the workspace version IS
 *     published — a real drift, naming the example, the pin, and the
 *     workspace version.
 *   - `skips`: workspace version is not (yet) published — the legitimate
 *     cloud-first ordering, counted and named, never rendered as a pass.
 *   - `errors`: the registry answered something other than found/E404 — a
 *     hard failure, never downgraded to a skip.
 */
export function checkExamplePinsPublished(pins, npmView = defaultNpmView) {
  const violations = [];
  const skips = [];
  const errors = [];
  for (const pin of pins) {
    const result = npmView(pin.dep, pin.workspaceVersion);
    if (result.status === "error") {
      errors.push({ ...pin, detail: result.detail });
    } else if (result.status === "unpublished") {
      skips.push(pin);
    } else if (pin.pin !== pin.workspaceVersion) {
      violations.push(pin);
    }
  }
  return { checked: pins.length, violations, skips, errors };
}

/**
 * The write side's registry budget, deliberately ONE attempt where the read
 * side takes three. `defaultNpmView`'s retry exists because the gate is a
 * REQUIRED status check that must not flake on a transient 5xx. The re-pin has
 * the opposite cost function: it runs inside `allocate-version.yml`'s three-
 * attempt push loop, synchronously, per exact pin, in a `timeout-minutes: 20`
 * job that also runs `npm ci` — so three attempts × a 60s timeout × the backoff
 * × the push retries is minutes of stalling in the release path, and it buys
 * nothing, because a missed re-pin costs exactly one cycle and the next run
 * plans it again. Cheap to lose, expensive to wait for.
 */
const writeSideNpmView = (name, version) => defaultNpmView(name, version, { attempts: 1 });

/**
 * The write-side of this gate's own read-side logic. `checkExample
 * PinsPublished`'s `violations` ARE, by construction, the only pins safe to
 * rewrite automatically: the sibling is confirmed PUBLISHED (an `npm view`
 * that just returned a real answer), so `npm install --package-lock-only`
 * against it can succeed for real, unlike a version this same push is still in
 * the middle of allocating (see the header of `allocate-release-versions.mjs`'s
 * `planAllocations` for why a freshly-bumped-in-this-run version must NOT be
 * repinned to here — it isn't on the registry yet).
 *
 * Returns one entry per example whose pin can be safely corrected: the
 * rewritten `package.json` text (a plain textual substitution, matching
 * `allocate-release-versions.mjs`'s own `rewriteVersion` — round-tripping
 * through `JSON.stringify` would lose formatting) plus the shell command that
 * regenerates that example's lockfile against the now-confirmed-published
 * version. Nothing here executes the command or writes the file; the caller
 * (`allocate-release-versions.mjs`) folds both into the same commit it already
 * builds.
 *
 * Silently produces nothing when `repoRoot` has no `package.json` or no
 * `agent-examples/` — the throwaway git fixtures `allocate-release-versions.test.mjs`
 * builds are neither, and this function is called unconditionally from every
 * plan, not just ones that touch examples.
 */
export function planExampleRepins(repoRoot, npmView = writeSideNpmView) {
  if (!existsSync(join(repoRoot, "package.json")) || !existsSync(join(repoRoot, "agent-examples"))) return [];

  const { exact } = discoverExampleSiblingDeps(repoRoot);
  const { violations, errors } = checkExamplePinsPublished(exact, npmView);

  if (errors.length > 0) {
    // `checkExamplePinsPublished` is emphatic that a non-E404 answer is a hard
    // failure and never a skip. The write side cannot honour that literally — a
    // registry outage must not stop a release — but it must not launder it into
    // "nothing drifted" either, which is what silently dropping `errors` would
    // do. Say so; the read-side gate is the one that hard-fails.
    console.warn(
      `::warning::${errors.length} example pin(s) could not be checked against the registry, so they are NOT ` +
        `re-pinned in this run: ${errors.map((e) => `agent-examples/${e.example} ${e.dep}@${e.workspaceVersion} (${e.detail})`).join("; ")}`,
    );
  }

  // A regex rather than a literal-string match (unlike this file's siblings'
  // `"version": "x"` searches): a hand-formatted `package.json` always has a
  // space after the colon, but nothing in npm requires one, so matching only
  // the formatted shape would silently find zero occurrences on a compact file
  // instead of one — a formatting failure no author intended. The capture
  // groups mean only the pin's own bytes are replaced, never a coincidental
  // earlier occurrence of the same string inside the matched text.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // One example can carry TWO drifted `@pome-sh/*` pins, and `applyAllocations`
  // writes entries in order, so last write wins per path: each entry's
  // `contents` must therefore already carry every EARLIER substitution to the
  // same manifest, or the first repin is silently dropped while the commit
  // message still claims it — the read-side gate would then keep reddening on a
  // drift the commit says it fixed.
  const latest = new Map();
  const repins = [];
  for (const v of violations) {
    const manifestRelPath = `agent-examples/${v.example}/package.json`;
    const contents = latest.get(manifestRelPath) ?? readFileSync(join(repoRoot, manifestRelPath), "utf8");
    const pattern = new RegExp(`("${escape(v.dep)}"\\s*:\\s*")${escape(v.pin)}(")`, "g");
    const occurrences = contents.match(pattern)?.length ?? 0;
    if (occurrences !== 1) {
      // Deliberately NOT a throw. This runs inside `planAllocations`, on every
      // push to `main`, so throwing would stop EVERY package's release over one
      // ambiguous example manifest (a `"@pome-sh/x": "<pin>"` repeated in
      // `overrides`, or in a second install field) — a repo-wide release outage
      // caused by the thing meant to remove a one-line PR. Skip this one pin
      // instead: `reportExamplePinParity` still reds on it, so it cannot go
      // silent, and a human re-pins it the way they did before the repin path existed.
      console.warn(
        `::warning::${manifestRelPath}: expected exactly one \`"${v.dep}": "${v.pin}"\`, found ${occurrences} — ` +
          "refusing to guess which one is the pin, so it is NOT re-pinned automatically. " +
          "check-example-pins-published.mjs keeps reporting the drift until it is fixed by hand.",
      );
      continue;
    }
    const replacement = contents.replace(pattern, `$1${v.workspaceVersion}$2`);
    latest.set(manifestRelPath, replacement);
    repins.push({
      example: v.example,
      dep: v.dep,
      from: v.pin,
      to: v.workspaceVersion,
      writes: [{ path: manifestRelPath, contents: replacement }],
      // `--package-lock-only`: this workflow never runs the example itself, so
      // there is nothing to gain from a real `node_modules` and a real install
      // would need dev toolchains (tsx, vitest) this job has no other use for.
      // The path is QUOTED: `v.example` is a directory name off `readdirSync`,
      // and this string is `bash`ed by a job holding a write-capable App token.
      // `--prefer-online` for the same reason the view above carries it: this
      // resolves the version that was published minutes ago, and a cached
      // packument that predates it makes the install fail on a version the
      // registry really does serve.
      regenerate: [
        `(cd "agent-examples/${v.example}" && npm install --package-lock-only --no-audit --no-fund --prefer-online)`,
      ],
    });
  }
  return repins;
}

/**
 * Run discovery + the registry check and print a report in the shape
 * `gate-examples.mjs` expects: throws on zero eligible pins (a check
 * examining nothing must not report a pass), prints the skip count even when
 * everything else is green, and returns `true`/`false` for the caller to fold
 * into its own exit code.
 */
export function reportExamplePinParity(repoRoot, npmView = defaultNpmView) {
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(repoRoot);
  // The floor counts EXACT pins only. Counting `linked` here would have let a
  // tree whose examples are all `file:` links report a green pass having made
  // zero registry calls — and converting `agent-examples/support-triage` to a `file:`
  // link is a plausible edit (three other examples already are one), so that
  // would delete this gate's only watch silently, which is the whole shape it
  // exists to catch. `unwatchable` reds on its own below, so it does not need
  // to satisfy a floor either.
  if (exact.length === 0) {
    throw new Error(
      "check-example-pins-published found zero exact-version @pome-sh/* pins with a workspace sibling under " +
        `agent-examples/* (${linked.length} file:/link: link(s), ${unwatchable.length} unwatchable) — refusing to ` +
        "report a pass having made no registry call at all. agent-examples/support-triage must keep an exact pin: " +
        "its README offers `npx degit` of that subtree alone, which cannot resolve a link out of the tree.",
    );
  }

  const { checked, violations, skips, errors } = checkExamplePinsPublished(exact, npmView);

  if (errors.length > 0) {
    console.error(`\n❌ registry lookup FAILED for ${errors.length} pin(s) (not a skip — a real error):\n`);
    for (const e of errors) {
      console.error(`  agent-examples/${e.example} (${e.field}.${e.dep}@${e.workspaceVersion}): ${e.detail}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ published pin DRIFT in ${violations.length} example(s):\n`);
    for (const v of violations) {
      console.error(
        `  agent-examples/${v.example} (${v.field}.${v.dep}): pins ${v.pin}, but the workspace sibling is ` +
          `${v.workspaceVersion} and ${v.workspaceVersion} is published. Re-pin to ${v.workspaceVersion}.`,
      );
    }
  }

  if (unwatchable.length > 0) {
    console.error(
      `\n❌ ${unwatchable.length} @pome-sh/* dep(s) under agent-examples/* resolve from the registry but have no ` +
        `single version to check — an unwatched pin, not an exempt one:\n`,
    );
    for (const u of unwatchable) {
      console.error(
        `  agent-examples/${u.example} (${u.field}.${u.dep}): "${u.pin}" is neither an exact version nor a ` +
          `file:/link: workspace link. Pin it to the workspace version (${u.workspaceVersion}) so it can be ` +
          `watched. A file: link is the alternative ONLY for an example that is not offered for standalone ` +
          `fetch — agent-examples/support-triage is (its README documents \`npx degit\` of that subtree alone), so a ` +
          `link out of the tree breaks its \`npm install\` and empties this gate at the same time.`,
      );
    }
  }

  if (skips.length > 0) {
    console.log(`\n⚠️  skipped ${skips.length} pin(s) — sibling workspace version not yet published:`);
    for (const s of skips) {
      console.log(`  agent-examples/${s.example} (${s.field}.${s.dep}): workspace is ${s.workspaceVersion}, pin is ${s.pin}`);
    }
  }

  const ok = violations.length === 0 && errors.length === 0 && unwatchable.length === 0;
  const passed = checked - violations.length - skips.length - errors.length;
  console.log(
    `\nexample pin↔registry parity: ${passed} matched, ${skips.length} skipped (unpublished), ` +
      `${violations.length} drifted, ${errors.length} errored (of ${checked} exact pin(s) checked); ` +
      `${linked.length} file:/link: workspace link(s) out of scope, ${unwatchable.length} unwatchable.`,
  );
  return ok;
}
