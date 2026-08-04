# The CLI names the third state `INCOMPLETE`, and stops contradicting the cloud

Covers **F-932 in full** and **F-925's CLI half**. They are one change: the same
renderer, the same exit-code decision, and — per both tickets — the same
`@pome-sh/cli` publish.

F-925's cloud half merged as pome-cloud `870374b5`. F-931 (the per-criterion
class) merged as `65439c0b`.

---

## The symptom

```
UNEVAL Task 01 — Bug, happy path
  score: un-evaluated (cannot pass) — 2 passed, 0 failed, 2 skipped, 0 errored; cloud score: 100/100
```

Two of four criteria never ran. The CLI noticed, and said so in two broken ways:
it called the state **`cannot pass`**, which reads as the agent's failure; and it
**overrode** a verdict it is not authoritative over instead of naming a state
the verdict itself now carries.

---

## Findings that shaped the design

Measured on brisbane `4675826`, which is `origin/main`.

**F1 — `can_pass` is ALREADY any-shaped. This is the finding that shrinks the
work.** `uploadAndFinalize.ts`'s `scoreFromFinalizeResponse`:

```ts
can_pass: hasCriteriaResults
  ? totalRequired > 0 && skipped === 0 && errored === 0
  : true,
```

`skipped === 0` — **one abstention is enough**. The CLI's predicate is already
F-925's ratified rule and has been all along, which is why the terminal output
above exists at all. F-932 says it outright: *"The CLI was right."*

So this is **not** a predicate change and **not** a new consumer. It is naming,
authority, and an exit code.

**F2 — `all_skipped` is the WRONG field to read, and reading it would re-open
the hole F-932 warns about.** F-932's instruction is "render the cloud's
`incomplete`", written when it looked as though F-925 would publish a run-level
flag. F-925's cloud half deliberately publishes none — and that turns out to
matter more than it did at the time:

| | predicate |
| -- | -- |
| wire `all_skipped` | `isFullyUnevaluated` — **every** criterion abstained |
| CLI `can_pass` | **any** criterion abstained |
| cloud `deriveRunStatus` | **any** criterion abstained |

`all_skipped` is strictly narrower. Wiring the CLI to it would *loosen* the A5
guard — exactly the inflation F-932's own rewritten bullet 3 exists to prevent.
Both surfaces already compute the same rule from the same `criteria_results`;
what they lack is a written statement that it is one rule. That is a test and a
pair of comments, not a field. No third place spans the two repos.

**F3 — The FDRS-618 divergence's compat argument is already implemented, so
retiring it costs nothing.** `eval.ts:532-540` documents why `pome run` maps the
raw score while `pome eval` applies the A5 guard: *"pre-FDRS-618 cloud builds
don't emit `criteria_results`."* But `scoreFromFinalizeResponse` already handles
that — `hasCriteriaResults ? … : true` makes `can_pass` true when the field is
absent, so `scoreStatus` degrades to score-only for exactly those builds. The
divergence guards a case the shared helper already guards. Deleting it changes
behaviour only for responses that DO carry `criteria_results`, which is the case
the ticket wants changed.

**F4 — The group already has a three-valued exit contract.**
`groupRender.ts:126` documents `0` = every completed trial passed, `1` = a
completed trial failed, `2` = nothing completed. So a third state is not
unprecedented here; what is unprecedented is a fourth *code*.

**F5 — One ticket coordinate is wrong.** F-932's "Repo / area" lists
`cli/src/hosted/runTaskHosted.ts`; the file is `cli/src/runner/runTaskHosted.ts`.
The line numbers (648-649) are right.

**F6 — A known, unreachable corner, recorded so it is not mistaken for a bug.**
`Score.evaluated` is `totalRequired > 0`, so a run with **zero** criteria reads
`incomplete` in the CLI while the cloud's `total > 0` guard keeps it
score-derived. The CLI's task parser requires a `## Success Criteria` section,
so no CLI-run task reaches it. Not fixed; naming it costs a sentence and
re-deriving it later would cost an afternoon.

---

## Design

### 1. Rename the state; do not touch the guard

`ScoreStatus`'s third value becomes `"incomplete"`. `scoreStatus` and `can_pass`
keep their logic **exactly** — they are the A5 inflation guard, and F-932's
rewritten bullet 3 is explicit that deleting them removes the one place the CLI
refuses to inflate a partial run into a pass.

| | before | after |
| -- | -- | -- |
| label | `UNEVAL` | `INCOMPLETE` |
| line | `score: un-evaluated (cannot pass) — 2 passed, 0 failed, 2 skipped, 0 errored; cloud score: 100/100` | `score: incomplete — 2 of 4 criteria not evaluated; 2 passed, 0 failed, 2 skipped, 0 errored; cloud score: 100/100` |

"cannot pass" goes because it is a verdict about the agent. The replacement
leads with the count, which is the fact the reader needs and the thing the
cloud's own header now says.

### 2. `pome run` applies the A5 guard

`runTaskHosted.ts:649` becomes `scoreStatus(score, passThreshold) === "pass" ? 0 : 1`,
retiring the documented divergence on F3's grounds — the compatibility it
protects is already protected one layer down.

**`incomplete` exits 1, not a new code.** `pome eval` has shipped exactly that
for the same state; two surfaces already agree on it; and `2` is documented as
"nothing completed", so widening it would break a meaning something else
depends on.

The cost, stated rather than hidden: **a CI pipeline cannot distinguish "the
agent regressed" from "we could not grade it".** F-932 raises the CI-signal
question directly, and a distinct code would answer it better. It is declined
here because CLI exit codes are a public contract and neither ticket asks to
widen it — that is its own decision, not a side effect of this one.

### 3. The run-set stops counting an ungradable trial as a failure

`TrialRow`'s `passed: boolean` becomes a three-state verdict. `groupSummaryLines`
prints the fraction over gradable trials with the incomplete count beside it,
mirroring what `errored` already does and what F-925 shipped cloud-side:

```
3 of 4 passed · 1 incomplete, excluded from the fraction
```

Never `4 of 5`, and never `3 of 5`.

`groupExitCode` keeps its documented contract and gains one clause: an
incomplete trial is not a pass, so a group containing one cannot exit 0. A
group whose trials were *all* incomplete still exits 1 rather than 2 — `2`
means nothing completed, and these completed.

### 4. Testing — both tickets carry `tdd-required`

Tests first, failing for their stated reasons before implementation.

| area | what fails first |
| -- | -- |
| `scoreStatus` / `runScoreLine` | returns `"incomplete"`; the line names the count and contains neither `cannot pass` nor `un-evaluated` |
| `pome run` exit | a 100/100 run with one abstention exits 1; a fully-evaluated 100/100 exits 0; a response with **no** `criteria_results` still exits by score alone (F3's compat, pinned) |
| trial group | the fraction reads `3 of 4 passed · 1 incomplete`; `groupExitCode` is 1 with an incomplete trial present |
| the shared rule | a test asserting `can_pass` is false for **one** skip — the statement that this and the cloud's `isRunIncomplete` are one rule (F2) |

`grep` acceptance from F-932, as *strings*: `cannot pass` and `UNEVAL` gone;
`scoreStatus` and `can_pass` still present.

---

## Done-when, mapped

| bullet | where |
| -- | -- |
| F-932: a fully-covered task prints `PASS 100/100` | unchanged behaviour, pinned by a test |
| F-932: an abstaining task prints `incomplete` with the count; neither surface says `passed` or `cannot pass` | §1 |
| F-932 (rewritten): `cannot pass` / `UNEVAL` gone as strings; the guard survives | §1 |
| F-932: CLI and cloud headlines never contradict | §1 + §2 — both now name the same state from the same rule |
| F-925: CLI trial line reads `INCOMPLETE …`, never visually identical to a pass | §1 + §3 |
| F-925: `pome run` exits non-zero on `incomplete` | §2 |
| F-925: run-set reads `3 passed · 1 failed · 1 incomplete`, never `4 of 5` | §3 |

---

## Out of scope

- **Publishing.** This ends at a merged PR plus a Changeset. Both tickets warn
  that sibling twins tickets share ONE `@pome-sh/cli` publish and that it must be
  cut last and deliberately; A3's lesson is that a seam ticket marked Done with
  one attachment is half-shipped.
- **A distinct exit code for `incomplete`** — §2, declined with reasons.
- **Reading `all_skipped` / `criteria_breakdown`** — F2, actively harmful.
- **Deleting `scoreStatus` / `can_pass`** — F-932's rewritten bullet 3.
- **The zero-criteria corner** — F6, unreachable through the CLI's parser.
