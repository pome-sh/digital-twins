// SPDX-License-Identifier: Apache-2.0
//
// Canonical first-party registration drift. First-party twins must be explicit
// at operational seams (contracts, bundles, images), but those explicit arrays
// are easy to update incompletely. This rule compares every registration with
// config/first-party-twins.json and fails loudly.
//
// The CLI's own registration is no longer a hand-maintained array: `TwinName` is
// derived from `TWIN_NAME_LIST` and `TWIN_REGISTRY` is a
// `Record<TwinName, TwinEntry>`, so a missing CLI entry is a compile error and
// the per-entry values are asserted by cli/test/unit/twin/registry.test.ts.
// `TWIN_NAME_LIST` itself is still compared here — that list is what the type is
// derived FROM, so nothing inside the CLI can catch it drifting from the
// canonical set. The seams below live outside the type system entirely (twin
// images, the black-box contract suite, the wire enums, workflow path filters)
// and are the reason this rule survives.
//
// Two seams deliberately absent: Docker base-image updates are Renovate's,
// which auto-discovers every `packages/twin-*/Dockerfile`; and the build order
// is a topological sort over `npm query .workspace`, which names no package, so
// a twin missing from the build is not expressible.

export default {
  name: "first-party-twins",
  describe: "every first-party twin registration seam agrees with config/first-party-twins.json",
  check(ctx) {
    const canonical = ctx.json("config/first-party-twins.json").twins;
    const expected = [...canonical].sort();
    const violations = [];

    const compare = (label, actual) => {
      const sorted = [...new Set(actual)].sort();
      if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
        violations.push(`${label}: expected [${expected.join(", ")}], got [${sorted.join(", ")}]`);
      }
    };

    /** A quoted-string array declared under `exportName`, read from source. */
    const quotedArray = (path, exportName) => {
      const match = ctx
        .readRel(path)
        .match(new RegExp(`(?:const|export const)\\s+${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\](?:\\s+as const)?`));
      if (!match) throw new Error(`${path}: could not find array ${exportName}`);
      return [...match[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)].map((item) => item[1]);
    };

    compare("cli/src/contract/sessions.ts MOUNTED_TWINS", quotedArray("cli/src/contract/sessions.ts", "MOUNTED_TWINS"));
    compare(
      "packages/wire/src/recorder-events.ts KNOWN_TWIN_IDS",
      quotedArray("packages/wire/src/recorder-events.ts", "KNOWN_TWIN_IDS"),
    );
    compare("cli/src/twin/registry.ts TWIN_NAME_LIST", quotedArray("cli/src/twin/registry.ts", "TWIN_NAME_LIST"));

    // `@pome-sh/checks` carries every twin's grading vocabulary to pome-cloud,
    // and its barrel names the twins explicitly; there is no way to derive them,
    // since each twin's array has a different element type. A new twin missing
    // here does not fail to compile and does not fail any twin's own contract
    // suite — it produces a criterion that silently never binds, which is the
    // exact failure that package exists to prevent.
    compare(
      "packages/checks/src/index.ts CHECKS_TWIN_NAMES",
      quotedArray("packages/checks/src/index.ts", "CHECKS_TWIN_NAMES"),
    );
    // `@pome-sh/sandbox-domains` carries the other half to the same consumer.
    // Same seam, one step worse: a twin missing here compiles, and its criteria
    // do not merely fail to bind, they bind against a vocabulary whose runtime
    // pome-cloud cannot construct at all. Both arrays are checked because the
    // two packages are the two legs of `checks-package-drift`.
    compare(
      "packages/sandbox-domains/src/index.ts SANDBOX_DOMAIN_NAMES",
      quotedArray("packages/sandbox-domains/src/index.ts", "SANDBOX_DOMAIN_NAMES"),
    );

    compare(
      "contract/helpers.mjs ALL_TWINS",
      [
        ...ctx
          .readRel("contract/helpers.mjs")
          .matchAll(/\{\s*name:\s*"([a-z][a-z0-9-]*)",\s*pkg:\s*"packages\/twin-/g),
      ].map((match) => match[1]),
    );
    compare(
      "contract/cli-start.test.mjs TWINS",
      [...ctx.readRel("contract/cli-start.test.mjs").matchAll(/cliStart\("([a-z][a-z0-9-]*)"/g)].map(
        (match) => match[1],
      ),
    );

    // Twin-image matrix is dynamic on PRs (`detect-twins`); the canonical full
    // set is declared as FIRST_PARTY_TWINS (and mirrored in the detect script's
    // `all='[...]'` / `for twin in ...` loop).
    const imageText = ctx.readRel(".github/workflows/twin-image.yml");
    const imageRaw =
      imageText.match(/#\s*FIRST_PARTY_TWINS:\s*([^\n]+)/)?.[1] ??
      imageText.match(/all='\[([^\]]+)\]'/)?.[1] ??
      imageText.match(/twin:\s*\[([^\]]+)\]/)?.[1];
    if (!imageRaw) throw new Error(".github/workflows/twin-image.yml: twin matrix not found");
    compare(
      ".github/workflows/twin-image.yml matrix",
      imageRaw
        .split(/[,\s]+/)
        .map((value) => value.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    );

    // The twins are bundled into the CLI by tsup (`noExternal: [/^@pome-sh\//]`),
    // so they are devDependencies of cli, not runtime deps. That list is still a
    // registration seam: a twin missing from it would not install, and its
    // registry entry's `import()` would not resolve.
    compare(
      "cli/package.json devDependencies",
      Object.keys(ctx.json("cli/package.json").devDependencies)
        .filter((name) => name.startsWith("@pome-sh/twin-"))
        .map((name) => name.slice("@pome-sh/twin-".length)),
    );

    for (const workflow of [
      ".github/workflows/twin-image.yml",
      ".github/workflows/agent-trace-overhead-gate.yml",
    ]) {
      const text = ctx.readRel(workflow);
      for (const twin of canonical) {
        if (!text.includes(`packages/twin-${twin}/**`)) {
          violations.push(`${workflow}: missing packages/twin-${twin}/** path filter`);
        }
      }
    }

    compare(
      "cli/src/cli/tasks-catalog.ts TASK_TWINS",
      [...ctx.readRel("cli/src/cli/tasks-catalog.ts").matchAll(/^\s{4}id:\s*"([a-z][a-z0-9-]*)",$/gm)].map(
        (match) => match[1],
      ),
    );

    return { violations, summary: `registrations agree: ${canonical.join(", ")}` };
  },
};
