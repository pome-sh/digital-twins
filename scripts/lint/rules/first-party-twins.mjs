// SPDX-License-Identifier: Apache-2.0
//
// The first-party twin list is read from config, never typed twice.

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

    compare(
      "packages/checks/src/index.ts CHECKS_TWIN_NAMES",
      quotedArray("packages/checks/src/index.ts", "CHECKS_TWIN_NAMES"),
    );
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
