// SPDX-License-Identifier: Apache-2.0
//
// `GET /repos/:o/:r/pulls/:n/files` and the pre-rename path.
//
// GitHub's `diff-entry` schema carries `previous_filename`, and GitHub sends it
// exactly when `status: "renamed"`. The twin declared `"renamed"` in
// `PullRequestFileRow["status"]` and could not produce it: `calculatePullFiles`
// diffs the two branches' file tables path by path, so a file that moved read as
// one `removed` entry plus one `added` entry, and `previous_filename` was
// registered as a deliberate omission in `upstream-coverage.types.ts`. An
// examinee that renamed a file and read its own PR's diff back therefore saw a
// shape real GitHub does not serve — a false pass on a routine operation.
//
// Two things had to be true for the field to be worth anything, and each has its
// own tooth below:
//
//   1. It is REACHABLE. A serializer that can emit a field no state can produce
//      is not a fix. The seed could not express a rename at all — a seeded
//      branch is created FROM the default branch and inherits every path, and a
//      `files[]` entry can only add or overwrite, never remove — so
//      `files[].renamed_from` is what carries the intent. The test drives the
//      field through the SEED, not through a hand-built `PullRequestFileRow`:
//      a row built in the test proves the serializer and says nothing about
//      whether any world can reach it.
//
//   2. It is CONDITIONAL. GitHub sends `previous_filename` on renames and omits
//      the key otherwise, so a serializer that emitted it always would be a new
//      divergence pointing the other way. The counter-tooth reads the added and
//      modified entries of the same response and asserts the key is absent.
//
// The value assertions run against two worlds that differ only in the path the
// file was renamed FROM. Asserting `previous_filename` is merely present would
// pass against a twin answering a constant; asserting each world's own value,
// and that they differ, is what makes the field load-bearing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubDomain } from "../src/domain/index.js";
import { openGitHubCloneDatabase } from "../src/db.js";
import { parseSeed } from "../src/seed.js";
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

/**
 * One world, parameterised by the path the moved file came FROM. Both worlds
 * rename to the same destination, so the only thing that can distinguish their
 * `/pulls/1/files` responses is `previous_filename` itself.
 *
 * The head branch also carries a plain addition and a plain modification, so the
 * counter-tooth can read a non-renamed entry out of the SAME response rather
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
          // The rename: same content, new path, and `previousPath` is gone from
          // the head branch as a result.
          { path: "src/handler.ts", branch: "move-handler", renamed_from: previousPath },
          { path: "src/index.ts", content: "export const ok = false;\n", branch: "move-handler" },
          { path: "docs/handler.md", content: "# handler\n", branch: "move-handler" }
        ],
        pull_requests: [
          {
            title: "Move the handler",
            body: "Renames the handler module.",
            head: "move-handler",
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

async function filesOf(previousPath: string) {
  const app = createGitHubCloneApp({ seed: world(previousPath) });
  const response = await app.request(`${base}/repos/acme/api/pulls/1/files`, withAuth(token));
  const text = await response.text();
  return {
    status: response.status,
    // The parsed WIRE body, not a domain return value: whether a key reaches the
    // examinee is a fact about the JSON, and `JSON.stringify` drops an
    // `undefined`-valued key that an in-process object would still report.
    body: (text ? JSON.parse(text) : null) as Array<Record<string, unknown>> | null
  };
}

function entry(body: Array<Record<string, unknown>> | null, filename: string) {
  return (body ?? []).find((file) => file.filename === filename);
}

describe("previous_filename — the pre-rename path is served and seedable", () => {
  it("serves the renamed file with the path THIS seed moved it from", async () => {
    const a = await filesOf(WORLD_A);
    const b = await filesOf(WORLD_B);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const movedA = entry(a.body, "src/handler.ts");
    const movedB = entry(b.body, "src/handler.ts");
    expect(movedA?.status).toBe("renamed");
    expect(movedB?.status).toBe("renamed");

    // The value, per world — not merely "the key is there".
    expect(movedA?.previous_filename).toBe(WORLD_A);
    expect(movedB?.previous_filename).toBe(WORLD_B);
    expect(movedA?.previous_filename).not.toBe(movedB?.previous_filename);
  });

  it("collapses the move into one entry — the old path is not also served as removed", async () => {
    const { body } = await filesOf(WORLD_A);
    const paths = (body ?? []).map((file) => file.filename);

    // Real GitHub reports a move as ONE renamed entry. Emitting
    // `previous_filename` on a renamed row while ALSO serving the old path as a
    // separate `removed` row would leave the response counting the move twice.
    expect(paths).not.toContain(WORLD_A);
    expect(paths.filter((path) => path === "src/handler.ts")).toHaveLength(1);
  });

  it("reports an exact move as zero additions and zero deletions", async () => {
    const { body } = await filesOf(WORLD_A);
    const moved = entry(body, "src/handler.ts");

    // A move with no content change touches no lines. Carrying the old file's
    // line count as deletions — which is what the `removed` arm of the path-by-
    // path diff did — would tell an examinee the file was rewritten.
    expect(moved).toMatchObject({ additions: 0, deletions: 0, changes: 0 });
  });

  it("omits the key entirely on files that were not renamed", async () => {
    const { body } = await filesOf(WORLD_A);

    const added = entry(body, "docs/handler.md");
    const modified = entry(body, "src/index.ts");
    expect(added?.status).toBe("added");
    expect(modified?.status).toBe("modified");

    // GitHub sends `previous_filename` exactly on renames. Emitting it
    // unconditionally — as `null`, or as the file's own name — would be a fresh
    // divergence in the opposite direction to the one this fixes.
    expect(added).not.toHaveProperty("previous_filename");
    expect(modified).not.toHaveProperty("previous_filename");
  });

  it("serves the moved file's contents at the new path and nothing at the old one", async () => {
    const app = createGitHubCloneApp({ seed: world(WORLD_A) });
    const at = async (path: string) => {
      const response = await app.request(
        `${base}/repos/acme/api/contents/${path}?ref=move-handler`,
        withAuth(token)
      );
      return response.status;
    };

    // The rename is a real state change on the branch, not a label attached to
    // the diff: the pre-rename path has to be GONE from the head branch, or the
    // twin is serving a diff that contradicts its own file tree.
    expect(await at("src/handler.ts")).toBe(200);
    expect(await at(WORLD_A)).toBe(404);
    // Still on the base branch, which is what makes it a diff at all.
    const onMain = await app.request(`${base}/repos/acme/api/contents/${WORLD_A}`, withAuth(token));
    expect(onMain.status).toBe(200);
  });
});

/** The world an examinee moves a file in, and its domain handle. */
function writeWorld(sourcePath: string) {
  const domain = new GitHubDomain(openGitHubCloneDatabase(":memory:"));
  domain.seed({
    users: [{ login: "acme", type: "Organization" }],
    repositories: [
      {
        owner: "acme",
        name: "api",
        default_branch: "main",
        collaborators: ["pome-agent"],
        files: [
          { path: "README.md", content: "# Acme API\n" },
          { path: sourcePath, content: MOVED }
        ]
      }
    ]
  });
  return domain;
}

/** `DELETE /contents/*` requires the blob sha, the way GitHub does. */
function shaOf(domain: GitHubDomain, path: string, ref: string) {
  return (domain.getFileContents({ owner: "acme", repo: "api", path, ref }) as { sha: string }).sha;
}

describe("previous_filename — an examinee's own rename, through the write path", () => {
  /**
   * The scenario the omission actually cost: nothing in GitHub's REST API is a
   * "rename", so an agent moves a file by writing the new path and deleting the
   * old one. GitHub's diff detects the move from the blob; the twin has to do
   * the same, because the write path carries no rename intent to record.
   */
  it("detects a delete-plus-create as a rename in the pull request it opens", async () => {
    const domain = writeWorld("src/legacy.ts");

    domain.createBranch({ owner: "acme", repo: "api", branch: "agent-move", from_branch: "main" });
    domain.createOrUpdateFile({
      owner: "acme",
      repo: "api",
      path: "src/current.ts",
      message: "Add the new module",
      content: MOVED,
      branch: "agent-move"
    });
    domain.deleteFile({
      owner: "acme",
      repo: "api",
      path: "src/legacy.ts",
      message: "Drop the old module",
      sha: shaOf(domain, "src/legacy.ts", "agent-move"),
      branch: "agent-move"
    });
    domain.createPullRequest({ owner: "acme", repo: "api", title: "Move it", head: "agent-move", base: "main" });

    const files = domain.getPullRequestFiles({ owner: "acme", repo: "api", pull_number: 1 }) as Array<
      Record<string, unknown>
    >;
    const moved = files.find((file) => file.filename === "src/current.ts");
    expect(moved?.status).toBe("renamed");
    expect(moved?.previous_filename).toBe("src/legacy.ts");
    expect(files.map((file) => file.filename)).not.toContain("src/legacy.ts");
  });

  it("leaves an unpaired delete as removed", async () => {
    const domain = writeWorld("src/gone.ts");

    domain.createBranch({ owner: "acme", repo: "api", branch: "agent-delete", from_branch: "main" });
    domain.deleteFile({
      owner: "acme",
      repo: "api",
      path: "src/gone.ts",
      message: "Drop it",
      sha: shaOf(domain, "src/gone.ts", "agent-delete"),
      branch: "agent-delete"
    });
    domain.createPullRequest({ owner: "acme", repo: "api", title: "Delete it", head: "agent-delete", base: "main" });

    const files = domain.getPullRequestFiles({ owner: "acme", repo: "api", pull_number: 1 }) as Array<
      Record<string, unknown>
    >;
    const gone = files.find((file) => file.filename === "src/gone.ts");
    // A deletion with nothing to pair against must stay a deletion. Pairing it
    // with any addition would invent a move the agent never made.
    expect(gone?.status).toBe("removed");
    expect(gone).not.toHaveProperty("previous_filename");
  });
});

describe("previous_filename — what the seed refuses", () => {
  const seedWith = (file: Record<string, unknown>) => () =>
    parseSeed({
      repositories: [
        {
          owner: "acme",
          name: "api",
          files: [{ path: "src/old.ts", content: MOVED }, file]
        }
      ]
    });

  // Both refusals name `renamed_from` in the message on purpose: matching any
  // error at all would let these pass on the pre-fix "content is required"
  // type error, which is not the rule under test.
  it("refuses a rename whose source is the destination", () => {
    expect(seedWith({ path: "src/old.ts", branch: "move", renamed_from: "src/old.ts" })).toThrow(/renamed_from/);
  });

  it("refuses a rename that also declares content", () => {
    // The twin detects EXACT moves — a paired blob. Letting a seed name both a
    // source and a different content would let it ask for a rename the diff
    // could not report, which is the same unreachability this fixes.
    expect(seedWith({ path: "src/new.ts", branch: "move", renamed_from: "src/old.ts", content: "different\n" })).toThrow(
      /renamed_from/
    );
  });

  it("refuses a file entry with neither content nor a rename source", () => {
    expect(seedWith({ path: "src/new.ts", branch: "move" })).toThrow();
  });

  it("refuses a rename on the default branch, where there is nothing to move from", () => {
    const app = () => createGitHubCloneApp({ seed: world(WORLD_A) });
    // The valid world stands; the same rename with no `branch` does not.
    expect(app).not.toThrow();
    expect(() =>
      createGitHubCloneApp({
        seed: {
          repositories: [
            {
              owner: "acme",
              name: "api",
              files: [
                { path: "src/old.ts", content: MOVED },
                { path: "src/new.ts", renamed_from: "src/old.ts" }
              ]
            }
          ]
        }
      })
    ).toThrow(/renamed_from/);
  });

  it("refuses a rename whose source is not a file on the branch", () => {
    expect(() =>
      createGitHubCloneApp({
        seed: {
          repositories: [
            {
              owner: "acme",
              name: "api",
              files: [
                { path: "README.md", content: "# Acme API\n" },
                { path: "src/new.ts", branch: "move", renamed_from: "src/never-existed.ts" }
              ]
            }
          ]
        }
      })
    ).toThrow(/renamed_from/);
  });
});
