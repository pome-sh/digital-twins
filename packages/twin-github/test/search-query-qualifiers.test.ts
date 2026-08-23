// SPDX-License-Identifier: Apache-2.0
// GitHub's search API takes ONE scoping input, `q`, and encodes every filter as a
// qualifier inside it (`repo:octocat/hello-world`, `state:open`).

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

/**
 * One search term — `idempotency` — planted in all three repositories, in an
 * issue title, a file and a file path. Scoping is only demonstrable against a
 * world where the unscoped answer is bigger than the scoped one.
 *
 * `acme` and `globex` are Organizations and `alice` is a User, so `org:` and
 * `user:` have something to tell apart (and this suite pins that this twin
 * deliberately does NOT tell them apart — see the `org:`/`user:` case).
 */
const WORLD: GitHubStateSeed = {
  users: [
    { login: "acme", type: "Organization", name: "Acme" },
    { login: "globex", type: "Organization", name: "Globex" },
    { login: "alice", type: "User", name: "Alice" },
    { login: "pome-agent", type: "User", name: "Pome Agent" },
  ],
  repositories: [
    {
      owner: "acme",
      name: "api",
      description: "Acme's API.",
      default_branch: "main",
      files: [
        { path: "README.md", content: "# Acme API\n" },
        { path: "src/idempotency.ts", content: "export const idempotencyKey = 'acme';\n" },
      ],
      issues: [
        { number: 1, title: "Add idempotency keys to POST /orders", state: "open" },
        { number: 2, title: "Retry storm from a missing idempotency token", state: "closed" },
      ],
    },
    {
      // Same repository NAME as acme's, different owner. `repo:acme/api` must
      // exclude this one, which a scope resolved on the bare name would not.
      owner: "globex",
      name: "api",
      description: "Globex's API.",
      default_branch: "main",
      files: [
        { path: "README.md", content: "# Globex API\n" },
        { path: "src/idempotency.ts", content: "export const idempotencyKey = 'globex';\n" },
      ],
      issues: [{ number: 1, title: "idempotency keys for billing", state: "open" }],
    },
    {
      owner: "alice",
      name: "tools",
      description: "Alice's scripts.",
      default_branch: "main",
      files: [{ path: "idempotency.md", content: "Notes on retry safety.\n" }],
      issues: [{ number: 1, title: "idempotency helper script", state: "open" }],
    },
  ],
};

const app = createGitHubCloneApp({ seed: WORLD });

async function search(path: string): Promise<{ status: number; items: any[] }> {
  const response = await app.request(`${base}${path}`, withAuth(token));
  const body = (await response.json()) as { items?: unknown[] };
  return { status: response.status, items: (body.items ?? []) as any[] };
}

/**
 * `acme/api#2` — repo-qualified, because issue numbers are per-repo.
 *
 * Read off `repository_url`, which is where an issue carries its repository:
 * GitHub's `/search/issues` items are issue objects and have no `repository`
 * field, unlike the code and commit results below.
 */
async function issues(query: string): Promise<string[]> {
  const { status, items } = await search(`/search/issues?q=${encodeURIComponent(query)}`);
  expect(status).toBe(200);
  return items
    .map((item) => `${item.repository_url.replace("https://api.github.com/repos/", "")}#${item.number}`)
    .sort();
}

/** `acme/api:src/idempotency.ts`. */
async function code(query: string): Promise<string[]> {
  const { status, items } = await search(`/search/code?q=${encodeURIComponent(query)}`);
  expect(status).toBe(200);
  return items.map((item) => `${item.repository.full_name}:${item.path}`).sort();
}

/** `acme/api@Initial seed commit` — every seeded repo gets exactly one. */
async function commits(query: string): Promise<string[]> {
  const { status, items } = await search(`/search/commits?q=${encodeURIComponent(query)}`);
  expect(status).toBe(200);
  return items.map((item) => `${item.repository.full_name}@${item.commit.message}`).sort();
}

const ALL_IDEMPOTENCY_ISSUES = ["acme/api#1", "acme/api#2", "alice/tools#1", "globex/api#1"];
const ACME_IDEMPOTENCY_ISSUES = ["acme/api#1", "acme/api#2"];

describe("search `q` qualifiers", () => {
  describe("the request GitHub documents", () => {
    it("scopes `/search/issues` by `repo:` and excludes the other repositories", async () => {
      // THE case that returned zero before this ticket. It is stated against
      // the unscoped answer as well, so a regression that broke scoping
      // altogether (returning everything) fails here too.
      expect(await issues("idempotency repo:acme/api")).toEqual(ACME_IDEMPOTENCY_ISSUES);
      expect(await issues("idempotency")).toEqual(ALL_IDEMPOTENCY_ISSUES);
    });

    it("scopes `/search/code` by `repo:`", async () => {
      expect(await code("idempotency repo:acme/api")).toEqual(["acme/api:src/idempotency.ts"]);
      expect(await code("idempotency")).toEqual([
        "acme/api:src/idempotency.ts",
        "alice/tools:idempotency.md",
        "globex/api:src/idempotency.ts",
      ]);
    });

    it("scopes `/search/commits` by `repo:`", async () => {
      expect(await commits("seed repo:acme/api")).toEqual(["acme/api@Initial seed commit"]);
      expect(await commits("seed")).toEqual([
        "acme/api@Initial seed commit",
        "alice/tools@Initial seed commit",
        "globex/api@Initial seed commit",
      ]);
    });

    it("resolves `repo:` on the FULL name, not the bare repository name", async () => {
      // `acme/api` and `globex/api` share the name `api`. A scope resolved on
      // the bare name would answer both and still look like it worked.
      expect(await issues("idempotency repo:globex/api")).toEqual(["globex/api#1"]);
    });

    it("matches `repo:` case-insensitively, the way GitHub resolves a repository", async () => {
      expect(await issues("idempotency repo:ACME/API")).toEqual(ACME_IDEMPOTENCY_ISSUES);
    });
  });

  describe("a qualifier with no free text is a scope on its own", () => {
    it("answers every issue in the repository", async () => {
      expect(await issues("repo:acme/api")).toEqual(ACME_IDEMPOTENCY_ISSUES);
    });

    it("answers every file in the repository", async () => {
      expect(await code("repo:acme/api")).toEqual([
        "acme/api:README.md",
        "acme/api:src/idempotency.ts",
      ]);
    });
  });

  describe("`org:` and `user:` scope by owner", () => {
    it("scopes to an organization's repositories", async () => {
      expect(await issues("idempotency org:acme")).toEqual(ACME_IDEMPOTENCY_ISSUES);
    });

    it("scopes to a user's repositories", async () => {
      expect(await issues("idempotency user:alice")).toEqual(["alice/tools#1"]);
    });

    it("does not distinguish an organization from a user — a deliberate simplification", async () => {
      // GitHub documents `org:` for organizations and `user:` for accounts.
      // This twin resolves BOTH to the repository's owner login and checks no
      // account type. Stated as its own assertion because it is a divergence
      // (FIDELITY.md divergence 1), not an accident: the alternative — refusing
      // `user:acme` because `acme` is an Organization — would answer `[]` to a
      // request real GitHub serves, which is the failure this whole ticket is
      // about, pointed the other way.
      expect(await issues("idempotency user:acme")).toEqual(ACME_IDEMPOTENCY_ISSUES);
      expect(await issues("idempotency org:alice")).toEqual(["alice/tools#1"]);
    });

    it("ORs several scope qualifiers together, the way GitHub does", async () => {
      expect(await issues("idempotency repo:acme/api user:alice")).toEqual([
        "acme/api#1",
        "acme/api#2",
        "alice/tools#1",
      ]);
    });
  });

  describe("`state:` on `/search/issues`", () => {
    it("filters to the open issues", async () => {
      expect(await issues("idempotency repo:acme/api state:open")).toEqual(["acme/api#1"]);
    });

    it("filters to the closed issues", async () => {
      expect(await issues("idempotency repo:acme/api state:closed")).toEqual(["acme/api#2"]);
    });

    it("keeps NO open default when `state:` is absent", async () => {
      // GitHub's search API has no `state=open` default — `is:open` is a query
      // qualifier, not a default — so the closed issue must still be in the answer.
      expect(await issues("idempotency repo:acme/api")).toContain("acme/api#2");
    });

    it("is NOT a qualifier on `/search/code`, so it stays free text", async () => {
      // `state:` is an issue-search qualifier on GitHub; code search has no such
      // filter. Lifting it out of `q` here would answer a BROADER set than
      // GitHub, which is the direction this ticket exists to close.
      expect(await code("idempotency state:open")).toEqual([]);
    });
  });

  describe("a qualifier this twin does not parse stays in the free-text term", () => {
    it("does not silently drop an unknown qualifier", async () => {
      // GitHub treats an unrecognised `word:word` as part of the search text.
      // Dropping it would answer a BROADER set than GitHub for a typo'd
      // qualifier — an agent would pass here and lose results in production.
      // Narrowing is the safe direction, so `bogus:x` stays in the term and
      // matches nothing.
      expect(await issues("idempotency")).toEqual(ALL_IDEMPOTENCY_ISSUES);
      expect(await issues("idempotency bogus:x")).toEqual([]);
    });

    it("leaves the qualifiers GitHub has that this twin does not parse in the term", async () => {
      // `in:`, `language:`, `path:` and the boolean operators are named in FIDELITY.md
      // divergence 1 as unparsed.
      expect(await code("idempotency language:ts")).toEqual([]);
    });

    it("parses `is:` on `/search/issues`, where GitHub has it", async () => {
      // Measured 2026-08-21 on `cli/cli`: `is:open` ≡ `state:open` (same 5), and
      // `is:issue` (21) + `is:pr` (16) partitioned the unscoped 37 exactly.
      expect(await issues("idempotency is:open")).toEqual(await issues("idempotency state:open"));
      expect(await issues("idempotency repo:acme/api is:closed")).toEqual(["acme/api#2"]);
      // `is:issue` is the identity here: this surface reads the issues table.
      expect(await issues("idempotency is:issue")).toEqual(await issues("idempotency"));
    });

    it("is NOT a qualifier on `/search/code`, so `is:` stays free text there", async () => {
      // Same rule `state:` follows two describes up, and the same reason:
      // GitHub's code search has `is:archived` / `is:fork`, which this twin does
      // not model, so lifting `is:` out of a code query would answer a BROADER
      // set than GitHub rather than a narrower one.
      expect(await code("idempotency is:archived")).toEqual([]);
    });

    it("leaves a `repo:` with no owner in the term — GitHub takes `owner/name`", async () => {
      expect(await issues("idempotency repo:api")).toEqual([]);
    });

    it("leaves a `state:` value the surface does not have in the term", async () => {
      // `state:merged` is not a state `/search/issues` can answer. Honouring it
      // as "no filter" is the failure the strict `stateFilter` enum in
      // `route-inputs.ts` was introduced to prevent — `?state=merged` silently
      // listing everything.
      expect(await issues("idempotency repo:acme/api state:merged")).toEqual([]);
    });
  });

  describe("the three query parameters GitHub does not declare are gone", () => {
    // github's measured undeclared disposition is `ignore`, so these are discarded
    // rather than refused: real GitHub answers 200 to a query parameter it does.
    const IGNORED = [
      { name: "?owner=", suffix: "&owner=acme" },
      { name: "?repo=", suffix: "&repo=api" },
      { name: "?state=", suffix: "&state=closed" },
      { name: "all three at once", suffix: "&owner=acme&repo=api&state=closed" },
    ] as const;

    for (const surface of [
      { name: "/search/issues", path: "/search/issues?q=idempotency" },
      { name: "/search/code", path: "/search/code?q=idempotency" },
      { name: "/search/commits", path: "/search/commits?q=seed" },
    ]) {
      for (const ignored of IGNORED) {
        it(`${surface.name} ignores ${ignored.name}`, async () => {
          const bare = await search(surface.path);
          const probed = await search(`${surface.path}${ignored.suffix}`);
          expect(bare.status).toBe(200);
          expect(probed.status, `${surface.name} refused ${ignored.name}`).toBe(200);
          expect(
            probed.items,
            `${surface.name} scoped its answer by ${ignored.name}, which GitHub does not declare`
          ).toEqual(bare.items);
        });
      }
    }

    it("does not publish them in the declared input surface", async () => {
      const { GITHUB_ROUTE_INPUTS } = await import("../src/route-inputs.js");
      for (const path of ["/search/code", "/search/commits", "/search/issues"]) {
        const declaration = GITHUB_ROUTE_INPUTS.find((entry) => entry.path === path);
        expect(declaration, `${path} is not declared at all`).toBeDefined();
        expect(
          declaration!.inputs.filter((input) => input.location === "query").map((input) => input.name).sort(),
          `${path} declares an input GitHub's OpenAPI does not`
        ).toEqual(["page", "per_page", "q"]);
      }
    });
  });
});
