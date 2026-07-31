// SPDX-License-Identifier: Apache-2.0
import { checkPattern, templateSlots } from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import { checksFor, pinnedVersion } from "../../src/cli/checks.js";
import {
  explainSkew,
  formatSkewRefusal,
  type RemoteVocabulary,
} from "../../src/cli/vocabulary-skew.js";

// A digest the cloud published that is not ours. The handshake only ever compares
// digests for EQUALITY, so a sentinel is the honest fixture here: what is under
// test is the explanation, never the hash arithmetic.
const MOVED = "sha256:the-cloud-published-a-different-digest";

/**
 * The cloud's payload, mirrored from this CLI's own declarations.
 *
 * Derived, never a literal list — the vocabulary is a CLOSED SET THAT GROWS
 * (F-1075, F-1151), so a hand-written fixture would assert the size of the set
 * where these tests mean to assert the classification of a difference. Every
 * field `GET /v1/checks` serves is mirrored, including the compiled `pattern`
 * and the parameter patterns, because prod really does serve both.
 */
function mirror(twin: string): RemoteVocabulary {
  return {
    digest: MOVED,
    checks: checksFor(twin).map((def) => ({
      id: def.id,
      template: def.template,
      substrate: def.substrate,
      pattern: checkPattern(def).source,
      params: templateSlots(def.template).params.map((name) => ({
        name,
        pattern: def.params[name]!.pattern,
      })),
    })),
  };
}

/** The first declaration that takes at least one parameter — derived, so no test
 *  below names a check that a later ticket may reorder or rename. */
function withParams(twin: string): string {
  const def = checksFor(twin).find((c) => templateSlots(c.template).params.length > 0);
  if (!def) throw new Error(`${twin} declares no parameterised check`);
  return def.id;
}

function findingFor(remote: RemoteVocabulary, id: string) {
  const hit = remote.checks.find((c) => c.id === id);
  if (!hit) throw new Error(`fixture lost ${id}`);
  return hit;
}

describe("explainSkew", () => {
  it("names a check this CLI has and the cloud does not", () => {
    const remote = mirror("github");
    const dropped = remote.checks[0]!.id;
    remote.checks = remote.checks.filter((c) => c.id !== dropped);

    expect(explainSkew("github", remote)).toEqual([{ kind: "only_here", check: dropped }]);
  });

  it("names a check the cloud has and this CLI does not", () => {
    const remote = mirror("github");
    remote.checks = [
      ...remote.checks,
      { id: "github.invented-later", template: "Something new", substrate: "final" },
    ];

    expect(explainSkew("github", remote)).toEqual([
      { kind: "only_there", check: "github.invented-later" },
    ]);
  });

  it("names the check and both sentences when a template moved", () => {
    const remote = mirror("github");
    const id = remote.checks[0]!.id;
    const here = findingFor(remote, id).template;
    findingFor(remote, id).template = `${here} (reworded)`;

    expect(explainSkew("github", remote)).toEqual([
      { kind: "template", check: id, here, there: `${here} (reworded)` },
    ]);
  });

  // F-1137's first Done-when bullet. `substrate` is hashed by `checksDigest` and
  // was not compared by the refusal, so this skew refused while naming nothing.
  it("names the check and both substrates when only the substrate moved", () => {
    const remote = mirror("github");
    const id = remote.checks[0]!.id;
    const here = findingFor(remote, id).substrate;
    findingFor(remote, id).substrate = here === "tape" ? "final" : "tape";

    expect(explainSkew("github", remote)).toEqual([
      { kind: "substrate", check: id, here, there: findingFor(remote, id).substrate },
    ]);
  });

  it("names the check and both parameter signatures when a slot's pattern moved", () => {
    const remote = mirror("github");
    const id = withParams("github");
    const check = findingFor(remote, id);
    const here = check.params!.map((p) => `${p.name}=${p.pattern}`).join(", ");
    check.params = check.params!.map((p, i) =>
      i === 0 ? { ...p, pattern: "CHANGED-BY-THE-CLOUD" } : p,
    );

    expect(explainSkew("github", remote)).toEqual([
      {
        kind: "params",
        check: id,
        here,
        there: check.params!.map((p) => `${p.name}=${p.pattern}`).join(", "),
      },
    ]);
  });

  // F-1137's second Done-when bullet, localised. The compiled pattern IS on the
  // `GET /v1/checks` wire (F-1074 Phase 3, verified against prod), so a
  // generator-only skew can name the check rather than only its class.
  it("names the check when the compiled pattern moved under an identical declaration", () => {
    const remote = mirror("github");
    const id = remote.checks[0]!.id;
    const check = findingFor(remote, id);
    const here = check.pattern!;
    // Same declaration, different compiled source: what a `buildPattern` change
    // in the two sides' `@pome-sh/sdk` looks like on the wire.
    check.pattern = here.replace("^", "^(?:)");

    expect(explainSkew("github", remote)).toEqual([
      { kind: "pattern", check: id, here, there: check.pattern, paramsCompared: true },
    ]);
  });

  it("reports the sentence, not the compiled pattern, when the template moved too", () => {
    const remote = mirror("github");
    const id = remote.checks[0]!.id;
    const check = findingFor(remote, id);
    check.template = `${check.template} (reworded)`;
    check.pattern = `${check.pattern}(?:)`;

    expect(explainSkew("github", remote).map((f) => f.kind)).toEqual(["template"]);
  });

  // F-1137's second Done-when bullet, unlocalised: the class the ticket asks for.
  // A control plane that publishes no compiled pattern leaves nothing to diff
  // field-by-field, and this is the branch that used to render as the empty string.
  it("names the generator as its own class when the cloud published nothing to diff", () => {
    const remote = mirror("github");
    remote.checks = remote.checks.map(({ id, template, substrate }) => ({
      id,
      template,
      substrate,
    }));

    expect(explainSkew("github", remote)).toEqual([
      { kind: "pattern_generation", check: null, here: expect.any(String), there: MOVED },
    ]);
  });

  it("never explains a skew with an empty list", () => {
    const twin = "github";
    const payloads: RemoteVocabulary[] = [
      // Byte-identical to ours in every published field, yet a different digest.
      mirror(twin),
      { digest: MOVED, checks: [] },
      {
        digest: MOVED,
        checks: mirror(twin).checks.map(({ id, template, substrate }) => ({
          id,
          template,
          substrate,
        })),
      },
    ];
    for (const remote of payloads) {
      expect(explainSkew(twin, remote).length).toBeGreaterThan(0);
    }
  });

  it("orders findings by check id, so the readout does not depend on declaration order", () => {
    const remote = mirror("github");
    for (const check of remote.checks) {
      check.substrate = check.substrate === "tape" ? "final" : "tape";
    }
    const named = explainSkew("github", remote).map((f) => f.check);

    expect(named.length).toBe(remote.checks.length);
    expect(named).toEqual([...named].sort());
  });
});

describe("formatSkewRefusal", () => {
  it("renders one bullet per finding, and never a blank one", () => {
    const remote = mirror("github");
    const id = remote.checks[0]!.id;
    findingFor(remote, id).substrate = "tape";
    const message = formatSkewRefusal("github", explainSkew("github", remote));

    const bullets = message.split("\n").filter((line) => line.trimStart().startsWith("- "));
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) expect(bullet.replace(/^\s*-\s*/, "")).not.toBe("");
  });

  it("names the local @pome-sh/sdk pin when the generator is what moved", () => {
    const remote = mirror("github");
    remote.checks = remote.checks.map(({ id, template, substrate }) => ({
      id,
      template,
      substrate,
    }));
    const message = formatSkewRefusal("github", explainSkew("github", remote));

    expect(message).toContain(`@pome-sh/sdk ${pinnedVersion("@pome-sh/sdk")}`);
    expect(message).toContain("buildPattern");
  });

  it("leaves the sdk pin out when the vocabulary itself is what moved", () => {
    const remote = mirror("github");
    findingFor(remote, remote.checks[0]!.id).substrate = "tape";
    const message = formatSkewRefusal("github", explainSkew("github", remote));

    expect(message).not.toContain("@pome-sh/sdk");
    expect(message).toContain(`@pome-sh/twin-github ${pinnedVersion("@pome-sh/twin-github")}`);
  });
});
