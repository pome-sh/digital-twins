// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOUNTED_TWINS } from "../../src/contract/index.js";
import { createProgram } from "../../src/cli/main.js";
import {
  checksFor,
  checksHeader,
  pinLabel,
  pinnedVersion,
  twinsWithoutChecks,
} from "../../src/cli/checks.js";

// Read straight from the workspace tree, on purpose: the assertion must not
// share a resolution mechanism with the code under test.
function workspaceVersion(dir: string): string {
  const manifest = JSON.parse(
    readFileSync(new URL(`../../../packages/${dir}/package.json`, import.meta.url), "utf8"),
  ) as { version: string };
  return manifest.version;
}

interface CapturedConsole {
  log: string[];
  error: string[];
}

function captureConsole(): CapturedConsole {
  const captured: CapturedConsole = { log: [], error: [] };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.log.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.error.push(args.map(String).join(" "));
  });
  return captured;
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("pome checks", () => {
  it("lists a twin's declared checks with what each one actually compares", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "github"]);
    const out = captured.log.join("\n");
    expect(out).toContain("github.no-new-labels");
    // The slot is displayed by NAME, derived from the template — no title field
    // has to exist for a listing to be readable.
    expect(out).toContain("No new labels were created in `<repo>`");
    // The description is the whole reason the declaration gained one.
    expect(out).toContain("DEFINITIONS");
    // Discovery hands over the command instead of describing it.
    expect(out).toContain("--check github.no-new-labels --arg repo=acme/api");
    expect(process.exitCode).toBeUndefined();
  });

  it("indexes the twins that declare checks when none is given", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks"]);
    expect(captured.log.join("\n")).toContain("github");
  });

  // A3's completion invariant.
  it("leaves no mounted twin without a declared vocabulary", () => {
    expect(twinsWithoutChecks()).toEqual([]);
    for (const twin of MOUNTED_TWINS) {
      expect(checksFor(twin).length, `${twin} declares no checks`).toBeGreaterThan(0);
    }
  });

  it("errors with a hint on an unknown twin", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "gitbub"]);
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("github");
  });

  // F-1791: the header printed "(@pome-sh/twin-github unknown)" on every
  // install. The old lookup read the CLI's own `dependencies`, but tsup INLINES
  // the twins now — they are devDependency workspace links, so that manifest
  // key can never name them again. The version that belongs here is the one of
  // the twin code actually riding in this process.
  it("names the inlined twin version in the header, never 'unknown'", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "github"]);
    const header = captured.log[0]!;
    expect(header).toContain(`(@pome-sh/twin-github ${workspaceVersion("twin-github")})`);
    expect(header).not.toContain("unknown");
  });

  it("resolves an inlined package's version from the workspace link in dev", () => {
    expect(pinnedVersion("@pome-sh/twin-github")).toBe(workspaceVersion("twin-github"));
    expect(pinnedVersion("@pome-sh/sdk")).toBe(workspaceVersion("sdk"));
  });

  // The honest branch: when no version is resolvable the parenthetical is
  // OMITTED — a word like "unknown" in the first line of the vocabulary
  // listing reads as a defect, which is exactly how F-1791 was filed.
  it("omits the version parenthetical entirely when it cannot be resolved", () => {
    expect(pinnedVersion("@pome-sh/no-such-package")).toBeUndefined();
    expect(checksHeader("github", 16, undefined)).toBe("github — 16 declared checks");
    expect(pinLabel("@pome-sh/no-such-package")).toBe("@pome-sh/no-such-package");
  });

  // The published tarball has no workspace to fall back to, so the build must
  // bake the versions in. Assert the map the tsup config defines, not the
  // bundling itself: every inlined @pome-sh package, each with a real version.
  it("bakes a version for every inlined @pome-sh package into the bundle", async () => {
    const config = (await import("../../tsup.config.js")).default as {
      define?: Record<string, string>;
    };
    const baked = JSON.parse(JSON.parse(config.define!.POME_INLINED_PKG_VERSIONS!)) as Record<
      string,
      string
    >;
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const inlined = Object.keys(manifest.devDependencies).filter((dep) =>
      dep.startsWith("@pome-sh/"),
    );
    expect(inlined.length).toBeGreaterThan(0);
    for (const dep of inlined) {
      expect(baked[dep], `${dep} has no baked version`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("--json emits the declaration plus a digest, for skills and agents", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "github", "--json"]);
    const body = JSON.parse(captured.log.join("\n")) as {
      twin: string;
      digest: string;
      checks: Array<{ id: string; description: string; params: Array<{ example: string }> }>;
    };
    expect(body.twin).toBe("github");
    expect(body.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Look the check up by id rather than by index.
    const noNewLabels = body.checks.find((check) => check.id === "github.no-new-labels")!;
    expect(noNewLabels.params[0]!.example).toBe("acme/api");
    // Every declaration must carry a description an authoring surface can show, so assert it of ALL of them rather than of whichever sorts first.
    for (const check of body.checks) {
      expect(check.description.length, `${check.id} declares no description`).toBeGreaterThan(0);
    }
  });
});
