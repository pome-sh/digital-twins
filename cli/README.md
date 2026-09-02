# Pome CLI

The `pome` CLI runs AI-agent tasks against resettable digital twins of real SaaS APIs.
It records each run and sends hosted runs to Pome for evaluation.

The CLI does not score locally.

- `pome run` uses the hosted workflow by default. It records the run and prints the hosted verdict.
- `pome run --local` uses local twins. It records one trace and does not request a verdict.
- `pome eval` uploads existing local artifacts and prints the hosted verdict.

See [docs.pome.sh](https://docs.pome.sh) for the full documentation.
Use `pome --help` or `pome help <command>` for command details.

## Requirements

- Node.js 24 or later
- A Pome account and API key for hosted runs and evaluations
- A supported model-provider credential when the agent calls a model provider

Local twin commands do not require a Pome account.

## Install

Install the CLI globally:

```bash
npm install -g @pome-sh/cli
pome --help
```

You can also run one command without a global installation:

```bash
npx @pome-sh/cli twin start github
```

## Set Up A Project

Create the starter project in an empty directory:

```bash
mkdir pome-example
cd pome-example
pome init
pome login
pome register agent my-agent
pome run tasks/01-bug-happy-path.md
```

`pome init` writes `pome.json`, starter tasks, and an example agent in an empty directory.
In an existing project, it writes only the manifest unless you use `--starter`.

Set `command` in `pome.json`, or pass `--agent <command>` to `pome run`.

## Hosted Workflow

Hosted execution is the default for `pome run`.
The command creates hosted sandboxes, runs the agent, uploads the artifacts, and prints the verdict.

```bash
pome login
pome run tasks/01-bug-happy-path.md
pome inspect latest
```

Use `POME_API_KEY` instead of `pome login` in CI.
Use `-n <count>` to run a hosted trial group of 1 to 20 trials.
The task `runs` field supplies the count when you omit `-n`.

## Local Capture And Hosted Evaluation

Use `--local` to run one task against in-process twins.
This command records artifacts but never scores them.

```bash
pome run --local tasks/01-bug-happy-path.md
pome inspect latest
pome eval
```

`pome eval` uses `<artifacts-dir>/latest.json` when you omit the run directory.
You can also give the directory explicitly:

```bash
pome eval runs/01-bug-happy-path/<run-id>
```

`pome eval` uploads the trace to Pome and prints the hosted verdict.
It does not add a local score.

Do not combine `--local` with `-n`.
Local capture always runs one trial.

## Standalone Twins

Start a long-running local twin:

```bash
pome twin start gmail --port 3336
```

The command prints the REST URL, MCP URL, and bearer token.
For Gmail, `POME_GMAIL_TOKEN` is the same Pome session JWT as `POME_AUTH_TOKEN`.
It is not a Google OAuth token.

Create a seed file, then use it to start a twin:

```bash
pome twin new-seed github --out seed.json
pome twin start github --seed seed.json
```

A supplied seed replaces the default seed.
It does not merge with the default seed.

## Commands

| Command | Purpose |
| --- | --- |
| `pome init` | Write `pome.json` and, when applicable, starter files. |
| `pome login` | Sign in and store a hosted API key. |
| `pome logout` | Remove locally stored hosted credentials. |
| `pome docs [topic]` | Print or select a documentation URL. |
| `pome tasks [twin]` | List or copy bundled tasks. |
| `pome checks [twin]` | List the checks that can grade `[code]` criteria. |
| `pome checks add <file>` | Add one declared `[code]` criterion to a task. |
| `pome checks lint <file...>` | Report `[code]` criteria that do not bind to declared checks. |
| `pome compile-seeds [target]` | Compile prose seed state to `.seed.json` files with Claude. |
| `pome register agent <name>` | Register an agent and write its slug to `pome.json`. |
| `pome sandbox create` | Create a hosted sandbox. |
| `pome sandbox list` | List hosted sandboxes. |
| `pome sandbox stop <session-id>` | Stop a hosted sandbox. |
| `pome run [path]` | Run one task or all task files in a directory. Hosted is the default. |
| `pome doctor` | Check the manifest, twin routing, and egress controls. |
| `pome eval [run-dir]` | Upload recorded artifacts and request a hosted verdict. |
| `pome inspect <run>` | Print a trace and audit report. |
| `pome fix-prompt [target]` | Build a repair prompt from recorded traces and hosted verdicts. |
| `pome twin start [name]` | Start a standalone local twin. |
| `pome twin new-seed <name...>` | Print or write a starter seed file. |
| `pome twin status` | Check the last standalone twin and print its connection values. |
| `pome capture-server` | Run the internal model-call capture proxy. |

Use `pome <command> --help` before you use advanced options.

## Environment Variables

Global hosted configuration:

| Variable | Purpose |
| --- | --- |
| `POME_API_KEY` | Authenticate hosted commands. This value takes precedence over stored credentials. |
| `POME_API_URL` | Set the control-plane URL. `--api-url` takes precedence. |
| `POME_DASHBOARD_URL` | Set the dashboard URL for login and result links. |

Agent process configuration:

| Variable | Purpose |
| --- | --- |
| `POME_AGENT_ENV_ALLOWLIST` | Add comma-separated parent variable names to the agent process. |
| `POME_EGRESS_ALLOW` | Add comma-separated host patterns to the capture proxy allowlist. |
| `POME_INHERIT_AGENT_ENV=1` | Pass the full parent environment to the agent. Use this only with trusted agents. |
| `POME_TRUST_AGENT_COMMAND=1` | Run the agent command through a shell. Use this only with trusted commands. |

The CLI passes these provider variables to the agent by default when they are set:

- `AI_GATEWAY_API_KEY`
- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `GOOGLE_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

`pome compile-seeds` requires `ANTHROPIC_API_KEY`.

Standalone twin configuration:

| Variable | Purpose |
| --- | --- |
| `PORT` | Set the listen port for `pome twin start`. `--port` takes precedence. |
| `POME_SEED_JSON` | Supply seed JSON. `--seed` takes precedence. |
| `TWIN_AUTH_SECRET` | Supply the secret that signs local session JWTs. |
| `POME_TWIN_DATA_DIR` | Set the directory for the persisted twin secret. |

The twin entry points also accept their provider-specific host, port, database, and no-seed variables.
See [`CONTRACT.md`](../CONTRACT.md) for that runtime interface.

## Artifacts

The default artifact root is `runs/`.
Use the global `--artifacts-dir <dir>` option to select another root.

Each completed run uses this directory format:

```text
<artifacts-dir>/<task-slug>/<run-id>/
```

The six core files are:

| File | Content |
| --- | --- |
| `meta.json` | Run identity, times, agent exit, twins, and format versions. |
| `events.jsonl` | Redacted twin, model, and adapter events. |
| `state_initial.json` | Initial state for the primary twin. |
| `state_final.json` | Final state for the primary twin. |
| `stdout.txt` | Redacted agent standard output. |
| `stderr.log` | Redacted agent standard error. |

A run can also contain these files:

| File | Condition |
| --- | --- |
| `signals.jsonl` | The runner creates this adapter-event sidecar. |
| `egress.jsonl` | The capture proxy records refused connections here. |
| `state_final.<twin>.json` | A multi-twin run records each additional final state. |
| `verdict.json` | A hosted `pome run` caches the hosted verdict for `pome fix-prompt`. |
| `eval-session.json` | `pome eval` records the hosted evaluation session for safe reuse. |

The artifact root also contains `latest.json`.
It points to the most recent run directory.

The CLI never writes `score.json`.
A hosted verdict comes from Pome.

## Exit Codes

### Hosted `pome run` And `pome eval`

| Code | Meaning |
| --- | --- |
| `0` | The hosted verdict is `pass`. |
| `1` | The hosted verdict is `fail` or `incomplete`. |
| `2` | A twin, missing agent command, network, or orchestration error prevented a verdict. |
| `3` | Authentication failed. |
| `4` | The account exceeded a quota. |
| `5` | The command input or task configuration is invalid. |

For `pome run`, the task supplies the pass threshold.
For `pome eval`, the pass threshold is `100`.

For a hosted `pome run`, read `state` in `verdict.json` to distinguish `fail` from `incomplete`.
The possible values are `"pass"`, `"fail"`, and `"incomplete"`.

The `evaluated`, `not_evaluated`, `pre_satisfied`, and `total` fields describe grading coverage.
`score` is a percentage over `evaluated` criteria only.
Thus, `not_evaluated > 0` means that the score does not cover the complete task.

### Hosted Trial Groups

`pome run -n k` returns one code for the group when `k` is greater than `1`.

| Code | Meaning |
| --- | --- |
| `0` | At least one trial completed and every completed trial passed. |
| `1` | At least one completed trial failed or was incomplete. |
| `2` | No trial completed. |

Errored trials do not enter the verdict fraction.
An incomplete trial also prevents exit `0`.

### Local `pome run --local`

| Code | Meaning |
| --- | --- |
| `0` | The agent completed and the CLI recorded the trace. This code is not a verdict. |
| `2` | A local twin, missing agent command, or runner error prevented capture. |
| `3` | The agent failed, timed out, or failed its preflight. |
| `5` | The command input or task configuration is invalid. |

Do not use a local exit `0` as a CI quality gate.
Run `pome eval <run-dir>` to request a verdict.

### `pome fix-prompt`

- Exit `0` means that the command succeeded. Standard output can be empty when all run sets passed.
- Exit `1` means that the newest non-passing set is incomplete.
- Exit `5` means that the target or arguments are invalid.

## Contribute

Run these commands from the repository root:

```bash
npm install
npm run build
npm run typecheck
npx vitest run --project cli
```

Use `npm run test:contract` for the packaged twin runtime contract.
Run `node --test contract/cli-start.test.mjs` after you build the CLI front door.

The package publishes `pome` from `cli/dist/src/cli/main.js`.

## License

Apache-2.0. See [`LICENSE`](../LICENSE).
