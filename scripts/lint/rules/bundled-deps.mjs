// SPDX-License-Identifier: Apache-2.0
//
// The CLI bundles every internal `@pome-sh/*` package into its own dist
// (`noExternal: [/^@pome-sh\//]`), so those packages' own `dependencies` stop
// being installed for them: whatever they `import` has to resolve from the
// PUBLISHED CLI's dependency tree instead. Nothing in the type system or the
// bundler notices when it cannot — esbuild happily leaves an unresolvable bare
// import in a lazily-loaded chunk, and the failure lands on a user running
// `pome twin start linear` with ERR_MODULE_NOT_FOUND.
//
// That is exactly how `graphql` (twin-linear's GraphQL executor) slipped
// through. This rule unions the third-party runtime dependencies of every
// internal package the CLI inlines and asserts each one is satisfiable from the
// CLI manifest — either declared in cli `dependencies`, or inlined by the
// bundler (`noExternal`).

// Every workspace package the CLI inlines. Kept explicit rather than globbed:
// a new internal package must be a deliberate addition here, and
// adapter-claude-sdk is NOT in the CLI's graph (it is published separately).
const BUNDLED_PACKAGES = [
  "packages/sdk",
  "packages/wire",
  "packages/twin-github",
  "packages/twin-slack",
  "packages/twin-stripe",
  "packages/twin-gmail",
  "packages/twin-linear",
];

// Bare specifiers the bundler inlines rather than leaves as imports. Mirrors
// cli/tsup.config.ts `noExternal`.
const INLINED = [/^@pome-sh\//];

/** Third-party runtime specifiers each bundled package needs at runtime.
 *  `peerDependencies` count: the sdk's optional `@hono/node-server` peer is a
 *  real runtime import on the server path. */
function requiredSpecifiers(ctx) {
  const required = new Map(); // specifier -> [packages needing it]
  for (const dir of BUNDLED_PACKAGES) {
    const manifest = ctx.json(`${dir}/package.json`);
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const spec of Object.keys(manifest[field] ?? {})) {
        if (INLINED.some((pattern) => pattern.test(spec))) continue;
        required.set(spec, [...(required.get(spec) ?? []), manifest.name]);
      }
    }
  }
  return required;
}

export default {
  name: "bundled-deps",
  describe: "every specifier imported by a CLI-inlined package resolves from the CLI manifest",
  check(ctx) {
    const cliManifest = ctx.json("cli/package.json");
    const declared = new Set(Object.keys(cliManifest.dependencies ?? {}));
    const required = requiredSpecifiers(ctx);

    const violations = [];
    for (const [spec, needers] of required) {
      if (declared.has(spec)) continue;
      violations.push(
        `${spec} (needed by ${needers.join(", ")}) is neither in cli \`dependencies\` nor inlined by ` +
          `the bundler — a lazily-loaded twin chunk would die with ERR_MODULE_NOT_FOUND.`,
      );
    }

    // @pome-sh/* left in the published runtime deps: none of them is
    // installable by an end user, so a leaked spec breaks the install. The sdk
    // and the twins are `private: true` and on no registry at all, and
    // `@pome-sh/wire` is published only to GitHub Packages, which answers 401
    // without a token. All of them are inlined by the bundler instead.
    for (const spec of declared) {
      if (!spec.startsWith("@pome-sh/")) continue;
      violations.push(
        `${cliManifest.name} declares internal package ${spec} as a runtime dependency — it is not ` +
          `installable by an end user. Remove the dependency, do not publish it.`,
      );
    }

    return {
      violations,
      summary: `${required.size} third-party specifier(s) from ${BUNDLED_PACKAGES.length} inlined packages all satisfiable`,
      hint:
        "Fix: add the package to cli/package.json `dependencies` (preferred for large or CJS-heavy\n" +
        "libraries such as graphql), or add it to `noExternal` in cli/tsup.config.ts so the bundler\n" +
        "inlines it.",
    };
  },
};
