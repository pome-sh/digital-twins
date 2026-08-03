---
"@pome-sh/cli": minor
---

A twin HTTP row in `events.jsonl` now names the tool call that caused it.

The post-run merge resolves each `TwinHttpEvent`'s `parent_event_id` to the
`event_id` of the `ToolUseEvent` that made the call, keyed on the SDK's real
`tool_use_id`. Previously every twin row carried a null parent, so a trace was
either a tool tree or a flat list of twin calls, never one tree.

Wire vocab: emitters write `parent_event_id` (the spawning row's `event_id`) or
`causing_tool_use_id`, replacing `parent_id`, which meant four different things
depending on which writer produced the row. Recordings written by older
versions still parse — `parent_id` is accepted as a legacy input key and
normalized on read.
