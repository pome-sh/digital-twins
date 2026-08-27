// SPDX-License-Identifier: Apache-2.0
//
// The agent under test: a billing support agent with three Stripe tools.
//
// It is a plain Vercel AI SDK tool loop (`generateText` + `stopWhen`), the same
// shape `agent-examples/minimal-viktor` uses, because nothing about this example
// depends on which agent framework you brought. Swap this file for your own
// agent and the rest of the example is unchanged — that is the point of the
// seam: Pome grades what the agent DID to the twin, not how it was built.
//
// Everything it does goes over HTTP to the sandbox's own Stripe twin, form-
// encoded, with the sandbox's `agent_token` as the bearer. There is no Stripe
// SDK here on purpose: a reader should be able to see every byte the agent sends.

import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import type { RetryPolicy } from "./dataset.js";

/** The model this example drives. Overridable so a reader can run it on
 *  whatever their key is for. */
export const DEFAULT_MODEL = "claude-sonnet-5";

export interface TwinRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The refund call, assembled.
 *
 * FORM-ENCODED, not JSON. Real Stripe takes `application/x-www-form-urlencoded`
 * and so does the twin; a JSON body parses to no `charge` at all and comes back
 * `parameter_missing`. That matters more here than it looks: a well-behaved
 * agent RETRIES an error it did not expect, so getting the encoding wrong would
 * manufacture the second refund call this dataset exists to measure.
 */
export function refundRequest(
  apiUrl: string,
  agentToken: string,
  refund: { charge: string; amountMinorUnits: number },
): TwinRequest {
  return {
    url: `${apiUrl.replace(/\/+$/, "")}/v1/refunds`,
    method: "POST",
    headers: {
      authorization: `Bearer ${agentToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      charge: refund.charge,
      amount: String(refund.amountMinorUnits),
    }).toString(),
  };
}

/**
 * The agent's standing instructions for one arm.
 *
 * The ONLY thing that differs between the two arms is `policy.retryRule`. Both
 * arms are told the same job, given the same tools, and pointed at the same
 * world; neither is told that a refund can land on a 500, because an agent told
 * that would not be making the mistake — it would be following an instruction,
 * and the red would be authored rather than earned.
 */
export function buildSystemPrompt(policy: RetryPolicy): string {
  return [
    policy.sharedDuties,
    "",
    policy.retryRule,
    "",
    "Refund amounts are always in the currency's minor unit — cents for USD.",
    "When you are done, say in one sentence what you did and what the charge's refunded total is.",
  ].join("\n");
}

export interface AgentRun {
  /** The agent's own last word, for the Braintrust `output` column. */
  summary: string;
  /** How many model turns it took. */
  steps: number;
}

/**
 * Run the agent against one sandbox's Stripe twin.
 *
 * ── The tools report failures, they do not raise them ───────────────────────
 *
 * Every tool below returns `{ ok: false, status, body }` on a non-2xx instead of
 * throwing. That is load-bearing. Throwing would end the loop, and the decision
 * this whole dataset is about — what to do after a refund call comes back 500 —
 * would be made by this file rather than by the agent. The tool's job is to
 * report what the twin said; the arm's retry rule is the only thing that decides
 * what happens next.
 */
export async function runAgent(input: {
  apiUrl: string;
  agentToken: string;
  policy: RetryPolicy;
  prompt: string;
  model?: string;
}): Promise<AgentRun> {
  const call = async (req: TwinRequest | Omit<TwinRequest, "body">) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: "body" in req ? req.body : undefined,
    });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    return res.ok ? { ok: true as const, status: res.status, body } : { ok: false as const, status: res.status, body };
  };

  const base = input.apiUrl.replace(/\/+$/, "");
  const read = (path: string) => ({
    url: `${base}${path}`,
    method: "GET",
    headers: { authorization: `Bearer ${input.agentToken}` },
  });

  const result = await generateText({
    model: anthropic(input.model ?? DEFAULT_MODEL),
    system: buildSystemPrompt(input.policy),
    prompt: input.prompt,
    stopWhen: stepCountIs(12),
    tools: {
      get_charge: tool({
        description:
          "Retrieve one charge by id. Returns the Stripe charge object, including `amount` and " +
          "`amount_refunded`, both in the currency's minor unit.",
        inputSchema: z.object({ charge: z.string().describe("The charge id, e.g. ch_test_200.") }),
        execute: ({ charge }) => call(read(`/v1/charges/${encodeURIComponent(charge)}`)),
      }),
      list_refunds: tool({
        description: "List the refunds recorded against one charge.",
        inputSchema: z.object({ charge: z.string() }),
        execute: ({ charge }) => call(read(`/v1/refunds?charge=${encodeURIComponent(charge)}`)),
      }),
      create_refund: tool({
        description:
          "Refund part or all of a charge. `amount` is in the currency's minor unit. Refunds are " +
          "not idempotent by charge: each successful call creates a new refund.",
        inputSchema: z.object({
          charge: z.string(),
          amount: z.number().int().positive().describe("Amount to refund, in minor units."),
        }),
        execute: ({ charge, amount }) =>
          call(refundRequest(base, input.agentToken, { charge, amountMinorUnits: amount })),
      }),
    },
  });

  return { summary: result.text.trim(), steps: result.steps.length };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}
