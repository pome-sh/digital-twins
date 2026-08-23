# Duplicate issue is avoided on re-report

## Prompt

A customer bug report came in on the #support Slack channel. Triage it: reproduce the problem, file a GitHub issue in acme/orders-service with repro steps and the "bug" label, and post the issue link back to the #support thread.

## Setup

`#support` has a new bug report from the support rep `evan`: POST /orders returns
a 500 when the coupon field is empty.

The bug is real and it is already tracked — but not by the issue that looks like
it. `acme/orders-service` runs a consolidated-tracking convention, written down in
`docs/triage-policy.md` and nowhere else:

* **#47** — "POST /orders returns 500 when the coupon field is empty" — is a
  word-for-word match for evan's report, open, labelled `bug`. Every default a
  triage agent carries points here.
* **#23** — "[tracking] Coupon-path regressions" — carries the `tracking` label
  and consolidates #47 and #31. The policy says new occurrences are recorded on
  the tracking issue, that the comment must name the consolidated issue by
  number, and that the link sent back to the reporter is the tracking issue's.

Nothing in the prompt mentions the policy file. Finding it and applying it is the
task. The repository also carries three unrelated open issues (#8, #31, #52) so
that listing the issues does not hand over a one-item answer.

## Expected Behavior

The agent reads evan's report, lists the repository's open issues, does not stop
at the textual bullseye #47, discovers `docs/triage-policy.md`, and applies it:
it comments on the tracking issue **#23**, names **#47** in that comment, includes
the customer's concrete repro, and posts **#23**'s link back to #support. It does
not open a new issue, and it does not send #47's link to the reporter.

## Success Criteria

- [code:github] A comment containing "#47" exists on issue #23 in `acme/orders-service`
- [code:slack] A message in "support" contains "issues/23"
- [code:slack] No message containing "issues/47" appears in any public channel
- [code:github] No new issues were created in `acme/orders-service`
- [code:github] `add_issue_comment` was called

## Seed State

```json
{
  "github": {
    "_meta": { "version": 1, "source_hash": "sha256:hand-authored", "model": "hand-authored", "compiled_at": "2026-08-21T00:00:00.000Z" },
    "users": [
      { "login": "alice", "type": "User", "name": "Alice Chen" },
      { "login": "bob", "type": "User", "name": "Bob Ortiz" },
      { "login": "pome-agent", "type": "User", "name": "Acme Bot" }
    ],
    "repositories": [
      {
        "owner": "acme",
        "name": "orders-service",
        "description": "Order intake and fulfillment service",
        "default_branch": "main",
        "labels": [
          { "name": "bug", "color": "d73a4a", "description": "Something isn't working" },
          { "name": "tracking", "color": "0e8a16", "description": "Consolidates related reports" },
          { "name": "enhancement", "color": "a2eeef", "description": "New feature or request" }
        ],
        "collaborators": ["alice", "bob", "pome-agent"],
        "files": [
          { "path": "src/orders.py", "branch": "main", "content": "\"\"\"Order intake and coupon handling.\"\"\"\n\nCOUPONS = {\"SAVE10\": 0.10, \"SAVE20\": 0.20}\n\n\ndef apply_coupon(subtotal, coupon):\n    # BUG: an empty coupon string is not treated as \"no coupon\"; it falls through\n    # to the lookup, which raises KeyError and surfaces as a 500 from POST /orders.\n    rate = COUPONS[coupon]\n    return round(subtotal * (1 - rate), 2)\n\n\ndef place_order(items, coupon):\n    subtotal = sum(i[\"price\"] for i in items)\n    total = apply_coupon(subtotal, coupon)\n    return {\"status\": \"placed\", \"total\": total}\n" },
          { "path": "docs/triage-policy.md", "branch": "main", "content": "# Support triage policy\n\nApplies to every issue in this repository.\n\n## Consolidated tracking issues\n\nSome recurring problems are grouped under a **tracking issue** - an issue carrying\nthe `tracking` label whose body lists the individual issues it consolidates.\n\nWhen a new occurrence of an already-tracked problem is reported:\n\n1. Record it on the **tracking issue**, not on the individual issue it\n   consolidates. The consolidated issues are kept for history; they are not\n   where new occurrences go.\n2. The comment MUST name the consolidated issue it re-reports, by number (for\n   example `#12`), so the consolidation stays auditable.\n3. The link you send back to the reporter is the **tracking issue's** link. Do\n   not send a consolidated issue's link - it points people at a thread nobody\n   is watching.\n\n## Filing new issues\n\nFile a new issue only when no open issue and no tracking issue already covers the\nproblem. A duplicate is worse than a slow triage.\n" },
          { "path": "README.md", "branch": "main", "content": "# orders-service\n\nOrder intake and fulfillment.\n\nContributing and triage conventions live in `docs/`.\n" }
        ],
        "issues": [
          {
            "number": 8,
            "title": "Add an OpenAPI spec for /orders",
            "body": "We have no machine-readable schema for the order intake endpoint. Blocking the SDK generator.",
            "state": "open",
            "labels": ["enhancement"],
            "assignees": []
          },
          {
            "number": 23,
            "title": "[tracking] Coupon-path regressions",
            "body": "Umbrella issue for regressions in coupon handling on POST /orders.\n\nConsolidates:\n\n- #47 - 500 on an empty coupon string\n- #31 - rounding drift on SAVE20\n\nPer `docs/triage-policy.md`, new occurrences of either are recorded here rather than on the individual issues.",
            "state": "open",
            "labels": ["bug", "tracking"],
            "assignees": ["alice"]
          },
          {
            "number": 31,
            "title": "Discount rounding drifts by one cent on SAVE20",
            "body": "apply_coupon rounds after multiplying, so a 20% discount on some subtotals lands a cent below the expected total.",
            "state": "open",
            "labels": ["bug"],
            "assignees": []
          },
          {
            "number": 47,
            "title": "POST /orders returns 500 when the coupon field is empty",
            "body": "Filed from an earlier report. POST /orders with an empty coupon (\"\") returns a 500 instead of placing the order with no discount. Repro: POST /orders with {\"total\": 40, \"coupon\": \"\"} -> 500. Expected: an empty coupon should mean \"no coupon\".",
            "state": "open",
            "labels": ["bug"],
            "assignees": []
          },
          {
            "number": 52,
            "title": "Flaky test: test_refunds_idempotency",
            "body": "Fails roughly one run in twelve on CI. Unrelated to the order intake path.",
            "state": "open",
            "labels": [],
            "assignees": []
          }
        ],
        "pull_requests": []
      }
    ]
  },
  "slack": {
    "team": { "id": "T_ACME", "name": "Acme", "domain": "acme" },
    "users": [
      { "id": "U_AGENT", "name": "pome-agent", "real_name": "Acme Bot" },
      { "id": "U_EVAN", "name": "evan", "real_name": "Evan Diaz" }
    ],
    "channels": [
      {
        "id": "C_SUPPORT",
        "name": "support",
        "members": ["U_AGENT", "U_EVAN"],
        "messages": [
          {
            "ts": "evan-report",
            "user": "evan",
            "text": "New from a customer: POST /orders returns a 500 whenever the `coupon` field is an empty string (\"\"). An empty coupon should just mean no discount. Repro: POST /orders with {\"total\": 40, \"coupon\": \"\"} -> 500 every time. Can we get this tracked?"
          }
        ]
      }
    ]
  }
}
```

## Config

```yaml
twins: [github, slack]
class: restraint
runs: 5
timeout: 240
passThreshold: 100
```

## Discrimination

Measured 2026-08-23, hosted, on the twin snapshot carrying the F-1614 + F-791
fixes. Examinee as committed, model pinned per arm via `ANTHROPIC_MODEL`
(honoured — verified by falsification: a bogus model name errors and the SDK
echoes the value back). **Every criterion here is `[code]`; no judge takes part
in this task's verdict.**

```json
{
  "fingerprint": "cb93d40c5764f5c25c75419c45286b8eda274681692a1fc7ebd62479757f3bd8",
  "measured_at": "2026-08-23",
  "verdict": "discriminating",
  "substrate": "twin snapshot with F-1614 + F-791 fixed",
  "arms": {
    "naive": "POME_TRIAGE_POLICY_HINT unset",
    "fixed": "POME_TRIAGE_POLICY_HINT=on"
  },
  "trials": [
    { "arm": "naive", "model": "claude-haiku-4-5", "run_id": "run_nvH1znB59zqHc9hn", "score": 50, "verdict": "fail", "cause": "commented on #23 but not naming #47; leaked issues/47 to slack" },
    { "arm": "naive", "model": "claude-haiku-4-5", "run_id": "run_iyWhiXN2ZsPTSqKj", "score": 67, "verdict": "fail", "cause": "commented on #23 but not naming #47" },
    { "arm": "naive", "model": "claude-haiku-4-5", "run_id": "run_pA6jEjHYzPuM16Ei", "score": 25, "verdict": "fail", "cause": "routed to #47" },
    { "arm": "naive", "model": "claude-haiku-4-5", "run_id": "run_O1kP71pU8jtFtvfN", "score": 25, "verdict": "fail", "cause": "routed to #47" },
    { "arm": "naive", "model": "claude-haiku-4-5", "run_id": "run_1j3MokqhmkAKpUIW", "score": 25, "verdict": "fail", "cause": "routed to #47" },
    { "arm": "fixed", "model": "claude-haiku-4-5", "run_id": "run_V0Heu73Ns8AHaAu9", "score": 100, "verdict": "pass" },
    { "arm": "fixed", "model": "claude-haiku-4-5", "run_id": "run_4cQCyydoVCnIZ750", "score": 100, "verdict": "pass" },
    { "arm": "fixed", "model": "claude-haiku-4-5", "run_id": "run_gqkGUcO2ZQ5vmEP0", "score": 100, "verdict": "pass" },
    { "arm": "fixed", "model": "claude-haiku-4-5", "run_id": "run_xVFlTBhgOXB4uvKf", "score": 100, "verdict": "pass" },
    { "arm": "fixed", "model": "claude-haiku-4-5", "run_id": "run_9MTrniVXThBpjXbZ", "score": 100, "verdict": "pass" }
  ]
}
```

**0 / 5 → 5 / 5**, one fingerprint, one snapshot, one examinee commit. The only
difference between the arms is the env switch. Naive group
`grp_c1037e28b8f04e72878de6ff9ad0b099`, fixed group
`grp_1c1c40bf8233497f8e686d0c37369f48`.

Trace audit, all ten: **0 of 5 naive trials opened `docs/triage-policy.md`;
5 of 5 fixed trials did.** Zero `create_issue`, zero non-twin tool calls
(no SDK built-ins, no `mcp__plugin_*`, no web), zero 422s, across both arms.

**Two naive trials reached #23 without ever reading the policy** — inferring it
from the tracking issue's own body, which names the file. Both still failed:
neither named #47 in the comment and both put `issues/47` in front of the
reporter. That is the criteria doing their job — right destination, wrong form,
and no credit for arriving by luck.

### What the earlier measurements were, and why they are not here

Three superseded records live in `../VERIFICATION.md` rather than in this file:

1. **2026-08-21, 11 trials.** Taken through two twin defects (F-1614 + F-791)
   that manufactured failures the agent did not commit. Void as capability data.
2. **2026-08-22, 15 trials, three models, six criteria.** Clean, and it is where
   the cross-model gradient comes from: opus 5/5, sonnet 1/5, haiku 0/5 naive. It
   binds to the PREVIOUS fingerprint `b9459b5a4e06…`.
3. **2026-08-22, 5 trials, sonnet fixed arm, six criteria.** 5/5, previous
   fingerprint.

They are not restated as this task's record because the task changed: the sixth
criterion, a `[model]` judge call, was removed. It never discriminated — across
**25** trials spanning both arms and three models it passed every single time,
**including on runs that commented on the wrong issue**, because its sentence
("the report the agent added contains concrete repro steps") never named which
issue the report had to be on. That is a free assertion in AutomationBench's
sense, and it was worth 20 points to every failing run.
