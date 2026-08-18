# @pome-sh/sandbox-domains

## Unreleased (patch)

**`SlackDomain.seed` writes files, and `slackSeedSchema` accepts them** (F-1509).
The seed gained
`files: [{id?, name, title?, filetype?, user?, channels?, content?}]`, so
`filesList` / `filesInfo` / `slack_read_file` read a populated table on a freshly
seeded world. Until now `filesUpload` — a mutation — was the `files` table's only
writer, so every read-only run against a fresh seed answered on an empty table.

`user` and `channels` take seed HANDLES (a user/channel `name`) or ids, the same
currency `channels[].members` already accepts. `mimetype` is derived from
`filetype`, `size` from the byte length of `content`, and `title` defaults to
`name` — the same derivations `filesUpload` applies, so a seeded file and an
uploaded one are indistinguishable in a response. A `channels` entry naming no
seeded channel is dropped rather than stored, so `files.list?channel=…` can never
filter against an id no channel has.

**No check vocabulary moved**, so this release does NOT need to be pinned in
lockstep with `@pome-sh/checks` the way 0.2.0 below did — `checks-package-drift`
compares the binding surface, and the binding surface is unchanged. Both packages
carry an entry only because both re-export the seed schema.

**Patch, not minor.** `files` defaults to `[]`: every existing seed parses to the
same value and the `files` table is untouched when the key is empty. Widening an
input schema cannot break a caller.

## 0.2.0 — 2026-08-14

**`GITHUB_CHECKS`' tape slot widens from two action names to three** (F-1521), so
this package's binding surface moves and its pin must catch up with
`@pome-sh/checks`' in the same step.

The tuple's LENGTH does not change — still sixteen checks, none added or removed.
What moves is the compiled pattern of `github.tool-was-called` and
`github.tool-never-called`: both take their `{tool}` slot from the twin's
`TAPE_ASSERTABLE_TOOLS`, which gained `add_issue_comment`, so
`` `add_issue_comment` was called `` now binds where it previously did not.
`checksDigest` hashes that pattern, so the digest moves.

**This release and `@pome-sh/checks`' are one release, cut from one commit.**
`checks-package-drift.test.ts` demands the declarations package and this runtime
declare an identical binding surface per twin, with no allowlist — publishing a
widened vocabulary whose runtime could not follow is the wall F-1524 recorded.
Pinning one of the two without the other reds that gate.

**The runtime half.** `GitHubDomain.addIssueComment` is unchanged in behaviour;
what changed is upstream of this package's exports, in the twin's REST route,
which now declares `add_issue_comment` as the action it performs so the recorder
stamps the same name it already stamped for an MCP `tools/call`. A consumer of
this package sees that only through the widened vocabulary above — the HTTP door
ships in the twin's own server entry, which this package does not re-export.

## 0.1.0 — 2026-08-13

First release. The **domain layer** — the in-process runtime a bound check
reads — published as one self-contained bundle (F-1526).

**On the name.** Everything this package wraps is still called a *twin* in this
repository: `@pome-sh/twin-github`, `TWIN_CHECKS`, `CONTRACT.md`. The published
artifact is called `sandbox-domains` anyway, because *twin* is being retired
from the product vocabulary and an npm name is the one identifier here that
cannot be renamed later — a package name is permanent, an internal symbol is a
find-and-replace. So the artifact uses the vocabulary this is moving to and the
code still uses the one around it; the two converge when the rest of the repo
does. The exception is symbols this package RE-EXPORTS —
`toTwinHttpEventRow`, `TwinStripeDatabase`, `GITHUB_CHECKS` — which keep their
upstream spelling, because renaming a re-export would fork the name from the
thing it names.

**What this is for.** pome-cloud grades every `[code]` criterion out of
`@pome-sh/checks`' declarations and boots the twin domain layer in-process to
read the state those declarations describe. `checks-package-drift.test.ts`
demands the two declare an identical binding surface per twin, with no allowlist
— and until now only one of them could publish. The five `@pome-sh/twin-*`
packages went `private: true` on 2026-08-04 to fix a real bug (two zod schema
identities for one wire type, F-942) and had no publish lane after it, so when
the vocabulary widened the runtime could not follow: the gate went red with no
legal move available. This package is that lane. The twins and `@pome-sh/sdk`
stay private; nothing about F-942 or F-1308 is reversed.

**What it exports.** Per twin, at `@pome-sh/sandbox-domains/<twin>`:

| entry | exports |
| -- | -- |
| `./github` | `GitHubDomain`, `openGitHubCloneDatabase`, `parseSeed`, `GITHUB_CHECKS` |
| `./gmail` | `GmailDomain`, `openGmailTwinDatabase`, `parseSeed`, `GMAIL_CHECKS` |
| `./linear` | `LinearDomain`, `openLinearTwinDatabase`, `parseSeed`, `LINEAR_CHECKS` |
| `./slack` | `SlackDomain`, `openSlackTwinDatabase`, `parseSeed`, `SLACK_CHECKS` |
| `./stripe` | `StripeDomain`, `openTwinStripeDatabase`, `parseSeed`, `applySeed`, `TwinStripeDatabase`, `STRIPE_CHECKS` |
| `./server` | `toTwinHttpEventRow` |

The barrel (`@pome-sh/sandbox-domains`) carries all five with per-twin prefixes —
every twin names its seed parser `parseSeed`, so four of the five would lose a
name collision otherwise — plus `SANDBOX_DOMAINS`, the keyed record a boot path
wants when it is handed a twin name rather than knowing it.

`./server` exists to retire the last frozen `@pome-sh/sdk@0.11.1` pin:
`toTwinHttpEventRow` was the only symbol two pome-cloud modules imported from
that whole barrel.

**How it is built.** tsup with `noExternal: [/^@pome-sh\//]` and
`splitting: true`, the same shape `@pome-sh/checks` uses. Zero `@pome-sh/*`
runtime dependencies; `zod` is a **peerDependency** and is never bundled, so the
consumer's graph holds exactly one zod and `parseSeed`'s results stay
interchangeable with seeds the consumer built. SQLite is `node:sqlite`, so there
is no native dependency to install. `hono` is an ordinary declared dependency
here rather than a forbidden engine byte — the deliberate difference from
`@pome-sh/checks`, which ships declarations and must carry no engine at all.

`@octokit/openapi-types` and `stripe` are declared because the shipped `.d.ts`
reaches them: they are the twins' upstream shape anchors, and they appear in
`GitHubDomain`'s and `StripeDomain`'s method signatures. They carry no runtime
code into the bundle. Consumers typecheck as Node servers (`@types/node` and the
DOM lib), which is what `stripe`'s and `hono`'s own declarations require.

Requires Node ≥ 24 (`node:sqlite`).
