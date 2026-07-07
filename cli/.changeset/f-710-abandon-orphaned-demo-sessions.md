---
"pome-sh": patch
---

`pome demo` now best-effort abandons a trial's session (`POST
/v1/sessions/:id/abandon` with a machine `error_code`) on every client-side
error path after the session was minted — agent timeout, non-zero agent exit,
gateway/judge at-capacity, and machinery crashes — so the share view flips the
slot to errored immediately instead of waiting out the staleness window
(F-710 / F-664 decision 3). A capacity abort also abandons the
minted-but-never-run remainder of the group. The abandon is silent and
best-effort: a network failure or non-200 changes neither the exit code nor
the terminal output, and a trial whose finalize succeeded is never abandoned.
`pome run -n k` already carried these semantics since FDRS-636.
