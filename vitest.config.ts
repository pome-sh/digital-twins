import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Every vitest project in the repo, in one place. `npx vitest run` is the whole
// vitest suite -- one process, one report -- which is what makes "npm test"
// mean the tests rather than eleven sequential npm invocations.
//
// `environment: "node"` is gone from every entry: it is vitest's default, and
// project entries do NOT inherit root-level `test` options, so there is no root
// default here that a project could silently diverge from.
//
// COVERAGE IS DELIBERATELY NOT HERE. vitest reads `coverage` only at the root
// level, and a `coverage` block written inside a project entry is dropped with
// no warning -- measured against a 99% line threshold on a 75%-covered project,
// the run exits 0 having applied nothing. twin-github and twin-slack need
// different thresholds against their own src/, and a single root block would
// pool coverage across every project and let one package hide under another's.
// So each of those two keeps a `vitest.coverage.config.ts`, named for its one
// purpose and passed explicitly by `test:coverage` with --config, rather than a
// second `vitest.config.ts` that only one of the two invocation paths reads.

const repo = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Every packages/* directory that ships tests, discovered rather than listed.
 *  A hand-written list here would be a second source of truth against the root
 *  `workspaces` glob: adding packages/twin-foo would compile, typecheck and pass
 *  every gate while none of its tests ever ran. */
const PACKAGES = readdirSync(repo("./packages"))
  .filter((name) => existsSync(repo(`./packages/${name}/package.json`)))
  .filter((name) => existsSync(repo(`./packages/${name}/test`)))
  .sort();

// The official-client, agent-path, socket-boundary and checks-contract suites
// drive real MCP handshakes over a listening socket; on a contended CI runner
// the sequential round-trips cross vitest's 5s default.
const TWIN = { testTimeout: 30_000 };

// Was packages/twin-slack/test/setup.ts, a `setupFiles` whose whole body set
// these two variables in a beforeAll. `env` sets them before any module loads,
// which is strictly earlier, and it does not need a file.
const SLACK = {
  ...TWIN,
  env: {
    TWIN_AUTH_SECRET: "test-secret-32-chars-minimum-length",
    SLACK_DETERMINISTIC_TS: "1",
  },
};

const EXTRA: Record<string, Record<string, unknown>> = { "twin-slack": SLACK };

export default defineConfig({
  test: {
    projects: [
      ...PACKAGES.map((name) => ({
        test: {
          name,
          root: `./packages/${name}`,
          include: ["test/**/*.test.ts"],
          ...(EXTRA[name] ?? (name.startsWith("twin-") ? TWIN : {})),
        },
      })),
      {
        test: {
          name: "cli",
          root: "./cli",
          include: ["test/**/*.test.ts"],
          env: { POME_CLI_DISABLE_KEYCHAIN: "1" },
          testTimeout: 15_000,
          hookTimeout: 15_000,
          // The cli suite runs AFTER every packages/* project, alone in the
          // worker pool -- a higher groupOrder is a barrier, not a hint.
          //
          // Its e2e files boot twins and spawn capture-servers on real ports,
          // and so do the twin suites. Under the previous arrangement cli was a
          // separate vitest process that CI ran after the packages, so the two
          // never overlapped. Collapsing them into one pool made them overlap
          // and runTaskCapture + demo-e2e failed on the first full run and
          // passed on the second -- flaky, not broken, which is the worse
          // outcome of the two. This keeps the ordering the old invocation gave
          // for free.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
