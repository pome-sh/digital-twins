// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { GitHubStateSeed } from "./types.js";

export const seedSchema = z.object({
  users: z
    .array(
      z.object({
        login: z.string().min(1),
        type: z.enum(["User", "Organization"]).default("User"),
        name: z.string().default("")
      })
    )
    .default([]),
  repositories: z.array(
    z.object({
      owner: z.string().min(1),
      name: z.string().min(1),
      description: z.string().default(""),
      private: z.boolean().default(false),
      default_branch: z.string().min(1).default("main"),
      collaborators: z.array(z.string().min(1)).default([]),
      labels: z
        .array(
          z.object({
            name: z.string().min(1),
            color: z.string().default("ededed"),
            description: z.string().default("")
          })
        )
        .default([]),
      // F-1500 — `renamed_from` is how a seed expresses a MOVE, and with it the
      // `status: "renamed"` the row type has always declared and no world could
      // reach. A seeded branch is created from the default branch and inherits
      // every path, and a plain `files[]` entry can only add or overwrite, so
      // before this there was no way to make a path ABSENT from the head branch
      // — and `previous_filename` was therefore unreachable from any seed, not
      // merely unemitted.
      //
      // `content` is refused alongside `renamed_from` rather than merged with
      // it: the diff detects a move by pairing identical blobs (see
      // `calculatePullFiles`), so a seed naming a source AND different content
      // would be asking for a rename the diff would report as an add plus a
      // remove. Refusing it keeps "the seed asked for a rename" and "the twin
      // serves a rename" the same statement. The content comes from the source
      // path, which the domain resolves on the branch the move happens on.
      files: z
        .array(
          z
            .object({
              path: z.string().min(1),
              content: z.string().optional(),
              branch: z.string().optional(),
              renamed_from: z.string().min(1).optional()
            })
            .superRefine((file, ctx) => {
              if (file.renamed_from === undefined) {
                if (file.content === undefined) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["content"],
                    message: "content is required on a file entry that declares no renamed_from"
                  });
                }
                return;
              }
              if (file.content !== undefined) {
                ctx.addIssue({
                  code: "custom",
                  path: ["content"],
                  message: `renamed_from carries the source file's content, so content must be omitted (${file.path})`
                });
              }
              if (file.renamed_from === file.path) {
                ctx.addIssue({
                  code: "custom",
                  path: ["renamed_from"],
                  message: `renamed_from must name a different path than the file it moves to (${file.path})`
                });
              }
            })
        )
        .default([]),
      // F-1421 — milestones, tags and releases are repository-level entities the
      // twin already SERVES (`GET /milestones`, `/tags`, `/releases`,
      // `/releases/latest`, `/releases/tags/:tag`) and the seed could not
      // express. Zod strips unknown keys, so a seed naming one reached the
      // domain as nothing at all and those routes could only ever answer `[]`
      // — a shape of infidelity no shape-diff can see, because an empty array
      // on both sides compares zero elements.
      milestones: z
        .array(
          z.object({
            // Assigned sequentially from 1 in seed order when omitted, the way
            // `nextMilestoneNumber` hands them out. Honored when given, so a
            // seed that pins `PATCH /milestones/2` addresses the milestone it
            // named rather than one silently renumbered under it.
            number: z.number().int().positive().optional(),
            title: z.string().min(1),
            description: z.string().default(""),
            state: z.enum(["open", "closed"]).default("open"),
            // GitHub's own spelling: an ISO 8601 timestamp. Absent means the
            // milestone has no due date (`due_on: null` on the wire).
            due_on: z.string().optional()
          })
        )
        .default([]),
      // A tag names a commit. `target` is any ref the twin resolves — a branch
      // name or a SHA — and defaults to the repository's default-branch head. A
      // release whose `tag_name` matches an entry here reuses that tag rather
      // than minting a second one: `createRelease` looks the tag up first.
      tags: z
        .array(
          z.object({
            name: z.string().min(1),
            target: z.string().min(1).optional()
          })
        )
        .default([]),
      releases: z
        .array(
          z.object({
            tag_name: z.string().min(1),
            // Nullable upstream, so an absent `name` means `null` — not `""`.
            name: z.string().optional(),
            body: z.string().default(""),
            target_commitish: z.string().min(1).optional(),
            draft: z.boolean().default(false),
            prerelease: z.boolean().default(false),
            author: z.string().min(1).optional()
          })
        )
        .default([]),
      issues: z
        .array(
          z.object({
            number: z.number().int().positive().optional(),
            title: z.string().min(1),
            body: z.string().default(""),
            state: z.enum(["open", "closed"]).default("open"),
            labels: z.array(z.string().min(1)).default([]),
            assignees: z.array(z.string().min(1)).default([]),
            // The issue's conversation timeline, served at
            // `GET /repos/:o/:r/issues/:n/comments` (F-1421). `author` is
            // seeded honestly rather than taken from the write path, which
            // stamps every comment `pome-agent`: a world in which the agent
            // under test wrote every comment on the issue it is being asked to
            // read is not one worth testing against.
            comments: z
              .array(
                z.object({
                  body: z.string().min(1),
                  author: z.string().min(1).optional()
                })
              )
              .default([])
          })
        )
        .default([]),
      pull_requests: z
        .array(
          z.object({
            number: z.number().int().positive().optional(),
            title: z.string().min(1),
            body: z.string().default(""),
            head: z.string().min(1),
            base: z.string().min(1).default("main"),
            state: z.enum(["open", "closed"]).default("open"),
            author: z.string().min(1).optional(),
            // Reviews seeded on this PR. `state` mirrors GitHub's review
            // state enum; `author` must exist in the user/collaborator set.
            reviews: z
              .array(
                z.object({
                  author: z.string().min(1),
                  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]).default("APPROVED"),
                  body: z.string().default("")
                })
              )
              .default([]),
            // Commit statuses applied to this PR's head SHA. Wired into the
            // commit_statuses table so get_pull_request_status and the merge
            // path see them without needing a separate setup call.
            statuses: z
              .array(
                z.object({
                  context: z.string().min(1).default("ci/build"),
                  state: z.enum(["error", "failure", "pending", "success"]).default("success"),
                  description: z.string().default("")
                })
              )
              .default([]),
            // F-1421 — the PR's CONVERSATION timeline. Same table, same route
            // and same number space as an issue's comments, because GitHub
            // models a pull request as an issue (F-1151). This is the third
            // thing a reader could call "a comment on the PR" and the seed
            // keeps all three apart: `reviews[].body` is the prose on a review
            // verdict, `review_comments[]` below is anchored to a file and
            // line, and THIS one is the timeline.
            comments: z
              .array(
                z.object({
                  body: z.string().min(1),
                  author: z.string().min(1).optional()
                })
              )
              .default([]),
            // F-1421 — inline review comments, served at
            // `GET /repos/:o/:r/pulls/:n/comments`. Seeded through the domain's
            // own write path, so `path` must name a file the PR changes and
            // `line` must exist in it: a seeded review comment is one
            // `POST /pulls/:n/comments` could have produced, not a row only the
            // seeder can make.
            review_comments: z
              .array(
                z.object({
                  body: z.string().min(1),
                  path: z.string().min(1),
                  line: z.number().int().positive().default(1),
                  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
                  author: z.string().min(1).optional()
                })
              )
              .default([])
          })
        )
        .default([])
    })
  )
});

export type ParsedGitHubStateSeed = z.output<typeof seedSchema>;

export function parseSeed(input: unknown): ParsedGitHubStateSeed {
  const seed = seedSchema.parse(normalizeLegacyGitHubSeed(input));
  if (seed.repositories.length === 0) {
    throw new Error("GitHub seed must contain at least one repository");
  }
  return seed;
}

function normalizeLegacyGitHubSeed(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const seed = input as Record<string, unknown>;
  if (!Array.isArray(seed.repositories)) return input;

  return {
    ...seed,
    repositories: seed.repositories.map((repo) => {
      if (!repo || typeof repo !== "object" || Array.isArray(repo)) return repo;
      const record = repo as Record<string, unknown>;
      if (!Array.isArray(record.issues)) return repo;
      return {
        ...record,
        issues: record.issues.map((issue) => normalizeLegacyIssueAssignee(issue))
      };
    })
  };
}

function normalizeLegacyIssueAssignee(issue: unknown): unknown {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
  const record = issue as Record<string, unknown>;
  if (!("assignee" in record) || "assignees" in record) return issue;

  const { assignee, ...rest } = record;
  if (assignee === null || assignee === undefined || assignee === "") {
    return { ...rest, assignees: [] };
  }
  if (typeof assignee === "string") {
    return { ...rest, assignees: [assignee] };
  }
  return issue;
}

/**
 * Boot-time seed loader: prefer `POME_SEED_JSON` env (set by the cloud
 * control-plane from the CLI-supplied scenario seed; see FDRS-353) and
 * fall back to `defaultSeedState()` when the env is absent. Throws on
 * malformed JSON or schema-invalid seed, so a misconfigured cloud
 * deploy fails the twin server's healthz instead of silently booting
 * with the default world.
 */
/**
 * `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv`, which is
 * structurally the same thing but an AMBIENT global. This signature is vendored
 * into `@pome-sh/checks`'s published declarations, and an ambient reference there
 * makes a consumer's `tsc` fail with TS2503 unless they happen to have
 * `@types/node` installed — a dependency this package should not impose to
 * describe a plain string map.
 */
export function loadSeedFromEnv(env: Record<string, string | undefined> = process.env): ParsedGitHubStateSeed {
  const raw = env.POME_SEED_JSON;
  if (raw === undefined || raw === "") {
    return parseSeed(defaultSeedState());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `POME_SEED_JSON is not valid JSON: ${(err as Error).message}`
    );
  }
  return parseSeed(parsed);
}

export function defaultSeedState(): GitHubStateSeed {
  return {
    users: [
      { login: "acme", type: "Organization", name: "Acme" },
      { login: "alice", type: "User", name: "Alice" },
      { login: "bob", type: "User", name: "Bob" },
      { login: "pome-agent", type: "User", name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        description: "Example API service used by GitHub twin tests.",
        default_branch: "main",
        collaborators: ["alice", "bob", "pome-agent"],
        labels: [
          { name: "bug", color: "d73a4a", description: "Something is not working" },
          { name: "feature", color: "a2eeef", description: "New feature or request" },
          { name: "question", color: "d876e3", description: "More information needed" }
        ],
        files: [
          { path: "README.md", content: "# Acme API\n\nA seeded repository for local GitHub twin tests.\n" },
          { path: "src/index.ts", content: "export function handler() {\n  return 'ok';\n}\n" }
        ],
        issues: [
          {
            number: 1,
            title: "500 error on POST /orders after deploy",
            body: "Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.",
            labels: ["bug"],
            assignees: []
          }
        ]
      }
    ]
  };
}
