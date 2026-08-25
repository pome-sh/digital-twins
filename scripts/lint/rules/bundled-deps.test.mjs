#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for bundled-deps. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

const BUNDLED = [
  "packages/sdk",
  "packages/wire",
  "packages/twin-github",
  "packages/twin-slack",
  "packages/twin-stripe",
  "packages/twin-gmail",
  "packages/twin-linear",
];

function tree({ cliDeps = {}, overrides = {} } = {}) {
  const files = {
    "cli/package.json": JSON.stringify({ name: "@pome-sh/cli", version: "1.0.0", dependencies: cliDeps }),
  };
  for (const dir of BUNDLED) {
    files[`${dir}/package.json`] = JSON.stringify({ name: `@pome-sh/${dir.split("/")[1]}` });
  }
  return { ...files, ...overrides };
}

const withDeps = (dir, manifest) => ({ [`${dir}/package.json`]: JSON.stringify(manifest) });

defineCases("bundled-deps", [
  {
    name: "no third-party runtime deps at all passes",
    files: tree(),
    expect: "green",
  },
  {
    name: "a twin's dependency the CLI does not declare is a violation (the graphql shape)",
    files: tree({
      overrides: withDeps("packages/twin-linear", {
        name: "@pome-sh/twin-linear",
        dependencies: { graphql: "^16.0.0" },
      }),
    }),
    expect: "red",
    contains: ["graphql", "needed by @pome-sh/twin-linear"],
  },
  {
    name: "the same dependency declared by the CLI passes",
    files: tree({
      cliDeps: { graphql: "^16.0.0" },
      overrides: withDeps("packages/twin-linear", {
        name: "@pome-sh/twin-linear",
        dependencies: { graphql: "^16.0.0" },
      }),
    }),
    expect: "green",
  },
  {
    name: "peerDependencies count as runtime requirements",
    files: tree({
      overrides: withDeps("packages/sdk", {
        name: "@pome-sh/sdk",
        peerDependencies: { "@hono/node-server": "^1.0.0" },
      }),
    }),
    expect: "red",
    contains: "@hono/node-server",
  },
  {
    name: "an internal @pome-sh/* dep is inlined, not required",
    files: tree({
      overrides: withDeps("packages/twin-github", {
        name: "@pome-sh/twin-github",
        dependencies: { "@pome-sh/sdk": "*" },
      }),
    }),
    expect: "green",
  },
  {
    name: "an internal @pome-sh/* left in the CLI's runtime deps is a violation",
    files: tree({ cliDeps: { "@pome-sh/wire": "*" } }),
    expect: "red",
    contains: "declares internal package @pome-sh/wire",
  },
]);
