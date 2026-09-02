# Stripe x402 buyer-agent example

This repository example runs an x402 buyer against the local Stripe twin.

The example performs these steps:

1. Starts a local seller on port `4040`.
2. Requests the protected `/paid` route.
3. Receives an x402 402 challenge.
4. Sends an `X-PAYMENT` header.
5. Checks the PaymentIntent and Stripe events in the twin.

## Run

From the repository root, use two terminals:

```bash
# Terminal 1
npm run dev -w @pome-sh/twin-stripe

# Terminal 2
npm start --prefix packages/twin-stripe/examples/buyer-agent
```

The example requires Node.js 24 or later.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `POME_TWIN_BASE_URL` | `http://127.0.0.1:3333` | Stripe twin base URL |
| `POME_TWIN_API_KEY` | `sk_test_pome_default` | Stripe-shaped API key |
| `POME_TWIN_SID` | `default` | Session ID |
| `POME_BUYER_AGENT_SELLER_PORT` | `4040` | Local seller port |
