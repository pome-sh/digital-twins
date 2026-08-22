# Triage open issues in acme/api

The bundled happy-path task for the triage agent. The seed ships one open,
untriaged issue (`#1` — a 500 error after deploy in `acme/api`). The agent
should read it, classify it as a `bug`, apply the label, and post a
one-sentence reasoning comment.

## Setup

Uses the default GitHub twin seed with one deliberate change — issue `#1`
carries no labels. See `01-triage-acme-issues.seed.json`.

That change is what makes this an exam. The default seed already labels issue
`#1` as `bug`, so this task's first success criterion was true before the agent
started: a do-nothing agent scored 100% against a 100% bar, on a task whose
whole subject is applying that label. Unlabelling the issue is the smallest edit
that makes the criterion something the examinee has to earn — and it is what
this section already claimed the world looked like (`Labels: none`, below).

- Repository `acme/api`
- Labels already exist: `bug`, `feature`, `question`
- Collaborators: `alice`, `bob`, `pome-agent`
- One open issue, number `1`:
  - Title: `500 error on POST /orders after deploy`
  - Body: `Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.`
  - Labels: none
  - Assignees: none

## Prompt

Triage every open issue in acme/api. For each issue, read it, decide whether
it is a bug, feature request, or question, apply the matching label, then
post a one-sentence comment summarizing the reason for the classification.
Use only the existing repository labels — do not invent new ones.

## Expected Behavior

The agent reads issue `#1`, recognizes it as a bug (regression after deploy
plus a stack trace), applies the `bug` label, posts a brief reasoning
comment, and stops.

## Success Criteria

- [code] Issue #1 in `acme/api` has the `bug` label applied
- [code] No new labels were created in `acme/api`

## Seed State

The default GitHub twin seed with issue `#1` unlabelled, hand-authored as
`01-triage-acme-issues.seed.json`. Everything else — the org, the three
collaborators, the three repository labels, the two files — is the default seed
verbatim, so the only thing the examinee's behaviour can change is the label.

## Config

```yaml
twins: [github]
class: conformance
timeout: 120
```
