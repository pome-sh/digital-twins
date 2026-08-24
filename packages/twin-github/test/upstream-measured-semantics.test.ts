// SPDX-License-Identifier: Apache-2.0
// `list_issues`/`search_issues` semantics measured against real GitHub 2026-08-21:
// multi-label UNIONs on MCP and INTERSECTs on REST; a term matches a whole.

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

/** A world where union (3), intersection (1) and either label alone (2, 2) are
 *  four distinct sets, so an AND-where-GitHub-ORs fix cannot pass by luck. */
const WORLD: GitHubStateSeed = {
  users: [
    { login: "acme", type: "Organization", name: "Acme" },
    { login: "pome-agent", type: "User", name: "Pome Agent" },
  ],
  repositories: [
    {
      owner: "acme",
      name: "orders-service",
      description: "Order intake.",
      default_branch: "main",
      labels: [
        { name: "bug", color: "d73a4a", description: "Something is not working" },
        { name: "tracking", color: "0e8a16", description: "Umbrella issue" },
      ],
      issues: [
        {
          number: 8,
          title: "POST /orders returns 500 when the coupon field is empty",
          body: "An empty coupon should mean no discount rather than a lookup miss.",
          state: "open",
          labels: ["bug"],
        },
        {
          number: 23,
          title: "[tracking] Coupon-path regressions",
          body: "Umbrella issue. Consolidates the coupon defects.",
          state: "open",
          labels: ["bug", "tracking"],
        },
        {
          number: 31,
          title: "Docs: describe the couponless checkout flow",
          // `apply_coupon` is the compound case and it is load-bearing: a bare
          // `coupon` has to reach it, and `couponless` in the title has to stay
          // out of reach. One issue carries both so a tokeniser cannot satisfy
          // one by breaking the other.
          body: "The couponless path is undocumented. See apply_coupon in src/orders.py.",
          state: "open",
          labels: ["tracking"],
        },
        {
          number: 47,
          title: "Flaky test: refunds idempotency",
          body: "Fails about one run in twenty.",
          state: "closed",
          labels: ["bug"],
        },
      ],
    },
  ],
};

const app = createGitHubCloneApp({ seed: WORLD });

/** `tools/call`, returning the twin's answer or the refusal it produced. */
async function mcp(name: string, args: unknown): Promise<{ refused: boolean; body: any }> {
  const response = await app.request(
    `${base}/mcp`,
    withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const envelope = (await response.json()) as any;
  const text = envelope?.result?.content?.[0]?.text ?? JSON.stringify(envelope);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { refused: Boolean(envelope?.result?.isError || envelope?.error), body };
}

async function rest(path: string): Promise<{ status: number; body: any }> {
  const response = await app.request(`${base}${path}`, withAuth(token, { method: "GET" }));
  return { status: response.status, body: await response.json() };
}

/** Issue numbers, sorted — a SET, never a count (`list-state-default.test.ts`'s rule). */
const numbers = (rows: unknown): number[] =>
  (Array.isArray(rows) ? rows : []).map((row: any) => row.number).sort((a, b) => a - b);

async function listIssues(args: Record<string, unknown>): Promise<number[] | "REFUSED"> {
  const { refused, body } = await mcp("list_issues", { owner: "acme", repo: "orders-service", ...args });
  return refused ? "REFUSED" : numbers(body);
}

async function searchIssues(query: string): Promise<number[]> {
  const { refused, body } = await mcp("search_issues", { query });
  expect(refused, `search_issues(${query}) was refused: ${JSON.stringify(body)}`).toBe(false);
  return numbers(body?.items);
}

describe("the MCP door takes the array it advertises, and ORs it", () => {
  // GitHub declares an array of strings, and the deployed server answered 18
  // issues for `labels:["auth"]`.
  it("accepts `labels: [\"bug\"]`, the shape its own inputSchema declares", async () => {
    expect(await listIssues({ state: "OPEN", labels: ["bug"] })).toEqual([8, 23]);
  });

  // THE ROW THAT DECIDED THE FIX. Deployed MCP: 18 + 21 = 39, an exact union.
  // REST on the same two labels: 0. Both measured 2026-08-21.
  it("UNIONS multiple labels, the way GraphQL does — not the REST intersection", async () => {
    const union = await listIssues({ state: "OPEN", labels: ["bug", "tracking"] });
    expect(union).toEqual([8, 23, 31]);

    // Stated as the relation the measurement established, so this fails loudly if
    // someone "simplifies" the MCP door onto the REST CSV path later.
    const bugOnly = await listIssues({ state: "OPEN", labels: ["bug"] });
    const trackingOnly = await listIssues({ state: "OPEN", labels: ["tracking"] });
    const intersection = (bugOnly as number[]).filter((n) => (trackingOnly as number[]).includes(n));
    expect(union).toEqual([...new Set([...(bugOnly as number[]), ...(trackingOnly as number[])])].sort((a, b) => a - b));
    expect(union).not.toEqual(intersection);
  });

  // Rung 2 + 4: `OptionalStringArrayParam`'s `default:` branch errors with
  // "parameter labels could not be coerced to []string, is string", and the
  // deployed server returned exactly that. The twin used to ACCEPT the string —
  // a call the vendor refuses, which is the false-PASS class.
  it("REFUSES a CSV string on the MCP door, because GitHub's MCP refuses it", async () => {
    expect(await listIssues({ state: "OPEN", labels: "bug" })).toBe("REFUSED");
  });

  // Rung 2: `hasLabels := len(labels) > 0` omits the GraphQL argument entirely,
  // so an empty array filters nothing. Rung 4 confirmed it. The twin used to 422.
  it("treats an EMPTY array as no filter, not as a refusal and not as a match-nothing", async () => {
    expect(await listIssues({ state: "OPEN", labels: [] })).toEqual([8, 23, 31]);
  });

  // Rung 3 + 4: `labels:["AUTH"]` and `?labels=AUTH` both answered 18, the same
  // as `auth`. Both doors, so this belongs in the domain rather than at either
  // boundary.
  it("matches label names case-insensitively, on BOTH doors", async () => {
    expect(await listIssues({ state: "OPEN", labels: ["BUG"] })).toEqual([8, 23]);
    const { body } = await rest("/repos/acme/orders-service/issues?state=open&labels=BUG");
    expect(numbers(body)).toEqual([8, 23]);
  });

  // The other half of the rule, applied here: the doors disagree and both
  // are right, so the REST door must NOT drift onto the MCP door's semantics.
  it("keeps the REST door on GitHub's CSV INTERSECTION", async () => {
    const both = await rest("/repos/acme/orders-service/issues?state=open&labels=bug,tracking");
    expect(numbers(both.body)).toEqual([23]);

    // …and an empty CSV is no filter there too (measured: `?labels=` returned the
    // unfiltered set).
    const empty = await rest("/repos/acme/orders-service/issues?state=open&labels=");
    expect(numbers(empty.body)).toEqual([8, 23, 31]);
  });
});

describe("free text is tokenised, and a term matches a whole token", () => {
  // The ticket's own stated regression case, seeded and asserted.
  it("finds the issue whose title carries every term, in any order", async () => {
    expect(await searchIssues("coupon 500")).toEqual([8]);
    expect(await searchIssues("500 coupon")).toEqual([8]);
  });

  it("matches ACROSS title and body, the way one indexed document does", async () => {
    // `empty` is in #8's title, `discount` only in its body.
    expect(await searchIssues("empty discount")).toEqual([8]);
  });

  it("ANDs the terms — a term that matches nothing empties the answer", async () => {
    // #31 is here through `apply_coupon` in its body, not through `couponless`
    // in its title — see the compound case below, which pins both directions.
    expect(await searchIssues("coupon")).toEqual([8, 23, 31]);
    expect(await searchIssues("coupon refunds")).toEqual([]);
  });

  // THE ROW THAT DECIDED THE FIX. `authentication` → 607, `authenticati` → 0.
  // A per-term `.includes()` would answer #31 here and would be a false HIT.
  it("does NOT match a prefix of a token — `coupon` must not reach `couponless`", async () => {
    expect(await searchIssues("couponless")).toEqual([31]);
  });

  // Settled by negation: `per_page NOT page` → 0, so a document carrying the
  // compound also answers to its parts. Reading only the counts got this wrong.
  it("a bare term REACHES inside a snake_case or hyphenated compound", async () => {
    // #31's body says `apply_coupon` and its title says `couponless`. The first
    // must be reachable by `coupon`, the second must not — same issue, so this
    // cannot be satisfied by loosening the match.
    expect(await searchIssues("coupon")).toEqual([8, 23, 31]);
    expect(await searchIssues("apply")).toEqual([31]);
  });

  it("…and a query naming the compound stays NARROWER than its parts", async () => {
    // `per_page` 110 < `per page` 226 on `cli/cli`: only a document that really
    // carries the compound offers it, so the query keeps `_` and `-` intact.
    expect(await searchIssues("apply_coupon")).toEqual([31]);
    // #8's title has `orders` and #31's body has `apply`, but no issue carries
    // the compound `apply-orders`, so the narrower query answers nothing while
    // the two loose terms would have matched.
    expect(await searchIssues("apply-orders")).toEqual([]);
  });

  it("is case-insensitive on both sides of the match", async () => {
    expect(await searchIssues("COUPON 500")).toEqual([8]);
  });
});

describe("`is:` is GitHub's commonest issue qualifier and is parsed", () => {
  // Measured: `is:open` → 5 and `state:open` → 5, the same set. The twin used to
  // leave `is:open` in the free text, so ANY query carrying it answered [].
  it("`is:open` filters to the open issues, exactly as `state:open` does", async () => {
    expect(await searchIssues("refunds is:open")).toEqual([]);
    expect(await searchIssues("coupon is:open")).toEqual([8, 23, 31]);
    expect(await searchIssues("coupon is:open")).toEqual(await searchIssues("coupon state:open"));
  });

  it("`is:closed` filters to the closed issues", async () => {
    expect(await searchIssues("refunds is:closed")).toEqual([47]);
    expect(await searchIssues("refunds is:closed")).toEqual(await searchIssues("refunds state:closed"));
  });

  // Measured: `is:issue` 21 and `is:pr` 16 partition the unscoped 37.
  it("`is:issue` is the identity here, because this surface reads the issues table", async () => {
    expect(await searchIssues("coupon is:issue")).toEqual(await searchIssues("coupon"));
  });

  // The twin's `searchIssues` reads the issues table and this world's pulls are
  // not in it, so the honest answer is EMPTY rather than issues-dressed-as-PRs.
  // That is GITHUB-MCP-010's false PASS closed in the safe direction; the missing
  // `search_pull_requests` TOOL is a separate, still-registered gap.
  it("`is:pr` answers empty rather than handing back issues", async () => {
    expect(await searchIssues("coupon is:pr")).toEqual([]);
  });

  // Measured: `is:bogusvalue` → 0. GitHub recognises the qualifier and answers
  // nothing for a value it cannot honour; it does not treat it as free text.
  it("an `is:` value the surface cannot honour empties the answer, as GitHub's does", async () => {
    expect(await searchIssues("coupon is:bogusvalue")).toEqual([]);
  });

  it("a qualifier this twin does not parse at all still narrows to nothing", async () => {
    // Unchanged behaviour, re-pinned here because the `is:` case above could
    // easily be generalised into dropping unknown qualifiers, which would WIDEN
    // past GitHub — divergence 1's stated failure direction.
    expect(await searchIssues("coupon bogus:x")).toEqual([]);
  });
});
