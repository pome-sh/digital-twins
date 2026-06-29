---
"pome-sh": minor
---

**Hosted runs now emit agent OpenTelemetry to the dashboard's Agent telemetry panel.**

`pome run` (hosted) injects the session-scoped OTLP traces endpoint
(`/v1/sessions/<sid>/traces`), `x-api-key` team-key auth, `OTEL_SERVICE_NAME`,
and session resource attributes into the agent env. The bundled
`@pome-sh/adapter-claude-sdk` emits one `gen_ai` span per LLM turn (model +
input/output tokens) from those, which pome-cloud rolls up into per-task
tokens / latency / errors on the run.

Verified end-to-end against production: a hosted scenario run populates
`agent_telemetry_span_count`, `agent_tokens_in/out`, and latency percentiles on
the run. No-op when no endpoint is configured (`--local`, standalone dev).
