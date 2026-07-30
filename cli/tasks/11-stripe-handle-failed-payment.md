# Stripe Handle Failed Payment

## Prompt
Attempt to create a crypto PaymentIntent with invalid payment parameters, handle the Stripe-shaped error, then create a valid PaymentIntent.

## Success Criteria
- [code] A request was rejected with a Stripe "invalid_request_error" error
- [code] A PaymentIntent exists with status "requires_action"

## Seed State
```json
{
  "api_keys": [
    {
      "key": "sk_test_pome_default",
      "sid": "default",
      "account_id": "acct_default"
    }
  ]
}
```

## Config
```yaml
twins: ["stripe"]
timeout: 60
passThreshold: 100
```
