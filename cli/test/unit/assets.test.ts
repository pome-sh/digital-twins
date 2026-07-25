// SPDX-License-Identifier: Apache-2.0
//
// Asset-resolution suite for the bundled dist layout.
//
// The CLI reads three non-code files at runtime: the fix-prompt system prompt
// (read at MODULE SCOPE, so a wrong path is a startup crash, not a lazy error)
// and the packaged demo task markdown + its seed sidecar. All three used to be
// resolved with `dirname(fileURLToPath(import.meta.url))` relative to their
// importing module and copied into a mirrored `dist/src/...` tree.
//
// Under bundling that is unresolvable in principle: with `splitting: true` the
// importing module has no file of its own — `fix-prompt/prompt.ts` may be
// inlined into `dist/src/cli/main.js` or into a shared `dist/chunk-*.js`
// depending on how esbuild split the graph. These tests pin the replacement:
// assets live at `<packageRoot>/assets/**` in every layout, reachable from
// anywhere inside `dist/`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assetPath } from "../../src/cli/assets.js";
import { DEMO_TASK_NAME, demoTaskPath } from "../../src/demo/task.js";
import {
  FIX_PROMPT_SYSTEM_PROMPT,
  FIX_PROMPT_TEMPLATE_VERSION,
} from "../../src/fix-prompt/prompt.js";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("assetPath", () => {
  it("resolves under <packageRoot>/assets, not relative to the calling module", () => {
    const resolved = assetPath("demo", `${DEMO_TASK_NAME}.md`);
    expect(resolved).toBe(join(CLI_ROOT, "assets", "demo", `${DEMO_TASK_NAME}.md`));
    expect(existsSync(resolved)).toBe(true);
  });

  it("throws a packaging-bug error for a missing asset instead of returning a path", () => {
    expect(() => assetPath("demo", "not-shipped.md")).toThrow(/Packaged asset not found/);
  });
});

describe("fix-prompt system prompt", () => {
  it("loads at module scope — a wrong path would be a startup crash", () => {
    // The export is the result of a module-scope readFileSync; reaching this
    // assertion at all proves the asset resolved.
    expect(FIX_PROMPT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("is the versioned file on disk, byte-for-byte", () => {
    const onDisk = readFileSync(
      join(CLI_ROOT, "assets", "fix-prompt", "prompts", `fix-prompt-${FIX_PROMPT_TEMPLATE_VERSION}.md`),
      "utf8",
    );
    expect(FIX_PROMPT_SYSTEM_PROMPT).toBe(onDisk);
  });
});

describe("packaged demo task", () => {
  it("resolves the markdown", () => {
    const path = demoTaskPath();
    expect(path.endsWith(join("assets", "demo", `${DEMO_TASK_NAME}.md`))).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(DEMO_TASK_NAME);
  });

  it("ships its seed sidecar next to the markdown", () => {
    // `default-task.ts` derives the sidecar path by swapping the extension, so
    // the two files must stay co-located.
    const sidecar = demoTaskPath().replace(/\.md$/, ".seed.json");
    expect(existsSync(sidecar)).toBe(true);
    expect(() => JSON.parse(readFileSync(sidecar, "utf8"))).not.toThrow();
  });
});

describe("cli/package.json packaging", () => {
  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as {
    files: string[];
    dependencies: Record<string, string>;
    bundleDependencies?: string[];
  };

  it("ships assets/ in the tarball", () => {
    // Without this the published CLI crashes on startup in `pome fix-prompt`.
    expect(pkg.files).toContain("assets");
  });

  it("declares no internal @pome-sh/* runtime dependency (all are bundled)", () => {
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("@pome-sh/"))).toEqual([]);
  });

  it("no longer declares bundleDependencies", () => {
    // bundleDependencies packs from cli/node_modules, which npm leaves empty
    // for a workspace member — it declared seven bundled packages and shipped
    // none. The bundler replaces it.
    expect(pkg.bundleDependencies).toBeUndefined();
  });
});
