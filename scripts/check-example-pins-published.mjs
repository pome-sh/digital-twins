// SPDX-License-Identifier: Apache-2.0
//
// `agent-examples/*` pin published versions on purpose, so `workspace-pins` skips
// them and this covers them instead. A degraded registry must not read as
// unpublished.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EXAMPLE_ROOTS, listExamples } from "./lib/example-roots.mjs";
import { loadWorkspaceMembers } from "./lib/workspace-members.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const WORKSPACE_LINK = /^(?:file:|link:|\.{1,2}[\\/])/;
const SCOPE = "@pome-sh/";
const INSTALL_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export function discoverExampleSiblingDeps(repoRoot) {
  const siblingsByName = new Map(
    loadWorkspaceMembers(repoRoot).map((member) => [member.manifest.name, member]),
  );

  const exact = [];
  const linked = [];
  const unwatchable = [];
  // `root` travels WITH the record. Two roots hold examples now, so a bare
  // `example` name no longer locates the manifest this gate has to rewrite —
  // and getting that wrong would re-pin the wrong file, or silently none.
  for (const { root, name, dir } of listExamples(repoRoot)) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const field of INSTALL_FIELDS) {
      for (const [dep, pin] of Object.entries(pkg[field] ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = siblingsByName.get(dep);
        if (!sibling) continue; // no workspace sibling to compare a published pin against
        const record = { root, example: name, field, dep, pin, workspaceVersion: sibling.manifest.version };
        if (EXACT_VERSION.test(pin)) exact.push(record);
        else if (WORKSPACE_LINK.test(pin)) linked.push(record);
        else unwatchable.push(record);
      }
    }
  }
  return { exact, linked, unwatchable };
}

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
      if (attempt < attempts && delayMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt);
      }
    }
  }
  return { status: "error", detail: lastDetail, attempts };
}

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

const writeSideNpmView = (name, version) => defaultNpmView(name, version, { attempts: 1 });

export function planExampleRepins(repoRoot, npmView = writeSideNpmView) {
  if (!existsSync(join(repoRoot, "package.json"))) return [];
  if (!EXAMPLE_ROOTS.some((root) => existsSync(join(repoRoot, root)))) return [];

  const { exact } = discoverExampleSiblingDeps(repoRoot);
  const { violations, errors } = checkExamplePinsPublished(exact, npmView);

  if (errors.length > 0) {
    console.warn(
      `::warning::${errors.length} example pin(s) could not be checked against the registry, so they are NOT ` +
        `re-pinned in this run: ${errors.map((e) => `${e.root}/${e.example} ${e.dep}@${e.workspaceVersion} (${e.detail})`).join("; ")}`,
    );
  }

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const latest = new Map();
  const repins = [];
  for (const v of violations) {
    const manifestRelPath = `${v.root}/${v.example}/package.json`;
    const contents = latest.get(manifestRelPath) ?? readFileSync(join(repoRoot, manifestRelPath), "utf8");
    const pattern = new RegExp(`("${escape(v.dep)}"\\s*:\\s*")${escape(v.pin)}(")`, "g");
    const occurrences = contents.match(pattern)?.length ?? 0;
    if (occurrences !== 1) {
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
      root: v.root,
      example: v.example,
      dep: v.dep,
      from: v.pin,
      to: v.workspaceVersion,
      writes: [{ path: manifestRelPath, contents: replacement }],
      regenerate: [
        `(cd "${v.root}/${v.example}" && npm install --package-lock-only --no-audit --no-fund --prefer-online)`,
      ],
    });
  }
  return repins;
}

export function reportExamplePinParity(repoRoot, npmView = defaultNpmView) {
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(repoRoot);
  if (exact.length === 0 && linked.length === 0 && unwatchable.length === 0) {
    // No example depends on any published @pome-sh/* package, so there is
    // nothing to check against the registry. That is a legitimate clean state —
    // every example is standalone-fetchable from public npm alone — not the
    // checker having gone blind, so report a pass rather than throwing.
    console.log("example pin↔registry parity: no @pome-sh/* example deps to watch.");
    return true;
  }
  if (exact.length === 0) {
    throw new Error(
      "check-example-pins-published found zero exact-version @pome-sh/* pins with a workspace sibling under " +
        `agent-examples/* (${linked.length} file:/link: link(s), ${unwatchable.length} unwatchable) — refusing to ` +
        "report a pass having made no registry call at all. Every example that depends on a @pome-sh/* package " +
        "must keep an exact pin: `pome init --example <id>` fetches that subtree ALONE onto a user's machine, " +
        "and a link out of the tree cannot resolve there.",
    );
  }

  const { checked, violations, skips, errors } = checkExamplePinsPublished(exact, npmView);

  if (errors.length > 0) {
    console.error(`\n❌ registry lookup FAILED for ${errors.length} pin(s) (not a skip — a real error):\n`);
    for (const e of errors) {
      console.error(`  ${e.root}/${e.example} (${e.field}.${e.dep}@${e.workspaceVersion}): ${e.detail}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ published pin DRIFT in ${violations.length} example(s):\n`);
    for (const v of violations) {
      console.error(
        `  ${v.root}/${v.example} (${v.field}.${v.dep}): pins ${v.pin}, but the workspace sibling is ` +
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
        `  ${u.root}/${u.example} (${u.field}.${u.dep}): "${u.pin}" is neither an exact version nor a ` +
          `file:/link: workspace link. Pin it to the workspace version (${u.workspaceVersion}) so it can be ` +
          `watched. A file: link is the alternative ONLY for an example that is not offered for standalone ` +
          `fetch, and since \`pome init --example ${u.example}\` fetches this subtree alone onto a user's ` +
          `machine, this one is — so a link out of the tree breaks its \`npm install\` and empties this gate ` +
          `at the same time.`,
      );
    }
  }

  if (skips.length > 0) {
    console.log(`\n⚠️  skipped ${skips.length} pin(s) — sibling workspace version not yet published:`);
    for (const s of skips) {
      console.log(`  ${s.root}/${s.example} (${s.field}.${s.dep}): workspace is ${s.workspaceVersion}, pin is ${s.pin}`);
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
