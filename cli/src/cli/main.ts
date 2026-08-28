#!/usr/bin/env node
// file-size: the whole CLI command surface — 31 `.command()` registrations plus their
// options, in one file so `pome --help` and this module list the same commands in the
// same order. Splitting per command moves a registration away from its siblings, which
// is how two commands end up disagreeing about a shared flag's name or default.
// SPDX-License-Identifier: Apache-2.0
import { Command } from "commander";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLatestRun,
  readMetaSummary,
} from "../recorder/artifacts.js";
import {
  computeTraceHealth,
  readEventsJsonl,
  renderEvents,
  renderTraceHealth,
} from "../recorder/inspect.js";
import { runTask } from "../runner/runTask.js";
import { runTaskHosted } from "../runner/runTaskHosted.js";
import { effectiveTrialCount, parseTrialsFlag } from "../runner/trialCount.js";
import { outcomeOf, runScoreLine, scoreStatus } from "../hosted/evalResultView.js";
import { HostedUsageError, exitCodeFor } from "../hosted/errors.js";
import { resolveCredentials, clearLocalCredentials } from "./credentials.js";
import { loginWithClerk } from "./login.js";
import { runDocsCommand } from "./docs.js";
import { runCompileSeeds } from "./compile-seeds.js";
import { runTasksCommand } from "./tasks.js";
import { runChecksCommand } from "./checks.js";
import { runChecksAddCommand } from "./checks-add.js";
import { runChecksLintCommand } from "./checks-lint.js";
import { runEvalCommand } from "./eval.js";
import {
  copyAnnounceLine,
  ensureDefaultTask,
  runYoursFrameLines,
  trialsPinFallbackLine,
  type DefaultTaskResolution,
} from "./default-task.js";
import {
  findTwin,
  runnableTasks,
} from "./tasks-catalog.js";
import {
  friendlyHostedError,
  runSessionCreate,
  runSessionList,
  runSessionStop,
  SESSION_TWIN_NAMES,
  type SessionListStateFilter,
} from "./session.js";
import { normalizeRegisterTwins, runRegisterAgent } from "./register.js";
import { resolvePackageRoot } from "./resolve-package-root.js";
import {
  ClaudeManagedDeferredError,
  writeSdkScaffold,
} from "./init-sdk.js";
import {
  DEFAULT_CONTROL_PLANE_URL,
  DEFAULT_DASHBOARD_URL,
} from "./defaults.js";
import { deriveAgentSlug } from "../contract/index.js";
import {
  MANIFEST_JSON,
  readManifest,
  writeManifest,
} from "./project-config.js";
import { createGitHubSmokeApp, isTwinName, TWIN_NAME_LIST } from "../twin/registry.js";
import {
  buildFixPrompt,
  buildGroupFixPrompt,
  type TrialFixInput,
} from "../fix-prompt/index.js";
import {
  discoverRunSet,
  VERDICT_ARTIFACT_VERSION,
} from "../hosted/evalResultCache.js";
import { loadTrialEvents } from "../hosted/trialEvents.js";
import type { Task } from "../task/taskSchema.js";
import { parseTaskFile } from "../task/parseTask.js";
import type { RecorderEvent } from "../types/shared.js";

const PACKAGE_VERSION = readPackageVersion();
const SESSION_CREATE_FORMATS = new Set(["text", "json", "env"]);
const DEFAULT_AGENT_FILE = "examples/agents/scripted-triage-agent.ts";
// `node` (not `npx tsx`): Node ≥ 24 strips this file's type annotations
// natively, so the scaffolded zero-install quickstart never has to resolve a
// package over the network. `npx tsx` used to be the default, but `pome run`
// pipes the agent's traffic through the egress-floor proxy (deny-by-default,
// twin hosts + LLM providers + loopback only) — so on a machine that has
// never run `npx tsx` before, npx's own registry lookup for tsx gets refused
// by that same floor, the scaffolded agent silently never starts, and the
// documented `pome init && pome run --local tasks/01-bug-happy-path.md`
// quickstart ends in an empty trace ("twin runtime emitted no HTTP events")
// with no error pointing at the real cause.
const DEFAULT_AGENT_COMMAND = `node ${DEFAULT_AGENT_FILE}`;
const MANIFEST_SCHEMA_URL = "https://pome.sh/schemas/v1/pome.json";
// Cap on how many unreadable verdict.json paths `fix-prompt`
// discovery names individually, same "kept first N" convention as
// `fix-prompt/prompt.ts`'s MAX_EVENTS trim.
const MAX_UNREADABLE_PATHS_SHOWN = 5;

// Injected by tsup (`define: { PKG_VERSION }`) so the bundled CLI never has to
// locate its own package.json at runtime. Undeclared under `tsx src/cli/main.ts`,
// where the filesystem fallback below still applies.
declare const PKG_VERSION: string | undefined;

function readPackageVersion(): string {
  if (typeof PKG_VERSION === "string" && PKG_VERSION.length > 0) return PKG_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "..", "..", "package.json"),
      resolve(here, "..", "..", "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf8");
        const j = JSON.parse(raw) as { version?: string };
        if (typeof j.version === "string") return j.version;
      }
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

export function createProgram() {
  const program = new Command();

  program
    .name("pome")
    .description(
      "Test AI agents against digital twins of real SaaS APIs. Runs are recorded to app.pome.sh. Start with `pome demo`.",
    )
    .version(PACKAGE_VERSION)
    .showHelpAfterError("(add --help for usage)");

  program
    .command("init")
    .summary("Set up Pome in this project")
    .description("Create pome.json, plus starter files in a new project")
    .option(
      "--sdk <name>",
      "Scaffold for a specific agent SDK (claude | claude-managed). Adds the SDK-specific example file and pre-fills agent.framework so the dashboard badges runs correctly.",
    )
    .option(
      "--bare",
      "Write only the manifest — skip the starter task library and sample agents. Auto-selected when the current directory already has a package.json (the bring-your-own-agent case).",
    )
    .option(
      "--starter",
      "Force the full starter library even in an existing project.",
    )
    .action(async (opts: { sdk?: string; bare?: boolean; starter?: boolean }) => {
      const sdk = opts.sdk?.trim();
      if (
        sdk !== undefined &&
        sdk !== "claude" &&
        sdk !== "claude-managed"
      ) {
        console.error(
          `Unknown --sdk value "${opts.sdk}". Supported: claude, claude-managed.`,
        );
        process.exitCode = 2;
        return;
      }
      if (sdk === "claude-managed") {
        console.error(new ClaudeManagedDeferredError().message);
        process.exitCode = 2;
        return;
      }
      if (opts.bare && opts.starter) {
        console.error("Pass at most one of --bare / --starter.");
        process.exitCode = 2;
        return;
      }

      // A directory that already has a package.json is the "bring your
      // own agent" case: scaffold only the manifest, never the starter library
      // (a 2026-07-24 cold walk dumped 28 untracked files into a real project).
      // --starter / --bare override the auto-decision in either direction.
      const looksLikeExistingProject = existsSync(
        join(process.cwd(), "package.json"),
      );
      const bare = opts.starter
        ? false
        : Boolean(opts.bare) || looksLikeExistingProject;

      if (!bare) {
        await mkdir("tasks", { recursive: true });
        await mkdir("examples/agents", { recursive: true });
        await mkdir("runs", { recursive: true });
        await copyStarterFiles();
      }

      // Bare mode omits `command`: the BYO user launches their own agent, so a
      // default pointer at an unscaffolded examples/agents/... file would be a
      // broken instruction. --sdk still writes a real file and sets command.
      let command: string | undefined = bare ? undefined : DEFAULT_AGENT_COMMAND;
      let framework: string | undefined;
      let postInitMessage = bare
        ? "Pome initialized (existing project — starter library skipped).\n" +
          "Next steps:\n" +
          '  1. Set "command" in pome.json to your agent\'s launch command\n' +
          "  2. pome login                    # one-time, opens the dashboard to sign in\n" +
          "  3. pome register agent <name>    # scopes runs to this project (writes agent.slug to pome.json)\n" +
          "  4. pome run <your-task>.md\n" +
          "\n" +
          "Optional follow-ups:\n" +
          "  - pome tasks github --copy       # drop the starter task library into tasks/\n" +
          "  - pome init --sdk claude         # scaffold a Claude Agent SDK starter\n" +
          "\n" +
          "See `pome docs getting-started` for a narrative walkthrough."
        : "Pome initialized.\n" +
          "Next steps:\n" +
          "  1. pome login                    # one-time, opens the dashboard to sign in\n" +
          "  2. pome register agent <name>    # scopes runs to this project (writes agent.slug to pome.json)\n" +
          "  3. pome run tasks/01-bug-happy-path.md\n" +
          "\n" +
          "Optional follow-ups:\n" +
          "  - pome init --sdk claude         # scaffold a Claude Agent SDK starter\n" +
          "  - pome tasks stripe --copy       # add Stripe payment tasks when needed\n" +
          "\n" +
          "See `pome docs getting-started` for a narrative walkthrough.";

      if (sdk) {
        const scaffold = await writeSdkScaffold(sdk);
        command = scaffold.agentCommand;
        framework = scaffold.agentSdkValue;
        postInitMessage =
          `Pome initialized with --sdk ${sdk}. Scaffolded ${scaffold.exampleAgentRelativePath}.\n` +
          scaffold.postInstallHint;
      }

      // Point the manifest at an existing task directory so bare `pome run`
      // resolves it. The starter path always creates tasks/; bare mode
      // only claims it when the user already keeps their tasks there.
      const tasksDir =
        !bare || (await hasMarkdownTasks("tasks")) ? "tasks" : undefined;

      // The manifest requires `agent.slug`. `pome init` runs before
      // `pome register`, so seed a portable slug derived from the directory
      // name; register later overwrites it with the server-canonical slug.
      const existing = await readManifest(process.cwd());
      if (!existing) {
        const slug = deriveAgentSlug(basename(process.cwd())) || "my-agent";
        const agent: Record<string, unknown> = { slug };
        if (framework) agent.framework = framework;
        const manifest: Record<string, unknown> = {
          $schema: MANIFEST_SCHEMA_URL,
          agent,
        };
        if (command) manifest.command = command;
        if (tasksDir) manifest.tasks = tasksDir;
        manifest.artifacts_dir = "runs";
        manifest.pass_threshold = 100;
        await writeManifest(join(process.cwd(), MANIFEST_JSON), "json", manifest);
      } else if (sdk) {
        const priorAgent =
          typeof existing.raw.agent === "object" && existing.raw.agent !== null
            ? (existing.raw.agent as Record<string, unknown>)
            : {};
        const nextAgent = { ...priorAgent };
        if (framework) nextAgent.framework = framework;
        await writeManifest(existing.path, existing.format, {
          ...existing.raw,
          agent: nextAgent,
          command,
        });
      }
      console.error(postInitMessage);
    });

  program
    .command("login")
    .summary("Sign in and save an API key")
    .description("Sign in with Clerk and store a hosted team API key (macOS Keychain or ~/.pome/credentials.json)")
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--dashboard-url <url>",
      "App URL for Clerk sign-in (must serve /cli/login).",
      process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
    )
    .option(
      "--key-name <name>",
      "Label for the API key minted by this login.",
      "pome login",
    )
    .action(
      async (options: { apiUrl: string; dashboardUrl: string; keyName: string }) => {
        await loginWithClerk(options);
      },
    );

  program
    .command("logout")
    .summary("Delete the saved API key")
    .description("Remove locally stored hosted credentials (Keychain entry and/or ~/.pome/credentials.json)")
    .action(async () => {
      await clearLocalCredentials();
      console.error("Removed local Pome credentials.");
      console.error(
        "Server-side keys are not auto-revoked — revoke API keys from the dashboard if this device was lost.",
      );
    });

  program
    .command("docs")
    .summary("Print a docs.pome.sh URL by topic")
    .argument("[topic]", "Topic id (e.g. getting-started, github, cli) — prints the docs.pome.sh URL")
    .option(
      "--site <origin>",
      "Override docs site origin (default https://docs.pome.sh)",
    )
    .option(
      "--url",
      "Print the URL instead of opening the interactive topic picker.",
      false,
    )
    .description(
      "Navigate canonical narrative docs on docs.pome.sh",
    )
    .action(async (topic: string | undefined, opts: { site?: string; url?: boolean }) => {
      await runDocsCommand(topic, { site: opts.site, urlOnly: Boolean(opts.url) });
    });

  program
    .command("tasks")
    .summary("List or copy the bundled tasks")
    .argument(
      "[twin]",
      "Twin id (e.g. github). Omit to list available twins.",
    )
    .option(
      "--copy",
      "Copy the twin's runnable tasks into the local project.",
      false,
    )
    .option(
      "--force",
      "With --copy, overwrite existing files in the destination.",
      false,
    )
    .option(
      "--dest <dir>",
      "With --copy, write into this directory instead of ./tasks/.",
    )
    .description(
      "Browse the bundled task library (or copy a twin's tasks into the local project)",
    )
    .action(
      async (
        twin: string | undefined,
        opts: { copy: boolean; force: boolean; dest?: string },
      ) => {
        await runTasksCommand(twin, {
          copy: opts.copy,
          force: opts.force,
          dest: opts.dest,
        });
      },
    );

  // `pome checks` is a TOP-LEVEL group, not `pome tasks checks`:
  // `pome tasks` already takes `[twin]` positionally, so `tasks checks` would
  // parse "checks" as a twin id, and `pome task` one letter from `pome tasks`
  // is a trap.
  const checks = program
    .command("checks")
    .summary("List, add, and lint a twin's checks")
    .argument("[twin]", "Twin id (e.g. github). Omit to list twins that declare checks.")
    .option("--json", "Emit the declaration as JSON (for skills and agents).", false)
    .description(
      "Browse the typed checks a twin declares — the closed set a [code] criterion is graded by",
    )
    .action(async (twin: string | undefined, opts: { json: boolean }) => {
      await runChecksCommand(twin, { json: opts.json });
    });

  checks
    .command("add")
    .argument("<file>", "Task markdown file to append a criterion to")
    .option("--check <id>", "Check id (run `pome checks <twin>` to list them)")
    .option(
      "--arg <key=value>",
      "One per declared parameter. Repeat the flag.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .description(
      "Add one [code] criterion by picking a declared check — pome writes the English",
    )
    .action(async (file: string, opts: { check?: string; arg: string[]; apiUrl: string }) => {
      await runChecksAddCommand(file, {
        check: opts.check,
        arg: opts.arg,
        apiBaseUrl: opts.apiUrl,
      });
    });

  // The read-only half. `checks add` warns about the block it writes
  // into, which covers an author mid-edit; this answers the same question about a
  // file already on disk, which is what a builder's own CI needs. Offline: it
  // reads this CLI's pinned declarations and never calls the cloud.
  checks
    .command("lint")
    .argument("<file...>", "Task markdown file(s) — shell globs work: tasks/*.md")
    .description("Report [code] criteria that bind no declared check, so are never graded")
    .action(async (files: string[]) => {
      await runChecksLintCommand(files);
    });

  program
    .command("compile-seeds")
    .summary("Compile a task's seed state to JSON")
    .argument("[target]", "Task .md file or directory (defaults to ./tasks)")
    .option("--force", "Recompile even if the sidecar's source hash matches", false)
    .option(
      "--hosted",
      "Compile via the Pome control plane instead of calling Anthropic directly (uses your Pome API key; no ANTHROPIC_API_KEY needed)",
      false,
    )
    .option(
      "--api-url <url>",
      "Control-plane base URL (only relevant with --hosted).",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .description(
      "Compile prose `## Seed State` sections into sidecar .seed.json files (local: ANTHROPIC_API_KEY; --hosted: routes through Pome cloud)",
    )
    .action(async (target: string | undefined, opts: { force: boolean; hosted: boolean; apiUrl: string }) => {
      const code = await runCompileSeeds(target, {
        force: opts.force,
        hosted: opts.hosted,
        apiBaseUrl: opts.apiUrl,
      });
      if (code !== 0) process.exitCode = code;
    });

  const register = program
    .command("register")
    .summary("Register an agent with Pome")
    .description(
      "Register a cloud entity (agent, ...) and link this project to it",
    );

  register
    .command("agent")
    .argument("<name>", "Human-readable agent name (e.g. \"triage-bot\")")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--force",
      "Re-resolve the agent even when .pome/link.json already links one",
      false,
    )
    .option(
      "--twins <list>",
      "Comma-separated services this agent may exercise (e.g. github,slack), unioned with the manifest's twins. Default: the manifest's twins, else the cloud's default enablement.",
    )
    .description(
      "Create a cloud agent under the current team and write agent.slug to pome.json",
    )
    .action(
      async (name: string, opts: { apiUrl: string; force: boolean; twins?: string }) => {
        try {
          await runRegisterAgent({
            apiBaseUrl: opts.apiUrl,
            dashboardBaseUrl:
              process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
            name,
            force: opts.force,
            twins: normalizeRegisterTwins(opts.twins),
          });
        } catch (err) {
          console.error(friendlyHostedError(err));
          process.exitCode = 2;
        }
      },
    );

  // One spelling, and it is the product noun (VOCABULARY.md bans user-facing
  // `session` outright). The `session` alias existed so scripts written against
  // the CLI's first spelling kept working; there are no such scripts, and an
  // alias a reader can meet in `--help` is a second name for one thing.
  //
  // `session_id`, `/v1/sessions` and the `ses_` prefix are the WIRE and stay.
  const session = program
    .command("sandbox")
    .summary("Create, list, and stop sandboxes")
    .description(
      "Hosted sandboxes (same API as the dashboard Twins page — requires login)",
    );

  session
    .command("create")
    .description("Create a hosted sandbox for one or more twins and print its connection info")
    .option(
      "--twin <name>",
      // The enumeration is derived, never typed: this line is the public
      // discovery surface for which twins exist, and a hand-written copy of the
      // allowlist is what made it omit `linear` for a release. The worked example
      // stays editorial — github+gmail is the pairing bundled task 27 exercises —
      // and `session-twin-help.test.ts` runs the twins it names through the same
      // validator, so it cannot rot either.
      //
      // No longer `requiredOption`: a `--seed` file whose envelope names exactly
      // one twin already says which twin the sandbox is for. Commander would
      // reject the invocation before the action runs, so the check moved into
      // `runSessionCreate`, which fails with the same "No twin specified"
      // sentence when neither source supplies one.
      `${SESSION_TWIN_NAMES.join(" | ")}. Repeat the flag for a multi-twin sandbox (e.g. --twin github --twin gmail). Optional when --seed names exactly one twin.`,
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--seed <path>",
      "Start the sandbox from a JSON or YAML seed file instead of each twin's default. A seed REPLACES the default; it does not merge. Same file `pome twin start --seed` takes; write one with `pome twin seed <name>`.",
    )
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--secrets-file <path>",
      "Write shell exports containing session secrets to a local file with mode 0600",
    )
    .option(
      "--format <fmt>",
      "Output format: text, json, or env. env writes the exports to --secrets-file instead of printing them.",
      "text",
    )
    .action(
      async (opts: {
        twin?: string[];
        apiUrl: string;
        secretsFile?: string;
        format: string;
        seed?: string;
      }) => {
        try {
          const format = opts.format.trim().toLowerCase();
          if (!SESSION_CREATE_FORMATS.has(format)) {
            console.error("Unknown session create format. Use one of: text, json, env.");
            process.exitCode = 2;
            return;
          }
          await runSessionCreate({
            apiBaseUrl: opts.apiUrl,
            twins: opts.twin ?? [],
            format: format as "text" | "json" | "env",
            secretsFile: opts.secretsFile,
            seedPath: opts.seed,
          });
        } catch (err) {
          console.error(friendlyHostedError(err));
          process.exitCode = 2;
        }
      },
    );

  session
    .command("list")
    .description("List hosted sandboxes (defaults to --state running, like the dashboard)")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option("--limit <n>", "Max rows", "20")
    .option(
      "--state <state>",
      "Filter by sandbox state: running, ready, done, expired, or all. `running` also matches the server-side `ready` state, the way the dashboard shows them in one column.",
      "running",
    )
    .option("--format <fmt>", "Output format: text or json", "text")
    .action(
      async (opts: { apiUrl: string; limit: string; state: string; format: string }) => {
        const validStates: SessionListStateFilter[] = [
          "running",
          "ready",
          "done",
          "expired",
          "all",
        ];
        if (!validStates.includes(opts.state as SessionListStateFilter)) {
          console.error(
            `Unknown --state "${opts.state}". Supported: ${validStates.join(", ")}.`,
          );
          process.exitCode = 2;
          return;
        }
        try {
          await runSessionList({
            apiBaseUrl: opts.apiUrl,
            limit: Number.parseInt(opts.limit, 10) || 20,
            state: opts.state as SessionListStateFilter,
            format: opts.format as "text" | "json",
          });
        } catch (err) {
          console.error(friendlyHostedError(err));
          process.exitCode = 2;
        }
      },
    );

  session
    .command("stop")
    .description("Stop a hosted sandbox")
    .argument("<session-id>", "Sandbox id (ses_…)")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--discard",
      "Confirm destroying a session whose run has not been graded",
      false,
    )
    .action(
      async (
        sessionId: string,
        opts: { apiUrl: string; discard?: boolean },
      ) => {
        try {
          await runSessionStop({
            apiBaseUrl: opts.apiUrl,
            sessionId,
            discard: opts.discard === true,
          });
        } catch (err) {
          // runSessionStop already prints the full refusal detail for
          // HostedDiscardRefusedError; friendlyHostedError returns "" for it
          // so we don't print a duplicate (or bare blank) line here.
          const friendly = friendlyHostedError(err);
          if (friendly) console.error(friendly);
          process.exitCode = exitCodeFor(err);
        }
      },
    );

  program
    .command("run")
    .summary("Run a task and print the score")
    .argument(
      "[path]",
      "Task markdown file or directory. Omit to run the demo task Pome copies into your project.",
    )
    .option("--agent <command>", "Command that starts your agent.")
    .option(
      "-n, --trials <count>",
      "Number of trials to run as one group, 1 to 20. Hosted only; defaults to the task's `runs` field.",
    )
    .option("--artifacts-dir <dir>", "Directory for run artifacts", "runs")
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option("--agent-model <name>", "Informational; model name recorded on the run.", "unknown")
    .option(
      "--agent-version <version>",
      "Override the manifest's agent.version.",
    )
    .option(
      "--no-capture",
      "Self-host only: skip the capture proxy, so model calls are not recorded. Ignored on hosted runs.",
    )
    .option(
      "--local",
      "Self-host: record a trace against an in-process twin, with no score. Score it with `pome eval`.",
    )
    .description(
      "Run a task, or every task in a directory, and print the score. With no path, runs the demo task Pome copies into your project on first use. Refuses to start when `pome doctor` fails, and there is no --force. See `pome docs cli-run` for trial groups and exit codes.",
    )
    .action(
      async (
        target: string | undefined,
        options: {
          agent?: string;
          trials?: string;
          artifactsDir: string;
          local?: boolean;
          apiUrl: string;
          agentModel: string;
          agentVersion?: string;
          capture: boolean;
        }
      ) => {
        // F0-5 — `pome run`'s pre-flight (resolving files, reading config,
        // resolving credentials) used to propagate plain `Error`s to
        // Commander's top-level catch, which always demoted to exit 2.
        // That stole exit 3 (auth) from `pome logout && pome run` and
        // exit 5 (usage) from `pome run /does/not/exist.md`. Catch the
        // typed errors (HostedAuthError, HostedQuotaError,
        // HostedUsageError, HostedOrchError) here and map via
        // `exitCodeFor` so the documented contract holds.

        // Validate -n before anything runs (documented exit 5 on
        // a bad value, same as any other usage error).
        let trialsFlag: number | undefined;
        if (options.trials !== undefined) {
          try {
            trialsFlag = parseTrialsFlag(options.trials);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = exitCodeFor(err);
            return;
          }
        }

        // Read the manifest once — both bare-run task resolution and
        // the agent command below consume it.
        const manifestRead = await readManifest(process.cwd()).catch(() => null);

        // Bare `pome run` (no path) resolves its default:
        //   - a MIGRATED project (manifest with a `tasks` key) runs that whole
        //     declared directory, exactly like `pome run <that-dir>`: no demo
        //     drop, no "run yours" frame, each file at its own `runs`/-n;
        //   - an UN-MIGRATED project (no manifest / no `tasks` key) keeps the
        //     "run yours" demo default — a user-visible copy at
        //     tasks/first-run-demo.md (dropped on first use; its Config pins
        //     runs: 5 so an explicit -n still wins). The moment-05 frame prints
        //     later, once the doctor + credential gates have passed.
        let defaultTask: DefaultTaskResolution | null = null;
        let bareViaManifestTasks = false;
        if (target === undefined) {
          const declaredTasks = manifestRead?.manifest.tasks;
          if (manifestRead && declaredTasks) {
            // Resolve the declared dir relative to the manifest, not cwd — the
            // manifest can be discovered up-tree. A declared-but-missing dir
            // surfaces as taskFiles' usage error below (exit 5); we never
            // silently fall back to the demo drop once intent is declared.
            target = resolve(dirname(manifestRead.path), declaredTasks);
            bareViaManifestTasks = true;
          } else {
            try {
              defaultTask = await ensureDefaultTask();
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exitCode = exitCodeFor(err);
              return;
            }
            if (defaultTask.copied) console.error(copyAnnounceLine(defaultTask));
            if (!defaultTask.trialsApplied) console.error(trialsPinFallbackLine());
            target = defaultTask.path;
          }
        }

        let files: string[];
        let hostedCreds: { apiBaseUrl: string; apiKey: string } | null;
        try {
          files = await taskFiles(target);
        } catch (err) {
          const code = exitCodeFor(err);
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = code;
          return;
        }

        // Make a manifest-driven bare run legible: name where the set
        // came from, and never let an empty declared dir no-op silently.
        if (bareViaManifestTasks) {
          const manifestFile = basename(manifestRead!.path);
          const declared = manifestRead!.manifest.tasks;
          if (files.length === 0) {
            console.error(
              `no task .md files found in ${declared}/ (declared in ${manifestFile}) — add tasks or copy some with \`pome tasks <twin> --copy\`.`,
            );
          } else {
            console.error(
              `resolved ${files.length} task(s) from ${manifestFile} (tasks: "${declared}")`,
            );
          }
        }

        const configCommand = manifestRead?.manifest.command;
        const resolvedCommand = options.agent ?? configCommand;
        // Bare `pome init` (existing project) writes no `command`. Don't
        // silently fall back to the starter scaffold it never created — a
        // spawn of a missing file gives a cryptic error. Use the default only
        // when that file actually exists; otherwise fail with guidance.
        if (resolvedCommand === undefined && !existsSync(DEFAULT_AGENT_FILE)) {
          console.error(
            'No agent command configured. Set "command" in pome.json to your ' +
              'agent\'s launch command, or pass --agent "<command>".',
          );
          process.exitCode = 2;
          return;
        }
        const agentCommand = resolvedCommand ?? DEFAULT_AGENT_COMMAND;
        let worstExit = 0;

        // Hosted is the default. Self-host runs against an in-process twin via
        // `--local` (documented) or POME_LOCAL=1 (an internal escape hatch).
        // Self-host is CAPTURE-ONLY — it records the raw trace and
        // never scores/judges/correlates. A verdict comes only from the cloud
        // (`pome eval <dir>`, or a hosted `pome run`).
        const useLocal = options.local === true || process.env.POME_LOCAL === "1";

        // Trial groups are a hosted feature: the verdicts come
        // from cloud evaluation, and self-host runs are capture-only. Reject
        // the combination loudly instead of silently ignoring the flag.
        if (trialsFlag !== undefined && useLocal) {
          console.error(
            "-n/--trials needs the hosted path (verdicts come from the cloud judge); --local runs capture a single trace. Drop --local or -n.",
          );
          process.exitCode = 5;
          return;
        }

        // Doctor preflight gate. A repo failing any applicable
        // doctor check refuses to spawn the agent — BEFORE credentials are
        // resolved and before any twin/session is provisioned. Local runs get
        // the full engine (incl. local twin boot); hosted runs skip the local
        // twin (the cloud provisions the session twin) but still gate on
        // config, routing, and the egress floor. Deliberately no --force /
        // --skip-checks escape: "never a false success" — pome will not run
        // trials against a live API. (Design: CLI moments 03.)
        {
          const { runDoctorChecks } = await import("../doctor/checks.js");
          const { renderDoctorReport } = await import("../doctor/render.js");
          const doctorReport = await runDoctorChecks({ mode: useLocal ? "full" : "hosted" });
          if (!doctorReport.ok) {
            for (const line of renderDoctorReport(doctorReport)) console.error(line);
            console.error("");
            console.error(
              "pome run: wiring check failed — refusing to spawn the agent. Fix the cause above and re-run (there is no --force).",
            );
            // 5 = usage error, per docs/05-api-spec.md §1. NOT 1: that code
            // means "scored below its pass threshold", and nothing ran here —
            // a CI job branching on $? would read a hardcoded production host
            // as an agent regression.
            process.exitCode = 5;
            return;
          }
        }

        try {
          hostedCreds = useLocal
            ? null
            : await resolveCredentials({ apiBaseUrl: options.apiUrl });
        } catch (err) {
          const code = exitCodeFor(err);
          console.error(err instanceof Error ? err.message : String(err));
          if (code === 3) {
            console.error(
              "Tip: `pome login` to run against Pome cloud (which returns a verdict), or `pome run --local <path>` to run a self-hosted twin and capture a trace only.",
            );
          }
          process.exitCode = code;
          return;
        }

        // The moment-05 frame, only for the bare-run default and
        // only once every gate that could refuse the run has passed.
        if (defaultTask) {
          for (const line of runYoursFrameLines()) console.error(line);
        }

        for (const file of files) {
          if (hostedCreds) {
            // Hosted path: catch HostedAuthError/QuotaError/OrchError + map to
            // documented exit codes. Anything else falls through to Commander
            // (treated like self-host).
            try {
              // Effective trial count: -n wins, else the task
              // config's `runs` field (both capped at 20). k>1 takes the
              // trial-group path; k=1 stays EXACTLY the single-run path
              // below (no group is ever stamped for it).
              const taskForRuns = await parseTaskFile(file);
              const k = effectiveTrialCount(
                trialsFlag,
                taskForRuns.config.runs,
              );
              if (k > 1) {
                const { runTrialGroup } = await import(
                  "../runner/runTrialGroup.js"
                );
                // The literal re-run command the fix handoff
                // prints: bare default-task runs re-run as bare `pome run`;
                // explicit paths re-run by (cwd-relative) path + -n.
                const fileForRerun = relative(process.cwd(), file);
                const rerunCommand = defaultTask
                  ? options.trials !== undefined
                    ? `pome run -n ${k}`
                    : "pome run"
                  : `pome run ${
                      fileForRerun && !fileForRerun.startsWith("..")
                        ? fileForRerun
                        : file
                    } -n ${k}`;
                const groupResult = await runTrialGroup({
                  taskPath: file,
                  agentCommand,
                  agentCommandSource: options.agent
                    ? "--agent"
                    : configCommand
                      ? "pome.json"
                      : "built-in default",
                  trials: k,
                  artifactsDir: options.artifactsDir,
                  hosted: {
                    baseUrl: hostedCreds.apiBaseUrl,
                    apiKey: hostedCreds.apiKey,
                  },
                  dashboardBaseUrl:
                    process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
                  agentModel: options.agentModel,
                  agentVersion: options.agentVersion,
                  rerunCommand,
                });
                if (groupResult.exitCode > worstExit) {
                  worstExit = groupResult.exitCode;
                }
                continue;
              }

              const result = await runTaskHosted({
                taskPath: file,
                agentCommand,
                artifactsDir: options.artifactsDir,
                hosted: { baseUrl: hostedCreds.apiBaseUrl, apiKey: hostedCreds.apiKey },
                agentModel: options.agentModel,
                agentVersion: options.agentVersion,
              });
              const status = scoreStatus(
                result.score,
                result.scenario.config.passThreshold,
              );
              const label =
                status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "INCOMPLETE";
              console.error(`${label} ${result.scenario.title}`);
              console.error(`  ${runScoreLine(result.score, result.scenario.config.passThreshold, "cloud score")}`);
              console.error(`  local: ${result.artifacts.runDir}`);
              console.error(`  cloud: ${result.cloudDashboardUrl}`);
              if (result.exitCode !== 0) worstExit = result.exitCode;
            } catch (err) {
              const code = exitCodeFor(err);
              console.error(`ERROR ${file}`);
              console.error(`  ${err instanceof Error ? err.message : String(err)}`);
              if (code > worstExit) worstExit = code;
            }
          } else {
            // Self-host path: CAPTURE-ONLY. Record the raw trace;
            // no score, no verdict, no judge. Let exceptions (file-not-found,
            // parse errors, agent failures) propagate to Commander's top-level
            // handler.
            const result = await runTask({
              taskPath: file,
              agentCommand,
              artifactsDir: options.artifactsDir,
              // Commander negates --no-* flags: `--no-capture` → `capture: false`.
              noCapture: options.capture === false,
            });
            console.error(`TRACE ${result.scenario.title}`);
            console.error(`  run:  ${result.artifacts.runDir}`);
            console.error(
              `  captured; run \`pome eval ${result.artifacts.runDir}\` for a cloud verdict.`,
            );
            // Name every host the egress floor refused, so a stray
            // production call is a visible event, never a silent passthrough.
            if (result.blockedEgress.length > 0) {
              const refusals = result.blockedEgress.reduce((n, b) => n + b.count, 0);
              const named = result.blockedEgress
                .map((b) => `${b.host}:${b.port}${b.count > 1 ? ` ×${b.count}` : ""}`)
                .join(", ");
              console.error(
                `  egress: refused ${refusals} tunnel(s) to non-allowlisted host(s) — ${named}`,
              );
              console.error(
                "          twin + LLM traffic is unaffected; extend with POME_EGRESS_ALLOW=<host,…> if intentional.",
              );
            }
            if (result.exitCode !== 0) worstExit = result.exitCode;
          }
        }

        process.exitCode = worstExit;
      }
    );

  program
    .command("demo")
    .summary("Run a sample task, no account needed")
    .description(
      "Zero-auth first-run demo: boots a local GitHub twin, runs the bundled demo agent for 5 isolated trials (model calls via pome's anonymous demo gateway), and prints per-trial verdicts evaluated in Pome cloud. No signup, no API keys; ends with a no-login preview link.",
    )
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_BASE ??
        process.env.POME_API_URL ??
        DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--trials <n>",
      "Number of trials to run, 1 to 10",
      "5",
    )
    .option("--artifacts-dir <dir>", "Directory for run artifacts", "runs")
    .action(
      async (opts: { apiUrl: string; trials: string; artifactsDir: string }) => {
        const trials = Number.parseInt(opts.trials, 10);
        if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
          console.error(`Invalid --trials "${opts.trials}" (expected 1-10).`);
          process.exitCode = 5;
          return;
        }
        // Dynamic import mirrors doctor/install: keep the demo dependency
        // graph out of every other command's startup path.
        const { runDemo } = await import("../demo/runDemo.js");
        const result = await runDemo({
          apiBase: opts.apiUrl.replace(/\/$/, ""),
          dashboardBase:
            process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
          trials,
          artifactsDir: opts.artifactsDir,
        });
        process.exitCode = result.exitCode;
      },
    );

  // Hidden: the bundled demo agent `pome demo` spawns as its trial child
  // through the real capture path. Reads the POME_* env contract
  // injected by runTask plus POME_DEMO_* gateway coordinates.
  program
    .command("demo-agent", { hidden: true })
    .description("Internal: the bundled demo agent process (spawned by `pome demo`).")
    .action(async () => {
      const { runDemoAgentCommand } = await import("../demo/agent.js");
      const code = await runDemoAgentCommand();
      if (code !== 0) process.exitCode = code;
    });

  program
    .command("doctor")
    .summary("Check the agent and twin wiring")
    .description(
      "Check the agent↔twin wiring: pome.json (or pome.yaml) present + valid, the local twin boots + serves, requests routed to the twin (not a hardcoded production host), egress floor active. On failure prints one named cause (file:line where knowable) + one concrete fix and exits non-zero.",
    )
    .action(async () => {
      const { runDoctorChecks } = await import("../doctor/checks.js");
      const { renderDoctorReport } = await import("../doctor/render.js");
      const report = await runDoctorChecks();
      for (const line of renderDoctorReport(report, { passNote: true })) console.error(line);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("eval")
    .summary("Score a trace recorded earlier")
    .argument(
      "[run-dir]",
      "Existing run directory (runs/<task>/<run-id>). Omit to use <artifacts-dir>/latest.json.",
    )
    .option(
      "--artifacts-dir <dir>",
      "Directory whose latest.json picks the run when no run dir is given.",
      "runs",
    )
    .option(
      "--agent <slug>",
      "Agent identity for the eval session. Defaults to agent.slug from pome.json.",
    )
    .option(
      "--task <name>",
      "Task name recorded on the eval session. Defaults to meta.json's `scenario` slug (a legacy key name; then title).",
    )
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .description(
      "Upload an existing raw trace directory to Pome cloud for evaluation and print the authoritative score (capture/eval split — no local scoring; requires a control plane with POST /v1/eval-sessions)",
    )
    .action(
      async (
        runDir: string | undefined,
        opts: { artifactsDir: string; agent?: string; task?: string; apiUrl: string },
      ) => {
        await runEvalCommand(runDir, opts);
      },
    );

  // NOTE: `matrix` / `matrix-html` / `eval-report` were removed.
  // They were a pure LOCAL-scoring orchestrator — they shelled out to
  // `pome run` with POME_LOCAL=1 and aggregated the local score.json each
  // child wrote. With local evaluation gone (the OSS CLI is capture-only),
  // that path cannot produce a verdict, so the whole subsystem was retired
  // rather than left as a broken command. Fleet evaluation lives in the
  // cloud/research workspace.

  program
    .command("inspect")
    .argument("<run>", "Run id, run directory, or latest")
    .option("--artifacts-dir <dir>", "Directory for run artifacts", "runs")
    .description("Print a human-readable run report")
    .action(async (run: string, options: { artifactsDir: string }) => {
      const latest = run === "latest" ? await readLatestRun(options.artifactsDir) : undefined;
      const runDir = latest?.run_dir ?? resolve(run);

      const eventsResult = await readEventsJsonl(runDir);

      const meta = await readMetaSummary(runDir);

      console.log(`Run: ${latest?.run_id ?? run}`);
      console.log(`Directory: ${runDir}`);

      if (eventsResult.kind === "missing") {
        console.log("Events: (events.jsonl not found)");
      } else {
        const health = computeTraceHealth({
          events: eventsResult.events,
          taskUsesTwin: meta.twins.length > 0,
        });
        for (const line of renderTraceHealth(health)) console.log(line);
        for (const line of renderEvents(eventsResult.events)) console.log(line);
      }
      // `pome inspect` shows ONLY trace/audit content. There is no
      // local verdict: score.json is never written (local artifacts are
      // trace-only). A verdict comes from the cloud — run `pome eval <dir>`
      // (or a hosted `pome run`) and read it on the terminal / dashboard.
    });

  program
    .command("fix-prompt")
    .summary("Build a prompt for a failed run")
    .argument(
      "[target]",
      "Artifacts root or a trial run dir (default: runs). Legacy form: a path to events.jsonl — then <task> is required.",
    )
    .argument(
      "[task]",
      "Path to the task .md file (only with an events.jsonl target)",
    )
    .description(
      "Assemble a paste-into-IDE fix prompt (no LLM call, no network). With no args, reads the latest FAILED run set under ./runs: the persisted cloud verdicts (verdict.json) become grouped failure signatures over the raw traces, in one prompt. Point it at a trial run dir to target that set, or point it at an `events.jsonl` with its task file for a single trace.",
    )
    .action(async (target?: string, taskArg?: string) => {
      // Single-trace form: <events.jsonl> <task.md>. CAPTURE-ONLY — raw trace
      // plus declared criteria, no verdict, which is what a --local run has.
      if (target !== undefined && target.endsWith(".jsonl")) {
        if (!taskArg) {
          console.error(
            "The events.jsonl form needs the task file: pome fix-prompt <events.jsonl> <task.md>",
          );
          process.exitCode = 5;
          return;
        }
        const [eventsRaw, task] = await Promise.all([
          readFile(resolve(target), "utf8"),
          parseTaskFile(resolve(taskArg)),
        ]);
        const events: RecorderEvent[] = eventsRaw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as RecorderEvent);
        console.log(buildFixPrompt({ events, task }));
        return;
      }
      if (taskArg !== undefined) {
        console.error(
          "The second argument only applies to the events.jsonl form: pome fix-prompt <events.jsonl> <task.md>",
        );
        process.exitCode = 5;
        return;
      }

      // Run-set mode. Reassemble the run set from persisted
      // CLOUD verdicts (verdict.json, written by hosted `pome run`) + raw
      // traces, and emit ONE prompt with grouped failure signatures. Still
      // no network and no local judging — the verdicts were the cloud's.
      const root = target ?? "runs";
      const discovery = await discoverRunSet(resolve(root));
      // A verdict.json this CLI can't read is a RECOGNIZABLE prior
      // artifact version, not a foreign file, and the skip is named EVERY
      // time it happens — not only when nothing else was found. A runs/ that
      // holds one readable trial beside two stale ones would otherwise build
      // a prompt from a third of the run set and say nothing about the rest,
      // which is the same silent drop as reporting "no runs" for a dir full
      // of them.
      if (discovery.staleVersionCount > 0) {
        console.error(
          `${discovery.staleVersionCount} verdict.json file(s) under ${root} are not artifact version ${VERDICT_ARTIFACT_VERSION} (the only version this CLI reads) and were skipped — re-run \`pome run\` to record those trials again.`,
        );
      }
      // A verdict.json that EXISTS but is truncated, hand-edited, or
      // otherwise damaged is a different fact from a prior-version file (an
      // older CLI wrote that one correctly) and gets its own line, naming the
      // path(s) — a count alone would tell the user something was skipped but
      // not which trial to go look at. Reported every time it happens, same
      // as stale-version above, never only when nothing else was found.
      if (discovery.unreadableCount > 0) {
        console.error(
          `${discovery.unreadableCount} verdict.json file(s) under ${root} could not be read (truncated, hand-edited, or not a verdict artifact) and were skipped:`,
        );
        for (const path of discovery.unreadablePaths.slice(0, MAX_UNREADABLE_PATHS_SHOWN)) {
          console.error(`  - ${path}`);
        }
        const omitted = discovery.unreadablePaths.length - MAX_UNREADABLE_PATHS_SHOWN;
        if (omitted > 0) {
          console.error(`  (${omitted} more omitted — kept first ${MAX_UNREADABLE_PATHS_SHOWN})`);
        }
      }
      if (discovery.totalSets === 0) {
        if (discovery.staleVersionCount === 0 && discovery.unreadableCount === 0) {
          console.error(
            `No finalized run sets under ${root} — hosted \`pome run\` records a verdict.json per trial; run one first (or point fix-prompt at your artifacts dir).`,
          );
        }
        process.exitCode = 5;
        return;
      }
      if (!discovery.set) {
        // A root whose only non-passing run set is INCOMPLETE (the
        // grader never reached some criterion) is neither "all passed" nor a
        // failure to hand to a coding agent: routing it would assert an agent
        // defect nothing here established, and "all passed" would be false
        // about it. `incompleteSet` is only ever populated when no set failed
        // (see `discoverRunSet`), so this branch and the routing decision
        // above read the one computation and cannot disagree.
        //
        // What this message may NOT say is "just a grading gap" unread: a
        // trial's `state` is `incomplete` for ANY ungraded criterion
        // (`scoreStatus`'s A5 guard outranks everything else), so such a set
        // can still hold criteria that WERE graded and did fail. Claiming
        // "not an agent defect" over those would be this ticket's own defect
        // pointed the other way — understating instead of overstating. Count
        // them and say which case this is.
        const incomplete = discovery.incompleteSet;
        if (incomplete) {
          const ungradedTrials = incomplete.trials.filter(
            (t) => t.verdict.state === "incomplete",
          ).length;
          const gradedFailures = incomplete.trials.reduce(
            (n, t) =>
              n +
              t.verdict.criteria_results.filter((r) => outcomeOf(r) === "failed")
                .length,
            0,
          );
          const which = `task ${incomplete.taskName}${incomplete.groupId ? ` · group ${incomplete.groupId}` : ""}`;
          // "the most recent NON-PASSING set", never "the latest run set":
          // a newer set may have passed — `latestIncompleteRunSet` scans for
          // an outcome, not for the newest set.
          console.error(
            `Not routed to fix-prompt: no run set under ${root} failed outright. The most recent non-passing one (${which}) is INCOMPLETE — ${ungradedTrials} of ${incomplete.trials.length} trial(s) have criteria the grader never graded.`,
          );
          if (gradedFailures > 0) {
            console.error(
              `${gradedFailures} criterion result(s) in that set WERE graded and did fail, so this is not only a grading gap — but no trial in it was graded end to end, and a fix prompt built from a partial grading would claim more than was checked. Re-run \`pome run ${incomplete.taskPath}\` to grade the rest, or point fix-prompt straight at one trial (\`pome fix-prompt ${incomplete.trials[0]!.runDir}\`) to build one from the partial grading anyway.`,
            );
          } else {
            console.error(
              `Nothing in that set was graded and failed, so it is a grader/seed gap, not an agent defect, and fix-prompt will not hand it to your coding agent. Re-run \`pome run ${incomplete.taskPath}\` to grade those criteria; if they come back ungraded, the gap is in the task's checks or its seed, not in your prompt.`,
            );
          }
          process.exitCode = 1;
          return;
        }
        console.error(
          `Nothing to fix: the latest run sets under ${root} all passed.`,
        );
        return;
      }
      const set = discovery.set;
      let task: Task | null = null;
      try {
        task = await parseTaskFile(resolve(set.taskPath));
      } catch {
        // Task file moved/edited since the run — the prompt degrades to the
        // verdict-embedded criteria.
        task = null;
      }
      const trials: TrialFixInput[] = [];
      for (const [idx, t] of set.trials.entries()) {
        trials.push({
          label: `trial ${idx + 1} · ${t.verdict.session_id}`,
          runDir: t.runDir,
          verdict: t.verdict,
          events: (await loadTrialEvents(t.runDir)) as RecorderEvent[],
        });
      }
      console.log(
        buildGroupFixPrompt({
          taskName: set.taskName,
          groupId: set.groupId,
          task,
          trials,
        }),
      );
    });

  const twin = program
    .command("twin")
    .summary("Run a twin on this machine")
    .description("Start and reset a twin on this machine, print its status or a starter seed file");
  twin
    .command("start")
    .argument(
      "[name]",
      `Twin name (${TWIN_NAME_LIST.join(" | ")}). Optional when --seed names exactly one twin.`,
    )
    .option(
      "--port <port>",
      "Port to bind (default: $PORT, else GMAIL_TWIN_PORT/3336 for gmail, else 3333)",
    )
    .option(
      "--seed <path>",
      "Boot this twin from a JSON or YAML seed file instead of its default. A seed REPLACES the default; it does not merge. Takes the per-twin envelope { <twin>: { … } } or one twin's flat seed. Overrides POME_SEED_JSON.",
    )
    .description(
      "Start a standalone twin as a long-lived foreground server (Ctrl-C to stop)",
    )
    .action(async (name: string | undefined, options: { port?: string; seed?: string }) => {
      const { runTwinStartCommand } = await import("../twin/twinStart.js");
      await runTwinStartCommand(name, options);
    });

  twin
    .command("seed")
    .argument("<name...>", `Twin name (${TWIN_NAME_LIST.join(" | ")}). Repeat for one file covering several.`)
    .option("--out <path>", "Write to this file instead of stdout. Refuses to overwrite.")
    .option(
      "--for-task",
      "Emit the shape a `<task>.seed.json` sidecar takes — flat for one twin, the per-twin envelope for more, the rule the task's `## Config` twins already set. Without it you get a seed file for `--seed`, which is always the envelope.",
    )
    .description(
      "Print a starter seed file for a twin, generated from the twin's own starting state",
    )
    .action(async (names: string[], options: { out?: string; forTask?: boolean }) => {
      const { runTwinSeedCommand } = await import("../twin/twinSeed.js");
      await runTwinSeedCommand(names, options);
    });

  twin
    .command("reset")
    // The name defaults rather than being required, matching `twin start`, and
    // the success line names the twin it acted on.
    //
    // The description names the paths rather than promising an outcome: `twin
    // start` boots the twin in process, every twin opens an in-memory database
    // unless a `*_DB` path is set, and it re-seeds on every boot. So a reset
    // does not decide what the next start begins from.
    .argument("[name]", "Twin name", "github")
    .summary("Reset a twin's saved state")
    .description(
      "Delete the twin's database under `.pome/` or `.pome-data/`, and `.pome/twin-status.json`, the one file `pome twin status` reads for every twin. A twin holding its state in memory has nothing to delete.",
    )
    .action(async (name: string) => {
      if (!isTwinName(name)) {
        throw new Error(`Unknown twin '${name}'. Supported: ${TWIN_NAME_LIST.join(", ")}.`);
      }
      const dbPaths =
        name === "gmail"
          ? [".pome/gmail.db", ".pome-data/gmail/gmail.db"]
          : [`.pome/${name}.db`, `.pome-data/${name}/${name}.db`];
      for (const dbPath of dbPaths) {
        await rm(dbPath, { force: true });
        await rm(`${dbPath}-wal`, { force: true });
        await rm(`${dbPath}-shm`, { force: true });
      }
      await rm(".pome/twin-status.json", { force: true });
      console.log(`Standalone ${name} twin state reset.`);
    });

  twin
    .command("status")
    .description("Print standalone twin status")
    .action(async () => {
      if (!existsSync(".pome/twin-status.json")) {
        console.log("No standalone twin status found.");
        return;
      }
      console.log(await import("node:fs/promises").then((fs) => fs.readFile(".pome/twin-status.json", "utf8")));
    });

  program
    .command("endpoints")
    .summary("List a twin's endpoints")
    .argument("<name>", "Twin name")
    .description("List the endpoints the github or gmail twin serves")
    .action((name: string) => {
      const endpoints =
        name === "github"
          ? SUPPORTED_GITHUB_ENDPOINTS
          : name === "gmail"
            ? SUPPORTED_GMAIL_ENDPOINTS
            : null;
      if (!endpoints) {
        throw new Error("Endpoint listing is available for: github, gmail.");
      }
      for (const endpoint of endpoints) {
        console.log(`${endpoint}  semantic`);
      }
    });

  program
    .command("capture-server")
    .summary("Record the agent's model calls")
    .description(
      "Boot an HTTP CONNECT-tunnel proxy that appends one LlmCallEvent per tunnel to events.jsonl. Spawned by `pome run`; agent traffic flows via HTTPS_PROXY.",
    )
    .option("--port <port>", "TCP port to listen on (0 = ephemeral).", "8910")
    .option(
      "--events-out <path>",
      "Path to events.jsonl. Created if missing; appended to otherwise.",
    )
    .option(
      "--allow <hosts>",
      "Comma-separated egress allowlist patterns (exact host or *.suffix). The floor is deny-by-default: only these hosts + loopback are tunnelled; everything else gets 403.",
    )
    .option(
      "--egress-out <path>",
      "Path to egress.jsonl, the sidecar recording refused CONNECTs. Optional; the floor enforces regardless.",
    )
    .action(async (opts: { port: string; eventsOut?: string; allow?: string; egressOut?: string }) => {
      if (!opts.eventsOut) {
        console.error("pome capture-server: --events-out <path> is required");
        process.exitCode = 2;
        return;
      }
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`pome capture-server: invalid --port "${opts.port}"`);
        process.exitCode = 2;
        return;
      }
      const { runCaptureServerCommand } = await import("../capture-server/run.js");
      const { parseAllowCsv } = await import("../capture-server/egress.js");
      await runCaptureServerCommand({
        port,
        eventsOut: opts.eventsOut,
        allowHosts: parseAllowCsv(opts.allow),
        egressOut: opts.egressOut,
      });
    });

  program
    .command("health", { hidden: true })
    .description("Internal: boot the GitHub twin in process and print its health JSON.")
    .action(async () => {
      const app = (await createGitHubSmokeApp()) as { request: (url: string) => Promise<Response> };
      const response = await app.request("http://pome.local/healthz");
      console.log(await response.text());
    });

  return program;
}

const SUPPORTED_GITHUB_ENDPOINTS = [
  "GET /repos/:owner/:repo",
  "GET /repos/:owner/:repo/issues",
  "GET /repos/:owner/:repo/issues/:number",
  "PATCH /repos/:owner/:repo/issues/:number",
  "POST /repos/:owner/:repo/issues/:number/comments",
  "GET /repos/:owner/:repo/labels",
  "POST /repos/:owner/:repo/labels",
  "GET /repos/:owner/:repo/issues/:number/labels",
  "POST /repos/:owner/:repo/issues/:number/labels",
  "DELETE /repos/:owner/:repo/issues/:number/labels/:name",
  "GET /repos/:owner/:repo/collaborators",
  "POST /repos/:owner/:repo/issues/:number/assignees"
];

const SUPPORTED_GMAIL_ENDPOINTS = [
  "GET /gmail/v1/users/:userId/profile",
  "GET|POST /gmail/v1/users/:userId/messages",
  "GET|DELETE /gmail/v1/users/:userId/messages/:id",
  "POST /gmail/v1/users/:userId/messages/{send,import,batchModify,batchDelete}",
  "POST /gmail/v1/users/:userId/messages/:id/{modify,trash,untrash}",
  "GET /gmail/v1/users/:userId/messages/:messageId/attachments/:id",
  "GET|POST /gmail/v1/users/:userId/drafts",
  "GET|PUT|DELETE /gmail/v1/users/:userId/drafts/:id",
  "POST /gmail/v1/users/:userId/drafts/send",
  "GET /gmail/v1/users/:userId/threads",
  "GET|DELETE /gmail/v1/users/:userId/threads/:id",
  "POST /gmail/v1/users/:userId/threads/:id/{modify,trash,untrash}",
  "GET|POST /gmail/v1/users/:userId/labels",
  "GET|PUT|PATCH|DELETE /gmail/v1/users/:userId/labels/:id",
  "GET /gmail/v1/users/:userId/history",
  "GET|POST /gmail/v1/users/:userId/settings/filters",
  "GET|DELETE /gmail/v1/users/:userId/settings/filters/:id",
  "GET /gmail/v1/users/:userId/settings/{forwardingAddresses,sendAs}",
  "GET /gmail/v1/users/:userId/settings/forwardingAddresses/:email",
  "GET /gmail/v1/users/:userId/settings/sendAs/:email",
  "POST /upload/gmail/v1/users/:userId/{messages,drafts} (media|multipart)",
];

async function taskFiles(target: string) {
  const resolved = resolve(target);
  // F0-5a — surface bad-input paths as `HostedUsageError` so the top-level
  // exit-code mapper returns the documented exit 5 ("usage error") instead
  // of the default 2 ("twin/orch"). CI consumers branching on $? expect
  // 5 to mean "fix your command", not "retry the cloud".
  if (!existsSync(resolved)) {
    throw new HostedUsageError(`Task path not found: ${target}`);
  }
  const stat = await import("node:fs/promises").then((fs) => fs.stat(resolved));
  if (stat.isFile()) return [resolved];
  const entries = await readdir(resolved);
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => join(resolved, entry));
}

// Does the cwd already carry a task directory worth recording in the
// manifest? A directory named `dir` counts only when it holds at least one
// `.md` (an empty scaffold dir is not a task set).
async function hasMarkdownTasks(dir: string): Promise<boolean> {
  const abs = join(process.cwd(), dir);
  if (!existsSync(abs)) return false;
  try {
    const entries = await readdir(abs);
    return entries.some((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return false;
  }
}

async function copyStarterFiles() {
  const packageRoot = resolvePackageRoot(import.meta.url);
  if (!packageRoot) return;

  await Promise.all([
    copyStarterTasks(packageRoot),
    copyIfPresent(join(packageRoot, "examples", "agents"), join("examples", "agents")),
  ]);
}

async function copyIfPresent(source: string, target: string) {
  if (!existsSync(source)) return;
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

async function copyStarterTasks(packageRoot: string) {
  const taskDir = join(packageRoot, "tasks");
  if (!existsSync(taskDir)) return;

  const starterTwin = findTwin("github");
  const starterTasks = starterTwin
    ? runnableTasks(starterTwin).map((t) => t.filename)
    : [];

  await mkdir("tasks", { recursive: true });
  await Promise.all(
    starterTasks.flatMap((file) => {
      const sidecar = file.replace(/\.md$/i, ".seed.json");
      return [
        copyIfPresent(join(taskDir, file), join("tasks", file)),
        copyIfPresent(join(taskDir, sidecar), join("tasks", sidecar)),
      ];
    }),
  );
}

// Resolve symlinks on both sides of the entry-point comparison. Without
// this, the guard never matches under an `npm link` install
// where the global `pome` bin is a symlink and
// `process.argv[1]` keeps the symlink path while `import.meta.url`
// resolves to the real file. On macOS the same mismatch hits any `/tmp`
// path because `/tmp` symlinks to `/private/tmp`. Symptom: invoking
// `pome` (the symlinked binary) prints nothing and exits 0.
function isMainEntry(): boolean {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return here === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : "Error: unexpected failure",
    );
    process.exitCode = 2;
  }
}
