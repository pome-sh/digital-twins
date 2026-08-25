// SPDX-License-Identifier: Apache-2.0
//
// Every third-party dep of an inlined workspace package must be declared by the
// publisher, or it becomes ERR_MODULE_NOT_FOUND for the user.

const BUNDLED_PACKAGES = [
  "packages/sdk",
  "packages/wire",
  "packages/twin-github",
  "packages/twin-slack",
  "packages/twin-stripe",
  "packages/twin-gmail",
  "packages/twin-linear",
];

const INLINED = [/^@pome-sh\//];

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
