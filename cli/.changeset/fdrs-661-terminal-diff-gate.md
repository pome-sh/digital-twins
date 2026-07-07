---
"pome-sh": minor
---

**`pome install` now gates the wiring behind a terminal diff — nothing is written until you approve it.**

The default flow embeds the wiring agent headless on your own Claude
credentials (a one-time few-MB Claude Agent SDK driver download drives your
installed `claude` binary), stages its edits in an isolated shadow copy of
the repo, and renders the full file list + unified diff in pome's terminal.
The working tree changes only on `[y]`; dependencies the diff adds are
installed by pome afterwards, then `pome doctor` verifies to green. A
session that produces no applicable diff exits with the agent's named
reason, never a silent no-op. `pome install --interactive` keeps the
previous flow: a live agent session with approval in the agent's own
edit-approval UI (also the automatic fallback when no Claude credentials
are present or the driver download is declined).
