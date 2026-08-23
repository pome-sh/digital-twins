// SPDX-License-Identifier: Apache-2.0
// ADR-015 — the `seed` override on createSessionRequestSchema is a PERMISSIVE,
// shape-blind boundary.

import { describe, expect, it } from "vitest";
import { createSessionRequestSchema, githubSeedStateSchema } from "../../../src/contract/index.js";

describe("createSessionRequestSchema.seed — permissive boundary (ADR-015)", () => {
  it("forwards unknown / future seed fields verbatim instead of stripping them", () => {
    // A seed carrying fields no schema models, top level and nested. The old
    // narrow union zod-stripped them; the permissive boundary must not.
    const seed = {
      users: [{ login: "alice", type: "User", name: "Alice" }],
      repositories: [
        {
          owner: "acme",
          name: "server",
          // unknown nested field — the twin's business, not the boundary's
          some_future_field: { nested: [1, 2, 3] },
          pull_requests: [
            {
              title: "Fix rounding",
              head: "feature",
              reviews: [{ author: "alice", state: "APPROVED" }],
              statuses: [{ context: "ci/build", state: "success" }],
            },
          ],
          files: [{ path: "a.py", content: "x = 1\n" }],
        },
      ],
      top_level_unknown: "keep me",
    };
    const parsed = createSessionRequestSchema.parse({
      twins: ["github"],
      task_source: "Zg==",
      seed,
    });
    // Deep-equal: nothing stripped, nothing defaulted-in. The boundary is a
    // pass-through.
    expect(parsed.seed).toEqual(seed);
  });

  it("keeps the one invariant — rejects a seed that is not a JSON object", () => {
    // The boundary's sole domain rule (matching extractSeedFromScenarioSource).
    const asArray = createSessionRequestSchema.safeParse({
      twins: ["github"],
      task_source: "Zg==",
      seed: [{ owner: "acme", name: "server" }],
    });
    expect(asArray.success).toBe(false);

    const asString = createSessionRequestSchema.safeParse({
      twins: ["github"],
      task_source: "Zg==",
      seed: "not-an-object",
    });
    expect(asString.success).toBe(false);
  });
});

describe("githubSeedStateSchema — full GitHub world (ported from pome-cloud)", () => {
  it("models users / default_branch / files / pull_requests with reviews + statuses", () => {
    const parsed = githubSeedStateSchema.parse({
      users: [{ login: "alice" }],
      repositories: [
        {
          owner: "acme",
          name: "server",
          default_branch: "main",
          files: [{ path: "src/app.py", content: "x = 1\n", branch: "feature" }],
          pull_requests: [
            {
              title: "Fix rounding",
              head: "feature",
              reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "nit" }],
              statuses: [{ context: "ci/build", state: "failure" }],
            },
          ],
        },
      ],
    });
    const repo = parsed.repositories[0]!;
    expect(parsed.users?.[0]).toEqual({ login: "alice", type: "User", name: "" });
    expect(repo.default_branch).toBe("main");
    expect(repo.files?.[0]?.path).toBe("src/app.py");
    const pr = repo.pull_requests?.[0]!;
    expect(pr.base).toBe("main");            // default
    expect(pr.state).toBe("open");           // default
    expect(pr.reviews[0]?.state).toBe("CHANGES_REQUESTED");
    expect(pr.statuses[0]?.state).toBe("failure");
  });

  it("still accepts the 0.3.0-era issue-triage subset unchanged", () => {
    const parsed = githubSeedStateSchema.parse({
      repositories: [
        {
          owner: "acme",
          name: "server",
          issues: [{ number: 7, title: "Bug" }],
        },
      ],
    });
    expect(parsed.repositories[0]!.issues[0]!.state).toBe("open");
  });
});
