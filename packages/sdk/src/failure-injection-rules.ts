// SPDX-License-Identifier: Apache-2.0
//
// The failure-injection RULE surface: the rule shape, its zod schema, the mode
// enum and the counter store. Split out of `failure-injection.ts` so it can be
// reached without dragging `hono` in.
//
// WHY THE SPLIT EXISTS. A twin's SEED carries failure-injection rule payloads, so
// `packages/twin-stripe/src/seed.ts` needs `failureInjectionRuleSchema` — and
// `seed.ts` is part of the declaration surface `@pome-sh/checks` publishes. The
// middleware next door is typed `MiddlewareHandler` from `hono`, and a `.d.ts`
// that names `hono` cannot be resolved by a consumer who has no hono: it is a
// TS2307 in their build, from a package that only wanted a zod schema. Same
// argument as `check-state-path.ts` and `tape-assertable-tools.ts` — data and
// schema on one side of the seam, engine mechanism on the other.
//
// `failure-injection.ts` re-exports everything here, so `@pome-sh/sdk/server`'s
// surface is unchanged.
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const FAILURE_INJECTION_OVERRIDE_KEY = "failureInjectionOverride";

export type FailureInjectionOverride = {
  status: number;
  body: unknown;
};

export type FailureInjectionMode = "before_handler" | "after_handler";

export type FailureInjectionRule = {
  method: string;
  path: string;
  attempt: number;
  mode: FailureInjectionMode;
  status: number;
  body: unknown;
};

export const failureInjectionRuleSchema = z.object({
  method: z.string().min(1).transform((s) => s.toUpperCase()),
  path: z.string().min(1),
  attempt: z.number().int().positive(),
  mode: z
    .enum(["before_handler", "after_handler"] as const satisfies readonly FailureInjectionMode[])
    .default("after_handler"),
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
});

export type FailureInjectionStore = {
  setRules(rules: FailureInjectionRule[]): void;
  clear(): void;
  matchAndConsume(
    accountId: string,
    method: string,
    path: string
  ): FailureInjectionRule | null;
};

export function createFailureInjectionStore(): FailureInjectionStore {
  // The store is intentionally global across accounts. The (account_id,
  // method, path) counter keys keep accounts independent for matching;
  // rules themselves apply to whichever account issues the matching
  // request. Single-account scenarios (the common case, including the
  // hero scenario) don't need to express scope per rule.
  let rules: FailureInjectionRule[] = [];
  const counters = new Map<string, number>();
  const tuplesWithRules = new Set<string>();

  function tupleKey(method: string, path: string) {
    return `${method.toUpperCase()}\0${path}`;
  }
  function counterKey(accountId: string, method: string, path: string) {
    return `${accountId}\0${method.toUpperCase()}\0${path}`;
  }
  function rebuildIndex() {
    tuplesWithRules.clear();
    for (const r of rules) tuplesWithRules.add(tupleKey(r.method, r.path));
  }

  return {
    setRules(next) {
      rules = next.slice();
      counters.clear();
      rebuildIndex();
    },
    clear() {
      rules = [];
      counters.clear();
      tuplesWithRules.clear();
    },
    matchAndConsume(accountId, method, path) {
      const tk = tupleKey(method, path);
      if (!tuplesWithRules.has(tk)) return null;
      const ck = counterKey(accountId, method, path);
      const count = (counters.get(ck) ?? 0) + 1;
      counters.set(ck, count);
      return (
        rules.find(
          (r) =>
            r.method.toUpperCase() === method.toUpperCase() &&
            r.path === path &&
            r.attempt === count
        ) ?? null
      );
    },
  };
}
