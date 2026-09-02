# `@pome-sh/twin-stripe`

`@pome-sh/twin-stripe` is a stateful digital twin for Stripe payments and x402. It uses SQLite and exposes Stripe-shaped REST routes and 26 MCP tools.

This package is private implementation code. It is bundled with [`@pome-sh/cli`](../../cli/) and is not a separate install surface.

## Start the twin

```bash
npx @pome-sh/cli twin start stripe
```

The twin listens on port `3333` by default.

```bash
curl http://127.0.0.1:3333/healthz
```

The default seed creates `sk_test_pome_default` for session `default`.

## Stripe REST API

Stripe SDKs can use the root `/v1/*` routes. The API key identifies the session.

```ts
import Stripe from "stripe";

const stripe = new Stripe("sk_test_pome_default", {
  host: "127.0.0.1",
  port: 3333,
  protocol: "http",
});

await stripe.paymentIntents.create({
  amount: 1000,
  currency: "usd",
  payment_method_types: ["crypto"],
  payment_method_options: {
    crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
  },
});
```

The same handlers are available under `/s/:sid/v1/*`. On these routes, the URL `sid` must match the bearer token.

Create and settle a crypto PaymentIntent with HTTP:

```bash
curl -s -X POST http://127.0.0.1:3333/v1/payment_intents \
  -H "Authorization: Bearer sk_test_pome_default" \
  -H 'content-type: application/json' \
  -d '{"amount":1000,"currency":"usd","payment_method_types":["crypto"],"payment_method_options":{"crypto":{"mode":"deposit","deposit_options":{"networks":["base"]}}}}'

curl -s -X POST \
  http://127.0.0.1:3333/v1/test_helpers/payment_intents/<pi_id>/simulate_crypto_deposit \
  -H "Authorization: Bearer sk_test_pome_default" \
  -d '{}'
```

The settlement changes the PaymentIntent to `succeeded`, creates a charge, updates the balance, and emits events.

## Supported surface

| Surface | Count | Fidelity tier |
| --- | ---: | --- |
| Payment REST routes | 26 | Semantic |
| Product, price, subscription, and invoice routes | 13 | Shape |
| MCP tools | 26 | Semantic |
| `paymentMiddleware()` | 1 | Semantic |

[`FIDELITY.md`](FIDELITY.md) lists every route and known difference. [`fidelity.inventory.json`](fidelity.inventory.json) contains the machine-readable inventory.

## Authentication

The twin accepts two bearer forms:

- `sk_test_pome_<sid>` for Stripe SDK compatibility
- a Pome JWT whose `sid` claim matches `/s/:sid`

## MCP

The JSON-RPC endpoint is `POST /s/:sid/mcp`. Legacy HTTP endpoints are available at `GET /s/:sid/mcp/tools`, `POST /s/:sid/mcp/tools/:name`, and `POST /s/:sid/mcp/call`.

[`fixtures/mcp-tools-list.raw.json`](fixtures/mcp-tools-list.raw.json) defines the served tool listing.

The twin exposes these 26 tools:

```text
create_payment_intent
retrieve_payment_intent
list_payment_intents
update_payment_intent
confirm_payment_intent
cancel_payment_intent
simulate_crypto_deposit
retrieve_charge
list_charges
retrieve_balance
list_balance_transactions
retrieve_event
list_events
create_refund
retrieve_refund
list_refunds
create_customer
retrieve_customer
update_customer
delete_customer
list_customers
list_customer_payment_methods
create_payment_method
retrieve_payment_method
attach_payment_method
detach_payment_method
```

```bash
curl -s -X POST http://127.0.0.1:3333/s/default/mcp/call \
  -H "Authorization: Bearer sk_test_pome_default" \
  -H 'content-type: application/json' \
  -d '{"tool":"create_payment_intent","arguments":{"amount":1000,"currency":"usd","payment_method_types":["crypto"]}}'
```

## x402 example

The buyer-agent example starts a local seller with `paymentMiddleware()`. The buyer handles a 402 challenge and sends an `X-PAYMENT` header. It then checks Stripe state.

From the repository root, use two terminals:

```bash
# Terminal 1
npm run dev -w @pome-sh/twin-stripe

# Terminal 2
npm start --prefix packages/twin-stripe/examples/buyer-agent
```

[`examples/buyer-agent/README.md`](examples/buyer-agent/README.md) lists its configuration variables.

## Unsupported and limited behavior

The shape-tier billing routes preserve response structure but do not implement billing-cycle or invoice semantics.

Unsupported `/v1/*` routes return 501 with `fidelity: "unsupported"`. Named unsupported surfaces include Checkout Sessions, Payment Links, Setup Intents, and webhook endpoints.

Other recorded differences include:

- one API version: `2026-03-04.preview`
- no EIP-3009 signature verification for x402 payloads
- offset-based list pagination
- synchronous crypto settlement
- Base and USDC as the only deposit network and token

See [`FIDELITY.md`](FIDELITY.md) for the complete record.

## Contributor commands

Run package scripts from `packages/twin-stripe`:

```bash
npm run dev
npm run seed
npm run smoke
npm run typecheck
npm run fidelity:parity
npm run build
node dist/src/server.js
```

Run this test command from the repository root:

```bash
npx vitest run --project twin-stripe
```
