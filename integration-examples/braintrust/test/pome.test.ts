// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { WORLDS } from "../src/dataset.js";
import { assertWorldSeeded, controlPlaneRequest } from "../src/pome.js";

describe("controlPlaneRequest", () => {
  it("bearers the team API key against api.pome.sh", () => {
    const req = controlPlaneRequest({ POME_API_KEY: "pme_abc_def" }, "GET", "/v1/me");

    expect(req.url).toBe("https://api.pome.sh/v1/me");
    expect(req.headers.authorization).toBe("Bearer pme_abc_def");
  });

  // The credential is read HERE, off a passed-in environment, and never at
  // module load. `scripts/smoke-examples.mjs` launches every example for real on
  // every PR with no POME_API_KEY set; an example that resolved its key while
  // the module body evaluated would crash before reaching any outbound call and
  // red CI for everyone. Taking `env` as an argument makes that impossible
  // rather than merely unlikely.
  it("sends no Authorization header at all when there is no key, rather than throwing", () => {
    const req = controlPlaneRequest({}, "GET", "/v1/me");

    expect(req.headers.authorization).toBeUndefined();
    expect(req.url).toBe("https://api.pome.sh/v1/me");
  });

  it("honours POME_API_URL, which is what points the CI smoke leg at a dead port", () => {
    const req = controlPlaneRequest(
      { POME_API_URL: "http://127.0.0.1:59321/", POME_API_KEY: "pme_x" },
      "POST",
      "/v1/sandboxes",
      { twins: ["stripe"] },
    );

    expect(req.url).toBe("http://127.0.0.1:59321/v1/sandboxes");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body!)).toEqual({ twins: ["stripe"] });
  });
});

describe("assertWorldSeeded", () => {
  const [world] = WORLDS;
  const seeded = {
    id: world.chargeId,
    amount: world.chargeMinorUnits,
    amount_refunded: 0,
    status: "succeeded",
  };

  it("accepts the world the seed asked for", () => {
    expect(() => assertWorldSeeded(world, seeded)).not.toThrow();
  });

  // THE SECOND TRAP. The Stripe twin's seed schema is a plain `z.object`, not
  // `.strict()`, so a mistyped top-level key — `charge` for `charges` — is
  // dropped in SILENCE. `POST /v1/seeds/validate` answers `valid: true` for it.
  // A sandbox seeded with nothing then grades every criterion as `skipped`
  // (the charge resolves nowhere), which is not a red and not a green, and the
  // row reads as though the agent had a quiet day.
  it("refuses a sandbox where the charge never landed", () => {
    expect(() => assertWorldSeeded(world, null)).toThrow(/did not land/i);
  });

  it("refuses a charge that landed with the wrong money on it", () => {
    expect(() => assertWorldSeeded(world, { ...seeded, amount: 999 })).toThrow(/amount/);
  });

  it("refuses a charge that is already part-refunded, which would move the headroom", () => {
    expect(() => assertWorldSeeded(world, { ...seeded, amount_refunded: 5_000 })).toThrow(
      /amount_refunded/,
    );
  });
});
