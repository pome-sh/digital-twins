// SPDX-License-Identifier: Apache-2.0
//
// MCP tool definitions. Owned by AGENT-B.
//
// Tool names mirror stripe-node — `create_payment_intent`,
// `retrieve_charge`, `list_events`, etc. Same shape as twin-github's
// tools.ts so the MCP wrapper in app.ts (AGENT-A) just works:
// `executeTool(domain, name, args)`.

import { loadMcpToolFixture } from "@pome-sh/sdk";
import { z } from "zod";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import type { StripeDomain } from "./domain/index.js";
import { TwinError } from "./errors.js";

/**
 * The tool table Stripe serves. Every name, description and input schema on
 * the wire comes from this fixture; the array below declares only how each
 * tool's arguments are validated (F-1325).
 *
 * Its substrate is `twin-code-transcription` — this listing was read off this
 * twin. There is nothing to compare it to: `@stripe/mcp` declares no tools of
 * its own and the live surface is a function of the caller's Restricted API
 * Key, so F-1326 recorded stripe as `not-captured` rather than inventing a
 * deployment-invariant table.
 */
export const stripeToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

// ---------- shared shapes ----------

const piPMTypes = z.array(z.enum(["crypto", "card"])).length(1);

const cryptoOptions = z.object({
  mode: z.literal("deposit"),
  deposit_options: z
    .object({
      networks: z.array(z.string()).min(1).optional(),
    })
    .optional(),
});

const limitShape = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

const createdRange = {
  created: z
    .union([
      z.coerce.number().int(),
      z.object({
        gt: z.coerce.number().int().optional(),
        gte: z.coerce.number().int().optional(),
        lt: z.coerce.number().int().optional(),
        lte: z.coerce.number().int().optional(),
      }),
    ])
    .optional(),
};

type CreatedFlat = {
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

function flattenCreated(input: { created?: number | { gt?: number; gte?: number; lt?: number; lte?: number } }): CreatedFlat {
  if (input.created === undefined) return {};
  if (typeof input.created === "number") {
    return { created_gte: input.created, created_lte: input.created };
  }
  return {
    created_gt: input.created.gt,
    created_gte: input.created.gte,
    created_lt: input.created.lt,
    created_lte: input.created.lte,
  };
}

// ---------- tool definitions ----------

/**
 * How each tool's arguments are validated, indexed by the name the fixture
 * declares. `stripeToolInputSchema` is the projection that produced every
 * `inputSchema` in the fixture, and the contract suite runs it over each
 * schema here and demands those bytes back.
 */
export const toolArgumentSchemas = [
  {
    name: "create_payment_intent",
    schema: z.object({
      amount: z.coerce.number().int().positive(),
      currency: z.string().min(1),
      payment_method_types: piPMTypes,
      payment_method_options: z
        .object({
          crypto: cryptoOptions,
        })
        .optional(),
      payment_method: z.string().optional(),
      customer: z.string().optional(),
      confirm: z.boolean().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      capture_method: z.string().optional(),
      confirmation_method: z.string().optional(),
    }),
  },
  {
    name: "retrieve_payment_intent",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_payment_intents",
    schema: z.object({ ...limitShape, ...createdRange }),
  },
  {
    name: "confirm_payment_intent",
    schema: z.object({ id: z.string().min(1), payment_method: z.string().optional() }),
  },
  {
    name: "update_payment_intent",
    schema: z.object({
      id: z.string().min(1),
      amount: z.coerce.number().int().optional(),
      metadata: z.record(z.string(), z.string().nullable()).optional(),
      payment_method: z.string().optional(),
      customer: z.string().optional(),
    }),
  },
  {
    name: "cancel_payment_intent",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "simulate_crypto_deposit",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "retrieve_charge",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_charges",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      payment_intent: z.string().optional(),
      customer: z.string().optional(),
    }),
  },
  {
    name: "create_refund",
    schema: z.object({
      charge: z.string().min(1),
      amount: z.coerce.number().int().positive().optional(),
      reason: z.string().optional(),
    }),
  },
  {
    name: "retrieve_refund",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_refunds",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      charge: z.string().optional(),
      payment_intent: z.string().optional(),
    }),
  },
  {
    name: "create_customer",
    schema: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      description: z.string().optional(),
      phone: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  },
  {
    name: "retrieve_customer",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "update_customer",
    schema: z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      email: z.string().optional(),
      description: z.string().optional(),
      phone: z.string().optional(),
      // Nullable values mirror the REST surface: null (or "") unsets the key.
      metadata: z.record(z.string(), z.string().nullable()).optional(),
    }),
  },
  {
    name: "delete_customer",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_customers",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      email: z.string().optional(),
    }),
  },
  {
    name: "list_customer_payment_methods",
    schema: z.object({
      customer: z.string().min(1),
      type: z.string().optional(),
      ...limitShape,
    }),
  },
  {
    name: "create_payment_method",
    schema: z.object({
      type: z.literal("card"),
      card: z.object({
        number: z.string().min(1),
        exp_month: z.coerce.number().int(),
        exp_year: z.coerce.number().int(),
        cvc: z.string().optional(),
      }),
    }),
  },
  {
    name: "retrieve_payment_method",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "attach_payment_method",
    schema: z.object({ id: z.string().min(1), customer: z.string().min(1) }),
  },
  {
    name: "detach_payment_method",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "retrieve_balance",
    schema: z.object({}).optional(),
  },
  {
    name: "list_balance_transactions",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      type: z.string().optional(),
    }),
  },
  {
    name: "retrieve_event",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_events",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      type: z.string().optional(),
    }),
  },
] as const;

export type ToolName = (typeof toolArgumentSchemas)[number]["name"];

/** Names of tools that mutate state. The MCP route uses this for recorder annotation. */
export function isMutatingTool(name: string): boolean {
  return [
    "create_payment_intent",
    "confirm_payment_intent",
    "update_payment_intent",
    "cancel_payment_intent",
    "simulate_crypto_deposit",
    "create_refund",
    "create_customer",
    "update_customer",
    "delete_customer",
    "create_payment_method",
    "attach_payment_method",
    "detach_payment_method",
  ].includes(name);
}

/** Execute a tool by name. Mirrors twin-github's `executeTool(domain, name, input)`. */
export function executeTool(
  domain: StripeDomain,
  accountId: string,
  name: string,
  input: unknown
): unknown {
  const definition = toolArgumentSchemas.find((tool) => tool.name === name);
  if (!definition) {
    throw new TwinError(
      "invalid_request_error",
      "tool_unknown",
      `No such MCP tool: '${name}'.`,
      { param: "tool", statusCode: 400 }
    );
  }
  const parsed = (definition.schema as z.ZodTypeAny).parse(input ?? {}) as Record<string, unknown>;
  switch (name as ToolName) {
    case "create_payment_intent":
      return domain.createPaymentIntent(accountId, parsed as never).body;
    case "retrieve_payment_intent":
      return domain.retrievePaymentIntent(accountId, parsed.id as string);
    case "list_payment_intents": {
      const flat = flattenCreated(parsed);
      return domain.listPaymentIntents(accountId, { ...parsed, ...flat } as never);
    }
    case "confirm_payment_intent":
      return domain.confirmPaymentIntent(accountId, parsed.id as string, {
        payment_method: parsed.payment_method as string | undefined,
      }).body;
    case "update_payment_intent": {
      const { id, ...fields } = parsed as { id: string } & Record<string, unknown>;
      return domain.updatePaymentIntent(accountId, id, fields as never).body;
    }
    case "cancel_payment_intent":
      return domain.cancelPaymentIntent(accountId, parsed.id as string).body;
    case "simulate_crypto_deposit":
      return domain.simulateCryptoDeposit(accountId, parsed.id as string).body;
    case "retrieve_charge":
      return domain.retrieveCharge(accountId, parsed.id as string);
    case "list_charges": {
      const flat = flattenCreated(parsed);
      return domain.listCharges(accountId, { ...parsed, ...flat } as never);
    }
    case "create_refund":
      return domain.createRefund(accountId, parsed as never).body;
    case "retrieve_refund":
      return domain.retrieveRefund(accountId, parsed.id as string);
    case "list_refunds": {
      const flat = flattenCreated(parsed);
      return domain.listRefunds(accountId, { ...parsed, ...flat } as never);
    }
    case "create_customer":
      return domain.createCustomer(accountId, parsed as never).body;
    case "retrieve_customer":
      return domain.retrieveCustomer(accountId, parsed.id as string);
    case "update_customer": {
      const { id, ...fields } = parsed as { id: string } & Record<string, unknown>;
      return domain.updateCustomer(accountId, id, fields as never).body;
    }
    case "delete_customer":
      return domain.deleteCustomer(accountId, parsed.id as string).body;
    case "list_customers": {
      const flat = flattenCreated(parsed);
      return domain.listCustomers(accountId, { ...parsed, ...flat } as never);
    }
    case "list_customer_payment_methods": {
      const { customer, ...rest } = parsed as { customer: string } & Record<string, unknown>;
      return domain.listCustomerPaymentMethods(accountId, customer, rest as never);
    }
    case "create_payment_method":
      return domain.createPaymentMethod(accountId, parsed as never).body;
    case "retrieve_payment_method":
      return domain.retrievePaymentMethod(accountId, parsed.id as string);
    case "attach_payment_method":
      return domain.attachPaymentMethod(
        accountId,
        parsed.id as string,
        parsed.customer as string
      ).body;
    case "detach_payment_method":
      return domain.detachPaymentMethod(accountId, parsed.id as string).body;
    case "retrieve_balance":
      return domain.retrieveBalance(accountId);
    case "list_balance_transactions": {
      const flat = flattenCreated(parsed);
      return domain.listBalanceTransactions(accountId, { ...parsed, ...flat } as never);
    }
    case "retrieve_event":
      return domain.retrieveEvent(accountId, parsed.id as string);
    case "list_events": {
      const flat = flattenCreated(parsed);
      return domain.listEvents(accountId, { ...parsed, ...flat } as never);
    }
  }
}

/**
 * The frozen wire projection of a Stripe tool's arguments — a best-effort
 * `z.toJSONSchema` shim that falls back to an empty object. Nothing serves it
 * any more (the fixture does), but the contract suite still runs it over every
 * schema above and compares, so the validator and the declaration cannot part
 * company.
 */
export function stripeToolInputSchema(schema: z.ZodType): unknown {
  const candidate = (z as unknown as { toJSONSchema?: (schema: z.ZodTypeAny) => unknown }).toJSONSchema;
  if (typeof candidate === "function") {
    try {
      return candidate(schema);
    } catch {
      return {};
    }
  }
  return {};
}
