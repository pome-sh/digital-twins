# Launcher — REST examinee (Skill 4 reference)

The runtime-specific seam for a **non-managed** examinee
(`examinee_launch.transport: "rest"`): a self-hosted agent process that talks to
the twins over plain REST instead of MCP. This is the path Gagan's
`minimal-viktor` took (scored 100/100 pre-A3). Same contract, no `ant`, no vault.
Assemble from the spec, run the process on the kickoff task, watch for idle, then
return to SKILL.md §3 to `finalize_run` while the twin session is live.

The spec still owns policy — you execute it. Field names are verbatim from
`examinee_launch`.

## 0. Preflight the wiring (before you launch)

A REST examinee is a repo you run yourself, so its wiring is yours to get right:
if the process reaches a real API instead of the twin, the run is silently
worthless — it tested nothing and may have touched production. Validate the
wiring **before** you start the process, the same four checks `pome doctor`
runs, **in order, stopping at the first failure** with one named cause + one
fix. There is no `--force`: a red check means do not launch.

1. **config** — the examinee repo has a valid `pome.json` manifest with a real
   `agent.command` (not the scaffold default).
2. **twin reachable** — the twin the task needs is up and answering:
   `examinee_launch.rest_urls[<twin>]` (and the bearer-authed session route)
   respond, not a connection refusal.
3. **routing** — the process reads its twin base URL from the injected env /
   `rest_urls`, and **no production-host literal survives in agent source** —
   even a `?? "https://api.github.com"` fallback is a twin bypass. (Loopback
   fallbacks like `http://127.0.0.1:3333` are fine.) For a Claude Agent SDK
   examinee this also means `withPome()` runs once at startup and `query`/`tool`
   come from `@pome-sh/adapter-claude-sdk`; for other stacks the trace comes
   from the twin side and routing is env alone.
4. **egress floor** — deny-by-default egress is intact: `POME_EGRESS_ALLOW`
   carries the twin patterns + loopback and **no `*` wildcard**. Never widen
   egress to make a check pass.

If the examinee repo has the pome CLI installed, just run `pome doctor` in it —
it executes exactly these checks and exits non-zero on the first failure, with
the cause (`file:line` where knowable) and the fix. Otherwise reason through the
four above. Only once the wiring is green do you map the spec and launch.

## Map the spec into the process

| `examinee_launch` field | Becomes, for the REST examinee |
| --- | --- |
| `rest_urls` `{ <twin>: <url> }` | the base URL the process calls per twin (`<twinsBase>/<twin>/s/<sid>`) — the github twin speaks GitHub-REST shapes, the slack twin Slack-Web method names with **no `/api` prefix** |
| `env.POME_GITHUB_REST_URL` / `env.POME_SLACK_REST_URL` | the same per-twin bases as environment variables, if the process reads config from env |
| `env.POME_AUTH_TOKEN` (= `agent_token`) | the bearer for every twin call — `Authorization: Bearer <token>`. **SENSITIVE**: inject it into the process env for this run only, never write it to a file or bake it into the agent |
| `network` clamp / closed-book (D10) | you own egress here — give the process **no** `web_search` / `web_fetch` and no general internet; it should reach only the twin URLs, matching the seeded world |
| `initial_events` | feed them to the process verbatim if it is an ambient/deployment-kickoff agent |

There is no `mcp_permission_policy` concern on this path — REST has no
tool-confirmation handshake, so the F-787 deadlock does not apply.

## Run and detect idle

1. Point the process's twin/tool endpoints at `rest_urls` (or inject the `env`
   vars), with `POME_AUTH_TOKEN` as the bearer.
2. Start it on the kickoff task = `examinee_task.prompt` (plus `initial_events`
   if applicable).
3. **Idle** = the process has finished the task and stopped calling the twins
   (it exits, or blocks with no further requests). Detection is process-level:
   watch the process, or the twin request stream going quiet.
4. The instant it idles, go to **SKILL.md §3**: `finalize_run(session_id,
   agent_token)` on the Pome `session_id`, while the twin sandbox is still up.
   Do not shut the twins down first — a late finalize loses the tape.
