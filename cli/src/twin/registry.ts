// SPDX-License-Identifier: Apache-2.0
//
// The one place a first-party twin is registered inside the CLI.
//
// Before this module, adding a twin meant editing four hand-maintained lists
// (a `switch` in twinHarness, `SUPPORTED_STANDALONE_TWINS`, `defaultSeedFor`,
// `defaultPortFor`) plus a repo-wide lint that diffed them against each other.
// Now `TWIN_NAME_LIST` derives the `TwinName` union and `TWIN_REGISTRY` is a
// `Record<TwinName, TwinEntry>`, so a missing or misspelled twin is a compile
// error and every per-twin fact lives in one entry.
//
// Each entry reaches its twin package through a `import()` INSIDE the entry's
// own methods, never a top-level import. Two reasons:
//   1. the bundler emits one lazily-loaded chunk per twin instead of pulling
//      all five twins (and five SQLite schemas) into the CLI's startup path;
//   2. `pome twin start github` only pays for github.
//
// THIS MODULE IS NOT THE WHOLE STORY, and for six releases it was the wrong
// half of it. Everything above was true here and false in aggregate:
// `cli/src/task/{parseTask,taskSchema,githubSeedCompat,seed-compiler,
// seed-compiler-hosted}.ts` top-level-imported twin-github/gmail/linear's
// PACKAGE ROOTS to reach a zod seed schema, and a root export carries the domain
// and the Hono app too — so `pome --version` parsed 698 KB of three twin servers
// while this file's header said it did not. A twin's laziness is a property of
// the CLI's whole static graph, not of this file.
//
// If you need a twin's seed schema or its default world, import its `./seed`
// subpath: `seed.ts` is a zod-only leaf, and that is why the fix needed no
// `async` threading. `scripts/lint/rules/twin-chunks.mjs` is the standing
// gate — it fails on any static edge from the CLI to a twin's root, `db.ts` or
// `domain/`, so this comment cannot go stale again without CI saying so.
//
// `version` is the exception: it is a build-time JSON import of the twin's own
// manifest, so it is inlined into the bundle and needs no module resolution at
// runtime. `cli/src/recorder/specMeta.ts` reports these in every run's
// meta.json and pome-cloud's ingest attributes captured behavior to the exact
// twin build — so the value MUST be the twin's own version, never the CLI's.
import githubManifest from "@pome-sh/twin-github/package.json" with { type: "json" };
import slackManifest from "@pome-sh/twin-slack/package.json" with { type: "json" };
import stripeManifest from "@pome-sh/twin-stripe/package.json" with { type: "json" };
import gmailManifest from "@pome-sh/twin-gmail/package.json" with { type: "json" };
import linearManifest from "@pome-sh/twin-linear/package.json" with { type: "json" };
import type { Recorder } from "../recorder/recorder.js";

/** Canonical first-party twin ids. The source of `TwinName`. */
export const TWIN_NAME_LIST = ["github", "slack", "stripe", "gmail", "linear"] as const;

export type TwinName = (typeof TWIN_NAME_LIST)[number];

/** Mutable copy for error messages / `Array.includes` narrowing. */
export const TWIN_NAMES: readonly string[] = TWIN_NAME_LIST;

export function isTwinName(value: string): value is TwinName {
  return (TWIN_NAMES as readonly string[]).includes(value);
}

/** The account every local Stripe scenario seeds under. The runner mints a JWT
 *  whose `account_id` claim matches this, so `exportState` and the session
 *  resolve to the same account the seed data lives in. */
export const STRIPE_LOCAL_ACCOUNT_ID = "acct_default";

/** Hono app shape the runner serves; kept structural so no entry's emitted
 *  declaration has to name its twin's own vendored Hono types (TS2742). */
export type TwinApp = {
  fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
};

export type TwinBootContext = {
  /** Already twin-shaped seed state. `undefined` means "the twin's default". */
  seedState: unknown;
  runId: string;
  twinBaseUrl?: string;
  /** Shared recorder — every twin in one local run buffers into one stream. */
  recorder: Recorder;
};

/** What a booted twin hands back to `bootTwin`. Deliberately narrow: the
 *  recorder lifecycle is the harness's business, the SQLite handle is the
 *  entry's. */
export type TwinBoot = {
  app: TwinApp;
  exportState(): unknown | Promise<unknown>;
  /** Extra JWT claims the runner mints into the agent token. */
  extraClaims?: Record<string, unknown>;
  /** Release this twin's SQLite handle. */
  closeDb(): void;
};

export type TwinEntry = {
  /** Uppercase env prefix: the agent reads `POME_<envName>_{REST,MCP}_URL`. */
  readonly envName: string;
  /** CONTRACT.md listen-port default for `pome twin start`. */
  readonly defaultPort: number;
  /** Twin-specific port override env var, when CONTRACT.md defines one. */
  readonly portEnvName?: string;
  /** Provider-specific bearer alias, when the provider SDK expects one. */
  readonly tokenEnvName?: string;
  /** The twin package's OWN version, inlined at build time. */
  readonly version: string;
  /** Default world for `pome twin start` with no seed. `undefined` means the
   *  twin seeds its own default during boot. */
  defaultSeed(): Promise<unknown>;
  boot(ctx: TwinBootContext): Promise<TwinBoot>;
};

export const TWIN_REGISTRY: Record<TwinName, TwinEntry> = {
  github: {
    envName: "GITHUB",
    defaultPort: 3333,
    version: githubManifest.version,
    // The github twin's own `defaultSeedState()` is applied by `boot` below
    // when no seed is supplied — the pre-existing standalone behavior.
    defaultSeed: async () => undefined,
    async boot({ seedState, runId, recorder }) {
      const {
        createGitHubCloneApp,
        defaultSeedState,
        GitHubDomain,
        openGitHubCloneDatabase,
      } = await import("@pome-sh/twin-github");
      const db = openGitHubCloneDatabase();
      const domain = new GitHubDomain(db as never);
      domain.seed((seedState === undefined ? defaultSeedState() : seedState) as never);
      const app = (await createGitHubCloneApp({
        db,
        recorder,
        runId,
      } as never)) as TwinApp;
      return {
        app,
        exportState: () => domain.exportState() as unknown,
        closeDb: () => (db as { close(): void }).close(),
      };
    },
  },

  slack: {
    envName: "SLACK",
    defaultPort: 3333,
    version: slackManifest.version,
    defaultSeed: async () => (await import("@pome-sh/twin-slack")).defaultSeedState(),
    async boot({ seedState, runId, recorder }) {
      const { createSlackTwinApp, openSlackTwinDatabase, SlackDomain } =
        await import("@pome-sh/twin-slack");
      const db = openSlackTwinDatabase(":memory:");
      const domain = new SlackDomain(db);
      // `applySeed` runs the twin's own `parseSeed` (regex/shape validation +
      // default-filling) before seeding, so the permissive scenario-side
      // `slackSeedStateSchema` is tightened to the twin's contract here.
      domain.applySeed(seedState);
      const app = createSlackTwinApp({
        db,
        domain,
        // One shared CLI recorder buffers events for every twin; the engine
        // types its param as `RecorderStore` (same structural shape).
        recorder: recorder as NonNullable<Parameters<typeof createSlackTwinApp>[0]>["recorder"],
        runId,
      }) as TwinApp;
      return {
        app,
        exportState: () => domain.exportState(),
        closeDb: () => db.close(),
      };
    },
  },

  stripe: {
    envName: "STRIPE",
    defaultPort: 3333,
    version: stripeManifest.version,
    defaultSeed: async () => (await import("@pome-sh/twin-stripe")).defaultSeed(),
    async boot({ seedState, runId, recorder, twinBaseUrl }) {
      // Engine-based twin: the factory owns middleware, MCP mount, and
      // the failure-injection store — seed rules ride in via `seed` and land in
      // the same store the session middleware reads, so e.g.
      // scenario 14's lost-response 402 actually fires. Recorder counters
      // (dropped) come from the engine handle, so the shared CLI recorder
      // suffices here too.
      const stripeTwin = await import("@pome-sh/twin-stripe");
      const { createApp } = await import("@pome-sh/sdk/server");
      const {
        applySeed: applyStripeSeed,
        createTwinStripeApp,
        openTwinStripeDatabase,
        parseSeed: parseStripeSeed,
        StripeDomain,
      } = stripeTwin;
      const db = openTwinStripeDatabase(":memory:");
      const domain = new StripeDomain(db);
      const seed = parseStripeSeed(seedState);
      const baseUrl = twinBaseUrl ?? "http://127.0.0.1:3333";
      type StripeDefinitionFactory = (factoryOpts: {
        db: ReturnType<typeof openTwinStripeDatabase>;
        twinBaseUrl?: string;
      }) => Parameters<typeof createApp>[0];
      const createStripeTwinDefinition = (
        stripeTwin as typeof stripeTwin & {
          createStripeTwinDefinition?: StripeDefinitionFactory;
        }
      ).createStripeTwinDefinition;
      const app = (createStripeTwinDefinition
        ? createApp(createStripeTwinDefinition({ db, twinBaseUrl: baseUrl }), {
            db,
            recorder,
            runId,
            seed,
          })
        : (() => {
            // Older published twin-stripe packages predate the additive `seed`
            // app option. Seed explicitly so local runs don't boot an empty
            // credential store when the CLI resolves that package.
            applyStripeSeed(db, seed);
            return createTwinStripeApp({
              db,
              recorder:
                recorder as NonNullable<Parameters<typeof createTwinStripeApp>[0]>["recorder"],
              runId,
              twinBaseUrl: baseUrl,
            } as Parameters<typeof createTwinStripeApp>[0] & { twinBaseUrl?: string });
          })()) as TwinApp;
      return {
        app,
        exportState: () => domain.exportState(STRIPE_LOCAL_ACCOUNT_ID),
        extraClaims: { account_id: STRIPE_LOCAL_ACCOUNT_ID },
        closeDb: () => db.close(),
      };
    },
  },

  gmail: {
    envName: "GMAIL",
    defaultPort: 3336,
    portEnvName: "GMAIL_TWIN_PORT",
    tokenEnvName: "POME_GMAIL_TOKEN",
    version: gmailManifest.version,
    defaultSeed: async () => (await import("@pome-sh/twin-gmail")).defaultSeedState(),
    async boot({ seedState, runId, recorder }) {
      const { createGmailTwinApp, GmailDomain, openGmailTwinDatabase, parseSeed } =
        await import("@pome-sh/twin-gmail");
      const db = openGmailTwinDatabase(":memory:");
      const seed = parseSeed(seedState);
      const domain = new GmailDomain(db);
      const app = createGmailTwinApp({ db, seed, recorder, runId }) as TwinApp;
      return {
        app,
        exportState: () => domain.exportState(),
        extraClaims: { gmail_email: seed.primaryMailbox.email },
        closeDb: () => db.close(),
      };
    },
  },

  linear: {
    envName: "LINEAR",
    defaultPort: 3337,
    portEnvName: "LINEAR_TWIN_PORT",
    tokenEnvName: "POME_LINEAR_TOKEN",
    version: linearManifest.version,
    defaultSeed: async () => (await import("@pome-sh/twin-linear")).defaultSeedState(),
    async boot({ seedState, runId, recorder }) {
      const {
        createLinearTwinApp,
        DEFAULT_LINEAR_EMAIL,
        LinearDomain,
        openLinearTwinDatabase,
        parseSeed,
      } = await import("@pome-sh/twin-linear");
      const db = openLinearTwinDatabase(":memory:");
      const seed = parseSeed(seedState);
      const domain = new LinearDomain(db);
      const app = createLinearTwinApp({ db, seed, recorder, runId }) as TwinApp;
      const primaryEmail =
        seed.users.find((user) => user.admin)?.email ??
        seed.users[0]?.email ??
        DEFAULT_LINEAR_EMAIL;
      return {
        app,
        exportState: () => domain.exportState(),
        extraClaims: { linear_email: primaryEmail },
        closeDb: () => db.close(),
      };
    },
  },
};

/**
 * The github twin's app with its own default world and no CLI session wiring —
 * `pome health`'s in-process smoke check, and the fixture the adapter tests
 * drive. Return type is pinned to `unknown` (every caller casts to its own view
 * of the app) so tsc does not try to name the twin's Hono app type in this
 * module's emitted declarations: that inferred type references twin-github's
 * own copy of hono and is not portable (TS2742).
 */
export async function createGitHubSmokeApp(): Promise<unknown> {
  const { createGitHubCloneApp } = await import("@pome-sh/twin-github");
  return createGitHubCloneApp();
}

/** Every twin's own package version, keyed by twin id. Consumed by
 *  `specMeta.ts` for the meta.json `twin_versions` block. */
export function twinVersions(): Record<TwinName, string> {
  const out = {} as Record<TwinName, string>;
  for (const name of TWIN_NAME_LIST) out[name] = TWIN_REGISTRY[name].version;
  return out;
}

/** Resolve the listen port for `pome twin start` when `--port` is omitted.
 *  `PORT` wins for every twin (contract suite / packaged entries); gmail and
 *  linear additionally honor their own CONTRACT.md override. */
export function defaultPortFor(
  twin: TwinName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PORT) return env.PORT;
  const entry = TWIN_REGISTRY[twin];
  const override = entry.portEnvName ? env[entry.portEnvName] : undefined;
  return override ?? String(entry.defaultPort);
}
