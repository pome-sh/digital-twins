// SPDX-License-Identifier: Apache-2.0
//
// F-1614 + F-791 — the two `list_issues` / `search_issues` behaviours that were
// MEASURED against real GitHub rather than reasoned about, and the twin pinned
// to what came back.
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM THE OTHER SEARCH SUITES ────────────
//
// `search-query-qualifiers.test.ts` pins how `q` is SCOPED; `list-state-default`
// pins the state default. Neither could have caught either defect here, because
// both defects are agreements between the twin and itself: the twin advertised
// an array and validated a string, and it matched `q` as one substring. Nothing
// in the repository held a statement about what the VENDOR does with the same
// call, so there was nothing for either to disagree with.
//
// This file is that statement. Every expectation below is a measurement, its
// provenance named on the case, and the twin is asserted against the vendor's
// answer rather than against a prior reading of this twin's own code.
//
// ── HOW EACH ROW WAS MEASURED (2026-08-21) ──────────────────────────────────
//
// Four rungs were available and all four were used, weakest first:
//
//   1. the vendor's DECLARED schema — `fixtures/mcp-tools-list.raw.json`, which
//      is GitHub's own `tools/list` capture (`config/mcp-capture-sources.json`
//      pins `github/github-mcp-server` @ c2bc7dc0, `--toolsets=default`);
//   2. the vendor's SOURCE at that pinned commit — `pkg/github/issues.go`'s
//      `ListIssues` and `pkg/github/params.go`'s `OptionalStringArrayParam`;
//   3. the vendor's live REST and GraphQL APIs, via `gh api` / `gh api graphql`
//      against `cli/cli`;
//   4. the vendor's DEPLOYED MCP server — `tools/call list_issues` against
//      `https://api.githubcopilot.com/mcp/` with a GitHub token.
//
// Rung 4 had never been read before this ticket; `config/mcp-capture-sources.json`
// asks for exactly that read under `unguardedDirection`.
//
//   call                                    real GitHub            rung
//   ─────────────────────────────────────── ────────────────────── ────
//   MCP list_issues labels:["auth"]          18 issues              3,4
//   MCP list_issues labels:["auth","codesp"] 39 = 18+21 → ANY-of    3,4
//   REST ?labels=auth,codespaces             0        → ALL-of      3
//   MCP list_issues labels:"auth" (string)   REFUSED                2,4
//   MCP list_issues labels:[]                no filter              2,4
//   labels:["AUTH"] / ?labels=AUTH           18 → case-insensitive  3,4
//   search q="codespaces"                    345                    3
//   search q="authentication"                607                    3
//   search q="codespaces authentication"     37       → ALL terms   3
//   search q="authenticati" (prefix)         0        → whole token 3
//   search q="… is:open"                     5  ≡ state:open        3
//   search q="… is:issue" / "… is:pr"        21 / 16  → partition   3
//   search q="… is:bogusvalue"               0                      3
//
// The two that decided the SHAPE of the fix, and would each have been got wrong
// by reasoning from the ticket text:
//
//   * MULTI-LABEL IS A UNION, NOT AN INTERSECTION. GitHub's MCP `list_issues`
//     runs on GraphQL (`issues(labels: [String!])`), and GraphQL ORs the set —
//     18 + 21 = 39 on `cli/cli`. GitHub's REST `?labels=a,b` INTERSECTS the same
//     two labels to 0. F-1614's prescribed fix was "join the array to CSV and
//     call the REST-shaped domain", which would have answered 0 where GitHub
//     answers 39 — the same false-empty class as F-791, introduced by the patch
//     for F-1614.
//
//   * A TERM MATCHES A WHOLE TOKEN, NOT A SUBSTRING. `authentication` returns
//     607 and `authenticati` returns 0. F-791's prescribed fix was "tokenise on
//     whitespace and match all terms", which with a substring test per term
//     would answer 607 for the prefix — trading a false EMPTY for a false HIT,
//     and a false hit is the worse class for a grading instrument
//     (`mcp-argument-surface.test.ts`'s own taxonomy).
//
// Counts on a live repository drift, so nothing below asserts 18 or 607. What is
// asserted is the RELATION each count established — union vs intersection, whole
// token vs prefix, `is:open` ≡ `state:open` — against a seeded world this repo
// owns.

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
 * A world shaped to make each measured relation observable, and to make the
 * WRONG answer a different set rather than a different count.
 *
 * `bug` and `tracking` are carried by DIFFERENT issues with exactly one issue in
 * common, so union (3), intersection (1) and either label alone (2, 2) are four
 * distinct sets. A fix that ANDs where GitHub ORs cannot pass by coincidence.
 *
 * The coupon issue is F-791's own stated regression case, transplanted from the
 * ticket: its title carries `coupon` and `500` as separate words, so a
 * whole-string matcher finds nothing for `coupon 500` and a tokenised one finds
 * it. `couponless` exists solely to be a token that a PREFIX match would reach
 * and a whole-token match must not.
 */
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
          body: "The couponless path is undocumented.",
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

describe("F-1614 — the MCP door takes the array it advertises, and ORs it", () => {
  // Rung 1 + 2: the fixture declares `{"type":"array","items":{"type":"string"}}`
  // and `OptionalStringArrayParam` reads it as one. Rung 4: the deployed server
  // answered 18 issues for `labels:["auth"]`.
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

  // The other half of F-1460's rule, applied here: the doors disagree and both
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

describe("F-791 — free text is tokenised, and a term matches a whole token", () => {
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
    // #31 carries `couponless`, not `coupon`, so it is absent here for the same
    // reason the prefix case below says it must be.
    expect(await searchIssues("coupon")).toEqual([8, 23]);
    expect(await searchIssues("coupon refunds")).toEqual([]);
  });

  // THE ROW THAT DECIDED THE FIX. `authentication` → 607, `authenticati` → 0.
  // A per-term `.includes()` would answer #31 here and would be a false HIT.
  it("does NOT match a prefix of a token — `coupon` must not reach `couponless`", async () => {
    expect(await searchIssues("couponless")).toEqual([31]);
    expect(await searchIssues("coupon")).not.toContain(31 as never);
  });

  it("is case-insensitive on both sides of the match", async () => {
    expect(await searchIssues("COUPON 500")).toEqual([8]);
  });
});

describe("F-791 — `is:` is GitHub's commonest issue qualifier and is parsed", () => {
  // Measured: `is:open` → 5 and `state:open` → 5, the same set. The twin used to
  // leave `is:open` in the free text, so ANY query carrying it answered [].
  it("`is:open` filters to the open issues, exactly as `state:open` does", async () => {
    expect(await searchIssues("refunds is:open")).toEqual([]);
    expect(await searchIssues("coupon is:open")).toEqual([8, 23]);
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
