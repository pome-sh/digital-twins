#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Pure string transforms over CHANGELOG headings. Insertions only: writeRelease()
// rebuilds the file so the released region is carried across by construction. An
// `## Unreleased` with no level throws rather than defaulting to patch.

export const PENDING_HEADING_EXAMPLE = "## Unreleased (patch)";

const HEADING_RE = /^##[ \t].*$/gm;
const PENDING_RE = /^##[ \t]+Unreleased[ \t]*\((patch|minor)\)[ \t]*$/i;
const PENDING_ISH_RE = /^##[ \t].*unreleased/i;

const LEVEL_RANK = { patch: 0, minor: 1 };

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

export function writeRelease(text, { version, date, body, label = "CHANGELOG.md" }) {
  const parsed = parseChangelog(text, label);
  const trimmed = String(body ?? "").trim();
  if (!trimmed) throw new Error(`${label}: refusing to write ${version} with an empty entry body.`);
  const heading = `## ${version}${date ? ` — ${date}` : ""}`;
  const section = `${heading}\n\n${trimmed}\n${parsed.released ? "\n" : ""}`;
  return `${parsed.preamble}${section}${parsed.released}`;
}

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
