// SPDX-License-Identifier: Apache-2.0
//
// The rule that keeps a twin's published input surface COMPLETE.
//
// # What it enforces
//
// No module a twin's route registrars can reach may read a request input
// imperatively. Every input a handler sees has to arrive through
// `declareRouteInputs(...).parse()`, because that declaration is what gets
// published to pome-cloud's declared-fidelity lane.
//
// # Why a gate and not a type
//
// `packages/sdk/src/route-inputs.ts` makes two of the three failure modes
// structurally impossible: a handler receives only the declaration's output, so
// it cannot ACCEPT an input the declaration omits, and the declaration is the
// validator, so it cannot REJECT one the declaration names. The third — a
// handler that ignores its parsed input and reaches for `c.req.query("sort")`
// anyway — no type can prevent. It is one line, it typechecks, every existing
// test passes, and the published artifact silently stops being the whole truth.
//
// That is worse than not checking at all. `not-compared` is honest;
// "compared, no drift" computed from an incomplete declaration is a lane
// reporting a pass nobody measured, which is how people learn to ignore it.
//
// # Why the walk is structural
//
// The gate does not carry a list of route files. It finds every module that
// registers a route (by the call it must make to do so), then walks the real
// static import graph out of each one and checks everything it reaches inside
// the same twin. A new route file is covered the moment it registers a route; a
// helper extracted out of one is covered because the route file still imports
// it. Both are the ways a hand-maintained list would have gone quietly stale —
// and gmail's input names lived in exactly such a helper (`rest-common.ts`)
// before this ticket, two modules away from anything named "routes".
//
// A twin with no discoverable registrar is a hard failure, not a skip: removing
// the thing a reachability gate walks is the cheap way to pass it.
//
// Dependency-free and build-free, like its sibling rules, so it runs before
// `npm ci`.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildSpecifierMap, reachable, stripNonCode } from "../../lib/static-import-graph.mjs";

/**
 * The imperative request reads. Each is a way to obtain an input value whose
 * NAME appears only at the call site — which is precisely the shape this ticket
 * replaced, in all four HTTP twins at once.
 *
 * `c.req.method` and `c.req.path` are deliberately absent: they are routing
 * facts, not inputs, and the recorder legitimately needs both.
 */
const BANNED = [
  { pattern: /\breq\.query\s*\(/, what: "req.query(" },
  { pattern: /\breq\.queries\s*\(/, what: "req.queries(" },
  { pattern: /\breq\.param\s*\(/, what: "req.param(" },
  { pattern: /\breq\.json\s*\(/, what: "req.json(" },
  { pattern: /\breq\.text\s*\(/, what: "req.text(" },
  { pattern: /\breq\.blob\s*\(/, what: "req.blob(" },
  { pattern: /\breq\.arrayBuffer\s*\(/, what: "req.arrayBuffer(" },
  { pattern: /\breq\.formData\s*\(/, what: "req.formData(" },
  { pattern: /\breq\.parseBody\s*\(/, what: "req.parseBody(" },
  { pattern: /\breq\.valid\s*\(/, what: "req.valid(" },
  { pattern: /\breq\.header\s*\(/, what: "req.header(" },
  { pattern: /\breq\.raw\.clone\s*\(/, what: "req.raw.clone(" },
  { pattern: /new URL\(\s*\w+\.req\.url\s*\)/, what: "new URL(c.req.url)" },
];

/**
 * How a route registrar is recognised.
 *
 * Not "a file called routes.ts", and not "a file containing `app.get(`" either:
 * every twin registers at least some routes through a path VARIABLE
 * (`app.get(BASE, …)`, `app.post(path, handler)`), so a pattern anchored on a
 * literal path misses gmail and slack entirely — and a pattern loose enough to
 * catch them matches every `map.get(key)` in the repo.
 *
 * What a route registrar cannot avoid is being handed the router. So the marker
 * is a parameter typed as one, plus `mountDeclaredRoute(` for a module that
 * mounts without taking the router as a parameter. Everything else those
 * modules import is reached by the walk, which is how the helper that gmail's
 * input names actually lived in gets covered.
 */
const ROUTER_PARAMETER = /:\s*(?:Hono|DeclarableRouter)\b/;
const DECLARED_REGISTRATION = /\bmountDeclaredRoute\s*\(/;

/**
 * Engine-boundary reads that are not route input surfaces.
 *
 * The boundary this gate polices is the twin's OWN REST/GraphQL routes — the
 * ones pome-cloud's declared-fidelity lane matches against a vendor operation.
 * Three things sit outside it and legitimately read a request directly:
 *
 *   * Middleware that runs for every request whatever matched, reading a
 *     transport concern no vendor declares per operation: an idempotency key,
 *     an x402 payment envelope, the correlation headers the recorder stamps.
 *     Declaring those on all 181 surfaces would report 181 fresh
 *     `undeclaredByVendor` rows that are not drift.
 *   * The ENGINE's own surfaces (`/admin/*`, MCP dispatch, the x402 handshake).
 *     They have declarations of their own where they have inputs at all —
 *     `ToolSpec.schema` for every MCP tool, the seed schema for `/admin/seed` —
 *     and are not twin REST routes.
 *   * Auth: which credential arrived is the engine's question, asked before any
 *     route matched.
 *
 * An exemption grants SPECIFIC read kinds, not a file. And every entry must (a)
 * exist and (b) still contain each read it grants, or this gate fails: a stale
 * exemption silently covering nothing is how a gate stops working, and a
 * file-wide one is how a real violation hides behind a legitimate neighbour.
 */
const MIDDLEWARE_EXEMPTIONS = [
  // ── twin-stripe: the recorder row every route helper writes ────────────────
  {
    file: "packages/twin-stripe/src/routes/_helpers.ts",
    expression: `c.req.raw.clone().text()`,
    reason:
      "recorder plumbing, not a route input: drains the body once for the event's `request_body`. " +
      "It must happen BEFORE the declaration parses, so relocating it moves control flow whose " +
      "failure mode is a silently blank `request_body` on every recorded mutation.",
  },
  {
    file: "packages/twin-stripe/src/routes/_helpers.ts",
    expression: `c.req.header("x-pome-scenario-step-id")`,
    reason:
      "recorder plumbing, not a route input: the adapter's step correlation header, stamped on " +
      "the event as `task_step_id`. No vendor declares it on any operation.",
  },
  {
    file: "packages/twin-stripe/src/routes/_helpers.ts",
    expression: `c.req.header("x-pome-correlation-id")`,
    reason:
      "recorder plumbing, not a route input: the adapter's correlation header, stamped on the " +
      "event as `correlation_id`. No vendor declares it on any operation.",
  },
  {
    file: "packages/twin-stripe/src/routes/_helpers.ts",
    expression: `path: new URL(c.req.url).pathname`,
    reason:
      "recorder plumbing, not a route input: the event's own `path` field. Same expression the " +
      "engine's `recorder.handle()` uses for the same field.",
  },
  // ── twin-stripe: Idempotency-Key middleware ───────────────────────────────
  {
    file: "packages/twin-stripe/src/idempotency.ts",
    expression: `c.req.param("sid")`,
    reason:
      "idempotency middleware, not a route input: scopes the replay cache to the session. Runs " +
      "ahead of routing, for every route, so it belongs to no operation's input surface.",
  },
  {
    file: "packages/twin-stripe/src/idempotency.ts",
    expression: `c.req.header("Idempotency-Key")`,
    reason:
      "idempotency middleware, not a route input: keys the replay cache. The one route that " +
      "treats the key as a real INPUT — POST /v1/refunds, which passes it to the domain — " +
      "declares it as a header input in `src/route-inputs.ts`.",
  },
  {
    file: "packages/twin-stripe/src/idempotency.ts",
    expression: `const path = new URL(c.req.url).pathname`,
    reason:
      "idempotency middleware, not a route input: part of the replay-cache key, so a replayed " +
      "key on a different path is not a hit.",
  },
  {
    file: "packages/twin-stripe/src/idempotency.ts",
    expression: `c.req.header("x-pome-scenario-step-id")`,
    reason: "recorder plumbing, not a route input: the replayed event's `task_step_id`.",
  },
  {
    file: "packages/twin-stripe/src/idempotency.ts",
    expression: `c.req.header("x-pome-correlation-id")`,
    reason: "recorder plumbing, not a route input: the replayed event's `correlation_id`.",
  },
  {
    file: "packages/twin-stripe/src/idempotency.ts",
    expression: `path: new URL(c.req.url).pathname`,
    reason: "recorder plumbing, not a route input: the replayed event's own `path` field.",
  },
  // ── twin-stripe: x402 wire protocol ───────────────────────────────────────
  {
    file: "packages/twin-stripe/src/x402.ts",
    expression: `const url = new URL(c.req.url)`,
    reason:
      "x402 wire protocol, not a route input: builds the `resource` URL the 402 challenge quotes " +
      "back. x402 wraps the routes; it is not an operation.",
  },
  {
    file: "packages/twin-stripe/src/x402.ts",
    expression: `c.req.header("X-PAYMENT")`,
    reason:
      "x402 wire protocol, not a route input: the payment envelope for the 402 handshake. No " +
      "Stripe operation declares it.",
  },
  {
    file: "packages/twin-stripe/src/session.ts",
    expression: `c.req.header("x-pome-correlation-id")`,
    reason: "recorder plumbing, not a route input: the gated-exchange event's `correlation_id`.",
  },
  {
    file: "packages/twin-stripe/src/session.ts",
    expression: `c.req.header("x-pome-scenario-step-id")`,
    reason: "recorder plumbing, not a route input: the gated-exchange event's step correlation.",
  },
  {
    file: "packages/twin-stripe/src/session.ts",
    expression: `path: new URL(c.req.url).pathname`,
    reason: "recorder plumbing, not a route input: the gated-exchange event's own `path` field.",
  },
  {
    file: "packages/twin-stripe/src/session.ts",
    expression: `c.req.header("authorization")`,
    reason:
      "auth, not a route input: resolves the API key for the x402 handshake. Which credential " +
      "arrived is asked before any route matched.",
  },
  // ── twin-stripe: the engine's bodyReader hook ─────────────────────────────
  {
    file: "packages/twin-stripe/src/twin.ts",
    expression: `if (new URL(c.req.url).pathname.endsWith("/admin/seed"))`,
    reason:
      "the engine's `bodyReader` hook, not a route input: picks the decoder for the " +
      "ENGINE-owned surfaces. `/admin/seed` declares its inputs through the twin's seed schema.",
  },
  {
    file: "packages/twin-stripe/src/twin.ts",
    expression: `return await c.req.json()`,
    reason:
      "the engine's `bodyReader` hook, not a route input: decodes bodies for `/admin/seed` and " +
      "MCP dispatch, whose inputs are declared by the seed schema and each `ToolSpec.schema`.",
  },
  {
    file: "packages/twin-stripe/src/twin.ts",
    expression: `const contentType = c.req.header("content-type")`,
    reason:
      "the engine's `bodyReader` hook, not a route input: chooses form vs JSON decoding for the " +
      "engine-owned surfaces. A content type is a transport fact, not a declared parameter.",
  },
  {
    file: "packages/twin-stripe/src/twin.ts",
    expression: `return await c.req.parseBody()`,
    reason:
      "the engine's `bodyReader` hook, not a route input: the form branch of the same decoder.",
  },
  // ── twin-slack: the same engine bodyReader hook, its own entries ───────────
  //
  // Deliberately spelled out per twin rather than shared with stripe's as a
  // "bodyReader" category: twin-github needed no exemption at all, and a
  // category is how gmail would silently inherit a grant nobody examined.
  {
    file: "packages/twin-slack/src/util.ts",
    expression: `const contentType = (c.req.header("content-type") ?? "").toLowerCase()`,
    reason:
      "`parseFormOrJson`, the engine's `bodyReader` hook (`twin.ts`) — not a route input. It " +
      "decodes bodies for the ENGINE-owned surfaces only: `/admin/seed`, validated by the twin's " +
      "seed schema, and the legacy `/mcp/call`, validated by each `ToolSpec.schema`. `routes.ts` " +
      "no longer imports it; the gate reaches it through `twin.ts`.",
  },
  {
    file: "packages/twin-slack/src/util.ts",
    expression: `const body = await c.req.json()`,
    reason:
      "`parseFormOrJson`, the engine's `bodyReader` hook — not a route input: the JSON branch of " +
      "the decoder for `/admin/seed` and the legacy `/mcp/call`.",
  },
  {
    file: "packages/twin-slack/src/util.ts",
    expression: `const body = await c.req.parseBody()`,
    reason:
      "`parseFormOrJson`, the engine's `bodyReader` hook — not a route input: the form branch of " +
      "the decoder for `/admin/seed` and the legacy `/mcp/call`.",
  },
  // ── twin-linear: the pre-auth `extensions` gate reads a CLONE ─────────────
  //
  // The one entry here that grants a clone rather than a named read, and the
  // reason is the mirror image of twin-stripe's first entry above: that one
  // drains the body BEFORE the declaration parses so the recorder's
  // `request_body` is not blank, this one refuses to drain it at all for the
  // same reason.
  {
    file: "packages/twin-linear/src/twin.ts",
    expression: `const peek = new HonoRequest(c.req.raw.clone())`,
    reason:
      "recorder plumbing, not a route input: the `extensions` gate answers ahead of " +
      "`bearerAuth`, so it runs before the recorder — and the recorder captures `request_body` " +
      "with its own `c.req.raw.clone().json()`, which throws once the stream is disturbed and " +
      "records null instead. Parsing the original would blank the tape on every recorded " +
      "/graphql request with nothing going red. The clone is handed straight to " +
      "`LINEAR_ROUTES.graphql*.parse()`, so the DECLARATION is still the only thing reading a " +
      "value by name — this grants which Request is parsed, not what may be read off it. " +
      "`test/route-input-declarations.test.ts` asserts the tape still carries the body.",
  },
];


export default {
  name: "route-inputs",
  describe: "no imperative request read in a module a twin's route registrars reach",
  check(ctx) {
    const packagesDir = ctx.abs("packages");
    const twinDirs = existsSync(packagesDir)
      ? readdirSync(packagesDir)
          .filter((dir) => dir.startsWith("twin-") && statSync(join(packagesDir, dir)).isDirectory())
          .sort()
      : [];
    if (twinDirs.length === 0) throw new Error(`No packages/twin-* found under ${ctx.root}.`);

    // ─── Discover the twins and their route registrars ───────────────────────
    const specifiers = buildSpecifierMap(ctx.root);
    const registrarsByTwin = new Map();
    const twinsWithNoRegistrar = [];

    for (const dir of twinDirs) {
      const found = ctx
        .files({ dirs: [`packages/${dir}/src`], ext: [".ts"], mustExist: false })
        .filter((file) => !file.endsWith(".d.ts"))
        .filter((file) => {
          const code = stripNonCode(ctx.read(file));
          return ROUTER_PARAMETER.test(code) || DECLARED_REGISTRATION.test(code);
        });
      if (found.length === 0) twinsWithNoRegistrar.push(dir);
      else registrarsByTwin.set(dir, found);
    }

    // A twin with no discoverable registrar is a hard failure, not a skip:
    // removing the thing a reachability rule walks is the cheap way to pass it.
    if (twinsWithNoRegistrar.length > 0) {
      throw new Error(
        `${twinsWithNoRegistrar.length} twin(s) have no module registering a route, so this rule ` +
          `covers nothing for them: ${twinsWithNoRegistrar.map((d) => `packages/${d}`).join(", ")}. ` +
          `Every twin serves an HTTP surface — one whose registrar this rule cannot find has either ` +
          `moved its registration behind an indirection or renamed the mounting helper. Update ` +
          `ROUTER_PARAMETER / DECLARED_REGISTRATION here in the same change.`,
      );
    }

    // ─── The exemptions must still describe real code ────────────────────────
    // The dead-check, run BEFORE the scan: an entry that matches nothing must
    // FAIL, not quietly pass. An allowlist that has stopped matching is a rule
    // measuring less than it claims.
    const staleExemptions = [];
    for (const entry of MIDDLEWARE_EXEMPTIONS) {
      if (!ctx.exists(entry.file)) {
        staleExemptions.push(`${entry.file} — does not exist`);
        continue;
      }
      if (!stripNonCode(ctx.readRel(entry.file)).includes(entry.expression)) {
        staleExemptions.push(
          `${entry.file} — grants \`${entry.expression}\`, which the file no longer contains`,
        );
        continue;
      }
      // And it has to be exempting something this rule would actually stop.
      if (!BANNED.some((banned) => banned.pattern.test(entry.expression))) {
        staleExemptions.push(
          `${entry.file} — grants \`${entry.expression}\`, which is not a read this rule bans`,
        );
      }
    }
    if (staleExemptions.length > 0) {
      return {
        violations: staleExemptions,
        hint:
          "Narrow or remove the entry. An exemption that describes code which no longer needs it is\n" +
          "an exemption nobody will question the next time one is added.",
      };
    }

    // ─── Check every module a registrar reaches, inside its own twin ─────────
    /** file → the exact expressions allowlisted in it. */
    const exemptExpressions = new Map();
    for (const entry of MIDDLEWARE_EXEMPTIONS) {
      exemptExpressions.set(entry.file, [...(exemptExpressions.get(entry.file) ?? []), entry.expression]);
    }

    const violations = [];
    const checkedFiles = new Set();

    for (const [dir, registrars] of registrarsByTwin) {
      const twinRoot = join(packagesDir, dir, "src");
      const { importedBy } = reachable(registrars, specifiers);
      for (const file of importedBy.keys()) {
        // Scoped to the twin's own sources: the sdk's engine (auth, recorder,
        // failure injection) is reached from here and is not a route input
        // surface, and `route-inputs.ts` is where the reads are SUPPOSED to live.
        if (!file.startsWith(`${twinRoot}/`) && file !== twinRoot) continue;
        const rel = ctx.rel(file);
        const granted = exemptExpressions.get(rel) ?? [];
        checkedFiles.add(rel);
        for (const [index, line] of stripNonCode(ctx.read(file)).split("\n").entries()) {
          for (const banned of BANNED) {
            if (!banned.pattern.test(line)) continue;
            // Allowlisted per EXPRESSION, not per file and not per read kind: a
            // new read on a new line in the same module is still a violation, so
            // a real one cannot hide behind a legitimate neighbour.
            if (granted.some((expression) => line.includes(expression))) continue;
            violations.push(`${rel}:${index + 1} — ${banned.what}\n      ${line.trim()}`);
          }
        }
      }
    }

    const registrarCount = [...registrarsByTwin.values()].flat().length;
    return {
      violations,
      summary:
        `${checkedFiles.size} module(s) reachable from ${registrarCount} route registrar(s) across ` +
        `${twinDirs.length} twins, none reading a request input outside its declaration ` +
        `(${MIDDLEWARE_EXEMPTIONS.length} engine-middleware exemption(s))`,
      detail: [...checkedFiles].sort(),
      hint:
        "An input read this way has its NAME only at the call site, so it is absent from the\n" +
        "surface published in packages/twin-*/route-inputs.json. pome-cloud's declared-fidelity\n" +
        "lane then compares the vendor's inputs against an incomplete list and reports no drift —\n" +
        "a pass nobody measured, which is worse than the `not-compared` it reported before.\n\n" +
        "Declare the input in the twin's `src/route-inputs.ts` and read it off the parsed result\n" +
        "instead. See packages/sdk/src/route-inputs.ts for the mechanism and\n" +
        "packages/twin-github/src/route-inputs.ts for a worked example.",
    };
  },
};
