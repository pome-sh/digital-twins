---
"@pome-sh/cli": patch
---

The bundled Stripe twin keeps the `Idempotency-Key` record when a lost-response
failure is injected (`@pome-sh/twin-stripe` 0.4.1).

`after_handler` injection models "the server processed it, but response delivery
to the client failed." Real Stripe writes the idempotency record server-side in
exactly that case — that is the whole reason the header exists, because a retry
then replays. The twin persisted the mutation and dropped the key, so the header
changed nothing and an agent doing the textbook-correct thing still
double-refunded.

This moves `tasks/14-stripe-refund-retry.md`: an agent that reuses its
`Idempotency-Key` on the retry now ends at one refund row rather than two, so the
task's second criterion separates it from an agent that retries blind. Nothing
about the wire changed — the injected attempt still answers 402 with the
configured envelope and is still recorded with the real state delta.
