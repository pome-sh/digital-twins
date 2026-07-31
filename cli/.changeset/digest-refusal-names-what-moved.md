---
"@pome-sh/cli": patch
---

The digest refusal now names what moved in every case, including the two it used
to refuse over in silence.

`pome checks add` compares its own vocabulary digest against the one the control
plane grades with, and refuses to write a sentence when they differ. That refusal
built its "which check moved" list from `id` and `template`, while `checksDigest`
hashes `id`, `substrate` and the COMPILED pattern. So a skew that moved only a
`substrate`, or only `buildPattern`'s output while every template stayed
byte-identical, printed the headline and then an empty bullet list — a named
refusal that named nothing, in exactly the two cases the digest was widened to
catch.

The comparison is now a taxonomy with no silent branch: ids on one side only, a
moved sentence, a moved substrate, moved parameter patterns, and — because
`GET /v1/checks` publishes the compiled pattern too — a check whose declaration
matches ours yet compiles differently, which is reported as the `@pome-sh/sdk`
`buildPattern` difference it is, with this CLI's sdk pin named. A control plane
that publishes no compiled pattern leaves nothing to localise, and that case is
reported as its own class rather than as a blank list.
