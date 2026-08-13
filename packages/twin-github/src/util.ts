// SPDX-License-Identifier: Apache-2.0
//
// GitHub-domain helpers only (F-682): timestamps, sha fabrication, content
// encoding, pagination, diff-stat counting. Request-id stamping moved to
// the engine's recorder with the port.
import { createHash, randomUUID } from "node:crypto";
import type { PullRequestFileRow } from "./types.js";

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

/** One side of a file diff: the tree, keyed by path. */
export type DiffTree = Map<string, { content: string; sha: string }>;

/**
 * F-1513 — the ONE derivation of GitHub's `diff-entry` rows from a pair of file
 * trees, serving both `GET /repos/:o/:r/pulls/:n/files` and
 * `GET /repos/:o/:r/compare/:basehead`.
 *
 * The two surfaces ask the same question of two different pairs of trees — the
 * pull's two branch file tables, the compare's two commit snapshots — and until
 * this they answered it with two independent path-by-path loops. F-1500 taught
 * the pull loop to pair a move; the compare loop kept expanding one into an
 * `added` plus a `removed` carrying no `previous_filename` at all, and a live
 * capture against the real sandbox read `["added","renamed"]` upstream against
 * `["added","removed"]` from the twin on a repo where the pull surface was
 * already green. Two implementations of one rule is HOW they drifted, so the
 * fix is one implementation rather than a second correct copy: the callers now
 * differ only in where the trees come from and how the urls are built (a branch
 * ref for the pull, the head commit sha for the compare).
 */
export function diffFileRows(
  repoId: number,
  base: DiffTree,
  head: DiffTree,
  urls: (path: string) => { blob_url: string; raw_url: string; contents_url: string }
): PullRequestFileRow[] {
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  // F-1500 — which base-only path each head-only path MOVED from, keyed by the
  // head path. Resolved before the row loop so the removed side can be skipped
  // in the same pass that emits the renamed row.
  const renames = detectRenames(
    paths.filter((path) => base.has(path) && !head.has(path)).map((path) => ({ path, sha: base.get(path)!.sha })),
    paths.filter((path) => head.has(path) && !base.has(path)).map((path) => ({ path, sha: head.get(path)!.sha }))
  );
  const movedFrom = new Set(renames.values());
  const rows: PullRequestFileRow[] = [];
  for (const path of paths) {
    const before = base.get(path);
    const after = head.get(path);
    if (before?.sha === after?.sha) continue;
    // The source side of a move is not a deletion of its own — GitHub reports
    // one `renamed` entry, not a removal plus an addition. Emitting both would
    // have the response count the move twice.
    if (movedFrom.has(path)) continue;
    const previousFilename = renames.get(path) ?? null;
    const diff = linesChanged(before?.content, after?.content ?? "");
    rows.push({
      repo_id: repoId,
      pull_number: 0,
      filename: path,
      status: previousFilename ? "renamed" : before && after ? "modified" : after ? "added" : "removed",
      // A detected move is an EXACT one (identical blobs), so it touches no
      // lines — which is what GitHub reports for it. `linesChanged` would call
      // the whole file an addition, because from its path-by-path view the
      // destination is a file that did not exist.
      additions: previousFilename ? 0 : diff.additions,
      deletions: previousFilename ? 0 : after ? diff.deletions : before?.content.split("\n").length ?? 0,
      changes: previousFilename ? 0 : diff.additions + diff.deletions,
      ...urls(path),
      patch: `@@ ${path} @@`,
      previous_filename: previousFilename
    });
  }
  return rows;
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
