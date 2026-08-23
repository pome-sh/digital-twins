// SPDX-License-Identifier: Apache-2.0
/**
 * WHY do this CLI and the cloud disagree about a twin's vocabulary?
 *
 * `checksDigest` hashes three fields per check: `id`, `substrate`, and the
 * COMPILED pattern (`packages/sdk/src/checks.ts`). The refusal in `checks-add.ts`
 * used to build its "which check moved" list from `id` and `template` — so a skew
 * that moved only `substrate`, or only `buildPattern`'s output while every
 * template was byte-identical, refused correctly and then named NOTHING. A named
 * refusal that names nothing, in exactly the two cases the digest was widened to
 * catch, during a situation that already blocks the author.
 *
 * The fix is a taxonomy with no silent branch: `explainSkew` returns a NON-EMPTY
 * list by construction, and the type says so. The class names are pome-cloud's
 * (`apps/control-plane/src/services/vocabulary-parity.ts`) so the two
 * surfaces that explain the same disagreement stay greppable against each other.
 *
 * This side can say more than the cloud-side monitor can. `GET /v1/checks`
 * publishes the compiled `pattern` and the parameter patterns,
 * which the CLI's own `checks --json` does not — so a generator-only skew is
 * localisable to a check HERE, and only falls back to the unlocalised
 * `pattern_generation` class when the control plane published nothing to diff.
 *
 * `description` and `params[].example` are compared by nothing here on purpose:
 * `checksDigest` does not hash them, so a difference in either cannot be what
 * moved the digest, and comparing them could only manufacture false findings.
 */
import { checkPattern, templateSlots } from "@pome-sh/sdk/checks";

import { checksFor, localDigest, pinnedVersion, type DeclaredCheck } from "./checks.js";

/** One check as `GET /v1/checks` publishes it. */
export interface RemoteCheck {
  id: string;
  template: string;
  substrate: string;
  /** The compiled regex source. Optional because a control plane that does not
   *  publish it must degrade to a named class, never to a crash or to silence. */
  pattern?: string;
  /** Ordered as the template names them — the compiled pattern wraps one group
   *  per slot in that order, so the ORDER is part of what the digest sees. */
  params?: Array<{ name: string; pattern: string }>;
}

export interface RemoteVocabulary {
  digest: string;
  checks: RemoteCheck[];
}

export type SkewFinding =
  | { kind: "only_here"; check: string }
  | { kind: "only_there"; check: string }
  | { kind: "template"; check: string; here: string; there: string }
  | { kind: "substrate"; check: string; here: string; there: string }
  | { kind: "params"; check: string; here: string; there: string }
  // Same declaration, different compiled pattern: the two sides' `@pome-sh/sdk`
  // turn one declaration into different regexes. `paramsCompared` records whether
  // the cloud published the parameter patterns — without them, a parameter type
  // is the other thing this could be, and the report has to say so.
  | { kind: "pattern"; check: string; here: string; there: string; paramsCompared: boolean }
  // Nothing above fired and the digests still differ. Carries the digest pair
  // rather than a check, because the difference is not localisable to one.
  | { kind: "pattern_generation"; check: null; here: string; there: string };

function paramsHere(def: DeclaredCheck): string {
  return templateSlots(def.template)
    .params.map((name) => `${name}=${def.params[name]!.pattern}`)
    .join(", ");
}

function paramsThere(check: RemoteCheck): string {
  return (check.params ?? []).map((p) => `${p.name}=${p.pattern}`).join(", ");
}

/** The fields BOTH sides always publish. Returns empty when the declarations
 *  agree — which is the precondition for reading anything into the compiled
 *  pattern, since a moved template moves the pattern too and reporting both
 *  would bury the cause under its own consequence. */
function declarationSkew(def: DeclaredCheck, check: RemoteCheck): SkewFinding[] {
  const findings: SkewFinding[] = [];
  if (def.template !== check.template) {
    findings.push({ kind: "template", check: def.id, here: def.template, there: check.template });
  }
  if (def.substrate !== check.substrate) {
    findings.push({
      kind: "substrate",
      check: def.id,
      here: def.substrate,
      there: check.substrate,
    });
  }
  if (check.params !== undefined && paramsHere(def) !== paramsThere(check)) {
    findings.push({
      kind: "params",
      check: def.id,
      here: paramsHere(def),
      there: paramsThere(check),
    });
  }
  return findings;
}

/**
 * Every way this CLI's vocabulary for `twin` differs from the one the cloud
 * published, as at least one named finding.
 *
 * Ordered by check id, so the readout is a property of the difference rather
 * than of either side's declaration order.
 */
export function explainSkew(
  twin: string,
  remote: RemoteVocabulary,
): [SkewFinding, ...SkewFinding[]] {
  const here = new Map(checksFor(twin).map((def) => [def.id, def]));
  const there = new Map(remote.checks.map((check) => [check.id, check]));
  const findings: SkewFinding[] = [];

  for (const id of [...new Set([...here.keys(), ...there.keys()])].sort()) {
    const def = here.get(id);
    const check = there.get(id);
    if (!check) {
      findings.push({ kind: "only_here", check: id });
      continue;
    }
    if (!def) {
      findings.push({ kind: "only_there", check: id });
      continue;
    }

    const declaration = declarationSkew(def, check);
    if (declaration.length > 0) {
      findings.push(...declaration);
      continue;
    }

    const compiled = checkPattern(def).source;
    if (check.pattern !== undefined && check.pattern !== compiled) {
      findings.push({
        kind: "pattern",
        check: id,
        here: compiled,
        there: check.pattern,
        paramsCompared: check.params !== undefined,
      });
    }
  }

  const [first, ...rest] = findings;
  if (!first) {
    return [
      {
        kind: "pattern_generation",
        check: null,
        here: localDigest(twin),
        there: remote.digest,
      },
    ];
  }
  return [first, ...rest];
}

function pair(here: string, there: string): string[] {
  return [`        here:  ${here}`, `        cloud: ${there}`];
}

// One bullet per class, and the compiler holds the line: the annotated return
// type plus an exhaustive switch means a class added without a bullet is
// `error TS2366`, not a line that renders `undefined`. Do NOT add a `default:` —
// it would buy back the silence this module exists to remove.
function bullet(finding: SkewFinding): string[] {
  switch (finding.kind) {
    case "only_here":
      return [`      - ${finding.check} — this CLI has it, the cloud does not`];
    case "only_there":
      return [`      - ${finding.check} — the cloud has it, this CLI does not`];
    case "template":
      return [
        `      - ${finding.check} — the sentence differs`,
        ...pair(finding.here, finding.there),
      ];
    case "substrate":
      return [
        `      - ${finding.check} — the substrate differs, so the two sides grade it against`,
        `        different evidence`,
        ...pair(finding.here, finding.there),
      ];
    case "params":
      return [
        `      - ${finding.check} — the parameters differ`,
        ...pair(`[${finding.here}]`, `[${finding.there}]`),
      ];
    case "pattern":
      return [
        ...(finding.paramsCompared
          ? [
              `      - ${finding.check} — same sentence and parameters, different compiled`,
              `        pattern: the two sides' @pome-sh/sdk compile one declaration differently,`,
              `        which is a buildPattern change and not a vocabulary change`,
            ]
          : [
              `      - ${finding.check} — same sentence, different compiled pattern, and no`,
              `        parameter patterns published: either a parameter type or @pome-sh/sdk`,
              `        buildPattern moved`,
            ]),
        ...pair(finding.here, finding.there),
      ];
    case "pattern_generation":
      return [
        `      - the digests differ, but every field the cloud published matches this CLI's`,
        `        declarations. That makes it an @pome-sh/sdk difference — buildPattern, or what`,
        `        checksDigest hashes — rather than a vocabulary change`,
        ...pair(finding.here, finding.there),
      ];
  }
}

/** The refusal an author reads. Names the twin pin always, and the sdk pin only
 *  when the sdk is what the findings implicate — a pin nobody needs is noise in a
 *  message someone is reading because they are already blocked. */
export function formatSkewRefusal(twin: string, findings: readonly SkewFinding[]): string {
  const sdkImplicated = findings.some(
    (f) => f.kind === "pattern" || f.kind === "pattern_generation",
  );
  return [
    `Refusing to write: this CLI and the cloud disagree about ${twin}'s vocabulary, so a ` +
      `sentence written here might not be graded there.`,
    ...findings.flatMap(bullet),
    "",
    `  local @pome-sh/twin-${twin} ${pinnedVersion(`@pome-sh/twin-${twin}`)}` +
      (sdkImplicated ? `, @pome-sh/sdk ${pinnedVersion("@pome-sh/sdk")}` : ""),
    ...(sdkImplicated
      ? [`  The cloud publishes no sdk version here, so that is the only pin this CLI can name.`]
      : []),
    `  Update with \`npm i -g @pome-sh/cli@latest\`. If this CLI is already current, the ` +
      `cloud is behind — that is a deploy, not something you can fix here.`,
  ].join("\n");
}
