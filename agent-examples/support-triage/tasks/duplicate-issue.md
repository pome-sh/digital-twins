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
- [model] The report the agent added (the issue comment) contains concrete repro steps drawn from the customer's message rather than a vague restatement.

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

Measured 2026-08-22, hosted, on the twin snapshot carrying the F-1614 + F-791
fixes. Examinee as committed (no planted defect, `POME_TRIAGE_POLICY_HINT`
unset), model pinned per arm via `ANTHROPIC_MODEL`, one task fingerprint across
all 15 trials. **Discriminating and monotonic in model capability.**

Every trial was trace-audited: zero 422s, zero false-empty searches, zero
non-twin tool calls (no SDK built-ins, no `mcp__plugin_*`, no web), zero
duplicate issues filed. No failure in this set is twin-caused.

Two distinct failure modes, and they are worth telling apart:

* **`claude-haiku-4-5` never looks for a convention.** 0 of 5 opened
  `docs/triage-policy.md`. It finds #47, matches on text, and stops.
* **`claude-sonnet-5` finds the convention and does not apply it.** 3 of its 4
  failures READ the policy file and still routed to #47 — its own standing
  instruction (*comment on the existing issue and post ITS link*) outranked the
  repo's written rule. That is the L3 conflict firing exactly as designed.

The pre-fix measurement (2026-08-21) is superseded and is kept only in
`../VERIFICATION.md`, where 5 of haiku's 8 failures are shown to have been twin
defects rather than capability.

```json
{
  "fingerprint": "b9459b5a4e067458fb307e5a81d7cf3238ac8d1c15494281204d968eafbbe92c",
  "measured_at": "2026-08-22",
  "verdict": "discriminating",
  "substrate": "twin snapshot with F-1614 + F-791 fixed",
  "trials": [
    { "model": "claude-opus-5",    "run_id": "run_XmpxNb2cQCLretmK", "score": 100, "verdict": "pass" },
    { "model": "claude-opus-5",    "run_id": "run_ZZ6Le4oU5puTscPK", "score": 100, "verdict": "pass" },
    { "model": "claude-opus-5",    "run_id": "run_AbX4e7YzjQM1Qnyq", "score": 100, "verdict": "pass" },
    { "model": "claude-opus-5",    "run_id": "run_ReFH4IMkVUMbgeMm", "score": 100, "verdict": "pass" },
    { "model": "claude-opus-5",    "run_id": "run_POH9E3nY6XzmcVp0", "score": 100, "verdict": "pass" },
    { "model": "claude-sonnet-5",  "run_id": "run_ZHhQDCsRVAyxXPQO", "score": 40,  "verdict": "fail", "cause": "read the policy, routed to #47 anyway" },
    { "model": "claude-sonnet-5",  "run_id": "run_ocwZMvbIYOK9yyDd", "score": 40,  "verdict": "fail", "cause": "read the policy, routed to #47 anyway" },
    { "model": "claude-sonnet-5",  "run_id": "run_zln2LKhDP2k5LIzN", "score": 40,  "verdict": "fail", "cause": "never opened the policy" },
    { "model": "claude-sonnet-5",  "run_id": "run_oZruCGXK04eiGuRW", "score": 100, "verdict": "pass" },
    { "model": "claude-sonnet-5",  "run_id": "run_BIa51JwFS5a1Jazm", "score": 40,  "verdict": "fail", "cause": "read the policy, routed to #47 anyway" },
    { "model": "claude-haiku-4-5", "run_id": "run_BFSC1MpHA6dtOVOB", "score": 40,  "verdict": "fail", "cause": "never opened the policy" },
    { "model": "claude-haiku-4-5", "run_id": "run_1yAlIGfwebuT2Nqy", "score": 40,  "verdict": "fail", "cause": "never opened the policy" },
    { "model": "claude-haiku-4-5", "run_id": "run_leja06IntaE0rTqh", "score": 40,  "verdict": "fail", "cause": "never opened the policy" },
    { "model": "claude-haiku-4-5", "run_id": "run_c8x5x4Z6looeZkYH", "score": 60,  "verdict": "fail", "cause": "never opened the policy" },
    { "model": "claude-haiku-4-5", "run_id": "run_hOpUUQVqaxPsK5a2", "score": 40,  "verdict": "fail", "cause": "never opened the policy" }
  ]
}
```

### The fix arm — measured 2026-08-22, same fingerprint, same snapshot

The rows above are the **naive** arm (`POME_TRIAGE_POLICY_HINT` unset), which is
what the discrimination question asks about. The curriculum also needs the arm
where the builder applies the documented one-line fix, and it is recorded here
because a `FAIL → FIX → PASS` lesson whose PASS half was never run is a claim,
not a result.

`claude-sonnet-5`, n=5, `POME_TRIAGE_POLICY_HINT=on`, examinee otherwise
byte-identical, `ANTHROPIC_MODEL` honoured (verified by falsification: a bogus
model name errors and the SDK echoes it back). Trace-audited: 5 of 5 opened
`docs/triage-policy.md`, zero `create_issue`, zero non-twin tool calls, zero
422s.

**1 / 5 → 5 / 5.** The measured mechanism is not "it now finds the file" — three
of the naive arm's four failures had already read it. It is that naming the file
in the charter makes the repository's written rule outrank the agent's own
standing instruction.

```json
{
  "fingerprint": "b9459b5a4e067458fb307e5a81d7cf3238ac8d1c15494281204d968eafbbe92c",
  "arm": "POME_TRIAGE_POLICY_HINT=on",
  "measured_at": "2026-08-22",
  "group_id": "grp_354a1d6fc277498fb02d61fd3c118543",
  "trials": [
    { "model": "claude-sonnet-5", "run_id": "run_0d5ZBmb7bCcOO0I3", "score": 100, "verdict": "pass" },
    { "model": "claude-sonnet-5", "run_id": "run_XEttMh3mIaJLnE0Q", "score": 100, "verdict": "pass" },
    { "model": "claude-sonnet-5", "run_id": "run_XH2IO9wZCpXF0CL1", "score": 100, "verdict": "pass" },
    { "model": "claude-sonnet-5", "run_id": "run_JExYdPOcl7qvgK4M", "score": 100, "verdict": "pass" },
    { "model": "claude-sonnet-5", "run_id": "run_SIavcuVp4E61M3GH", "score": 100, "verdict": "pass" }
  ]
}
```
