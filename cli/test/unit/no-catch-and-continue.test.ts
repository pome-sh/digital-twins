// SPDX-License-Identifier: Apache-2.0
// F-745 / D4 — the no-catch-and-continue gate must (a) pass on the real SDK
// engine tree (every catch there rethrows, returns an error/sentinel, or
// rejects) and (b) FAIL the moment a statement-level catch clause in
// packages/sdk/src swallows a failure without throwing, returning, or
// rejecting. Promise `.catch(cb)` handlers are OUT of scope.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs gate script, no type declarations.
import { findViolations } from "../../../scripts/no-catch-and-continue.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("no-catch-and-continue gate (SDK engine)", () => {
  it("passes on the real SDK engine tree", async () => {
    const violations = await findViolations(repoRoot);
    expect(violations).toEqual([]);
  });

  describe("tmp-dir fixtures", () => {
    let tmp: string;
    let engineDir: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), "no-catch-gate-"));
      engineDir = join(tmp, "packages", "sdk", "src");
      await mkdir(engineDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    const write = (name: string, body: string) => writeFile(join(engineDir, name), body);

    it("flags an empty catch (a)", async () => {
      await write("bad.ts", "export function f() {\n  try {\n    risky();\n  } catch {\n  }\n}\n");
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("flags a log-only catch (b)", async () => {
      await write(
        "bad.ts",
        "export function f() {\n  try {\n    risky();\n  } catch (e) {\n    console.error(e);\n  }\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("accepts a catch that throws (c)", async () => {
      await write(
        "ok.ts",
        "export function f() {\n  try {\n    risky();\n  } catch (e) {\n    throw new Error(String(e));\n  }\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("accepts a catch that returns (d)", async () => {
      await write(
        "ok.ts",
        "export function f(): number | undefined {\n  try {\n    return risky();\n  } catch {\n    return undefined;\n  }\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("ignores the word catch inside a comment or string (e)", async () => {
      await write(
        "ok.ts",
        [
          "// this comment mentions catch but is not a catch clause { }",
          'const s = "we catch nothing here { }";',
          "const t = `template catch { }`;",
          "export const x = 1;",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("ignores a Promise .catch(cb) handler — out of scope (f)", async () => {
      await write(
        "ok.ts",
        "export async function f() {\n  await risky().catch(() => {});\n  const b = await g().catch(() => ({}));\n  return b;\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });
  });
});
