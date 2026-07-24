# Gmail Named Fault Seeds + Retry/Partial-Failure Example — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a named, reusable `rate-limited` fault-injection seed primitive to the Gmail twin and ship the first Gmail example (`gmail-retry-notify`) that teaches retry/partial-failure with a red baseline and a green fixed variant, then verify everything end-to-end on hosted twins + hosted evals.

**Architecture:** The Gmail seed grows an opt-in `faults` array (default `[]`, so existing behavior is unchanged, mirroring twin-linear's `strictScopes`). A small fault registry (`faults.ts`) maps a fault *name* to behavior; `rate-limited` throttles a target operation deterministically by call count (succeed first N → 429 for the next M → recover). A single gate call at the top of `sendMessage` covers both the REST and MCP send surfaces. The example is a Vercel-AI-SDK REST tool loop (same shape as `merge-agent`) whose red→green difference is a one-line system-prompt swap (same shape as `support-triage/local`).

**Tech Stack:** TypeScript, Zod, better-sqlite3-style `GmailTwinDatabase`, Hono routes, Vercel AI SDK (`ai` v6 + `@ai-sdk/anthropic`), `tsx`, vitest, the `pome` CLI (0.7.0, hosted).

## Global Constraints

- **npm only.** Root uses `npm ci` / `npm install`; `packages/*` share one root `package-lock.json`. Examples are standalone packages with their OWN `package-lock.json` (not root workspaces).
- **Vocabulary: "task", never "scenario"** in new code/docs/copy. Config key is `runs:` (not "trials"). Criterion markers are `[code]` / `[model]` only — never the retired D/P bracket forms.
- **Additive contract only.** The default Gmail seed must remain byte-for-byte unchanged (`faults` defaults to `[]`). No behavior change unless a task opts in.
- **No Retry-After HTTP header.** The shared sdk error path returns `{status, body}` with no header channel; the retry hint goes in the 429 body, not a header. Do not modify the shared sdk twin harness.
- **Secret handling.** The Pome API key (`pme_…`) is used only as a shell env var this session — NEVER written to any file, fixture, test, spec, plan, or commit. Repo secret-scan (gitleaks + TruffleHog) is enforced.
- **No changeset needed** (this PR does not touch `cli/`). Do NOT hand-bump `package.json` `version` fields — package releases are a separate `pome-package-release` flow; only add "Unreleased" CHANGELOG entries.
- **Node ≥ 24**; run twin tests with `cd packages/twin-gmail && npm test` after a root `npm ci` + shared-types runtime build.
- **Fault names are teaching vocabulary** — the only registered name this PR ships is `rate-limited`; the registry stays extensible but no second primitive is built.

---

## Phase A — Gmail fault primitive (twin-gmail + shared-types)

### Task A1: `fault_counters` table + reset

**Files:**
- Modify: `packages/twin-gmail/src/db.ts` (DDL block near line 6; `resetDatabase` near line 185–210)

**Interfaces:**
- Produces: a `fault_counters(operation TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0)` table, cleared on reset.

- [ ] **Step 1: Add the table to the schema DDL.** In the `CREATE TABLE IF NOT EXISTS …` block (the big SQL string starting ~line 5), add after the `gmail_config` table:

```sql
CREATE TABLE IF NOT EXISTS fault_counters (
  operation TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: Clear it on reset.** In the reset SQL (where `DELETE FROM gmail_config;` lives, ~line 185), add:

```sql
DELETE FROM fault_counters;
```

- [ ] **Step 3: Typecheck.** Run: `cd packages/twin-gmail && npx tsc -p tsconfig.json --noEmit` — Expected: PASS.
- [ ] **Step 4: Commit.**

```bash
git add packages/twin-gmail/src/db.ts
git commit -m "feat(twin-gmail): add fault_counters table (F-917)"
```

---

### Task A2: fault registry, schema, and gate (`faults.ts`) — TDD

**Files:**
- Create: `packages/twin-gmail/src/faults.ts`
- Test: `packages/twin-gmail/test/faults.test.ts`

**Interfaces:**
- Consumes: `GmailTwinDatabase` (from `./types.js`), `GmailError` (from `./errors.js`), the `fault_counters` table (A1), the `gmail_config` table.
- Produces:
  - `export const gmailFaultSchema` (Zod) — `{ name: "rate-limited", target=string("messages.send"), succeedFirst=int≥0(2), throttleFor=int>0(3), retryAfterSeconds=int>0(1) }`, `.strict()`.
  - `export type GmailFault = z.output<typeof gmailFaultSchema>`
  - `export function checkFault(db: GmailTwinDatabase, operation: string): void` — increments the per-operation counter; throws `GmailError(429, "rateLimitExceeded", …)` while the call index is inside the throttle window.

- [ ] **Step 1: Write the failing test.** Create `packages/twin-gmail/test/faults.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { openGmailTwinDatabase } from "../src/index.js";
import { checkFault, gmailFaultSchema } from "../src/faults.js";
import { GmailError } from "../src/errors.js";

function dbWithFault(fault: unknown) {
  const db = openGmailTwinDatabase(":memory:");
  const parsed = gmailFaultSchema.parse(fault);
  db.prepare("INSERT INTO gmail_config(key, value) VALUES ('faults', ?)").run(JSON.stringify([parsed]));
  return db;
}

describe("rate-limited fault", () => {
  it("passes succeedFirst, throttles throttleFor, then recovers", () => {
    const db = dbWithFault({ name: "rate-limited", target: "messages.send", succeedFirst: 2, throttleFor: 3 });
    const statuses: (number | "ok")[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        checkFault(db, "messages.send");
        statuses.push("ok");
      } catch (e) {
        statuses.push((e as GmailError).status);
      }
    }
    // calls 1-2 ok, 3-5 throttled (429), 6-8 ok again
    expect(statuses).toEqual(["ok", "ok", 429, 429, 429, "ok", "ok", "ok"]);
  });

  it("does nothing when no fault targets the operation", () => {
    const db = dbWithFault({ name: "rate-limited", target: "messages.send" });
    expect(() => checkFault(db, "drafts.send")).not.toThrow();
  });

  it("does nothing when no faults are configured", () => {
    const db = openGmailTwinDatabase(":memory:");
    expect(() => checkFault(db, "messages.send")).not.toThrow();
  });

  it("rejects an unknown fault name", () => {
    expect(() => gmailFaultSchema.parse({ name: "kaboom" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts` — Expected: FAIL (`Cannot find module '../src/faults.js'`).

- [ ] **Step 3: Implement `faults.ts`.** Create `packages/twin-gmail/src/faults.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { GmailError } from "./errors.js";
import type { GmailTwinDatabase } from "./types.js";

// Named, reusable fault-injection primitives. A seed lists faults by NAME; the
// name is teaching vocabulary. Default seeds carry none, so faults are strictly
// opt-in (mirrors twin-linear `strictScopes`). Extend KNOWN_FAULT_NAMES to add
// a primitive.
const KNOWN_FAULT_NAMES = ["rate-limited"] as const;

export const gmailFaultSchema = z
  .object({
    name: z.enum(KNOWN_FAULT_NAMES),
    target: z.string().min(1).max(128).default("messages.send"),
    succeedFirst: z.number().int().nonnegative().max(1000).default(2),
    throttleFor: z.number().int().positive().max(1000).default(3),
    retryAfterSeconds: z.number().int().positive().max(3600).default(1),
  })
  .strict();

export type GmailFault = z.output<typeof gmailFaultSchema>;

/**
 * Increment the per-operation call counter and, if a `rate-limited` fault is
 * armed for `operation`, throw a 429 during the throttle window. Deterministic
 * and clock-free: calls 1..succeedFirst pass, the next `throttleFor` calls
 * throw, every call after passes. EVERY matching call (including throttled
 * ones) advances the counter, so an agent that retries with backoff clears the
 * window while one that doesn't leaves those sends undelivered.
 */
export function checkFault(db: GmailTwinDatabase, operation: string): void {
  const fault = readFaults(db).find((f) => f.target === operation);
  if (!fault) return;
  const calls = bumpFaultCounter(db, operation);
  if (calls > fault.succeedFirst && calls <= fault.succeedFirst + fault.throttleFor) {
    throw new GmailError(
      429,
      "rateLimitExceeded",
      `Rate limit exceeded for ${operation}. Retry after ${fault.retryAfterSeconds}s.`,
    );
  }
}

function readFaults(db: GmailTwinDatabase): GmailFault[] {
  const row = db.prepare("SELECT value FROM gmail_config WHERE key = 'faults'").get() as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.value) as GmailFault[];
  } catch {
    return [];
  }
}

function bumpFaultCounter(db: GmailTwinDatabase, operation: string): number {
  db.prepare(
    "INSERT INTO fault_counters(operation, calls) VALUES (?, 1) " +
      "ON CONFLICT(operation) DO UPDATE SET calls = calls + 1",
  ).run(operation);
  const row = db.prepare("SELECT calls FROM fault_counters WHERE operation = ?").get(operation) as {
    calls: number;
  };
  return row.calls;
}
```

- [ ] **Step 4: Run tests to confirm PASS.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts` — Expected: PASS (4 tests).
- [ ] **Step 5: Commit.**

```bash
git add packages/twin-gmail/src/faults.ts packages/twin-gmail/test/faults.test.ts
git commit -m "feat(twin-gmail): rate-limited fault registry + gate (F-917)"
```

---

### Task A3: 429 → RESOURCE_EXHAUSTED in the error envelope — TDD

**Files:**
- Modify: `packages/twin-gmail/src/errors.ts` (`googleStatus`, ~line 109)
- Test: `packages/twin-gmail/test/faults.test.ts` (append)

**Interfaces:**
- Produces: `gmailErrorEnvelope(new GmailError(429, "rateLimitExceeded", msg))` → `{ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", … } } }`.

- [ ] **Step 1: Append the failing test** to `packages/twin-gmail/test/faults.test.ts`:

```ts
import { gmailErrorEnvelope } from "../src/errors.js";

describe("429 envelope", () => {
  it("maps 429 to RESOURCE_EXHAUSTED", () => {
    const env = gmailErrorEnvelope(new GmailError(429, "rateLimitExceeded", "slow down"));
    expect(env.status).toBe(429);
    expect((env.body as any).error.status).toBe("RESOURCE_EXHAUSTED");
    expect((env.body as any).error.errors[0].reason).toBe("rateLimitExceeded");
  });
});
```

- [ ] **Step 2: Run to confirm it fails.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts -t "429 envelope"` — Expected: FAIL (`status` is `"INTERNAL"`, not `"RESOURCE_EXHAUSTED"`).

- [ ] **Step 3: Add the mapping.** In `packages/twin-gmail/src/errors.ts`, inside `googleStatus`, add before the `404` line:

```ts
  if (status === 429) return "RESOURCE_EXHAUSTED";
```

- [ ] **Step 4: Run to confirm PASS.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/twin-gmail/src/errors.ts packages/twin-gmail/test/faults.test.ts
git commit -m "feat(twin-gmail): map 429 to RESOURCE_EXHAUSTED (F-917)"
```

---

### Task A4: wire `faults` into the seed schema, type, and seed persistence — TDD

**Files:**
- Modify: `packages/twin-gmail/src/seed.ts` (`gmailSeedSchema`, ~line 122)
- Modify: `packages/twin-gmail/src/types.ts` (`GmailStateSeed`, ~line 87)
- Modify: `packages/twin-gmail/src/domain/gmail-domain.ts` (`seed()`, ~line 17)
- Test: `packages/twin-gmail/test/faults.test.ts` (append)

**Interfaces:**
- Consumes: `gmailFaultSchema`, `GmailFault` (A2).
- Produces: parsed seeds carry `faults: GmailFault[]` (default `[]`); `GmailDomain.seed()` persists them into `gmail_config` key `faults`.

- [ ] **Step 1: Append the failing test** to `packages/twin-gmail/test/faults.test.ts`:

```ts
import { GmailDomain } from "../src/index.js";
import { parseSeed, defaultSeedState } from "../src/seed.js";

describe("seed integration", () => {
  it("default seed has no faults", () => {
    expect(parseSeed(defaultSeedState()).faults).toEqual([]);
  });

  it("domain.seed persists faults and gate reads them", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test" },
      faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 1, throttleFor: 1 }],
    } as any);
    expect(() => checkFault(db, "messages.send")).not.toThrow(); // call 1 ok
    expect(() => checkFault(db, "messages.send")).toThrow();      // call 2 throttled
  });

  it("reset clears the fault counter", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test" },
      faults: [{ name: "rate-limited", succeedFirst: 0, throttleFor: 1 }],
    } as any);
    expect(() => checkFault(db, "messages.send")).toThrow(); // call 1 throttled
    gmail.resetToDefault();                                   // clears counter + faults
    expect(() => checkFault(db, "messages.send")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm it fails.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts -t "seed integration"` — Expected: FAIL (`faults` is `undefined`).

- [ ] **Step 3a: Add `faults` to the seed schema.** In `packages/twin-gmail/src/seed.ts`: add the import near the top — `import { gmailFaultSchema } from "./faults.js";` — and add to the `gmailSeedSchema` object (before `.strict()`), alongside `deliveryMode`/`clock`:

```ts
    faults: z.array(gmailFaultSchema).max(50).default([]),
```

- [ ] **Step 3b: Add `faults` to the input type.** In `packages/twin-gmail/src/types.ts`, add to `GmailStateSeed`:

```ts
  faults?: import("./faults.js").GmailFault[];
```

- [ ] **Step 3c: Persist faults on seed.** In `packages/twin-gmail/src/domain/gmail-domain.ts`, inside `seed()`, after the `delivery_mode` insert (line ~22):

```ts
      this.db.prepare("INSERT INTO gmail_config(key, value) VALUES ('faults', ?)").run(JSON.stringify(seed.faults ?? []));
```

- [ ] **Step 4: Run to confirm PASS.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts` — Expected: PASS (all groups).
- [ ] **Step 5: Commit.**

```bash
git add packages/twin-gmail/src/seed.ts packages/twin-gmail/src/types.ts packages/twin-gmail/src/domain/gmail-domain.ts packages/twin-gmail/test/faults.test.ts
git commit -m "feat(twin-gmail): faults seed field + persistence (F-917)"
```

---

### Task A5: gate `sendMessage` + end-to-end domain test — TDD

**Files:**
- Modify: `packages/twin-gmail/src/domain/messages.ts` (`sendMessage`, ~line 70)
- Test: `packages/twin-gmail/test/faults.test.ts` (append)

**Interfaces:**
- Consumes: `checkFault` (A2). Both REST (`rest-routes-messages.ts`) and MCP send route through `sendMessage`, so this one call covers both surfaces.

- [ ] **Step 1: Append the failing test** to `packages/twin-gmail/test/faults.test.ts` (reuse the existing MIME helper pattern from `test/domain.test.ts` — import `composeMime` from `../src/index.js`):

```ts
import { composeMime } from "../src/index.js";

describe("sendMessage gate", () => {
  it("throttles the 2nd send when succeedFirst=1, throttleFor=1", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test" },
      faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 1, throttleFor: 1 }],
    } as any);
    const raw = composeMime({ from: "agent@pome-twin.test", to: ["x@pome-twin.test"], subject: "hi", text: "hi" });
    expect(() => gmail.send("agent@pome-twin.test", raw)).not.toThrow(); // 1st ok
    let status = 0;
    try { gmail.send("agent@pome-twin.test", raw); } catch (e) { status = (e as GmailError).status; }
    expect(status).toBe(429); // 2nd throttled
  });
});
```

  > Note: confirm the domain send entry is `gmail.send(...)` by reading `GmailDomain` in `gmail-domain.ts`; if the method wraps `messages.sendMessage`, call it through the domain. If `composeMime`'s signature differs, mirror `test/domain.test.ts`'s existing send test verbatim.

- [ ] **Step 2: Run to confirm it fails.** Run: `cd packages/twin-gmail && npx vitest run test/faults.test.ts -t "sendMessage gate"` — Expected: FAIL (2nd send succeeds; no 429).

- [ ] **Step 3: Add the gate.** In `packages/twin-gmail/src/domain/messages.ts`: add the import — `import { checkFault } from "../faults.js";` — and make it the FIRST statement of `sendMessage` (before `domain.mailboxId(email)`), so a throttled call has no side effect except the counter:

```ts
export function sendMessage(
  domain: GmailDomain,
  email: string,
  raw: Uint8Array | string,
  options: { threadId?: string } = {}
): { sender: SemanticMessage; deliveries: Array<{ mailboxEmail: string; message: SemanticMessage }> } {
  checkFault(domain.db, "messages.send");
  const senderMailboxId = domain.mailboxId(email);
  // …unchanged…
```

- [ ] **Step 4: Run the FULL twin test suite.** Run: `cd packages/twin-gmail && npm test` — Expected: PASS (new tests + all existing; the default seed adds no faults so nothing regresses).
- [ ] **Step 5: Commit.**

```bash
git add packages/twin-gmail/src/domain/messages.ts packages/twin-gmail/test/faults.test.ts
git commit -m "feat(twin-gmail): gate messages.send with rate-limited fault (F-917)"
```

---

### Task A6: shared-types mirror schema + test — TDD

**Files:**
- Modify: `packages/shared-types/src/seed-state.ts` (`gmailSeedStateSchema`, ~line 295)
- Test: `packages/shared-types/test/seed-state.test.ts` (create if absent, else append)

**Interfaces:**
- Produces: `gmailSeedStateSchema` accepts `faults` (default `[]`) so `taskSchema.seedState` validation passes for fault seeds.

- [ ] **Step 1: Write/append the failing test.** In `packages/shared-types/test/seed-state.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { gmailSeedStateSchema } from "../src/seed-state.js";

describe("gmailSeedStateSchema faults", () => {
  it("defaults faults to []", () => {
    const parsed = gmailSeedStateSchema.parse({ primaryMailbox: { email: "a@b.test" } });
    expect(parsed.faults).toEqual([]);
  });
  it("accepts a rate-limited fault", () => {
    const parsed = gmailSeedStateSchema.parse({
      primaryMailbox: { email: "a@b.test" },
      faults: [{ name: "rate-limited", target: "messages.send" }],
    });
    expect(parsed.faults[0].name).toBe("rate-limited");
  });
});
```

- [ ] **Step 2: Run to confirm it fails.** Run: `cd packages/shared-types && npx vitest run test/seed-state.test.ts` — Expected: FAIL (`faults` undefined / rejected).

- [ ] **Step 3: Add the mirror.** In `packages/shared-types/src/seed-state.ts`, above `gmailSeedStateSchema`, add:

```ts
const gmailFaultSchema = z
  .object({
    name: z.enum(["rate-limited"]),
    target: z.string().min(1).max(128).default("messages.send"),
    succeedFirst: z.number().int().nonnegative().max(1000).default(2),
    throttleFor: z.number().int().positive().max(1000).default(3),
    retryAfterSeconds: z.number().int().positive().max(3600).default(1),
  })
  .strict();
```

and add to the `gmailSeedStateSchema` object:

```ts
  faults: z.array(gmailFaultSchema).max(50).default([]),
```

- [ ] **Step 4: Run to confirm PASS + build shared-types runtime.** Run: `cd packages/shared-types && npx vitest run test/seed-state.test.ts && npm run build:runtime` — Expected: PASS + build OK.
- [ ] **Step 5: Commit.**

```bash
git add packages/shared-types/src/seed-state.ts packages/shared-types/test/seed-state.test.ts
git commit -m "feat(shared-types): mirror gmail faults seed field (F-917)"
```

---

## Phase B — The `gmail-retry-notify` example

### Task B1: scaffold the example package

**Files:**
- Create: `examples/gmail-retry-notify/package.json`, `pome.json`, `tsconfig.json`, `.gitignore`

- [ ] **Step 1: `package.json`** (mirror `merge-agent`; drop the google/openai adapters — Anthropic only):

```json
{
  "name": "@pome-sh/gmail-retry-notify-example",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Bundled Pome example: a Gmail notification agent that must retry throttled (429) sends without duplicating already-delivered ones. Teaches retry / partial-failure against the Gmail twin's rate-limited fault seed.",
  "scripts": {
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^3.0.81",
    "ai": "^6.0.193",
    "zod": "^4.1.13"
  },
  "devDependencies": {
    "@types/node": "^25.0.3",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  },
  "engines": { "node": ">=24" }
}
```

- [ ] **Step 2: `pome.json`:**

```json
{
  "$schema": "https://pome.sh/schemas/v1/pome.json",
  "agent": { "slug": "gmail-retry-notify" },
  "command": "npm start",
  "twins": ["gmail"],
  "tasks": "tasks",
  "artifacts_dir": "runs",
  "pass_threshold": 100
}
```

- [ ] **Step 3: `tsconfig.json`** — copy `examples/merge-agent/tsconfig.json` verbatim.
- [ ] **Step 4: `.gitignore`** — copy `examples/merge-agent/.gitignore` verbatim (ignores `node_modules`, `runs`, `.pome`).
- [ ] **Step 5: Generate the lockfile.** Run: `cd examples/gmail-retry-notify && npm install` — Expected: creates `package-lock.json` + `node_modules`.
- [ ] **Step 6: Commit** (do NOT commit `node_modules`):

```bash
git add examples/gmail-retry-notify/package.json examples/gmail-retry-notify/pome.json examples/gmail-retry-notify/tsconfig.json examples/gmail-retry-notify/.gitignore examples/gmail-retry-notify/package-lock.json
git commit -m "feat(examples): scaffold gmail-retry-notify (F-917)"
```

---

### Task B2: the agent (`src/index.ts`)

**Files:**
- Create: `examples/gmail-retry-notify/src/index.ts`

**Interfaces:**
- Env contract (injected by `pome run`): `POME_TASK`, `POME_GMAIL_REST_URL`, `POME_AUTH_TOKEN` (or `POME_GMAIL_TOKEN`), `POME_PREFLIGHT`. Model via `AI_GATEWAY_API_KEY` else `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Write `src/index.ts`.** Structure copied from `merge-agent` (hoisted-function launch — smoke-safe; the `RETRY_RULE_V1`/`V2` swap is the red→green fix):

```ts
/**
 * Pome bundled example: gmail-retry-notify.
 *
 * A model-driven Gmail notification agent (Vercel AI SDK) over the Gmail twin's
 * REST surface. It must send a short announcement to each recipient in POME_TASK.
 *
 * FAILURE CLASS: retry / partial failure. The task seeds the Gmail twin with a
 * named `rate-limited` fault: the first couple of sends succeed, the next few
 * return HTTP 429 RESOURCE_EXHAUSTED, then sends recover. A naive agent that
 * does not retry leaves those recipients unsent (partial failure) — or blindly
 * re-sends the whole batch and duplicates the ones that already went out. The
 * fix is the one-line swap from RETRY_RULE_V1 (red) to RETRY_RULE_V2 (green):
 * retry throttled sends with backoff, but only the ones that actually failed.
 *
 * Standard Pome agent contract (env injected by `pome run`):
 *   POME_TASK             the instruction (names the recipients)
 *   POME_GMAIL_REST_URL   session-scoped REST base for the Gmail twin
 *   POME_AUTH_TOKEN       bearer token for the twin session
 * POME_PREFLIGHT=1 → print "preflight ok" and exit, touching no network/model.
 */

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

// --- the one-line fix: swap V1 (red) for V2 (green) -------------------------
const RETRY_RULE_V1 =
  "Send the announcement to each recipient exactly once.";
const RETRY_RULE_V2 =
  "Send the announcement to each recipient exactly once. If a send fails with a " +
  "rate-limit / transient error (HTTP 429), wait briefly and retry ONLY that " +
  "recipient, up to 5 attempts, before giving up. NEVER re-send a recipient " +
  "whose send already succeeded. In your final summary, report exactly which " +
  "recipients were delivered and which (if any) were not.";
const RETRY_RULE = RETRY_RULE_V1; // ← green variant: change to RETRY_RULE_V2
// ---------------------------------------------------------------------------

const task = requiredEnv("POME_TASK");
const restUrl = requiredEnv("POME_GMAIL_REST_URL").replace(/\/$/, "");
const authToken = process.env.POME_AUTH_TOKEN ?? process.env.POME_GMAIL_TOKEN;
const modelSlug = (process.env.GMAIL_AGENT_MODEL ?? "anthropic/claude-opus-4-8").trim();
const maxSteps = Number(process.env.GMAIL_AGENT_MAX_STEPS ?? 30);

const system = [
  "You are an automated email notification agent for a Gmail mailbox.",
  RETRY_RULE,
  "Work autonomously. Finish once you have attempted every recipient.",
].join("\n");

const tools = {
  send_email: tool({
    description: "Send a plain-text email from the mailbox to one recipient.",
    inputSchema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    }),
    execute: ({ to, subject, body }) => {
      const raw = toBase64Url(buildMime({ from: SENDER, to, subject, body }));
      return gmail(`/gmail/v1/users/me/messages/send`, "POST", { raw });
    },
  }),
  list_sent: tool({
    description: "List messages already sent from the mailbox (to check what succeeded).",
    inputSchema: z.object({}),
    execute: () => gmail(`/gmail/v1/users/me/messages?labelIds=SENT`),
  }),
};

let SENDER = "pome-agent@pome-twin.test"; // resolved from the live profile in main()

await main();

async function main() {
  const profile = await gmail(`/gmail/v1/users/me/profile`);
  if (profile && typeof profile === "object" && "emailAddress" in profile) {
    SENDER = String((profile as { emailAddress: string }).emailAddress);
  }
  const model = await resolveModel(modelSlug);
  const result = await generateText({
    model,
    system,
    prompt: task,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });
  console.log(
    JSON.stringify({
      task,
      model: modelSlug,
      steps: result.steps.length,
      summary: result.text || "Agent finished.",
    }),
  );
}

async function gmail(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${restUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Hand the model the error (incl. 429) instead of throwing, so it can retry.
  if (!res.ok) return { ok: false, status: res.status, error: text || res.statusText };
  return text ? JSON.parse(text) : null;
}

function buildMime({ from, to, subject, body }: { from: string; to: string; subject: string; body: string }): string {
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function resolveModel(slug: string): Promise<Parameters<typeof generateText>[0]["model"]> {
  if (process.env.AI_GATEWAY_API_KEY) return slug;
  const id = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") })(id);
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}
```

- [ ] **Step 2: Typecheck.** Run: `cd examples/gmail-retry-notify && npm run typecheck` — Expected: PASS.
- [ ] **Step 3: Commit.**

```bash
git add examples/gmail-retry-notify/src/index.ts
git commit -m "feat(examples): gmail-retry-notify agent (red V1 default) (F-917)"
```

---

### Task B3: the task + seed

**Files:**
- Create: `examples/gmail-retry-notify/tasks/01-throttled-send.md`
- Create: `examples/gmail-retry-notify/tasks/01-throttled-send.seed.json`

- [ ] **Step 1: `tasks/01-throttled-send.md`:**

```markdown
# Throttled announcement send

## Setup

The mailbox `pome-agent@pome-twin.test` must send a short launch announcement to
five teammates. The Gmail twin is seeded with a named `rate-limited` fault on
`messages.send`: the first two sends succeed, the next sends are throttled with
HTTP 429 (RESOURCE_EXHAUSTED), then sends recover.

## Prompt

Send this launch announcement to each of these five recipients, one email each:
alice@pome-twin.test, bob@pome-twin.test, carol@pome-twin.test,
dave@pome-twin.test, erin@pome-twin.test.

Subject: "Pome launch is live". Body: "We shipped today — thanks for the help."

Confirm which recipients were delivered.

## Expected Behavior

Retry the throttled sends with backoff until all five are delivered, without
re-sending any recipient that already succeeded. Report the true delivery state.

## Success Criteria

- [code] The mailbox `pome-agent@pome-twin.test` has exactly 5 messages labeled SENT.
- [code] Exactly one SENT message is addressed to each of the five recipients (no duplicate sends).
- [code] No unsupported Gmail endpoint was called.
- [model] The final summary reports all five recipients as delivered and does not claim success for any send that did not complete.

## Seed State

A hand-authored Gmail seed: the agent's mailbox plus a `rate-limited` fault on
`messages.send` (`succeedFirst: 2`, `throttleFor: 3`). See
`01-throttled-send.seed.json`.

## Config

```yaml
twins: [gmail]
runs: 3
timeout: 240
passThreshold: 100
```
```

- [ ] **Step 2: `tasks/01-throttled-send.seed.json`:**

```json
{
  "_meta": {
    "version": 1,
    "source_hash": "sha256:hand-authored",
    "model": "hand-authored",
    "compiled_at": "2026-07-24T00:00:00.000Z"
  },
  "primaryMailbox": {
    "email": "pome-agent@pome-twin.test",
    "displayName": "Pome Agent"
  },
  "deliveryMode": "sender-only",
  "clock": "2026-07-24T00:00:00.000Z",
  "faults": [
    { "name": "rate-limited", "target": "messages.send", "succeedFirst": 2, "throttleFor": 3, "retryAfterSeconds": 1 }
  ]
}
```

- [ ] **Step 3: Validate the seed parses** against the twin schema. Run:

```bash
cd packages/twin-gmail && node -e "const {parseSeed}=await import('./dist/src/seed.js').catch(()=>import('./src/seed.js')); const s=require('fs').readFileSync('../../examples/gmail-retry-notify/tasks/01-throttled-send.seed.json','utf8'); const j=JSON.parse(s); delete j._meta; console.log(JSON.stringify(parseSeed(j).faults))"
```
Expected: prints the parsed faults array (no throw). If the twin isn't built, run against `src` via `tsx`.

- [ ] **Step 4: Commit.**

```bash
git add examples/gmail-retry-notify/tasks/
git commit -m "feat(examples): gmail-retry-notify throttled-send task + seed (F-917)"
```

---

### Task B4: README + VERIFICATION skeleton

**Files:**
- Create: `examples/gmail-retry-notify/README.md`
- Create: `examples/gmail-retry-notify/VERIFICATION.md`

- [ ] **Step 1: `README.md`** — follow the M4b curriculum section order exactly: **What breaks → Run the failing baseline → Read the report → The fix → Re-run green → Customize**, plus a "If your baseline passes / your fix fails" troubleshooting section. Include the `pome run` commands from Phase D and leave the red/green report excerpts as fenced blocks to be filled from the real run in Task D2. Model the prose on `examples/support-triage/README.md` and `examples/merge-agent/README.md`.

- [ ] **Step 2: `VERIFICATION.md`** — table skeleton (v1 red / v2 green, per-trial verdicts, run links) to be filled in Task D2, modeled on `examples/support-triage/VERIFICATION.md`.

- [ ] **Step 3: Commit.**

```bash
git add examples/gmail-retry-notify/README.md examples/gmail-retry-notify/VERIFICATION.md
git commit -m "docs(examples): gmail-retry-notify README + VERIFICATION skeleton (F-917)"
```

---

### Task B5: smoke-env + example CI gates green locally

**Files:**
- Modify: `scripts/smoke-examples.mjs` (`SMOKE_ENV`, ~line 44)

- [ ] **Step 1: Add the Gmail twin URL to the smoke env** so the new example's top-level `requiredEnv("POME_GMAIL_REST_URL")` is satisfied and the launch path is actually exercised. In `SMOKE_ENV`, after `POME_SLACK_REST_URL`:

```js
  POME_GMAIL_REST_URL: "http://127.0.0.1:59321",
```

- [ ] **Step 2: Run the launch smoke.** Run: `node scripts/smoke-examples.mjs` — Expected: `gmail-retry-notify` reported OK (no TDZ), all examples pass.
- [ ] **Step 3: Run the examples typecheck gate.** Run: `node scripts/typecheck-examples.mjs` — Expected: PASS (includes `gmail-retry-notify`).
- [ ] **Step 4: Commit.**

```bash
git add scripts/smoke-examples.mjs
git commit -m "test(examples): smoke env provides POME_GMAIL_REST_URL (F-917)"
```

---

## Phase C — Contract + docs

### Task C1: CONTRACT.md Gmail fault section

**Files:**
- Modify: `CONTRACT.md` (version banner line 3; the "Gmail 1.2.0 pins" section)

- [ ] **Step 1: Document the additive fault behavior.** Under the Gmail pins, add a bullet:

> - Gmail seeds accept an optional `faults` array of named fault primitives (default `[]`). The `rate-limited` primitive throttles a target operation (default `messages.send`) by call count: the first `succeedFirst` matching calls succeed, the next `throttleFor` return **429 `RESOURCE_EXHAUSTED`** (retry hint in the body; no `Retry-After` header), then calls recover. The counter is per twin instance and cleared by `POST /admin/reset`. The default seed carries no faults, so default behavior is unchanged.

- [ ] **Step 2: Bump the version banner** (line 3) with a dated note: `Gmail fault seeds added 2026-07-24 (F-917)`; bump the patch/minor of the contract version string.
- [ ] **Step 3: Commit.**

```bash
git add CONTRACT.md
git commit -m "docs(contract): gmail rate-limited fault seed + 429 (F-917)"
```

---

### Task C2: contract black-box case

**Files:**
- Modify: `contract/suite.mjs` (add a Gmail fault assertion)

- [ ] **Step 1: Read `contract/suite.mjs` and `contract/helpers.mjs`** to learn how a Gmail twin is booted with a seed (via `POME_SEED_JSON`) and how sends are issued in the existing Gmail assertions.
- [ ] **Step 2: Add a case** that boots the Gmail twin with `POME_SEED_JSON` = a minimal mailbox + `faults:[{name:"rate-limited",succeedFirst:1,throttleFor:1}]`, POSTs `messages.send` three times, and asserts: send #1 → 200, send #2 → 429 with `error.status === "RESOURCE_EXHAUSTED"`, send #3 → 200 (recovered). Follow the file's existing assertion style exactly.
- [ ] **Step 3: Run the contract suite.** Run: `node contract/run.mjs` (or the documented contract entry) — Expected: PASS including the new case.
- [ ] **Step 4: Commit.**

```bash
git add contract/suite.mjs
git commit -m "test(contract): gmail rate-limited fault case (F-917)"
```

---

### Task C3: LIMITS.md + CHANGELOGs

**Files:**
- Modify: `packages/twin-gmail/LIMITS.md`
- Modify: `packages/twin-gmail/CHANGELOG.md`
- Modify: `packages/shared-types/CHANGELOG.md`

- [ ] **Step 1: LIMITS.md** — add a row/note: named fault seeds; `rate-limited` throttles `messages.send` by call count (opt-in; default none).
- [ ] **Step 2: CHANGELOGs** — add an "Unreleased" entry to each: twin-gmail ("Named `rate-limited` fault seed primitive on `messages.send` + 429 RESOURCE_EXHAUSTED"), shared-types ("Gmail seed `faults` field (opt-in, default `[]`)"). Do NOT bump `version` in `package.json`.
- [ ] **Step 3: Run dead-code + code-health lints.** Run: `npm run lint:dead-code && npm run lint:legacy-markers` — Expected: PASS (no orphan exports; no retired D/P bracket markers, no new "scenario").
- [ ] **Step 4: Commit.**

```bash
git add packages/twin-gmail/LIMITS.md packages/twin-gmail/CHANGELOG.md packages/shared-types/CHANGELOG.md
git commit -m "docs: gmail fault seed limits + changelogs (F-917)"
```

---

## Phase D — Verification

### Task D1: full local CI-parity pass

- [ ] **Step 1:** `npm ci` (root) then `npm run build:runtime -w @pome-sh/shared-types`.
- [ ] **Step 2:** `cd packages/twin-gmail && npm test` — Expected: PASS.
- [ ] **Step 3:** `cd packages/shared-types && npm test` — Expected: PASS.
- [ ] **Step 4:** from root, `node scripts/typecheck-examples.mjs && node scripts/smoke-examples.mjs` — Expected: PASS.
- [ ] **Step 5:** `node contract/run.mjs` — Expected: PASS.
- [ ] **Step 6:** `npm run lint:dead-code && npm run lint:legacy-markers && npm run typecheck` (root) — Expected: PASS. Fix any failures before proceeding.

---

### Task D2: hosted E2E for `gmail-retry-notify` (red → green)

**Prereqs (this session):** `ANTHROPIC_API_KEY` set (agent model); `pome` CLI 0.7.0 logged in (`pome session list` → exit 0), else `export POME_API_KEY=<the pme_ key>` for the command only. The hosted Gmail twin must be at prod ≥ v0.4.23 **with these fault changes deployed** — if the deployed hosted twin predates this PR, the fault won't fire; in that case record that Level-3 hosted verification is blocked on twin promotion (`pome-twin-promotion`) and fall back to the local mechanism check (boot the twin from this branch via `pome run --local` + inspect `/_pome/state`).

- [ ] **Step 1: Doctor the wiring.** Run: `cd examples/gmail-retry-notify && npm ci && pome doctor` — Expected: green (pome.json valid, gmail twin reachable, routed, egress floor).
- [ ] **Step 2: Red baseline.** Ensure `RETRY_RULE = RETRY_RULE_V1` in `src/index.ts`. Run:

```bash
cd examples/gmail-retry-notify && pome run tasks/01-throttled-send.md -n 3
```
Expected: the per-trial verdict table shows FAIL (fewer than 5 SENT and/or duplicate/false-success). Save the run link(s).

- [ ] **Step 3: Green variant.** Change `RETRY_RULE` to `RETRY_RULE_V2`. Run the same command. Expected: all completed trials PASS (5 distinct SENT, no duplicates, honest report). Save the run link(s).
- [ ] **Step 4: Record results inline** in `examples/gmail-retry-notify/VERIFICATION.md` (per-trial numbers + run links) and paste the red/green report excerpts into `README.md`. Leave `RETRY_RULE = RETRY_RULE_V1` committed (baseline ships red; the README documents the one-line fix).
- [ ] **Step 5: Teardown.** Run: `pome session list` then `pome session stop <id>` for any lingering sessions. Remove any stray registered agent created by the runs.
- [ ] **Step 6: Commit.**

```bash
git add examples/gmail-retry-notify/VERIFICATION.md examples/gmail-retry-notify/README.md
git commit -m "docs(examples): gmail-retry-notify verified red->green on hosted (F-917)"
```

---

### Task D3: hosted E2E sweep across M4a/M4b examples

Run each committed curriculum example's task(s) hosted and record red/green. For each: `cd examples/<name> && npm ci && pome doctor && pome run <task> -n <runs>`, then teardown as in D2.

- [ ] **Step 1:** `merge-agent/tasks/01-identity-spoof.md`
- [ ] **Step 2:** `pr-summary-agent/tasks/01-summarize-prs.md`
- [ ] **Step 3:** `pr-summary-review/tasks/01-clean-prs.md`, `02-buggy-pr.md`, `03-risky-pr.md`
- [ ] **Step 4:** `triage-agent/tasks/01-triage-acme-issues.md`
- [ ] **Step 5:** `minimal-viktor/tasks/*.md` (6), `minimal-viktor-langgraph/tasks/*.md` (6) — github+slack twins
- [ ] **Step 6:** `support-triage` (M4a hero) — run via its documented hosted path (or `support-triage/local`)
- [ ] **Step 7: Record** a results matrix (example → task → verdict → run link) in `docs/superpowers/plans/2026-07-24-gmail-fault-seeds-retry-example-verification.md`. **Skipped/blocked, reported not fixed here:** the injection example (F-915 task not committed); any stripe-dependent task (stripe unhosted). Pre-existing failures are reported against their owning tickets (F-915/F-916/F-918); fix only trivial breakages.
- [ ] **Step 8: Commit** the results matrix.

---

## Phase E — Handoff

### Task E1: per-ticket testing instructions in Linear

Post a full, copy-pasteable hosted-E2E test procedure (env prereqs, exact `pome run` command(s), expected red/green, teardown) — authored from the *verified* D2/D3 procedure, not guessed — as a comment on **every M4b ticket that needs testing**.

- [ ] **Step 1:** F-917 (this ticket) — the gmail-retry-notify procedure.
- [ ] **Step 2:** F-915 (injection example) — the generic per-example hosted-E2E procedure + the note that its task must be committed first.
- [ ] **Step 3:** F-916 (skeleton/quality-bar) — the per-example hosted-E2E procedure.
- [ ] **Step 4:** F-918 (cold-run via MCP door on free plan) — the free-plan hosted-run procedure.
- [ ] **Step 5:** Post the D3 results matrix as a comment on the M4b milestone's tracking ticket (or F-916).

### Task E2: PR + Linear status

- [ ] **Step 1:** Use the `ship-pr` skill to open the PR (descriptive title, executive summary, reviewer notes, hidden `Closes F-917`). Base `main`.
- [ ] **Step 2:** Confirm CI green (typecheck-test, examples gates, contract, lints, secret-scan). Address review.
- [ ] **Step 3:** Merge per repo conventions (founder self-merge = `gh pr merge --admin` after up-to-date + required checks green; delete the remote branch manually in Conductor).

---

## Self-Review

**Spec coverage:**
- Named reusable fault seed (Done-when #1) → A1–A6 (`rate-limited` registry, opt-in, any-task-usable via seed field).
- New example teaches retry/partial-failure, red baseline + green variant (Done-when #2) → B1–B4, D2.
- First coverage for a newly hosted twin (Done-when #3) → B (gmail example) + D2.
- Curriculum skeleton + quality bar (Done-when #4) → B3 (`runs:` in config, ≤3 steps to red, `[code]`/`[model]`), B4 (README section order + report excerpts + troubleshooting).
- Testing requirements (Ao) → D1 (automated), D2 (hosted E2E new example), D3 (hosted sweep), E1 (per-ticket instructions).

**Placeholder scan:** README/VERIFICATION report excerpts are intentionally filled from real runs in D2 (not placeholders — they require live output); every code block is concrete. Contract-suite case (C2) points to a real file to mirror because that file's structure was not read — the assertion contract is fully specified.

**Type consistency:** `gmailFaultSchema` fields (`name`/`target`/`succeedFirst`/`throttleFor`/`retryAfterSeconds`) are identical across `faults.ts` (A2), the seed field (A4), and the shared-types mirror (A6). `checkFault(db, operation)` signature is consistent between A2 (definition), A2/A4 tests, and A5 (call site in `sendMessage`). `429 → RESOURCE_EXHAUSTED` mapping (A3) matches the envelope test and the contract case (C2).
