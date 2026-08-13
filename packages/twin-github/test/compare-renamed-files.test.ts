// SPDX-License-Identifier: Apache-2.0
//
// `GET /repos/:o/:r/compare/:basehead` and the path a renamed file moved from.
//
// F-1500 taught `GET /repos/:o/:r/pulls/:n/files` to pair an exact move into one
// `renamed` entry carrying `previous_filename`, and a live capture against the
// real `pome-sh/twin-fixtures-sandbox` then read that half green. The compare
// surface answers the SAME question — the file-level diff of a base tree against
// a head tree — out of what was, until F-1513, its own independent path-by-path
// loop. It expanded a move into an `added` plus a `removed` and carried no
// pre-rename path at all, which is what the capture measured as two CRITICALs on
// one surface:
//
//   files[].status             upstream ["added","renamed"]  twin ["added","removed"]
//   files[].previous_filename  upstream present              twin field-removed
//
// Real GitHub runs rename detection on both surfaces. Two implementations of one
// rule is how these two drifted apart, so the teeth below are not "compare emits
// a rename" twice over — the load-bearing one asserts the two surfaces AGREE
// over the same base and head, which is the property whose absence produced the
// ticket and which cannot silently come apart again the way two independent
// expected-value literals can.
//
// NOT under test here, deliberately: the `commits` count on this surface. That
// leaf reads 4 upstream against 1 from the twin because the seeded sandbox's git
// history is not a mirror of the real repo's commit DAG (GH-DIV-020), it is
// registered separately, and pairing files must not move it — which is itself
// asserted below rather than assumed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import type { GitHubStateSeed } from "../src/types.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;
const MOVED = "export function handle() {\n  return 'ok';\n}\n";
const DESTINATION = "src/handler.ts";
const HEAD_BRANCH = "move-handler";

/**
 * One world, parameterised by the path the moved file came FROM, and carrying a
 * pull request over the very same base and head so the two surfaces can be asked
 * the identical question.
 *
 * The head branch also gains a plain addition and a plain modification, so the
 * counter-teeth can read a non-renamed entry out of the SAME response rather
 * than out of a second world where something else might differ.
 */
function world(previousPath: string): GitHubStateSeed {
  return {
    users: [
      { login: "acme", type: "Organization", name: "Acme" },
      { login: "pome-agent", type: "User", name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        default_branch: "main",
        collaborators: ["pome-agent"],
        files: [
          { path: "README.md", content: "# Acme API\n" },
          { path: previousPath, content: MOVED },
          // Modified on the head branch below.
          { path: "src/index.ts", content: "export const ok = true;\n" },
          // The move: same content, new path, and `previousPath` therefore
          // leaves the head branch.
          { path: DESTINATION, branch: HEAD_BRANCH, renamed_from: previousPath },
          { path: "src/index.ts", content: "export const ok = false;\n", branch: HEAD_BRANCH },
          { path: "docs/handler.md", content: "# handler\n", branch: HEAD_BRANCH }
        ],
        pull_requests: [
          {
            title: "Move the handler",
            body: "Renames the handler module.",
            head: HEAD_BRANCH,
            base: "main",
            author: "pome-agent"
          }
        ]
      }
    ]
  };
}

const WORLD_A = "src/legacy-handler.ts";
const WORLD_B = "src/old/entrypoint.ts";

type Row = Record<string, unknown>;

/**
 * The parsed WIRE body on both surfaces, not a domain return value: whether a
 * key reaches the examinee is a fact about the JSON, and `JSON.stringify` drops
 * an `undefined`-valued key that an in-process object would still report.
 */
function twin(previousPath: string) {
  const app = createGitHubCloneApp({ seed: world(previousPath) });
  const get = async (path: string) => {
    const response = await app.request(`${base}${path}`, withAuth(token));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    compare: () => get(`/repos/acme/api/compare/main...${HEAD_BRANCH}`),
    pullFiles: () => get("/repos/acme/api/pulls/1/files"),
    headSha: async () => ((await get(`/repos/acme/api/commits/${HEAD_BRANCH}`)).body as { sha: string }).sha
  };
}

function entry(files: Row[], filename: string) {
  return files.find((file) => file.filename === filename);
}

describe("compare — the pre-rename path is served on the comparison too", () => {
  it("serves the moved file as ONE renamed row naming the path THIS seed moved it from", async () => {
    const a = (await twin(WORLD_A).compare()).body as { files: Row[] };
    const b = (await twin(WORLD_B).compare()).body as { files: Row[] };

    const movedA = entry(a.files, DESTINATION);
    const movedB = entry(b.files, DESTINATION);
    expect(movedA?.status).toBe("renamed");
    expect(movedB?.status).toBe("renamed");

    // The value, per world — not merely "the key is there". Two worlds that
    // differ ONLY in the source path is what makes a twin answering a constant
    // fail here.
    expect(movedA?.previous_filename).toBe(WORLD_A);
    expect(movedB?.previous_filename).toBe(WORLD_B);
    expect(movedA?.previous_filename).not.toBe(movedB?.previous_filename);

    // One row, not two: the old path must not ALSO be served as a `removed`
    // entry, which is what the surface did before and what has the comparison
    // count the move twice.
    const paths = a.files.map((file) => file.filename);
    expect(paths).not.toContain(WORLD_A);
    expect(paths.filter((path) => path === DESTINATION)).toHaveLength(1);
  });

  it("serves the WHOLE renamed row, not just a status and a new key", async () => {
    const world = twin(WORLD_A);
    const headSha = await world.headSha();
    const { files } = (await world.compare()).body as { files: Row[] };

    // `toEqual`, not `toMatchObject`: a fix that adds `previous_filename` while
    // dropping a sibling leaf — or that grows one GitHub does not send — has to
    // fail here. Every value is a literal except the fabricated blob `sha`,
    // which the test refuses to re-derive: reimplementing the twin's own hash to
    // assert it would be a second copy of the rule, which is the mistake this
    // ticket exists to undo.
    expect(entry(files, DESTINATION)).toEqual({
      sha: expect.stringMatching(/^file_\d+$/),
      filename: DESTINATION,
      status: "renamed",
      // An exact move touches no lines. Reporting the old file's line count as
      // deletions would tell an examinee the file was rewritten.
      additions: 0,
      deletions: 0,
      changes: 0,
      blob_url: `https://github.com/acme/api/blob/${headSha}/${DESTINATION}`,
      raw_url: `https://raw.githubusercontent.com/acme/api/${headSha}/${DESTINATION}`,
      contents_url: `https://api.github.com/repos/acme/api/contents/${DESTINATION}?ref=${headSha}`,
      patch: `@@ ${DESTINATION} @@`,
      previous_filename: WORLD_A
    });
  });

  it("omits the key entirely on files that were not renamed", async () => {
    const { files } = (await twin(WORLD_A).compare()).body as { files: Row[] };

    const added = entry(files, "docs/handler.md");
    const modified = entry(files, "src/index.ts");
    expect(added?.status).toBe("added");
    expect(modified?.status).toBe("modified");

    // GitHub sends `previous_filename` exactly on renames. Emitting it
    // unconditionally — as `null`, or as the file's own name — would trade the
    // measured field-removed divergence for a type-changed one.
    expect(added).not.toHaveProperty("previous_filename");
    expect(modified).not.toHaveProperty("previous_filename");
  });
});

describe("compare — the two diff surfaces answer the same question", () => {
  // The three leaves that legitimately differ between the surfaces: a pull
  // request's urls name its head BRANCH REF, a comparison's name the head
  // COMMIT, because `basehead` can be two shas with no branch in it anywhere.
  const REF_DEPENDENT = new Set(["blob_url", "raw_url", "contents_url"]);
  const shape = (files: Row[]) =>
    files.map((file) => Object.fromEntries(Object.entries(file).filter(([key]) => !REF_DEPENDENT.has(key))));

  it("reports the same rename set over the same base and head", async () => {
    const world = twin(WORLD_A);
    const compare = (await world.compare()).body as { files: Row[] };
    const pull = (await world.pullFiles()).body as Row[];

    const renamesIn = (files: Row[]) =>
      files
        .filter((file) => file.status === "renamed")
        .map((file) => ({ filename: file.filename, previous_filename: file.previous_filename }));

    // Two empty sets agree vacuously, and that is exactly the state a neutered
    // pairing leaves BOTH surfaces in — so the equality below is only worth
    // something with this line above it.
    const detected = renamesIn(compare.files);
    expect(detected.length).toBeGreaterThan(0);
    expect(detected).toEqual([{ filename: DESTINATION, previous_filename: WORLD_A }]);
    expect(detected).toEqual(renamesIn(pull));
  });

  it("reports the same rows, in the same order, with the same counts", async () => {
    const world = twin(WORLD_A);
    const compare = (await world.compare()).body as { files: Row[] };
    const pull = (await world.pullFiles()).body as Row[];

    // The stronger form of the property: not just the renames, the whole diff.
    // A surface that gains a row, loses one, reorders them, or disagrees on a
    // status or a line count fails here — compared against the OTHER SURFACE'S
    // answer rather than against a literal, because a literal copied into both
    // tests is precisely how the two implementations drifted while both looked
    // asserted.
    expect(shape(compare.files)).toEqual(shape(pull));
    expect(compare.files.length).toBe(pull.length);
  });
});

describe("compare — pairing files leaves the commit walk alone", () => {
  it("does not move ahead_by, behind_by, total_commits or the commits array", async () => {
    const compare = (await twin(WORLD_A).compare()).body as {
      status: string;
      ahead_by: number;
      behind_by: number;
      total_commits: number;
      commits: Row[];
    };

    // The commit-count leaf on this surface is a separately tracked divergence
    // (the seeded history is not a mirror of the real repo's DAG). Detecting a
    // rename is a fact about TREES; it must not touch the ancestry walk in
    // either direction, or this fix would silently move a number someone else
    // is measuring.
    expect(compare.status).toBe("ahead");
    expect(compare.ahead_by).toBe(1);
    expect(compare.behind_by).toBe(0);
    expect(compare.total_commits).toBe(1);
    expect(compare.commits).toHaveLength(1);
  });
});
