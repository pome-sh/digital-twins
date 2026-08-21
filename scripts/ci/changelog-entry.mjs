#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1511 — THE CHANGELOG CONTRACT, now that the number is not the author's.
//
// The old contract was one rule: a package's `CHANGELOG.md` top heading must
// equal the version in the same PR. That rule is what made every open PR carry
// the number twice, and it is why a merge somewhere else invalidated both copies
// at once. The new contract splits it where the ADR splits authorship
// (RELEASING.md, "Why the number is not yours to write"):
//
//   ## Unreleased (patch)      ← the AUTHOR writes this, in the PR, with the
//                                 prose under it. `patch` / `minor` is a
//                                 judgement about consumers (RELEASING.md's
//                                 "minor plays the major role"), so it stays
//                                 with the person who made the change.
//   ## 0.23.46 — 2026-08-14    ← `allocate-release-versions.mjs` writes this,
//                                 on `main`, once, when it cuts the number.
//
// The heading↔number binding therefore still exists and still cannot drift — it
// is now created in the same commit that creates the number, by the same script,
// instead of being asserted after the fact against two hand-written copies.
//
// THREE PROPERTIES THIS FILE HOLDS, and each is a test in
// `check-release-note-required.test.mjs` / `allocate-release-versions.test.mjs`:
//
//   1. Insertions only. A release is written by inserting a section immediately
//      above the newest released one. `writeRelease()` reassembles the file as
//      `preamble + newSection + releasedRegion`, so the released region is
//      byte-identical by CONSTRUCTION rather than by assertion — and the PR gate
//      compares that same region against the base branch, which is what stops a
//      human rewriting history too.
//   2. An unsupported shape is never mistaken for an absent one. A heading that
//      mentions "unreleased" but is not exactly `## Unreleased (patch|minor)`
//      THROWS, naming the file and the line. The alternative — treating it as
//      "no pending entry" — means a release request that reads as silence, which
//      is the failure mode this repo has been bitten by often enough to have a
//      rule about it in AGENTS.md.
//   3. No default level. `## Unreleased` with no level is refused rather than
//      assumed to be a patch: whether a change forces consumers to act is not
//      something a script can infer, and quietly guessing "patch" would ship a
//      breaking change under a caret range that resolves it automatically.
//
// Pure string transforms — no I/O, no git, no CLI.

/** The exact heading an author writes. `(patch)` and `(minor)` are the levels. */
export const PENDING_HEADING_EXAMPLE = "## Unreleased (patch)";

/**
 * Any `##` heading. `m` + `g` so matches carry `.index` for exact slicing.
 * `[ \t]` after `##` on purpose: `### Patch Changes` (which entries use, and
 * which the Changesets era left behind) is not a heading at this level.
 *
 * KNOWN LIMIT, stated rather than discovered later: fenced code blocks are not
 * tracked, so a line inside one that starts with `## ` is read as a heading. An
 * entry quoting this very format — as RELEASING.md and cli/README.md do — must
 * indent it or wrap it inline, and the failure is loud (the parse refuses, or the
 * PR gate reports a heading mismatch) rather than a silently mis-split file.
 */
const HEADING_RE = /^##[ \t].*$/gm;
/** The only accepted pending heading. Case-insensitive, otherwise exact. */
const PENDING_RE = /^##[ \t]+Unreleased[ \t]*\((patch|minor)\)[ \t]*$/i;
/** "This heading is TRYING to be the pending one" — used to refuse near-misses. */
const PENDING_ISH_RE = /^##[ \t].*unreleased/i;

const LEVEL_RANK = { patch: 0, minor: 1 };

/**
 * Split a CHANGELOG into the three regions the contract cares about:
 *
 *   preamble  — everything above the first `##` heading, verbatim (title,
 *               format notes, the SPDX comment wire's file opens with).
 *   pending   — the `## Unreleased (level)` sections above the released region,
 *               in file order. Normally zero or one; TWO is a real state, not a
 *               corruption, and is handled rather than refused — two PRs branched
 *               off the same base can each add one, and reddening `main` over
 *               that would rebuild a smaller version of the treadmill this
 *               ticket removes.
 *   released  — from the first non-pending `##` heading to EOF, verbatim. The
 *               region nothing may ever rewrite.
 *
 * THE RELEASED REGION IS NEVER PARSED FOR REQUESTS, and that is a rule rather
 * than an oversight. It is a record of what shipped, this repo does not rewrite
 * records, and `packages/adapter-claude-sdk/CHANGELOG.md` carries a leftover bare
 * `## Unreleased` from the Changesets era sitting between 0.2.3 and 0.2.2 —
 * refusing to cut a release in 2026 because of a heading from July would be this
 * parser policing history it is forbidden to correct. The accident this could
 * otherwise hide (someone puts a real pending entry BELOW the newest released
 * one, and their release silently never happens) is caught by the other end of
 * the same rule: inserting anything into the released region makes it differ from
 * the base branch's, which is exactly what `check-release-note-required.mjs`
 * refuses.
 *
 * Throws on a pending heading above the released region that is not exactly the
 * accepted shape.
 */
export function parseChangelog(text, label = "CHANGELOG.md") {
  const headings = [...text.matchAll(HEADING_RE)].map((m) => ({
    text: m[0],
    start: m.index,
    bodyStart: m.index + m[0].length,
  }));
  for (let i = 0; i < headings.length; i += 1) {
    headings[i].end = headings[i + 1]?.start ?? text.length;
  }

  const pending = [];
  let firstReleased = null;
  for (const heading of headings) {
    // The first heading that is not a pending one opens the record. Everything
    // from there down is read as bytes and never as a request — see above.
    const match = heading.text.match(PENDING_RE);
    if (!match) {
      if (!PENDING_ISH_RE.test(heading.text)) {
        firstReleased = heading;
        break;
      }
      throw new Error(
        `${label}: \`${heading.text.trim()}\` is not a release request this repo can read. ` +
          `The one accepted spelling is \`${PENDING_HEADING_EXAMPLE}\` (or \`(minor)\`) — ` +
          `refused rather than ignored, because an entry that reads as silence is a ` +
          `release that never happens. See scripts/ci/changelog-entry.mjs.`,
      );
    }
    pending.push({
      level: match[1].toLowerCase(),
      heading: heading.text,
      body: text.slice(heading.bodyStart, heading.end),
      start: heading.start,
      end: heading.end,
    });
  }

  return {
    preamble: text.slice(0, headings[0]?.start ?? text.length),
    pending,
    released: firstReleased === null ? "" : text.slice(firstReleased.start),
    releasedHeading: firstReleased?.text.trim() ?? null,
  };
}

/**
 * The release this file is currently asking for, or `null`. Merges the sections
 * when there are several: the LEVEL is the highest asked for (a minor and a
 * patch in one release is a minor — the consumer still has to act), and the
 * bodies are concatenated in file order, because both authors' words are part of
 * the same release once both are on `main`.
 */
export function pendingRelease(text, label = "CHANGELOG.md") {
  const { pending } = parseChangelog(text, label);
  if (pending.length === 0) return null;
  const level = pending.reduce(
    (worst, entry) => (LEVEL_RANK[entry.level] > LEVEL_RANK[worst] ? entry.level : worst),
    "patch",
  );
  const body = pending
    .map((entry) => entry.body.trim())
    .filter(Boolean)
    .join("\n\n");
  return { level, body, sections: pending.length };
}

/**
 * Insert a released section and drop every pending one.
 *
 * The result is `preamble + section + released` — so the released region is
 * carried across byte-for-byte and the insertions-only property is a property of
 * this function's shape, not of a test that has to remember to check it. (There
 * is a test that checks it anyway.)
 */
export function writeRelease(text, { version, date, body, label = "CHANGELOG.md" }) {
  const parsed = parseChangelog(text, label);
  const trimmed = String(body ?? "").trim();
  if (!trimmed) throw new Error(`${label}: refusing to write ${version} with an empty entry body.`);
  const heading = `## ${version}${date ? ` — ${date}` : ""}`;
  const section = `${heading}\n\n${trimmed}\n${parsed.released ? "\n" : ""}`;
  return `${parsed.preamble}${section}${parsed.released}`;
}

/**
 * `0.N.P` + level. Deliberately refuses anything that is not three plain
 * numbers: this repo publishes `0.N.P` only, and a prerelease or build-metadata
 * version has more than one defensible successor. Guessing one would be the
 * script inventing a release policy.
 *
 * There is no `major` level, and that is the same refusal in a different place —
 * all four packages are pre-1.0, where RELEASING.md has minor playing the major
 * role. A 1.0.0 is a deliberate decision about a package's stability promise; it
 * is not something to reach by typing a word in a changelog heading.
 */
export function bumpVersion(version, level) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `cannot bump "${version}": this repo's published packages are plain N.N.N, and a ` +
        `prerelease or build-metadata version has no single obvious successor. Fix the ` +
        `manifest, or teach scripts/ci/changelog-entry.mjs the rule you want.`,
    );
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  throw new Error(`unknown release level "${level}" (accepted: patch, minor)`);
}
