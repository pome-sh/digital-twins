---
"@pome-sh/cli": minor
---

`pome checks` — the typed checks a twin declares, and `pome checks add <file>`,
which writes the criterion sentence for you.

You pick a check from the closed set and fill its typed parameters; pome renders
the English into `## Success Criteria`. You never type the sentence, so a
`[code]` criterion cannot fail to bind and silently leave the score denominator.

Before writing, the CLI compares its vocabulary digest with the cloud's and
refuses if the two disagree, naming which check moved. Offline it writes from
the local pin and says on stderr that it was not verified. It also refuses to
add a criterion the task already carries, which would be scored twice.
