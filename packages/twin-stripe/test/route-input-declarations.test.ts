// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — the two properties the declared input surface has to keep.
//
// Both are driven over the real HTTP surface of a booted twin rather than
// against `declaration.parse()` in isolation: the claim is not "the parser
// refuses this", it is "no handler in this twin can see it".

import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { diffRegisteredRoutes, type UndeclaredDisposition } from "@pome-sh/sdk/route-inputs";
import type { StripeDomain } from "../src/domain/index.js";
import { STRIPE_ROUTE_INPUTS } from "../src/route-inputs.js";
import { registerStripeRoutes } from "../src/routes/index.js";
import { createStripeApp, rest } from "./_appHelper.js";

/** A name no Stripe surface has ever accepted, in either location. */
const PROBE = "pome_undeclared_probe";

/**
 * F-1372's ruling for this twin: Stripe publishes `parameter_unknown` — "The
 * request contains one or more unexpected parameters. Remove these and try
 * again." — so the strict default F-1179 shipped is what Stripe does, and it
 * stays. The error code asserted below is Stripe's own word for it.
 *
 * Pinned as a literal rather than read off the declarations: a flip in
 * `src/route-inputs.ts` has to come here to be sanctioned, which is the half
 * the reverted first attempt at F-1372 skipped. See
 * `docs/undeclared-route-inputs.md`.
 */
const RULED: UndeclaredDisposition = "refuse";

/** The router pattern with a stand-in for every `:param`. */
function concretePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_whole, name: string) => `probe_${name}`);
}

describe("declared route inputs", () => {
  it("is ruled `refuse` on undeclared input, on every route", () => {
    expect(STRIPE_ROUTE_INPUTS.length).toBeGreaterThan(0);
    const dissenting = STRIPE_ROUTE_INPUTS.filter((d) => d.undeclared !== RULED).map(
      (d) => `${d.surface} is '${d.undeclared}'`
    );
    expect(dissenting, `these routes disagree with the twin's F-1372 ruling ('${RULED}')`).toEqual(
      []
    );
  });

  it("refuses an input the declaration does not name", async () => {
    const app = await createStripeApp();

    for (const declaration of STRIPE_ROUTE_INPUTS) {
      const path = concretePath(declaration.path);

      const query = await rest(app, declaration.method, `${path}?${PROBE}=x`);
      expect(query.status, `${declaration.surface} + ?${PROBE}`).toBeGreaterThanOrEqual(400);
      expect(query.status, `${declaration.surface} + ?${PROBE}`).toBeLessThan(500);
      expect(query.body.error.code, `${declaration.surface} + ?${PROBE}`).toBe(
        "parameter_unknown"
      );

      if (declaration.bodyEncoding === "none") continue;

      const body = await rest(app, declaration.method, path, { [PROBE]: "x" });
      expect(body.status, `${declaration.surface} + body ${PROBE}`).toBeGreaterThanOrEqual(400);
      expect(body.status, `${declaration.surface} + body ${PROBE}`).toBeLessThan(500);
      expect(body.body.error.code, `${declaration.surface} + body ${PROBE}`).toBe(
        "parameter_unknown"
      );
    }
  });

  it("declares every route it registers, and registers every route it declares", async () => {
    const registered: string[] = [];
    const record = (method: string) => (path: string) => {
      registered.push(`${method} ${path}`);
    };
    // Registration never touches the domain or the recorder — those are read
    // inside the handlers, which this router never invokes.
    const router = {
      get: record("GET"),
      post: record("POST"),
      put: record("PUT"),
      patch: record("PATCH"),
      delete: record("DELETE"),
      all: record("ALL"),
    };
    registerStripeRoutes(
      router as unknown as Hono,
      {} as StripeDomain,
      undefined,
      "route-input-declarations"
    );

    // `ALL /v1/*` is the loud-501 catch-all, registered directly in
    // routes/index.ts rather than through a declaration. It is deliberately NOT
    // a declared surface: it accepts no input and answers every unimplemented
    // path, so declaring it would publish one surface standing for every Stripe
    // endpoint this twin does not serve.
    const declarable = registered.filter((surface) => surface !== "ALL /v1/*");
    expect(registered).toContain("ALL /v1/*");

    expect(diffRegisteredRoutes(declarable, STRIPE_ROUTE_INPUTS)).toEqual({
      undeclared: [],
      unmounted: [],
      duplicated: [],
    });
  });
});
