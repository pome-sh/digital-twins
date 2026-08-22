# gmail-retry-notify

A model-driven Gmail notification agent (Vercel AI SDK, REST) that must send an
announcement to five recipients while the Gmail twin throttles it partway
through. **Failure class: retry / partial failure.**

This is the retry/partial-failure entry in the Pome example curriculum. Each
example teaches exactly one failure class with a failing baseline and a
one-line fix.

## What breaks

The task seeds the Gmail twin with a named `rate-limited` fault on
`messages.send`: the first two sends succeed, the next three return **HTTP 429
`RESOURCE_EXHAUSTED`**, then sends recover. A naive agent sends each recipient
once, hits 429 on the later ones, and stops — leaving those teammates unsent
(partial failure) or falsely reporting "all sent". Worse, an agent that reacts
by re-sending the whole batch duplicates the recipients that already went out
(the Gmail twin does not dedupe across separate send calls).

The named fault is a reusable twin primitive — any task can seed
`faults: [{ "name": "rate-limited", ... }]`; the name is the teaching
vocabulary.

## Run the failing baseline

Prerequisites: Node ≥ 24, `ANTHROPIC_API_KEY` set, and a logged-in `pome` CLI
(`pome login`). Then, from this directory:

```bash
npm ci
pome run tasks/01-throttled-send.md -n 3
```

The agent ships red: `src/index.ts` uses `RETRY_RULE_V1` ("send each recipient
once"). Expected: the trial table FAILS — fewer than five recipients delivered
and/or a false "all sent" summary.

<!-- BASELINE-REPORT: filled from the real red run in VERIFICATION.md -->

## Read the report

Open the run link printed by `pome run`. The failing criteria show which
recipients never received the announcement and, for the `[model]` criterion,
where the summary overclaimed delivery.

## The fix

One line in `src/index.ts`:

```diff
-const RETRY_RULE = RETRY_RULE_V1; // ← green variant: change to RETRY_RULE_V2
+const RETRY_RULE = RETRY_RULE_V2; // ← green variant: change to RETRY_RULE_V2
```

`RETRY_RULE_V2` tells the agent to back off and retry **only the recipients
that failed**, never re-sending a success, and to report the true delivery
state.

## Re-run green

```bash
pome run tasks/01-throttled-send.md -n 3
```

Expected: all five recipients delivered exactly once, no duplicates, honest
summary — every criterion passes.

<!-- GREEN-REPORT: filled from the real green run in VERIFICATION.md -->

See [`VERIFICATION.md`](./VERIFICATION.md) for the measured red vs green results.

## Customize

- Tune the fault in `tasks/01-throttled-send.seed.json`: `succeedFirst`,
  `throttleFor`, `retryAfterSeconds`.
- Point the same `rate-limited` fault at your own task's mailbox to test your
  own agent's retry handling.
- Swap the model with `GMAIL_AGENT_MODEL` (e.g. a smaller model that may not
  recover even with the V2 rule).

## If your baseline passes / your fix fails

Model runs are nondeterministic. If the red baseline (V1) occasionally passes,
raise `throttleFor` in the seed so more sends are throttled, or increase `-n`.
If the green fix (V2) occasionally fails, raise the retry budget in
`RETRY_RULE_V2` or lower `throttleFor`. The `runs: 3` trial count in the task
config is there because reliability is part of the lesson.
