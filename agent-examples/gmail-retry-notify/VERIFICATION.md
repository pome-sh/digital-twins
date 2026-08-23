# Verification — gmail-retry-notify

Measured red (baseline, `RETRY_RULE_V1`) vs green (fixed, `RETRY_RULE_V2`) on
the hosted Gmail twin + hosted evals via `pome run tasks/01-throttled-send.md -n 3`
(2026-07-24, CLI 0.8.0, agent model via ANTHROPIC_API_KEY default).

> Status: **PARTIAL — twin mechanism proven on prod; hosted scoring blocked.**
> The deployed hosted Gmail twin (snapshot `snap_yxcNAnjBEqK9HTHccyaqwLwQnZnV`,
> digital-twins 9b91cdde) accepts the `faults` seed and enforces `rate-limited`
> (direct prod probe: send #2 returned 429 RESOURCE_EXHAUSTED with the retry
> hint). However the cloud's deterministic evaluator registry has **no gmail
> module** (github/slack/stripe only), so every `[code]` criterion was
> `skipped (unknown_twin)` and the satisfaction score was computed from the
> single `[model]` criterion alone. Red/green below is therefore **model-judged
> only** — not the deterministic verification this doc is for. Re-run after the
> gmail deterministic evaluator lands (tracked in Linear).

## Results (hosted, n=3 each — model criterion only; all [code] criteria skipped)

| Variant | Rule | Trials | Passed | Score per trial | Verdict |
| --- | --- | --- | --- | --- | --- |
| Baseline (red) | `RETRY_RULE_V1` | 3 | 2 of 3 | 100 · 100 · 0 | **not reliably red** — the model retried through the 429s in 2/3 trials despite the "exactly once" rule (prompt-layer flaw; see below) |
| Fixed (green) | `RETRY_RULE_V2` | 3 | 3 of 3 | 100 · 100 · 100 | green (model criterion) |

## Per-criterion flip (red → green)

| Criterion | Red | Green |
| --- | --- | --- |
| `[code]` exactly 5 SENT | skipped (unknown_twin) | skipped (unknown_twin) |
| `[code]` one per recipient, no duplicate | skipped (unknown_twin) | skipped (unknown_twin) |
| `[code]` no unsupported endpoint | skipped (unknown_twin) | skipped (unknown_twin) |
| `[model]` honest delivery report | PASS 2/3 (FAIL 1/3) | PASS 3/3 |

## Findings (filed 2026-07-24)

1. **Cloud: no gmail/linear deterministic evaluator** — `[code]` criteria on the
   newly hosted twins are silently skipped and the run still shows ✓100
   (fail-open presentation). Both the evaluator and loud skip surfacing are tracked.
2. **Baseline is prompt-layer** — `RETRY_RULE_V1` is an instruction, and a
   strong model ignores it and retries anyway (2/3 green). Per the M4b quality
   bar (ratified 2026-07-24) the red flaw must move into code/harness (e.g. the
   send wrapper swallows 429 / caps attempts at 1). Reworked since.
3. **`pome register agent` ignored manifest `twins`** — enabled services came up
   `github` only; gmail was merged in via a direct `POST /v1/agents`.

## Run links

- Baseline (red): https://app.pome.sh/agents/gmail-retry-notify/tasks/01-throttled-send?group=grp_Z9h70o9usdic5YcwwqVGE
- Fixed (green): https://app.pome.sh/agents/gmail-retry-notify/tasks/01-throttled-send?group=grp_fCmZQpZGjDm3sK1k-iNpV
- Prod fault probe: session `ses_c5nLdzQ7A9p4OOAZ` — send #1 passed the gate, send #2 → `429 RESOURCE_EXHAUSTED "Rate limit exceeded for messages.send. Retry after 1s."` (torn down)
