#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table. Case 2 is the shape that actually
// happened: `graphql`, twin-linear's GraphQL executor, was a dependency of the
// twin and of nothing else, so the bundler left an unresolvable bare import in a
// lazily-loaded chunk and the failure landed on a user, not on CI.

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

/** Every inlined package with no third-party deps, plus whatever `overrides` says. */
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
    // The sdk's optional `@hono/node-server` peer is a real runtime import on
    // the server path, so peers count.
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
    // An internal `@pome-sh/*` spec is inlined by the bundler, so it is not a
    // requirement the CLI has to declare.
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
    // None of them is installable by an end user, so a leaked spec breaks the
    // install of the published CLI.
    name: "an internal @pome-sh/* left in the CLI's runtime deps is a violation",
    files: tree({ cliDeps: { "@pome-sh/wire": "*" } }),
    expect: "red",
    contains: "declares internal package @pome-sh/wire",
  },
]);
