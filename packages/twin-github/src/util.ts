// SPDX-License-Identifier: Apache-2.0
//
// GitHub-domain helpers only (F-682): timestamps, sha fabrication, content
// encoding, pagination, diff-stat counting. Request-id stamping moved to
// the engine's recorder with the port.
import { createHash, randomUUID } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function stableNumericId(input: string) {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function makeSha(...parts: unknown[]) {
  return createHash("sha1")
    .update(JSON.stringify(parts))
    .update(randomUUID())
    .digest("hex");
}

export function fileSha(content: string) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

export function treeSha(paths: string[]) {
  return createHash("sha1").update(paths.sort().join("\n")).digest("hex");
}

export function encodeContent(content: string) {
  return Buffer.from(content, "utf8").toString("base64");
}

export function decodeMaybeBase64(content: string, encoding?: string) {
  if (encoding === "base64") {
    return Buffer.from(content, "base64").toString("utf8");
  }
  return content;
}

export function paginate<T>(items: T[], page = 1, perPage = 30) {
  const safePage = Math.max(1, page);
  const safePerPage = Math.min(100, Math.max(1, perPage));
  const start = (safePage - 1) * safePerPage;
  return items.slice(start, start + safePerPage);
}

/**
 * F-1500 — pair the paths a diff dropped with the paths it gained, so a moved
 * file reads as one `renamed` entry carrying `previous_filename` instead of a
 * removal plus an addition. Returns head path -> the base path it moved from.
 *
 * Blob identity is the whole mechanism, and it is git's: nothing in GitHub's
 * REST API is a "rename", so an agent moves a file by writing the new path and
 * deleting the old one, and the diff has no recorded intent to read. Two paths
 * holding the SAME content, one only on the base and one only on the head, are
 * a move. That is exact-rename detection — git's `--find-renames` at 100%
 * similarity — and nothing weaker: a move that also edits the file is reported
 * as an add plus a remove, because guessing at a similarity threshold GitHub's
 * declared schema does not expose would be the twin inventing vendor behaviour
 * rather than reproducing it.
 *
 * `sorted` and pairing in path order make the answer deterministic when several
 * dropped paths share one content: the same two trees always produce the same
 * pairing, so a seeded world and a replayed capture agree.
 */
export function detectRenames(
  removed: Array<{ path: string; sha: string }>,
  added: Array<{ path: string; sha: string }>
): Map<string, string> {
  const byContent = new Map<string, string[]>();
  for (const file of [...removed].sort((a, b) => a.path.localeCompare(b.path))) {
    const paths = byContent.get(file.sha);
    if (paths) paths.push(file.path);
    else byContent.set(file.sha, [file.path]);
  }
  const renames = new Map<string, string>();
  for (const file of [...added].sort((a, b) => a.path.localeCompare(b.path))) {
    const source = byContent.get(file.sha)?.shift();
    if (source !== undefined) renames.set(file.path, source);
  }
  return renames;
}

export function linesChanged(before: string | undefined, after: string) {
  if (before === undefined) {
    return { additions: after.split("\n").filter(Boolean).length || 1, deletions: 0 };
  }
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let additions = 0;
  let deletions = 0;
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    if (oldLines[index] === newLines[index]) continue;
    if (newLines[index] !== undefined) additions += 1;
    if (oldLines[index] !== undefined) deletions += 1;
  }
  return { additions, deletions };
}
