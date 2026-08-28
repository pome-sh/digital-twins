# Pome CLI

The `pome` command runs AI-agent tasks against resettable digital twins of
real SaaS APIs (GitHub, Stripe, …), captures the trace, and gets a verdict from
Pome cloud.

The CLI is **capture-only**: it records raw traces and never scores, judges, or
correlates locally. A verdict comes only from the cloud — a hosted `pome run`
prints it to the terminal and records it to the dashboard, and
`pome eval <run-dir>` uploads a captured trace for a cloud verdict.

**📚 Full documentation lives at [docs.pome.sh](https://docs.pome.sh).**
Run `pome --help` (or `pome help <command>`) for the CLI reference, and
`pome docs getting-started` to print the quickstart's URL.

## Install

```bash
npm install -g @pome-sh/cli
pome --help
```

Or run it without installing: `npx @pome-sh/cli <command>` — e.g.
`npx @pome-sh/cli twin start github` boots a local GitHub twin with nothing
but Node ≥ 24.

Gmail is first-party too:

```bash
npx @pome-sh/cli twin start gmail --port 3336
# prints POME_GMAIL_REST_URL, POME_GMAIL_MCP_URL, and POME_GMAIL_TOKEN
pome tasks gmail --copy
```

`POME_GMAIL_TOKEN` is the same Pome session JWT as `POME_AUTH_TOKEN`; it is not
a Google OAuth token. Hosted Gmail availability is gated separately from the
local/OSS package release.

## Quickstart

```bash
pome login                       # one-time; opens the dashboard to sign in
pome init                        # scaffolds tasks/, examples/agents/, runs/, pome.json
pome register agent my-agent     # scopes runs to this project
pome run tasks/01-bug-happy-path.md --agent "node examples/agents/scripted-triage-agent.ts"
pome inspect latest              # trace/audit view of the last run
```

To capture a trace without the cloud (self-host), then get a verdict later:

```bash
pome run --local tasks/01-bug-happy-path.md   # captures a raw trace only, no verdict
pome eval runs/01-bug-happy-path/<run-id>         # uploads it for a cloud verdict
```

See [docs.pome.sh](https://docs.pome.sh) for the task library, authentication,
the Stripe/Slack twins, and everything else.

## CI one-shot — the exit-code contract

`pome run <task>` is the CI one-shot: one hosted, scored run, and its **exit
code is the verdict**. Gate CI on it directly.

| Exit code | Meaning |
| --- | --- |
| `0` | pass (hosted/scored run), or trace captured (`--local`, not scored) |
| `1` | ran and scored **below** the pass threshold, **or ran `INCOMPLETE`** |
| `2` | twin / orchestration error (network, 5xx, twin spawn failed) |
| `3` | auth error (401/403) — `pome login` again, or set `POME_API_KEY` in CI |
| `4` | quota exceeded (402/429) |
| `5` | usage error (bad flags, missing task file) |

Three rules CI must honor:

- **`--local` is not a verdict.** A `--local` run captures a raw trace and never
  scores, so its exit `0` means "trace captured," not "passed." Never gate CI on
  a `--local` exit code — score it later with `pome eval <run-dir>`.
- **`INCOMPLETE` shares exit `1`, and it is not the agent's failure.** A run
  whose criteria could not all be graded exits `1` rather than mapping its
  partial score to a code — a run whose checks never ran is not a green CI
  signal. The cost is stated rather than hidden: **`1` cannot tell "the agent
  regressed" from "we could not grade it."** To separate them programmatically,
  do not compare `score` against `pass_threshold` yourself — a run with a third
  of its criteria unevaluated can still read `score: 100, pass_threshold: 100`
  with nothing in those two fields alone saying so. Read `state` in the
  `verdict.json` a hosted `pome run` writes to
  `<artifacts-dir>/<task-slug>/<session-id>/verdict.json`: `"pass"`, `"fail"`,
  or `"incomplete"` — the same word the terminal prints beside the score, and
  the field to gate on. The `evaluated` / `not_evaluated` / `pre_satisfied` /
  `total` counts alongside it say how much of the task `score` covers:
  **`score` is a percentage over `evaluated` alone**, so `not_evaluated > 0`
  means `score` is silent about part of the run, and `evaluated: 0` means it
  scored nothing at all (the cloud sends `0` there for want of a denominator
  — "nothing was scored", not "nothing was correct").
- **Trial groups map as a whole.** `pome run -n k` (k>1) collapses the whole
  group to one code: `0` = at least one trial completed and every completed
  trial passed; `1` = at least one completed trial failed its threshold **or was
  incomplete**; `2` = no trial completed. Errored and incomplete trials are
  excluded from the verdict fraction (`3 of 4 passed · 1 incomplete`) so neither
  is counted as a pass nor charged to the agent as a loss — but a group holding
  one cannot exit `0`.
- **`pome fix-prompt` uses the same codes, and its `1` is only ever
  INCOMPLETE.** Building a prompt for a failed run set exits `0` (the prompt is
  on stdout, and stdout being non-empty is the signal that there was something
  to fix); an all-green root exits `0` with nothing on stdout; a bad argument or
  a root with no readable run sets exits `5`. `1` is reserved for the one case
  where the newest non-passing set was never fully graded: no prompt is built,
  because a run whose checks never ran is not evidence of an agent defect. This
  matches `pome run`, where `1` also covers INCOMPLETE — the two commands do not
  disagree about what an ungraded run exits, and `verdict.json`'s `state` stays
  the field to read when a script needs the reason rather than the code.

## Development

```bash
npm install
npm run typecheck
npm run build
npx vitest run --project cli
```

The package publishes the `pome` binary from `dist/src/cli/main.js`.

### Versioning — every behavior change ships with a release, and you do not write the number

Add the user-facing entry to `CHANGELOG.md` under an `## Unreleased (patch)` (or
`(minor)`) heading, above the newest released one, and leave `version` in
`cli/package.json` alone — a PR that moves it fails CI. Merging to `main` is the
release trigger: `.github/workflows/allocate-version.yml` allocates the number
there, rewriting that heading and the manifest in one commit, and
`.github/workflows/release.yml` compares the local version against npm and
publishes when they differ. `pome --version` reports the allocated value from a
build-time constant, so a user can always tell whether their install carries a
given fix.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
