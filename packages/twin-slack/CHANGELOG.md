# @pome-sh/twin-slack — CHANGELOG


## 0.3.6 — 2026-08-08

`slack.no-reaction-added` declares `subject: ({ reaction }) => reaction`. It
declared `null` while the comment beside it said the reaction name is SCANNED
and its `vacuityMutant` falsified exactly that slot (F-1157).

The consequence was not a blind grader but a wrong verdict, because the check is
NEGATIVE: a redactor masking `reactions[].name` makes the filter match nothing,
so `No "white_check_mark" reaction was added` PASSES over an export in which the
agent added that reaction. It was the only `vacuous_pass` across all five twins'
45 declarations, found by destroying the literal in the check's own declared
failing world and watching that world start to pass.

With the subject declared, the engine skips such a criterion at the door instead
of scoring it. No sentence, no parse and no passing-world verdict moves.

**This does not close F-1159**, which is the same check passing vacuously for a
different reason: `(final.reactions ?? [])` scores the same negative criterion
`passed` when the export carries no `reactions` collection at all. A masked value
and an absent section are different causes, and the probe that found the first
replaces strings rather than deleting collections, so it is structurally unable
to see the second. That guard still lives in the consuming engine's
`STATE_SECTION_GUARDS`; the gap is marked at the call site.


## 0.3.5 — 2026-08-06

Its MCP tool table is now derived from `fixtures/mcp-tools-list.raw.json`
rather than declared in TypeScript (F-1325). The fixture's provenance —
substrate, endpoint, protocol version, capture date and the sha of the raw
bytes — is validated at load, and the derivation is 1:1 in both directions, so
a tool the fixture does not declare and a fixture tool nothing implements are
each a throw at module load.

Name-neutral by construction: `tools/list` and the legacy `/mcp/tools` surface
are byte-identical before and after.

**Removed from the package root**: `listTools`, `listToolsForMcp` and
`toolDefinitions`. Nothing served them — the engine answers both `/mcp/tools`
and `tools/list` from `definition.tools` — so they were a second projection of
the same table. The replacements are `slackToolFixture`,
`slackToolInputSchema` and `toolSchemas`. This package is `private: true` and
on no registry, and neither published tarball re-exposes a twin package root,
so no installable consumer can have been importing them; every in-repo caller
moved in the same change.

## 0.3.3 — 2026-08-04

Dependency-only patch (#302): `hono` `^4.12.31` → `^4.13.0`, `zod` `^4.1.13` → `^4.4.3`, `@hono/node-server` `^2.0.10` → `^2.1.0`.
No source file changed and `npm run test:contract` is green, so the surface is
identical — this exists so the npm artifact stops differing from `main`, which is
the staleness the publish skip-guard cannot see.

## 0.3.2 — 2026-08-04

- Re-pinned to `@pome-sh/sdk@0.11.0` / `@pome-sh/shared-types@0.14.0` for the F-1200 parent-vocabulary
  change: a recorded row now carries `parent_event_id` rather than `parent_id`.
  No change to this twin's own surface — `npm run test:contract` is green.

All notable changes to the Slack twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).


## 0.3.1 — 2026-08-03

Every state-reading check says where it looked (F-1197).

- 5 declarations now fill `CheckOutcome.evidenceStatePaths` (new in
  `@pome-sh/sdk` 0.10.1) with RFC 6901 pointers into this twin's exported tree.
- `check-state.ts`'s resolvers return the pointer they walked. `Resolved<T>`'s
  found arm gains `path`; its missing arm gains an optional `searched`, naming
  the collection a failed lookup scanned.
- `checks-contract.test.ts` gains the citation gate and an EMPTY
  `HONEST_UNCITED_CHECKS` ledger.

A failed lookup cites too, and that is the half worth knowing about. An absent channel SKIPS rather than failing, and a skipped criterion's reason is the least self-explanatory thing on the report.
So the honest citation on that arm is not the row — there is none — but the list:
*this is where I looked, see for yourself that it is not in it.*

Requires `@pome-sh/sdk` 0.10.1: the declarations call `statePath` /
`childStatePath`, which 0.10.0 does not export.

No sentence, template, substrate or check id changed, so `checksDigest` is
identical and no criterion re-binds.

## 0.3.0 — 2026-07-30

Slack declares its assertable check vocabulary (F-1126, milestone A3).

- New `./checks` subpath: `SLACK_CHECKS`, five declarations, plus the
  `SlackCheckState` model they read (`check-state.ts`). pome-cloud deletes its
  hand-maintained mirror of that shape in the same milestone — the twin's model
  is now the only one.
- `slack.no-secret-newly-exposed` grades the secrets class as a `seed+final`
  delta. It never reads a secret: seed and final cross the same redactors, so
  the value is `[REDACTED]` on both sides and only its POSITION differs.
- `fidelity-contract.test.ts` gains a state-shape parity arm. The harness's
  three existing rings are all about the tool surface; nothing had ever compared
  the state export against anything.
- Repins `@pome-sh/sdk` to 0.10.0 and `@pome-sh/shared-types` to 0.13.0. The
  previous 0.5.1 / 0.12.0 pins meant npm installed nested PUBLISHED copies
  rather than symlinking the workspace, so this package had been built and
  tested against a five-minor-old sdk.

Minor: new published exports and an sdk floor a consumer must act on. No change
to the served REST/MCP surface or to `/_pome/state`.

## 0.2.2 — 2026-07-21

Dependency-only patch: repin `@pome-sh/sdk` to 0.5.1 and
`@pome-sh/shared-types` to 0.12.0 (F-818). No twin surface change.

## 0.2.1 — 2026-07-20

Dependency-only release: repins the shared first-party contract to
`@pome-sh/shared-types@0.11.0` and the additive Gmail-capable engine to
`@pome-sh/sdk@0.5.0`. Slack wire behavior is unchanged.

## 0.2.0 — 2026-07-16

Batches everything landed on main since 0.1.2 whose versions were never cut
(the publish workflow skips already-published versions, so npm 0.1.2 had gone
stale against the repo):

- #119 — FIDELITY.md re-cut by the heat rubric; the 3 ruled MCP read tools
  added to the packaged surface.
- #116 — structured fidelity inventory (`fidelity.inventory.json`) shipped as
  the machine-readable seam source of truth.
- #128 / #109 — `@pome-sh/sdk` pinned to 0.4.0: the twin self-generates
  `TWIN_AUTH_SECRET` on first non-loopback boot (`ensureTwinAuthSecret`).

Minor: the served REST/MCP fidelity surface changed shape.

## 0.1.2 — 2026-07-10

Dependency-only release for the node:sqlite driver swap (F-703):
`@pome-sh/sdk` pinned to 0.3.1 and the direct `better-sqlite3` dependency
dropped — the twin's install closure now has zero native modules. No twin
behavior changes.

## 0.1.1 — 2026-07-10

Dependency-only release: `@pome-sh/sdk` pinned to 0.3.0 (durable write-through
recorder) so the CLI bundle resolves a single sdk copy. No twin behavior
changes.

## 0.1.0 — 2026-07-09

First npm-published release (F-714).

A deterministic Slack Web API twin for agent testing — REST + MCP surfaces
over SQLite-backed state, built as a thin `@pome-sh/sdk` plugin (F-683): the
twin declares its domain, tools, and Slack's frozen wire shapes
(`{ok:false, error}` envelopes on HTTP 200, form-or-JSON body parsing); the
engine owns HTTP mounting, bearer auth, the recorder, MCP dispatch, and the
admin gate.

### Added

- `twin-slack` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- Slack Web API twin surface (channels, messages, reactions, files) as REST
  and MCP tools, with `SLACK_DETERMINISTIC_TS` for reproducible timestamps.
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `SLACK_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry points `createSlackTwinApp` and `slackTwinDefinition` for
  in-process embedding (used by the `pome` CLI's `--local` harness).
