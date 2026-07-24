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
`pome docs getting-started` to open the canonical quickstart.

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
pome scenarios gmail --copy
```

`POME_GMAIL_TOKEN` is the same Pome session JWT as `POME_AUTH_TOKEN`; it is not
a Google OAuth token. Hosted Gmail availability is gated separately from the
local/OSS package release.

## Quickstart

```bash
pome login                       # one-time; opens the dashboard to sign in
pome init                        # scaffolds scenarios/, examples/agents/, runs/, pome.config.json
pome register agent my-agent     # scopes runs to this project
pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
pome inspect latest              # trace/audit view of the last run
```

To capture a trace without the cloud (self-host), then get a verdict later:

```bash
pome run --local scenarios/01-bug-happy-path.md   # captures a raw trace only — no verdict
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
| `1` | ran and scored **below** the pass threshold |
| `2` | twin / orchestration error (network, 5xx, twin spawn failed) |
| `3` | auth error (401/403) — `pome login` again, or set `POME_API_KEY` in CI |
| `4` | quota exceeded (402/429) |
| `5` | usage error (bad flags, missing task file) |

Two rules CI must honor:

- **`--local` is not a verdict.** A `--local` run captures a raw trace and never
  scores, so its exit `0` means "trace captured," not "passed." Never gate CI on
  a `--local` exit code — score it later with `pome eval <run-dir>`.
- **Trial groups map as a whole.** `pome run -n k` (k>1) collapses the whole
  group to one code: `0` = at least one trial completed and every completed
  trial passed; `1` = at least one completed trial failed its threshold; `2` =
  no trial completed. Errored trials are excluded from the verdict fraction and
  never drag a passing group below `0` on their own.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

The package publishes the `pome` binary from `dist/src/cli/main.js`.

### Versioning — every behavior change ships with a bump

Any PR that touches `cli/src/**` must either add a changeset under
`cli/.changeset/` or bump `cli/package.json` directly; CI enforces this
via [`scripts/check-cli-version-bump.sh`](../scripts/check-cli-version-bump.sh).
Preferred path: `cd cli && npm run changeset`.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
