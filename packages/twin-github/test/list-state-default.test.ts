// SPDX-License-Identifier: Apache-2.0
// The three LIST surfaces real GitHub defaults to `state=open`, and the one search
// surface it does not.

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

// Issues and pull requests draw numbers from ONE per-repo counter, so the seed
// order below is what fixes them: issue #1, issue #2, then PR #3, PR #4.
const OPEN_ISSUE = 1;
const CLOSED_ISSUE = 2;
const OPEN_PULL = 3;
const CLOSED_PULL = 4;
// Milestones have their own counter, so these are #1 and #2 independently.
const OPEN_MILESTONE = 1;
const CLOSED_MILESTONE = 2;

/** One open and one closed of every kind whose list surface takes `state`. */
const WORLD: GitHubStateSeed = {
  users: [
    { login: "acme", type: "Organization", name: "Acme" },
    { login: "alice", type: "User", name: "Alice" },
    { login: "pome-agent", type: "User", name: "Pome Agent" }
  ],
  repositories: [
    {
      owner: "acme",
      name: "api",
      description: "State-default fixture for the three list surfaces.",
      default_branch: "main",
      collaborators: ["alice", "pome-agent"],
      labels: [{ name: "bug", color: "d73a4a", description: "Something is not working" }],
      files: [
        { path: "README.md", content: "# Acme API\n" },
        { path: "src/feature.ts", content: "export const feature = true;\n", branch: "feature" },
        { path: "src/hotfix.ts", content: "export const hotfix = true;\n", branch: "hotfix" }
      ],
      milestones: [
        { number: OPEN_MILESTONE, title: "v1.0 — checkout hardening", state: "open" },
        { number: CLOSED_MILESTONE, title: "v0.9 — shipped", state: "closed" }
      ],
      issues: [
        { number: OPEN_ISSUE, title: "Seeded bug: 500 on POST /orders", state: "open", labels: ["bug"] },
        // The only "idempotency" match in the world, and it is CLOSED — which is
        // what makes the search assertion below load-bearing.
        { number: CLOSED_ISSUE, title: "Seeded feature: add idempotency keys", state: "closed" }
      ],
      pull_requests: [
        { number: OPEN_PULL, title: "Add feature flag", head: "feature", base: "main", state: "open", author: "pome-agent" },
        { number: CLOSED_PULL, title: "Abandoned hotfix", head: "hotfix", base: "main", state: "closed", author: "pome-agent" }
      ]
    }
  ]
};

const app = createGitHubCloneApp({ seed: WORLD });

async function numbersAt(path: string): Promise<number[]> {
  const response = await app.request(`${base}${path}`, withAuth(token));
  expect(response.status).toBe(200);
  const body = (await response.json()) as Array<{ number: number }>;
  return body.map((row) => row.number).sort((a, b) => a - b);
}

/**
 * The one table this ticket is measured in: for each surface, what each of the
 * four `state` spellings must name. The absent case is the fix — it must equal
 * the explicit `open` case and NOT the `all` case.
 */
const SURFACES = [
  {
    name: "GET /repos/:o/:r/issues",
    path: "/repos/acme/api/issues",
    open: [OPEN_ISSUE],
    closed: [CLOSED_ISSUE],
    all: [OPEN_ISSUE, CLOSED_ISSUE]
  },
  {
    name: "GET /repos/:o/:r/pulls",
    path: "/repos/acme/api/pulls",
    open: [OPEN_PULL],
    closed: [CLOSED_PULL],
    all: [OPEN_PULL, CLOSED_PULL]
  },
  {
    name: "GET /repos/:o/:r/milestones",
    path: "/repos/acme/api/milestones",
    open: [OPEN_MILESTONE],
    closed: [CLOSED_MILESTONE],
    all: [OPEN_MILESTONE, CLOSED_MILESTONE]
  }
] as const;

describe("list surfaces default `state` to open, the way real GitHub does", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it("serves the OPEN set when no `state` is given", async () => {
        expect(await numbersAt(surface.path)).toEqual([...surface.open]);
      });

      it("serves the same set for an absent `state` as for an explicit `state=open`", async () => {
        expect(await numbersAt(surface.path)).toEqual(await numbersAt(`${surface.path}?state=open`));
      });

      it("does NOT serve the `state=all` set when no `state` is given", async () => {
        // The regression this ticket exists for. Stated as its own assertion so
        // a future change that reverts the default fails HERE, naming the cause,
        // rather than only in the set assertion above.
        expect(await numbersAt(surface.path)).not.toEqual(await numbersAt(`${surface.path}?state=all`));
      });

      it("keeps `state=closed` serving the closed set", async () => {
        expect(await numbersAt(`${surface.path}?state=closed`)).toEqual([...surface.closed]);
      });

      it("keeps `state=all` serving everything", async () => {
        expect(await numbersAt(`${surface.path}?state=all`)).toEqual([...surface.all]);
      });
    });
  }

  describe("GET /search/issues is the exception and keeps no default", () => {
    async function searchNumbers(path: string): Promise<number[]> {
      const response = await app.request(`${base}${path}`, withAuth(token));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Array<{ number: number }> };
      return body.items.map((item) => item.number).sort((a, b) => a - b);
    }

    it("still returns a closed match when no `state` is given", async () => {
      // GitHub's search API has no `state=open` default. The only match for this
      // query in the seeded world is the CLOSED issue, so an open default here
      // would answer `[]` — the reverse divergence, not a fix.
      expect(await searchNumbers("/search/issues?q=idempotency")).toEqual([CLOSED_ISSUE]);
    });

    it("still honours an explicit state, now spelled as a `q` qualifier", async () => {
      expect(await searchNumbers("/search/issues?q=idempotency state:closed")).toEqual([CLOSED_ISSUE]);
      expect(await searchNumbers("/search/issues?q=idempotency state:open")).toEqual([]);
    });

    it("ignores `?state=`, which GitHub's search API does not declare", async () => {
      // The parameter is gone from the declaration, and github's measured
      // undeclared disposition is `ignore` — so this is not a 4xx, it is the
      // same answer as without it. Asserted against `state=open`, the value
      // that USED to change the answer: a twin still scoping by the parameter
      // would answer `[]` here and fail loudly.
      const unfiltered = await searchNumbers("/search/issues?q=idempotency");
      expect(await searchNumbers("/search/issues?q=idempotency&state=open")).toEqual(unfiltered);
      expect(await searchNumbers("/search/issues?q=idempotency&state=closed")).toEqual(unfiltered);
    });
  });
});
