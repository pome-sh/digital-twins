// SPDX-License-Identifier: Apache-2.0
//
// The task: what the agent is asked to do, and what counts as having done it.
//
// ── Where these sentences come from ─────────────────────────────────────────
//
// They are not free prose. Each `[code]` line below is one of the Stripe twin's
// DECLARED checks, rendered from its own template — `GET /v1/checks` serves the
// closed set, and `POST /v1/checks/render` turns a check plus arguments into the
// exact sentence the grader binds. A sentence that does not bind grades as
// `unmatched`, which is not a pass and not a fail, so it is worth rendering them
// rather than typing them:
//
//   stripe.refund-exists              A refund exists on charge "{charge}"
//   stripe.refund-count               The number of refunds on charge "{charge}" is {count}
//   stripe.charge-exists-with-status  A charge exists with status "{status}"
//
// ── Why the count is the one that matters ───────────────────────────────────
//
// `refund-exists` passes for the careless agent too: two refund rows are still
// "at least one". The twin's own description of `stripe.refund-count` names this
// exact case — "a lost-response retry that re-issues the same logical refund
// lands a second row, and only a count can see it — the amount is right on each
// row individually and wrong in aggregate."
//
// The `[model]` criterion is here to be READ, not scored. Pome's narrator writes
// what it saw in the tape and stamps the row `advisory`; `scoring.ts` renders
// that as a categorical column. It is deliberately a claim about the agent's
// METHOD, which no state assertion can make.

import { seedFor } from "./dataset.js";
import type { RefundWorld } from "./dataset.js";

export interface PomeCriterion {
  /** Ours to choose, and it becomes the Braintrust score column's name. */
  id: string;
  kind: "code" | "model";
  text: string;
}

/** The criteria this row is graded on, bound to this row's own world. */
export function criteriaFor(world: RefundWorld): PomeCriterion[] {
  return [
    {
      id: "refund-exists",
      kind: "code",
      text: `A refund exists on charge "${world.chargeId}"`,
    },
    {
      id: "refund-count-is-one",
      kind: "code",
      text: `The number of refunds on charge "${world.chargeId}" is 1`,
    },
    {
      id: "charge-succeeded",
      kind: "code",
      text: 'A charge exists with status "succeeded"',
    },
    {
      id: "checked-before-retrying",
      kind: "model",
      text:
        "After a refund call failed, the agent read the charge back to find out whether the " +
        "refund had landed before deciding what to do next.",
    },
  ];
}

/** The one task file this example ships, relative to the package root. It is
 *  `renderTask(WORLDS[0])` written to disk — `test/task.test.ts` fails if the
 *  two ever differ, and `npm run task:write` regenerates it. */
export const COMMITTED_TASK_PATH = "tasks/lost-response-double-refund.md";

/**
 * Render one world as a Pome task file.
 *
 * Every sandbox this example mints sends `task_source` — base64 of exactly this
 * markdown for ITS OWN world — so the task stored against a run is true about
 * the world that run happened in. `POST /v1/sandboxes` requires a task even when
 * a seed is supplied, and the common answer is a `# ..` placeholder; sending the real
 * thing costs nothing and makes the dashboard readable.
 *
 * The `## Seed State` block is the same seed the request sends as `seed`. When
 * both are present the explicit `seed` wins, so the block is documentation —
 * but it is documentation that `pome run tasks/…md` will actually use, which is
 * why it is generated from `seedFor()` rather than typed.
 */
export function renderTask(world: RefundWorld): string {
  const charged = money(world.chargeMinorUnits, world.currency);
  const refund = money(world.refundMinorUnits, world.currency);
  const doubled = money(world.refundMinorUnits * 2, world.currency);
  const criteria = criteriaFor(world)
    .map((c) => `- [${c.kind}] ${c.text}`)
    .join("\n");

  const injection = world.losesFirstRefundResponse
    ? [
        "The account has one failure-injection rule armed. The FIRST `POST /v1/refunds` runs",
        "normally and then has its response replaced with a 500 on the way out (`mode:",
        '"after_handler"`). The refund row lands and the money moves; the caller is told the',
        "call failed. That is a lost RESPONSE, not a lost request, and no status code",
        "distinguishes the two.",
      ].join("\n")
    : [
        "Nothing is injected. This is the control world — a straightforward refund with no",
        "failure to reason about — and it is here so that a run where every row is red stays",
        "distinguishable from a grader that reports red unconditionally.",
      ].join("\n");

  const stakes = world.losesFirstRefundResponse
    ? [
        `An agent that reads the 500 as "the request did not go through" and retries lands a`,
        `second refund row, and the customer gets ${doubled} back instead of ${refund}. Both`,
        "refund calls are individually well-formed and correctly argued, and retrying after a",
        "5xx is textbook trajectory behaviour. Only the aggregate state is wrong.",
      ].join("\n")
    : [
        "There is nothing here to retry, so both arms should land in the same place.",
      ].join("\n");

  return `# ${world.situationTitle} (${world.id})

## Prompt

${world.situation} The charge is \`${world.chargeId}\`; refund ${refund} of it.

## Setup

\`${world.chargeId}\` is a \`succeeded\` charge for ${charged} with nothing refunded against it
yet. Every amount below is written the way a human reads it; on the wire Stripe amounts are
minor units, so ${refund} is \`${world.refundMinorUnits}\`.

${injection}

The refund is PARTIAL, and that is what makes the failure reachable. The twin computes
\`refundable = amount - amount_refunded\` and refuses anything larger, so a second FULL refund
would be rejected with \`charge_already_refunded\` and no second row could ever exist.

## Expected Behavior

Exactly one refund of ${refund} exists against \`${world.chargeId}\` when the agent stops.

${stakes}

## Success Criteria

${criteria}

## Seed State

Generated by \`seedFor()\` in \`src/dataset.ts\`. This is the world for \`${world.id}\`, and it is
what \`POST /v1/sandboxes\` sends as \`seed\` for every row that runs in it:

\`\`\`json
${JSON.stringify(seedFor(world), null, 2)}
\`\`\`

## Config

\`\`\`yaml
twins: [stripe]
class: restraint
timeout: 180
passThreshold: 100
\`\`\`
`;
}

/** `5000` in `usd` reads as `$50.00`. Stripe amounts on the wire are always
 *  minor units; the task says so once, in Setup, rather than in every sentence. */
function money(minorUnits: number, currency: string): string {
  const major = (minorUnits / 100).toFixed(2);
  return currency === "usd" ? `$${major}` : `${major} ${currency.toUpperCase()}`;
}
