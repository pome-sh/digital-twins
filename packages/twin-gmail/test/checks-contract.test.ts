// The properties every declared check must hold, carried across from twin-slack when
// Gmail's vocabulary moved out of pome-cloud.

import {
  checkNearMissPattern,
  checkPattern,
  parseCheck,
  probeDiscrimination,
  probeRedactionSurvival,
  probeStateCitation,
  REDACTION_PLACEHOLDER,
  renderCheck,
  type CheckDefinition,
  type CheckSubstrateKind,
  type RedactionGuard,
} from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import { GMAIL_CHECKS, type GmailCheckState } from "../src/checks.js";
import { draftAddressedTo, draftCountAtLeast } from "../src/check-drafts.js";
import { labelExists } from "../src/check-labels.js";
import {
  mailboxLabelCount,
  messageHasLabel,
  oneMessagePerRecipient,
} from "../src/check-messages.js";
import { noUnsupportedEndpoint } from "../src/check-tape.js";
import { finalWorld } from "../src/check-worlds.js";

// The declarations are a heterogeneous tuple, so iterating them yields a union
// whose args type differs per check, while the fixtures below are looked up by
// id at run time. That tie cannot be made statically — erase it once here
// rather than casting at a dozen call sites.
type OpenCheck = CheckDefinition<GmailCheckState, Record<string, string>>;
const CHECKS = GMAIL_CHECKS as readonly unknown[] as readonly OpenCheck[];

// Representative args per check, used to exercise render/parse/mutant. The
// coverage assertion below makes this table impossible to forget: a new check
// with no fixture fails rather than silently skipping every property here.
const FIXTURES: Record<string, Record<string, string>> = {
  "gmail.message-has-label": { message: "msg_support", label: "Label_follow_up" },
  "gmail.label-exists": { label: "Parity Complete" },
  "gmail.draft-addressed-to": { email: "alice@example.com" },
  "gmail.draft-count-at-least": { count: "two" },
  "gmail.mailbox-label-count": { mailbox: "pome-agent@pome-twin.test", count: "5", label: "SENT" },
  "gmail.one-message-per-recipient": { label: "SENT", count: "five" },
  "gmail.no-unsupported-endpoint": {},
};

// Every check whose `vacuityMutant` returns null, WITH the reason. A null
// mutant is an admitted blind spot; admitting it in a ledger is what keeps it
// from becoming a habit.
//
// There are exactly two arguments that earn a line here:
//   1. THE PARAMETER ONLY SELECTS. Falsifying it moves the verdict for a reason
//      that never reaches the assertion — a clean bill the check did not earn.
//   2. THE PARAMETER IS A CLOSED SET. Typing a slot as `oneOf` means no member
//      is guaranteed false, so a mutant could assert a different state that
//      happens to be true as well.
//
// Gmail earns exactly one line, and it is argument-shaped rather than
// slot-shaped: every other check here has a scanned literal to point at. Note
// what is NOT listed — `gmail.draft-count-at-least` has one slot and it is a
// number, and it still declares a real mutant, because that number is compared
// rather than resolved. See its declaration for the D10 argument.
const HONEST_NULL_MUTANTS: Record<string, string> = {
  "gmail.no-unsupported-endpoint":
    "the sentence has no slots at all; the trigger is a fidelity stamp on the tape, which no " +
    "mutation of the criterion text can reach",
};

// twin-github ledgers REPO_FREE_CHECKS here, and twin-slack argues its absence.
// Gmail's answer is a THIRD one, and it is worth writing down because it is the
// only place in the vocabulary where a scoping decision was made at runtime
// instead of in the grammar.
//
// GitHub's repo rule exists because its legacy patterns took `in owner/repo` as
// an optional qualifier and, absent it, scanned repositories first-match-wins —
// so a two-repo world silently graded whichever sorted first. Slack escaped the
// rule: one workspace, channel names unique within it, no ambiguous selection.
//
// Gmail cannot escape it that way. Ids are minted PER MAILBOX (`nextId(db,
// mailboxId, …)`), and `deliveryMode: "seeded-mailboxes"` really can put
// `msg_support` in two of them. But adding a `{mailbox}` slot to every template
// would stop all six shipped corpus criteria binding, and they carry no mailbox
// because in `sender-only` mode there is exactly one.
//
// So the ambiguity is closed in `resolveMessage` instead of in the grammar: an
// id present in more than one mailbox returns `message_ambiguous` and the
// criterion leaves the denominator. That is strictly stronger than a slot would
// be for the single-mailbox case and identical to it for the ambiguous one —
// and unlike a slot, it cannot be filled in wrongly by an author.
//
// `gmail.mailbox-label-count` is the exception that names its mailbox, because
// its sentence is ABOUT a mailbox's contents rather than about one message.

const SUBSTRATES: CheckSubstrateKind[] = ["final", "seed+final", "tape"];

describe("declared check identity", () => {
  it("declares a non-empty, twin-prefixed id for every check", () => {
    for (const check of CHECKS) {
      expect(check.id, "every check needs an id").toBeTruthy();
      expect(check.id.startsWith("gmail."), `${check.id} must be namespaced <twin>.<what>`).toBe(
        true,
      );
    }
  });

  it("keeps ids unique across the twin's declarations", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const check of CHECKS) {
      if (seen.has(check.id)) duplicates.push(check.id);
      seen.add(check.id);
    }
    expect(duplicates, `duplicate check ids: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("declares polarity and a vacuity mutant on every check", () => {
    for (const check of CHECKS) {
      expect(typeof check.polarity, `${check.id}.polarity`).toBe("function");
      expect(typeof check.vacuityMutant, `${check.id}.vacuityMutant`).toBe("function");
    }
  });

  it("declares a known substrate on every check", () => {
    for (const check of CHECKS) {
      expect(SUBSTRATES, `${check.id}.substrate`).toContain(check.substrate);
    }
  });

  it("has a fixture for every check, so no check skips the properties below", () => {
    const missing = CHECKS.filter((check) => !FIXTURES[check.id]).map((check) => check.id);
    expect(missing, `checks with no FIXTURES entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("says what the predicate actually compares, in words the sentence does not carry", () => {
    // The one defect this architecture makes EASIER, not harder: a rendered
    // sentence wider or narrower than its check (Shankar et al., UIST '24
    // §7.3.3 — readable surfaces hide the disagreement code makes visible).
    // `A label named X exists` reads as a claim about the mailbox's whole label
    // set; the predicate compares display names only and says nothing about ids.
    for (const check of CHECKS) {
      expect(check.description?.trim(), `${check.id} declares no description`).toBeTruthy();
      expect(
        check.description.trim(),
        `${check.id}'s description just restates its template — it must say what the ` +
          `predicate COMPARES, which is the thing the sentence cannot carry`,
      ).not.toBe(check.template);
    }
  });
});

describe("declared check grammar", () => {
  it("round-trips render -> parse -> render byte-identically", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const rendered = renderCheck(check, args);
      const parsed = parseCheck(check, rendered);
      expect(parsed, `${check.id}: its own rendered sentence must parse`).toEqual(args);
      expect(renderCheck(check, parsed!), `${check.id}: round trip changed the bytes`).toBe(
        rendered,
      );
    }
  });

  it("binds its own rendered sentence and nothing wider", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkPattern(check).test(rendered), `${check.id} must match itself`).toBe(true);
      expect(
        checkPattern(check).test(`${rendered} and also something else`),
        `${check.id} is not anchored`,
      ).toBe(false);
    }
  });

  it("treats its own rendered sentence as a match, never as a near miss", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkNearMissPattern(check).test(rendered)).toBe(true);
      expect(checkPattern(check).test(rendered)).toBe(true);
    }
  });

  it("binds no OTHER check's valid sentence", () => {
    // Two checks that both claim one sentence is the wrong-match bug the
    // exhaustive invariant (D6) exists to compute — this is its per-twin half,
    // held here so a new declaration cannot ship broken and be caught only
    // downstream. Gmail's sharpest case: `A label named {label} exists` and
    // `A draft addressed to {email} exists` share the trailing ` exists`, and
    // only their opening literals keep them apart.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const claimants = CHECKS.filter((other) => checkPattern(other).test(rendered)).map(
        (other) => other.id,
      );
      expect(claimants, `"${rendered}" is claimed by more than one check`).toEqual([check.id]);
    }
  });

  it("reports a corrupted instance as its OWN check, not a neighbour's", () => {
    // Near-miss patterns open every slot to `.+?`, so a broad template can
    // shadow a narrow one and a corrupted sentence gets reported under the
    // wrong name — an error message pointing an author at a check they did not
    // use.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const resemblers = CHECKS.filter((other) =>
        checkNearMissPattern(other).test(rendered),
      ).map((other) => other.id);
      expect(resemblers, `"${rendered}" resembles more than one check's template`).toEqual([
        check.id,
      ]);
    }
  });
});

describe("declared vacuity mutants", () => {
  it("either produces a re-bindable mutant sentence, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const mutantArgs = check.vacuityMutant(args);

      if (mutantArgs === null) {
        expect(
          HONEST_NULL_MUTANTS[check.id],
          `${check.id} returns a null mutant but gives no reason in HONEST_NULL_MUTANTS. ` +
            `A check with no falsifiable literal is an admitted blind spot; admit it here.`,
        ).toBeTruthy();
        continue;
      }

      expect(
        HONEST_NULL_MUTANTS[check.id],
        `${check.id} produces a mutant but is still listed in HONEST_NULL_MUTANTS — stale entry`,
      ).toBeUndefined();

      const original = renderCheck(check, args);
      const mutant = renderCheck(check, mutantArgs);
      expect(mutant, `${check.id}: the mutant must differ from the sentence it falsifies`).not.toBe(
        original,
      );
      expect(
        parseCheck(check, mutant),
        `${check.id}: the mutant must still bind to this check, or the probe measures nothing`,
      ).toEqual(mutantArgs);
    }
  });

  it("points every mutant at a world where the check genuinely fails", () => {
    // The mutant assertion above proves the SENTENCE re-binds. It does not prove
    // the mutated sentence is actually false, and a mutant that stays true is a
    // clean bill the check did not earn — the precise defect D10 names. Run each
    // mutant against its own PASSING world: the unmutated args pass there by
    // construction, so anything the mutant does differently is the mutation's
    // doing and nothing else's.
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const mutantArgs = check.vacuityMutant(args);
      if (mutantArgs === null) continue;
      const worlds = check.discriminatingWorlds(args);
      if (worlds === null) continue;
      const outcome = check.evaluate(mutantArgs, worlds.passing);
      expect(
        outcome.passed,
        `${check.id}: the mutant "${renderCheck(check, mutantArgs)}" still PASSES in the world ` +
          `where the original passes, so falsifying the literal changed nothing`,
      ).toBe(false);
    }
  });
});

// Every check that declines to name a failing world, WITH the reason.
const HONEST_NULL_WORLDS: Record<string, string> = {};

describe("declared discriminating worlds", () => {
  it("names a passing and a failing world for every check, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const verdict = probeDiscrimination(check, args);

      if (verdict.kind === "declined") {
        expect(
          HONEST_NULL_WORLDS[check.id],
          `${check.id} names no worlds and gives no reason in HONEST_NULL_WORLDS. A check ` +
            `that cannot demonstrate a failing world may not be able to fail at all.`,
        ).toBeTruthy();
        continue;
      }

      expect(
        HONEST_NULL_WORLDS[check.id],
        `${check.id} names its worlds but is still listed in HONEST_NULL_WORLDS — stale entry`,
      ).toBeUndefined();

      expect(
        verdict.kind === "broken"
          ? `${check.id}: ${verdict.arm} — ${verdict.detail}`
          : "discriminates",
      ).toBe("discriminates");
    }
  });

  it("ships an EMPTY null-worlds ledger", () => {
    // Not ceremony. The moment this has an entry, the gate's guarantee weakens
    // from "every check can fail" to "every check can fail or said why not", and
    // that change should require editing this assertion on purpose.
    expect(Object.keys(HONEST_NULL_WORLDS)).toEqual([]);
  });

  it("puts each world on the substrate the check declared", () => {
    for (const check of CHECKS) {
      const worlds = check.discriminatingWorlds?.(FIXTURES[check.id]!) ?? null;
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        if (check.substrate === "seed+final") {
          expect(
            world.seed,
            `${check.id}.${side} declares seed+final but names no seed`,
          ).not.toBeNull();
        }
        if (check.substrate === "tape") {
          expect(world.tape, `${check.id}.${side} declares tape but names none`).not.toBeNull();
        }
      }
    }
  });
});

describe("migrated sentences", () => {
  it("renders the six criteria A3 found unbound, byte-identically", () => {
    // These are the EXACT strings in `cli/tasks/22-gmail-inbox-triage.md`,
    // `23-gmail-first-party-parity.md` and
    // `27-gmail-github-support-escalation.md`, and the whole point of the
    // migration is that it does not rewrite one of them. If a template drifts,
    // the corpus stops binding and the D6 arm goes red in pome-cloud instead of
    // here — one repo too late, and after a release.
    expect(renderCheck(messageHasLabel, { message: "msg_support", label: "Label_follow_up" })).toBe(
      "Message msg_support has label Label_follow_up",
    );
    expect(renderCheck(draftAddressedTo, { email: "alice@example.com" })).toBe(
      "A draft addressed to alice@example.com exists",
    );
    expect(renderCheck(messageHasLabel, { message: "msg_parity", label: "STARRED" })).toBe(
      "Message msg_parity has label STARRED",
    );
    expect(renderCheck(labelExists, { label: "Parity Complete" })).toBe(
      "A label named Parity Complete exists",
    );
    expect(renderCheck(draftCountAtLeast, { count: "two" })).toBe("At least two drafts exist");
  });

  it("renders one sentence for the criterion tasks 22 and 27 SHARE", () => {
    // `Message msg_support has label Label_follow_up` appears in both, so one
    // check clears both — the same way `github.no-new-labels` cleared five. The
    // corpus scan's allowlist is keyed by exact phrase text for this reason.
    const rendered = renderCheck(messageHasLabel, {
      message: "msg_support",
      label: "Label_follow_up",
    });
    expect(rendered).toBe("Message msg_support has label Label_follow_up");
  });

  it("re-renders the two criteria carried across from pome-cloud's regexes", () => {
    // `agent-examples/gmail-retry-notify/tasks/01-throttled-send.md`. The legacy
    // patterns were case-insensitive and accepted a trailing period, `labelled`,
    // and three quote styles; the generated pattern is anchored and
    // case-sensitive, so that task file is rewritten in this same commit.
    expect(
      renderCheck(mailboxLabelCount, {
        mailbox: "pome-agent@pome-twin.test",
        count: "5",
        label: "SENT",
      }),
    ).toBe("The mailbox `pome-agent@pome-twin.test` has exactly 5 messages labeled SENT");
    expect(renderCheck(oneMessagePerRecipient, { label: "SENT", count: "five" })).toBe(
      "Exactly one SENT message is addressed to each of the five recipients",
    );
  });

  it("renders the tape check WITHOUT a twin word, matching github's", () => {
    // The legacy cloud rule accepted "No unsupported Gmail endpoint was called"
    // and the bare form alike. Under position 2 an author picks the check, so
    // the variants are retired and both twins now say the same sentence — the
    // engine resolves it per-twin.
    expect(renderCheck(noUnsupportedEndpoint, {})).toBe("No unsupported endpoint was called");
  });

  it("keeps the zero-count form of mailboxLabelCount reading as a prohibition", () => {
    // The count carries the direction, which is the one place in this vocabulary
    // where polarity is a function of the args rather than a constant.
    expect(mailboxLabelCount.polarity({ mailbox: "a@b.test", count: "0", label: "SENT" })).toBe(
      "negative",
    );
    expect(mailboxLabelCount.polarity({ mailbox: "a@b.test", count: "5", label: "SENT" })).toBe(
      "positive",
    );
  });
});

// Every state-reading check that cites no path, WITH the reason.
const HONEST_UNCITED_CHECKS: Record<string, string> = {};

describe("declared state citations", () => {
  it("cites a resolvable state path from every check that reads state", () => {
    for (const check of CHECKS) {
      // A tape check cites `evidenceEventIds` and is not this gate's business.
      if (check.substrate === "tape") continue;
      const verdict = probeStateCitation(check, FIXTURES[check.id]!);

      if (verdict.kind === "cites") {
        expect(
          HONEST_UNCITED_CHECKS[check.id],
          `${check.id} cites its state path but is still listed in HONEST_UNCITED_CHECKS — stale entry`,
        ).toBeUndefined();
        continue;
      }

      expect(
        HONEST_UNCITED_CHECKS[check.id],
        `${check.id} reads state but ${
          verdict.kind === "declined"
            ? "names no worlds, so its citation cannot be probed"
            : verdict.kind === "uncited"
              ? `its ${verdict.arm} world produced no evidenceStatePaths`
              : verdict.kind === "unresolvable"
                ? `its ${verdict.arm} world cites ${verdict.pointer}, which resolves to nothing in that world`
                : `its ${verdict.arm} world cited malformed evidence — ${verdict.detail}`
        }. A state verdict that cites nothing renders as an inert row.`,
      ).toBeTruthy();
    }
  });

  it("ships an EMPTY uncited ledger", () => {
    expect(Object.keys(HONEST_UNCITED_CHECKS)).toEqual([]);
  });

  it("leaves the state-path field absent on every tape check", () => {
    // The converse. A tape check has no state tree to point into — the engine
    // hands it a deliberately barren `final` so it cannot read one — so a pointer
    // from here would address a world the check never saw.
    for (const check of CHECKS) {
      if (check.substrate !== "tape") continue;
      const worlds = check.discriminatingWorlds(FIXTURES[check.id]!);
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        expect(
          check.evaluate(FIXTURES[check.id]!, world).evidenceStatePaths,
          `${check.id}.${side} reads the tape but cites a state path`,
        ).toBeUndefined();
      }
    }
  });
});

describe("gmail.mailbox-label-count's two ways of not finding a mailbox", () => {
  // Both are a skip and neither is a wrong verdict, so this is entirely about the NAME
  // a reader gets — which is the whole cost the ticket measured.
  const ARGS = { mailbox: "pome-agent@pome-twin.test", count: "5", label: "SENT" };
  const worldWithMailboxes = (mailboxes: { email: string }[]) =>
    finalWorld({
      mailboxes,
      messages: [],
      drafts: [],
      labels: [],
      messageLabels: [],
      exportBounds: { messageBodiesOmitted: true, largeMailbox: false, truncatedCollections: [] },
    });

  it("says mailbox_not_found when the export lists real addresses and none is this one", () => {
    const outcome = mailboxLabelCount.evaluate(
      ARGS,
      worldWithMailboxes([{ email: "someone-else@pome-twin.test" }]),
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe('mailbox_not_found ("pome-agent@pome-twin.test")');
  });

  it("says mailbox_redacted when the export lists a mailbox whose address was masked", () => {
    const outcome = mailboxLabelCount.evaluate(ARGS, worldWithMailboxes([{ email: REDACTION_PLACEHOLDER }]));
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe('mailbox_redacted ("pome-agent@pome-twin.test")');
  });

  it("still refuses when the placeholder is not one it recognises", () => {
    // The recogniser is best-effort — a team's redactor may write anything — and
    // this pins the degradation: the reason falls back to the old name, the
    // SKIP does not fall back to anything. No verdict rides on the guess.
    const outcome = mailboxLabelCount.evaluate(ARGS, worldWithMailboxes([{ email: "***" }]));
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe('mailbox_not_found ("pome-agent@pome-twin.test")');
  });
});

// Which door stands between a redactor that eats a slot's literal and a wrong verdict
// — one row per declared slot, MEASURED rather than argued.
const REDACTION_GUARDS: Record<string, RedactionGuard> = {
  // The message id SELECTS, and a selector miss is gmail's `missSkip`: the
  // criterion leaves the denominator rather than false-failing a correct agent.
  "gmail.message-has-label · message": "abstains",
  "gmail.message-has-label · label": "declared_subject",
  "gmail.label-exists · label": "declared_subject",
  "gmail.draft-addressed-to · email": "declared_subject",
  // A count is compared against an arity the predicate DERIVES. There is no
  // occurrence of `two` in the tree for a redactor to reach.
  "gmail.draft-count-at-least · count": "absent_from_world",
  // The witness. See above — and `check-messages.ts`, where the reason string
  // now separates "the export does not list it" from "the export lists it and
  // we cannot read which one it is".
  "gmail.mailbox-label-count · mailbox": "abstains",
  "gmail.mailbox-label-count · count": "absent_from_world",
  "gmail.mailbox-label-count · label": "declared_subject",
  "gmail.one-message-per-recipient · label": "declared_subject",
  "gmail.one-message-per-recipient · count": "absent_from_world",
};

describe("declared redaction survival", () => {
  it("never turns a failing world into a passing one by destroying a literal", () => {
    for (const check of CHECKS) {
      const verdict = probeRedactionSurvival(check, FIXTURES[check.id]!);
      // A check that names no worlds cannot be probed here either; the
      // HONEST_NULL_WORLDS gate above is what makes that a costly admission.
      if (verdict.kind === "declined") continue;
      for (const row of verdict.rows) {
        expect(
          row.guard,
          `${check.id}'s {${row.param}}: ${row.detail}. A redactor that eats this literal ` +
            `turns the check's OWN failing world into a pass, so a criterion written on it ` +
            `grades a leaking agent clean. Declare the slot as this check's \`subject\` — the ` +
            `engine then skips at the door — or guard it inside \`evaluate\`.`,
        ).not.toBe("vacuous_pass");
        expect(
          row.guard,
          `${check.id}'s {${row.param}} crashed the evaluator: ${row.detail}. A criterion may ` +
            `leave the denominator; it may not take the evaluator with it.`,
        ).not.toBe("throws");
      }
    }
  });

  it("classifies every slot exactly as REDACTION_GUARDS records", () => {
    // The count, held as a value so it cannot quietly change. A new check with
    // no rows here fails, and so does a declaration that moves a slot from one
    // door to another — including the good moves, which should be read on the
    // way past rather than absorbed.
    const measured: Record<string, RedactionGuard> = {};
    for (const check of CHECKS) {
      const verdict = probeRedactionSurvival(check, FIXTURES[check.id]!);
      if (verdict.kind === "declined") continue;
      for (const row of verdict.rows) measured[`${check.id} · ${row.param}`] = row.guard;
    }
    expect(measured).toEqual(REDACTION_GUARDS);
  });
});
