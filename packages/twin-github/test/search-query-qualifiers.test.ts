// SPDX-License-Identifier: Apache-2.0
//
// F-1389 — GitHub's search API takes ONE scoping input, `q`, and encodes every
// filter as a qualifier inside it (`repo:octocat/hello-world`, `state:open`).
// Its OpenAPI declares `q, sort, order, per_page, page` and nothing else.
//
// This twin used to take `?owner=`, `?repo=` and `?state=` as query parameters
// on `/search/code`, `/search/commits` and `/search/issues` and scope by them
// (GH-DECL-IN-001, GH-DECL-IN-002). Deleting those three declarations alone
// would have been the smaller half of the fix, and on its own it would have
// left the surface worse than it looks: `searchIssues` matched the WHOLE `q`
// string as a case-insensitive substring, so an agent writing the request
// GitHub actually documents —
//
//     GET /search/issues?q=idempotency repo:acme/api
//
// — got ZERO results here, because no issue's title or body contains that
// literal string. The surface did not merely let a wrong scoping habit pass; it
// PUNISHED the correct one. Both halves therefore land together: the qualifiers
// are parsed out of `q` and scoped by, and the three query parameters are gone
// from the declaration.
//
// Every assertion below compares a SET of results, never a count — the
// discipline `list-state-default.test.ts` sets out and the reason for it: a
// count matches for the wrong reason as easily as the right one. Results are
// keyed by `full_name` AND number/path, because issue numbers are drawn from a
// PER-REPO counter, so "issue #1" names three different issues in this world.
//
// The world seeds THREE repositories under three different owners, two of them
// sharing the repository name `api`. Both facts are load-bearing: a `repo:`
// scope has to be shown EXCLUDING the other repositories, and `repo:acme/api`
// has to be shown resolving on the full name rather than on `api`.

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

describe("search `q` qualifiers (F-1389)", () => {
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

    it("keeps NO open default when `state:` is absent (F-1427)", async () => {
      // GitHub's search API has no `state=open` default — `is:open` is a query
      // qualifier, not a default — so the closed issue must still be in the
      // answer. F-1427 gave the three LIST routes an open default and
      // deliberately left this surface without one; parsing `state:` as a
      // qualifier must not quietly introduce one.
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
      // `in:`, `language:`, `path:` and the boolean operators are named in
      // FIDELITY.md divergence 1 as unparsed. They are unparsed the same way
      // `bogus:` is — left in the term — rather than dropped.
      //
      // ⚠️ `is:` USED TO BE ON THAT LIST AND IS NOT ANY MORE (F-791). It was the
      // costliest member of it: `is:open` is GitHub's commonest issue qualifier,
      // so leaving it in the term zeroed every query that carried one, and an
      // agent that wrote the request GitHub documents was told nothing existed.
      // It is parsed now, and the case below pins the new behaviour.
      expect(await code("idempotency language:ts")).toEqual([]);
    });

    it("parses `is:` on `/search/issues`, where GitHub has it (F-791)", async () => {
      // Measured against real GitHub 2026-08-21 on `cli/cli`: `is:open` and
      // `state:open` answered the SAME 5 issues, and `is:issue` (21) + `is:pr`
      // (16) partitioned the unscoped 37 exactly. So `is:open` is not a second
      // filter with its own semantics — it is the spelling GitHub's own docs use
      // for the one this surface already had.
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
    // github's measured undeclared disposition is `ignore` (F-1372), so these
    // are discarded rather than refused: real GitHub answers 200 to a query
    // parameter it does not know. The claim is therefore that the answer is
    // UNCHANGED, not that the request is rejected.
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
