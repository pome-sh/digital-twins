---
"@pome-sh/cli": minor
---

`pome checks stripe` prints Stripe's declared vocabulary instead of "no declared checks yet" (F-1127).

Eleven declarations arrive from `@pome-sh/twin-stripe@0.4.0`, so `pome checks`, `pome checks add`
and `pome checks lint` all cover Stripe now. `TWINS_WITHOUT_CHECKS` is down to gmail and linear.

The six starter tasks under `tasks/` that target Stripe were rewritten to bind: tasks 11, 12, 13
and 14 carried `[code]` criteria that had never been graded deterministically — prose, a
JavaScript expression, and sentences whose subject the sentence never identified. `pome checks lint
tasks/1*-stripe*.md` is green on all of them.

Task 14 also loses a claim that measurement showed to be false: sending an `Idempotency-Key` on the
retry does not prevent the second refund row in this twin, because the injected 402 is the response
the idempotency middleware sees and it declines to cache any 4xx. What the task actually separates
is an agent that verifies before retrying from one that retries blindly.

`twinsWithoutChecks()` is exported so tests can derive "a twin that declares nothing" rather than
naming one — five tests named `stripe` inline and all five broke when it stopped being true.
