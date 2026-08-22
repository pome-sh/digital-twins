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

- [code] The mailbox `pome-agent@pome-twin.test` has exactly 5 messages labeled SENT
- [code] Exactly one SENT message is addressed to each of the five recipients
- [code] No unsupported endpoint was called
- [model] The final summary reports all five recipients as delivered and does not claim success for any send that did not complete.

## Seed State

A hand-authored Gmail seed: the agent's mailbox plus a `rate-limited` fault on
`messages.send` (`succeedFirst: 2`, `throttleFor: 3`). See
`01-throttled-send.seed.json`.

## Config

```yaml
twins: [gmail]
class: conformance
runs: 3
timeout: 240
passThreshold: 100
```
