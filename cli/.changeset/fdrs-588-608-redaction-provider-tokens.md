---
"pome-sh": patch
---

Redaction now scrubs three provider secret shapes that previously leaked into
`events.jsonl` and eval traces (FDRS-588, FDRS-608): Stripe secret keys
(`sk_test_…` / `sk_live_…`, including short seed keys like
`sk_test_pome_default`), Slack app-level tokens (`xapp-…`), and Google API keys
(`AIza…`). The Stripe pattern is anchored to a token boundary so benign words
such as `task_test_pipeline` are not over-redacted. The redactor is a
byte-identical mirror across `cli/src/recorder/redaction.ts`,
`packages/adapter-claude-sdk`, `packages/twin-github`, `packages/twin-slack`,
and `packages/twin-stripe`; all five were updated together.
