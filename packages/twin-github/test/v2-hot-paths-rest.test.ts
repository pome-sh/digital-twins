// SPDX-License-Identifier: Apache-2.0
// FDRS-300 — REST surface integration tests for the 27 v2 hot-path endpoints.
// Goes through the real Hono app, asserts HTTP status codes match GitHub
// expectations, and confirms mutations are persisted in follow-up reads.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
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

/** F-1460 — `PUT /contents/*` takes base64, the way GitHub's does. */
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function app() {
  return createGitHubCloneApp();
}

async function jsonReq(
  app: ReturnType<typeof createGitHubCloneApp>,
  method: string,
  path: string,
  body?: unknown,
  authToken = token
) {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(authToken, init));
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

// ----- Cluster A — branches & files -----------------------------------

describe("REST / cluster A — branches & files", () => {
  it("GET /branches lists; GET /branches/:name returns one; DELETE /git/refs/heads/:branch removes", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/feature/scratch" });
    const list = await jsonReq(a, "GET", "/repos/acme/api/branches");
    expect(list.status).toBe(200);
    expect((list.body as Array<{ name: string }>).map((b) => b.name)).toEqual(expect.arrayContaining(["main", "feature/scratch"]));

    const one = await jsonReq(a, "GET", "/repos/acme/api/branches/feature/scratch");
    expect(one.status).toBe(200);
    expect((one.body as { name: string }).name).toBe("feature/scratch");

    const removed = await jsonReq(a, "DELETE", "/repos/acme/api/git/refs/heads/feature/scratch");
    expect(removed.status).toBe(204);

    const gone = await jsonReq(a, "GET", "/repos/acme/api/branches/feature/scratch");
    expect(gone.status).toBe(404);
  });

  it("DELETE /contents/:path requires sha and clears the file", async () => {
    const a = app();
    const aliceToken = await signTestToken({ login: "alice" });
    const put = await jsonReq(a, "PUT", "/repos/acme/api/contents/del.txt", { message: "add", content: b64("x\n") }, aliceToken);
    expect(put.status).toBe(201);
    const sha = (put.body as { content: { sha: string } }).content.sha;
    const stale = await jsonReq(a, "DELETE", "/repos/acme/api/contents/del.txt", { message: "drop", sha: "WRONG" }, aliceToken);
    // F-1491 — measured: real GitHub answers a mismatched `sha` with 409, not 422.
    expect(stale.status).toBe(409);
    const removed = await jsonReq(a, "DELETE", "/repos/acme/api/contents/del.txt", { message: "drop", sha }, aliceToken);
    expect(removed.status).toBe(200);
    const gone = await jsonReq(a, "GET", "/repos/acme/api/contents/del.txt");
    expect(gone.status).toBe(404);
    const commits = await jsonReq(a, "GET", "/repos/acme/api/commits");
    expect((commits.body as Array<{ commit: { message: string }; author: { login: string } }>)[0]).toMatchObject({
      commit: { message: "drop" },
      author: { login: "alice" }
    });

    const recreate = await jsonReq(a, "PUT", "/repos/acme/api/contents/del.txt", { message: "re-add", content: b64("y\n") }, aliceToken);
    expect(recreate.status).toBe(201);
  });

  it("DELETE default branch returns 422", async () => {
    const a = app();
    const response = await jsonReq(a, "DELETE", "/repos/acme/api/git/refs/heads/main");
    expect(response.status).toBe(422);
  });
});

// ----- Cluster B — commits & diffs ------------------------------------

describe("REST / cluster B — commits & diffs", () => {
  it("GET /commits/:ref returns commit + stats", async () => {
    const a = app();
    const commits = await jsonReq(a, "GET", "/repos/acme/api/commits");
    const head = (commits.body as Array<{ sha: string }>)[0]!.sha;
    const response = await jsonReq(a, "GET", `/repos/acme/api/commits/${head}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sha: head, stats: expect.any(Object) });
  });

  it("PUT /contents returns 201 on create and 200 on update (FDRS-596)", async () => {
    const a = app();
    const create = await jsonReq(a, "PUT", "/repos/acme/api/contents/newfile.ts", { message: "add", content: b64("1\n") });
    expect(create.status).toBe(201);
    const sha = (create.body as { content: { sha: string } }).content.sha;
    const update = await jsonReq(a, "PUT", "/repos/acme/api/contents/newfile.ts", { message: "update", content: b64("2\n"), sha });
    expect(update.status).toBe(200);

    const seeded = await jsonReq(a, "GET", "/repos/acme/api/contents/README.md");
    const seededSha = (seeded.body as { sha: string }).sha;
    const seededUpdate = await jsonReq(a, "PUT", "/repos/acme/api/contents/README.md", {
      message: "update seeded file",
      content: b64("# Acme API\n\nUpdated.\n"),
      sha: seededSha
    });
    expect(seededUpdate.status).toBe(200);
  });

  it("GET /compare/:base...:head returns status + commits", async () => {
    const a = app();
    const before = await jsonReq(a, "GET", "/repos/acme/api/commits");
    const baseSha = (before.body as Array<{ sha: string }>)[0]!.sha;
    await jsonReq(a, "PUT", "/repos/acme/api/contents/advance.txt", { message: "advance", content: b64("x\n") });
    const response = await jsonReq(a, "GET", `/repos/acme/api/compare/${baseSha}...main`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ahead", ahead_by: expect.any(Number) });
  });

  it("GET /pulls/:n/diff returns the unified-diff envelope", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/diff-rest" });
    await jsonReq(a, "PUT", "/repos/acme/api/contents/diff.ts", { message: "m", content: b64("x\n"), branch: "diff-rest" });
    const pr = await jsonReq(a, "POST", "/repos/acme/api/pulls", { title: "Diff REST", head: "diff-rest", base: "main" });
    const number = (pr.body as { number: number }).number;
    const response = await jsonReq(a, "GET", `/repos/acme/api/pulls/${number}/diff`);
    expect(response.status).toBe(200);
    expect((response.body as { diff: string }).diff).toContain("diff --git");
  });

  it("GET /compare/:base...:head with bad format returns 422", async () => {
    const a = app();
    const response = await jsonReq(a, "GET", "/repos/acme/api/compare/no-dots");
    expect(response.status).toBe(422);
  });
});

// ----- Cluster C — PR deeper ------------------------------------------

describe("REST / cluster C — pull requests deeper", () => {
  async function openPr(a: ReturnType<typeof createGitHubCloneApp>) {
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/cr-rest" });
    await jsonReq(a, "PUT", "/repos/acme/api/contents/cr.ts", { message: "m", content: b64("1\n"), branch: "cr-rest" });
    const pr = await jsonReq(a, "POST", "/repos/acme/api/pulls", { title: "CR", head: "cr-rest", base: "main" });
    return (pr.body as { number: number }).number;
  }

  it("PATCH /pulls/:n updates title", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "PATCH", `/repos/acme/api/pulls/${n}`, { title: "New" });
    expect(response.status).toBe(200);
    expect((response.body as { title: string }).title).toBe("New");
  });

  // FDRS-453 — real GitHub returns the leaner "pull request simple" shape from
  // the LIST endpoint and the full PullRequest only from the single-PR GET.
  // The single-PR-only fields are merged / commits / additions / deletions /
  // changed_files. Lock the list-vs-single shape difference so the twin tracks
  // GitHub's documented schemas.
  const singlePrOnlyFields = ["merged", "commits", "additions", "deletions", "changed_files"] as const;

  it("GET /pulls (LIST) omits the single-PR-only fields", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "GET", "/repos/acme/api/pulls");
    expect(response.status).toBe(200);
    const list = response.body as Array<Record<string, unknown>>;
    const item = list.find((pr) => pr.number === n);
    expect(item).toBeDefined();
    for (const field of singlePrOnlyFields) {
      expect(item).not.toHaveProperty(field);
    }
    // The leaner shape keeps the rest of the PR fields intact.
    expect(item).toMatchObject({ number: n, state: "open", title: "CR" });
    expect(item).toHaveProperty("head");
    expect(item).toHaveProperty("base");
    expect(item).toHaveProperty("merge_commit_sha");
  });

  it("GET /pulls/:n (single) keeps the single-PR-only fields", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "GET", `/repos/acme/api/pulls/${n}`);
    expect(response.status).toBe(200);
    const item = response.body as Record<string, unknown>;
    for (const field of singlePrOnlyFields) {
      expect(item).toHaveProperty(field);
    }
    expect(item).toMatchObject({ number: n, state: "open", title: "CR", merged: false });
  });

  // F-1178 — GitHub shipped stacked pull requests and added `stack` to BOTH the
  // `pull-request` and `pull-request-simple` schemas, each `$ref`ing one new
  // `pull-request-stack` schema (vendored REST description at openapi-spec-mcp
  // commit f0d07e7, 2026-08-02; absent at a8f0142, 2026-07-31). Its shape is
  // read from that schema, not guessed from the name: nullable, with a REQUIRED
  // `base: { ref, sha }` and optional integer `size` / `position` / `id` /
  // `number`. Both surfaces carry it, so both are asserted here.
  type StackJson = { base: { ref: string; sha: string }; size: number; position: number; id: number; number: number };

  // Puts one commit on `ref` so a PR opened from it has a diff.
  async function branchWithWork(a: ReturnType<typeof createGitHubCloneApp>, ref: string) {
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: `refs/heads/${ref}` });
    await jsonReq(a, "PUT", `/repos/acme/api/contents/${ref}.ts`, { message: "m", content: b64("1\n"), branch: ref });
  }

  async function openPull(a: ReturnType<typeof createGitHubCloneApp>, title: string, head: string, base: string) {
    const pr = await jsonReq(a, "POST", "/repos/acme/api/pulls", { title, head, base });
    expect(pr.status).toBe(201);
    return (pr.body as { number: number }).number;
  }

  async function stackOf(a: ReturnType<typeof createGitHubCloneApp>, pull: number) {
    const detail = await jsonReq(a, "GET", `/repos/acme/api/pulls/${pull}`);
    expect(detail.status).toBe(200);
    return (detail.body as { stack: StackJson | null }).stack;
  }

  async function openStack(a: ReturnType<typeof createGitHubCloneApp>) {
    for (const ref of ["stack-lower", "stack-upper"]) await branchWithWork(a, ref);
    // The upper PR's base branch IS the lower PR's head branch — a stack.
    return {
      lower: await openPull(a, "Lower", "stack-lower", "main"),
      upper: await openPull(a, "Upper", "stack-upper", "stack-lower")
    };
  }

  it("GET /pulls/:n and GET /pulls both carry stack: null for an unstacked PR", async () => {
    const a = app();
    const n = await openPr(a);

    const detail = await jsonReq(a, "GET", `/repos/acme/api/pulls/${n}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toHaveProperty("stack");
    expect((detail.body as { stack: unknown }).stack).toBeNull();

    const list = await jsonReq(a, "GET", "/repos/acme/api/pulls");
    expect(list.status).toBe(200);
    const item = (list.body as Array<Record<string, unknown>>).find((pr) => pr.number === n);
    expect(item).toHaveProperty("stack");
    expect(item!.stack).toBeNull();
  });

  it("GET /pulls/:n carries the vendor stack shape for every member of a stack", async () => {
    const a = app();
    const { lower, upper } = await openStack(a);

    const lowerPr = (await jsonReq(a, "GET", `/repos/acme/api/pulls/${lower}`)).body as {
      base: { sha: string };
      stack: StackJson;
    };
    const upperPr = (await jsonReq(a, "GET", `/repos/acme/api/pulls/${upper}`)).body as typeof lowerPr;

    // `base` is the stack's base — the BOTTOM pull request's base ref/sha, for
    // both members, not each member's own base.
    expect(lowerPr.stack).toMatchObject({
      base: { ref: "main", sha: lowerPr.base.sha },
      size: 2,
      position: 1,
      number: lower
    });
    expect(upperPr.stack).toMatchObject({
      base: { ref: "main", sha: lowerPr.base.sha },
      size: 2,
      position: 2,
      number: lower
    });
    // One stack, one identity: an agent grouping PRs by stack must see the same
    // id from every member.
    expect(upperPr.stack.id).toBe(lowerPr.stack.id);
    expect(Number.isInteger(lowerPr.stack.id)).toBe(true);
    expect(typeof lowerPr.stack.base.sha).toBe("string");
  });

  it("GET /pulls carries the same concrete stack values as the detail surface", async () => {
    const a = app();
    const { lower, upper } = await openStack(a);
    const list = (await jsonReq(a, "GET", "/repos/acme/api/pulls")).body as Array<{
      number: number;
      base: { sha: string };
      stack: StackJson | null;
    }>;
    const listed = (pull: number) => list.find((item) => item.number === pull)!;

    // Concrete values on the LIST surface, not merely "equal to whatever detail
    // said" — a convergence-only assertion passes for any constant, null
    // included, so it cannot show the list surface derives a real stack.
    expect(listed(lower).stack).toMatchObject({
      base: { ref: "main", sha: listed(lower).base.sha },
      size: 2,
      position: 1,
      number: lower
    });
    expect(listed(upper).stack).toMatchObject({ size: 2, position: 2, number: lower });
    expect(listed(upper).stack!.id).toBe(listed(lower).stack!.id);

    // ...and the two surfaces still agree field for field.
    for (const pull of [lower, upper]) {
      expect(listed(pull).stack).toEqual(await stackOf(a, pull));
    }
  });

  // The identity is shared across members, so the answer must be a property of
  // the chain rather than of the PR the walk started from. A fork is where a
  // per-start walk breaks: two PRs would claim one `stack.id` while reporting
  // different sizes and memberships. Asserted from EVERY member.
  it("refuses to name a stack when the chain forks, from every member of the fork", async () => {
    const a = app();
    for (const ref of ["fork-bottom", "fork-left", "fork-right"]) await branchWithWork(a, ref);
    const bottom = await openPull(a, "Bottom", "fork-bottom", "main");
    const left = await openPull(a, "Left", "fork-left", "fork-bottom");
    const right = await openPull(a, "Right", "fork-right", "fork-bottom");
    expect(left).toBeLessThan(right);

    for (const pull of [bottom, left, right]) {
      expect(await stackOf(a, pull)).toBeNull();
    }
  });

  // The invariant the fork case exists to protect, asserted over a repo that
  // holds a clean stack AND a fork at once: any two PRs reporting the same
  // `stack.id` agree on `size` and on membership, and their positions are
  // exactly 1..size with no repeats.
  it("keeps stack identity coherent: equal stack.id implies equal size, membership and unique positions", async () => {
    const a = app();
    for (const ref of ["clean-lower", "clean-upper", "amb-bottom", "amb-left", "amb-right"]) await branchWithWork(a, ref);
    await openPull(a, "Clean lower", "clean-lower", "main");
    await openPull(a, "Clean upper", "clean-upper", "clean-lower");
    await openPull(a, "Amb bottom", "amb-bottom", "main");
    await openPull(a, "Amb left", "amb-left", "amb-bottom");
    await openPull(a, "Amb right", "amb-right", "amb-bottom");

    const list = (await jsonReq(a, "GET", "/repos/acme/api/pulls")).body as Array<{
      number: number;
      stack: StackJson | null;
    }>;

    const byId = new Map<number, Array<{ number: number; stack: StackJson }>>();
    for (const item of list) {
      if (item.stack === null) continue;
      const bucket = byId.get(item.stack.id) ?? [];
      bucket.push({ number: item.number, stack: item.stack });
      byId.set(item.stack.id, bucket);
    }

    // The clean stack is the only thing that got an identity at all.
    expect(byId.size).toBe(1);
    for (const [, members] of byId) {
      const size = members[0]!.stack.size;
      expect(members.every((member) => member.stack.size === size)).toBe(true);
      // Every member of a shared id agrees the stack has `size` members, and the
      // number of PRs reporting that id IS that size — no absent siblings.
      expect(members).toHaveLength(size);
      expect([...members].map((member) => member.stack.position).sort()).toEqual(
        Array.from({ length: size }, (_, index) => index + 1)
      );
      // Same membership: one bottom `number`, one base, agreed by all.
      expect(new Set(members.map((member) => member.stack.number)).size).toBe(1);
      expect(new Set(members.map((member) => JSON.stringify(member.stack.base))).size).toBe(1);
    }
  });

  it("terminates and reports no stack when the base chain is a cycle", async () => {
    const a = app();
    for (const ref of ["cycle-a", "cycle-b"]) await branchWithWork(a, ref);
    // cycle-b sits on cycle-a, then cycle-a is retargeted onto cycle-b.
    const first = await openPull(a, "Cycle A", "cycle-a", "main");
    const second = await openPull(a, "Cycle B", "cycle-b", "cycle-a");
    const retargeted = await jsonReq(a, "PATCH", `/repos/acme/api/pulls/${first}`, { base: "cycle-b" });
    expect(retargeted.status).toBe(200);

    for (const pull of [first, second]) {
      expect(await stackOf(a, pull)).toBeNull();
    }
  });

  // Linkage traverses pull requests of every state so a closed middle link does
  // not silently sever a live chain; MEMBERSHIP is the open members only.
  it("links through a closed middle PR and counts only the open members", async () => {
    const a = app();
    for (const ref of ["mid-bottom", "mid-middle", "mid-top"]) await branchWithWork(a, ref);
    const bottom = await openPull(a, "Mid bottom", "mid-bottom", "main");
    const middle = await openPull(a, "Mid middle", "mid-middle", "mid-bottom");
    const top = await openPull(a, "Mid top", "mid-top", "mid-middle");

    expect(await stackOf(a, bottom)).toMatchObject({ size: 3, position: 1 });
    expect(await stackOf(a, top)).toMatchObject({ size: 3, position: 3 });

    const closed = await jsonReq(a, "PATCH", `/repos/acme/api/pulls/${middle}`, { state: "closed" });
    expect(closed.status).toBe(200);

    // The chain is still live: bottom and top remain one stack of two, and the
    // closed middle is not counted.
    const bottomStack = await stackOf(a, bottom);
    const topStack = await stackOf(a, top);
    expect(bottomStack).toMatchObject({ base: { ref: "main" }, size: 2, position: 1, number: bottom });
    expect(topStack).toMatchObject({ size: 2, position: 2, number: bottom });
    expect(topStack!.id).toBe(bottomStack!.id);
    // A closed PR reports no stack of its own.
    expect(await stackOf(a, middle)).toBeNull();
  });

  it("reports no stack once only one open member is left", async () => {
    const a = app();
    const { lower, upper } = await openStack(a);
    const closed = await jsonReq(a, "PATCH", `/repos/acme/api/pulls/${lower}`, { state: "closed" });
    expect(closed.status).toBe(200);

    expect(await stackOf(a, upper)).toBeNull();
    expect(await stackOf(a, lower)).toBeNull();
  });

  // Links match the repo id as well as the ref name. The twin models fork PRs
  // (`head_repo_id` differs from `base_repo_id`), so matching on ref name alone
  // would link a fork's head branch to an upstream PR's identically-named base
  // branch and invent a stack out of a name collision.
  it("does not invent a stack from a fork branch sharing an upstream base ref name", async () => {
    const a = app();
    for (const ref of ["collide", "collide-upper"]) await branchWithWork(a, ref);
    // Upstream PR based ON the `collide` branch of acme/api.
    const upstream = await openPull(a, "Upstream", "collide-upper", "collide");

    // Fork copies every branch, so the fork has its own `collide` — same name,
    // different repo.
    const fork = await jsonReq(a, "POST", "/repos/acme/api/forks", {});
    expect(fork.status).toBe(201);
    const forkOwner = (fork.body as { owner: { login: string } }).owner.login;
    const forked = await openPull(a, "From fork", `${forkOwner}:collide`, "main");

    // Neither is stacked: the fork's `collide` is not the branch the upstream PR
    // is based on.
    expect(await stackOf(a, upstream)).toBeNull();
    expect(await stackOf(a, forked)).toBeNull();
  });

  it("does not let the state filter or pagination change a PR's stack", async () => {
    const a = app();
    const { lower, upper } = await openStack(a);
    const openOnly = (await jsonReq(a, "GET", "/repos/acme/api/pulls?state=open&per_page=1&page=2")).body as Array<{
      number: number;
      stack: StackJson | null;
    }>;
    const paged = openOnly.find((item) => item.number === lower || item.number === upper);
    expect(paged).toBeDefined();
    expect(paged!.stack).toEqual(await stackOf(a, paged!.number));
    expect(paged!.stack).toMatchObject({ size: 2, number: lower });
  });

  it("GET /pulls/:n/commits lists commits", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "GET", `/repos/acme/api/pulls/${n}/commits`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it("POST /pulls/:n/comments creates inline + reply", async () => {
    const a = app();
    const n = await openPr(a);
    const parent = await jsonReq(a, "POST", `/repos/acme/api/pulls/${n}/comments`, { body: "Nit", path: "cr.ts", line: 1 });
    expect(parent.status).toBe(201);
    const parentId = (parent.body as { id: number }).id;
    const reply = await jsonReq(a, "POST", `/repos/acme/api/pulls/${n}/comments/${parentId}/replies`, { body: "Fixed" });
    expect(reply.status).toBe(201);
    expect((reply.body as { in_reply_to_id: number }).in_reply_to_id).toBe(parentId);
  });
});

// ----- Cluster D — issue comments deeper ------------------------------

describe("REST / cluster D — issue comments deeper", () => {
  it("PATCH then DELETE /issues/comments/:id", async () => {
    const a = app();
    const created = await jsonReq(a, "POST", "/repos/acme/api/issues/1/comments", { body: "first" });
    expect(created.status).toBe(201);
    const id = (created.body as { id: number }).id;
    const patched = await jsonReq(a, "PATCH", `/repos/acme/api/issues/comments/${id}`, { body: "second" });
    expect(patched.status).toBe(200);
    expect((patched.body as { body: string }).body).toBe("second");
    const removed = await jsonReq(a, "DELETE", `/repos/acme/api/issues/comments/${id}`);
    expect(removed.status).toBe(204);
    const gone = await jsonReq(a, "PATCH", `/repos/acme/api/issues/comments/${id}`, { body: "x" });
    expect(gone.status).toBe(404);
  });
});

// ----- Cluster E — milestones -----------------------------------------

describe("REST / cluster E — milestones", () => {
  it("full CRUD lifecycle", async () => {
    const a = app();
    const created = await jsonReq(a, "POST", "/repos/acme/api/milestones", { title: "v1", description: "first" });
    expect(created.status).toBe(201);
    const number = (created.body as { number: number }).number;

    const list = await jsonReq(a, "GET", "/repos/acme/api/milestones");
    expect((list.body as Array<{ title: string }>).map((m) => m.title)).toContain("v1");

    const patched = await jsonReq(a, "PATCH", `/repos/acme/api/milestones/${number}`, { state: "closed" });
    expect((patched.body as { state: string }).state).toBe("closed");

    const removed = await jsonReq(a, "DELETE", `/repos/acme/api/milestones/${number}`);
    expect(removed.status).toBe(204);
  });

  it("filters list by state", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/milestones", { title: "alpha" });
    const beta = await jsonReq(a, "POST", "/repos/acme/api/milestones", { title: "beta" });
    const betaNumber = (beta.body as { number: number }).number;
    await jsonReq(a, "PATCH", `/repos/acme/api/milestones/${betaNumber}`, { state: "closed" });

    const open = await jsonReq(a, "GET", "/repos/acme/api/milestones?state=open");
    const closed = await jsonReq(a, "GET", "/repos/acme/api/milestones?state=closed");
    expect((open.body as Array<{ title: string }>).map((m) => m.title)).toContain("alpha");
    expect((closed.body as Array<{ title: string }>).map((m) => m.title)).toContain("beta");
  });
});

// ----- Cluster F — commit status + checks -----------------------------

describe("REST / cluster F — commit status + checks", () => {
  async function head(a: ReturnType<typeof createGitHubCloneApp>) {
    const commits = await jsonReq(a, "GET", "/repos/acme/api/commits");
    return (commits.body as Array<{ sha: string }>)[0]!.sha;
  }

  it("POST /statuses/:sha then GET /commits/:ref/status", async () => {
    const a = app();
    const sha = await head(a);
    const created = await jsonReq(a, "POST", `/repos/acme/api/statuses/${sha}`, { state: "success", context: "ci/test" });
    expect(created.status).toBe(201);
    const combined = await jsonReq(a, "GET", `/repos/acme/api/commits/${sha}/status`);
    expect((combined.body as { state: string }).state).toBe("success");
  });

  it("POST /check-runs then GET /commits/:ref/check-runs", async () => {
    const a = app();
    const sha = await head(a);
    const created = await jsonReq(a, "POST", "/repos/acme/api/check-runs", { name: "lint", head_sha: sha, status: "completed", conclusion: "success" });
    expect(created.status).toBe(201);
    const list = await jsonReq(a, "GET", `/repos/acme/api/commits/${sha}/check-runs`);
    expect((list.body as { total_count: number }).total_count).toBe(1);
  });

  it("POST /check-runs without conclusion when status=completed returns 422", async () => {
    const a = app();
    const sha = await head(a);
    const response = await jsonReq(a, "POST", "/repos/acme/api/check-runs", { name: "lint", head_sha: sha, status: "completed" });
    expect(response.status).toBe(422);
  });

  // Regression: a seeded PR `statuses[]` with state:"failure" must surface on
  // GET /pulls/:n/status as combined state:"failure" (total_count > 0), not the
  // empty-set default. Mirrors examples/minimal-viktor scenario 03 (failing-ci)
  // exactly — an earlier (pre-consolidation) twin dropped seeded PR statuses and
  // returned the zero-status default, which made that scenario unwinnable.
  it("GET /pulls/:n/status surfaces a seeded failing PR status", async () => {
    const a = createGitHubCloneApp({
      seed: {
        users: [{ login: "alice", type: "User", name: "Alice" }],
        repositories: [
          {
            owner: "viktor-hq",
            name: "orders-service",
            default_branch: "main",
            collaborators: ["alice"],
            files: [
              { path: "orders.py", content: "def total(items):\n    return 0\n", branch: "main" },
              { path: "orders.py", content: "def total(items):\n    return 1\n", branch: "add-discounts" }
            ],
            pull_requests: [
              {
                number: 1,
                title: "Add per-item discount support",
                head: "add-discounts",
                base: "main",
                state: "open",
                author: "alice",
                reviews: [],
                statuses: [{ context: "ci/test", state: "failure", description: "3 tests failing" }]
              }
            ]
          }
        ]
      }
    });
    const status = await jsonReq(a, "GET", "/repos/viktor-hq/orders-service/pulls/1/status");
    expect(status.status).toBe(200);
    const body = status.body as { state: string; total_count: number; statuses: Array<{ context: string; state: string }> };
    expect(body.state).toBe("failure");
    expect(body.total_count).toBe(1);
    expect(body.statuses[0]).toMatchObject({ context: "ci/test", state: "failure" });
  });
});

// ----- Cluster G — tags & releases ------------------------------------

describe("REST / cluster G — tags & releases", () => {
  it("POST /releases auto-creates the tag", async () => {
    const a = app();
    const created = await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v0.1.0", name: "First" });
    expect(created.status).toBe(201);
    const tags = await jsonReq(a, "GET", "/repos/acme/api/tags");
    expect((tags.body as Array<{ name: string }>).map((t) => t.name)).toContain("v0.1.0");
  });

  it("GET /releases/latest skips drafts/prereleases; 404 when none", async () => {
    const a = app();
    const empty = await jsonReq(a, "GET", "/repos/acme/api/releases/latest");
    expect(empty.status).toBe(404);
    await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v1.0.0", name: "Stable" });
    await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v1.0.1-rc", name: "RC", prerelease: true });
    const latest = await jsonReq(a, "GET", "/repos/acme/api/releases/latest");
    expect((latest.body as { tag_name: string }).tag_name).toBe("v1.0.0");
  });

  it("POST /releases on duplicate tag returns 422", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v0.5.0" });
    const dup = await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v0.5.0" });
    expect(dup.status).toBe(422);
  });
});

// ----- Cluster H — identity & collaborators ---------------------------

describe("REST / cluster H — identity & collaborators", () => {
  it("GET /user returns the authenticated user", async () => {
    const a = app();
    const response = await jsonReq(a, "GET", "/user");
    expect(response.status).toBe(200);
    expect((response.body as { login: string }).login).toBe("pome-agent");
  });

  it("PUT /collaborators/:username 201 for new user, 204 for existing", async () => {
    const a = app();
    const created = await jsonReq(a, "PUT", "/repos/acme/api/collaborators/newbie", { permission: "push" });
    expect(created.status).toBe(201);
    const existing = await jsonReq(a, "PUT", "/repos/acme/api/collaborators/alice", {});
    expect(existing.status).toBe(204);
  });

  it("PUT /collaborators requires push access", async () => {
    const a = app();
    const outsiderToken = await signTestToken({ login: "mallory" });
    const response = await jsonReq(a, "PUT", "/repos/acme/api/collaborators/anon", { permission: "push" }, outsiderToken);
    expect(response.status).toBe(403);
  });
});
