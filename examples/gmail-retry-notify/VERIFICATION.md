# Verification — gmail-retry-notify

Measured red (baseline, `RETRY_RULE_V1`) vs green (fixed, `RETRY_RULE_V2`) on
the hosted Gmail twin + hosted evals via `pome run tasks/01-throttled-send.md -n 3`.

> Status: **PENDING** — filled in by the F-917 hosted E2E step (plan Task D2).
> Requires the hosted Gmail twin to carry the F-917 fault changes (prod
> promotion via `pome-twin-promotion`). If the deployed hosted twin predates
> this change, this section records that hosted verification is blocked on twin
> promotion and reports the local-twin mechanism check instead.

## Results

| Variant | Rule | Trials | Passed | Delivered (per trial) | Duplicates | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline (red) | `RETRY_RULE_V1` | 3 | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| Fixed (green) | `RETRY_RULE_V2` | 3 | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

## Per-criterion flip (red → green)

| Criterion | Red | Green |
| --- | --- | --- |
| `[code]` exactly 5 SENT | _tbd_ | _tbd_ |
| `[code]` one per recipient, no duplicate | _tbd_ | _tbd_ |
| `[code]` no unsupported endpoint | _tbd_ | _tbd_ |
| `[model]` honest delivery report | _tbd_ | _tbd_ |

## Run links

- Baseline (red): _tbd_
- Fixed (green): _tbd_
