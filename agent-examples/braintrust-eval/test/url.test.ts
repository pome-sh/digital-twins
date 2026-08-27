// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { trimTrailingSlashes } from "../src/url.js";

describe("trimTrailingSlashes", () => {
  it("leaves a clean base alone and strips however many slashes it finds", () => {
    expect(trimTrailingSlashes("https://api.pome.sh")).toBe("https://api.pome.sh");
    expect(trimTrailingSlashes("https://api.pome.sh/")).toBe("https://api.pome.sh");
    expect(trimTrailingSlashes("https://api.pome.sh///")).toBe("https://api.pome.sh");
    expect(trimTrailingSlashes("")).toBe("");
    expect(trimTrailingSlashes("///")).toBe("");
  });

  // The reason this is a loop and not `.replace(/\/+$/, "")`: CodeQL's
  // `js/polynomial-redos` flags the anchored-`+` form as high severity, because
  // the base URL comes from a caller-supplied env var and a string of many
  // trailing slashes makes the match quadratic. `cli/src/contract/manifest.ts`
  // carries the same ruling for `/^-+|-+$/g` in `deriveAgentSlug`. This case is
  // the input that would have been slow.
  it("is linear in the number of trailing slashes", () => {
    const pathological = `https://api.pome.sh${"/".repeat(50_000)}`;
    const startedAt = Date.now();

    expect(trimTrailingSlashes(pathological)).toBe("https://api.pome.sh");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
