---
"@pome-sh/cli": minor
---

A run whose criteria did not all get graded is `INCOMPLETE`, and `pome run` no
longer exits 0 on it.

The old terminal output, from a real cold walk:

```
UNEVAL Task 01 — Bug, happy path
  score: un-evaluated (cannot pass) — 2 passed, 0 failed, 2 skipped, 0 errored; cloud score: 100/100
```

Two of the four criteria never ran. The CLI was **right** to refuse to call that
a pass — 100/100 over the other two is not a verified anything — and it said so
in two broken ways. `cannot pass` reads as the agent's failure, when the gap was
the grader's. And the state had no name the dashboard shared, so a first-run user
saw a scary refusal sitting next to `cloud score: 100/100` with no way to know
which one to believe.

Now both surfaces say the same word:

```
INCOMPLETE Task 01 — Bug, happy path
  score: incomplete — 2 of 4 criteria not evaluated; 2 passed, 0 failed, 2 skipped, 0 errored; cloud score: 100/100
```

**`pome run` exits 1 on an incomplete run.** It used to map the raw cloud score
straight to an exit code, a divergence from `pome eval` justified by old cloud
builds that emit no per-criterion results. That compatibility already lives one
layer down — the score reader marks such a response gradable so the guard becomes
a no-op for exactly those builds — so the divergence was protecting a case its
own helper already protected. A run whose check never ran is not a green CI
signal.

**A trial group stops counting an ungradable trial as a loss.** Five trials with
one abstention now read `3 of 4 passed · 1 incomplete, excluded from the
fraction` — never `4 of 5`, which counted it as a pass, and never `3 of 5`, which
counts it against the agent. The group cannot exit 0 while one of its trials was
never graded.

What did NOT change: the guard itself. `scoreStatus` and `can_pass` still refuse
to inflate a partial run into a pass on **any** abstention, which is the same
rule the dashboard applies to the same criteria. Only the name, the copy, and the
exit code moved.
