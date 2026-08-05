<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/sdk

**Internal to the `pome` CLI. Not a standalone install.**

The twin engine behind [Pome](https://pome.sh) digital twins. A twin is a
declaration — its domain, tools, and frozen wire shapes — and this engine
supplies all of the mechanism: HTTP mounting, bearer auth, the trace recorder
with secret redaction, MCP dispatch, SQLite-backed state, and the admin
reset/seed gate. The five first-party twins in
[`packages/`](../README.md) are thin plugins on it.

This package is an implementation detail of
[`@pome-sh/cli`](https://www.npmjs.com/package/@pome-sh/cli) and of the twin
container images; it ships inside the CLI tarball. Authoring third-party twins
on it is not a supported product surface, and there is no public
`defineTwin` API to depend on. To run a twin:

```bash
npx @pome-sh/cli twin start github
```

Every engine-booted twin honors the frozen runtime contract in
[`CONTRACT.md`](https://github.com/pome-sh/pome-twins/blob/main/CONTRACT.md)
— entry point, env surface, `/healthz` shape, auth, and MCP surfaces. Endpoint
fidelity tiers are defined in [`ENDPOINT-TIERS.md`](./ENDPOINT-TIERS.md).

## Recorder (twin-core home)

The trace recorder lives in this package (`packages/sdk/src/recorder.ts`).
There is no separate `packages/twin-core` — F-681 folded twin-core into
`@pome-sh/sdk`. Default boot uses an in-memory store; set
`POME_RECORDER_EVENTS_PATH` to enable durable write-through (`flush` /
`close`, TwinHttpEvent NDJSON). Redaction always runs in the handle *before*
`store.record()`, including for custom stores.

**Architecture (F-698 / §9 Q3):** recorder *transport* belongs in twin-core
(`@pome-sh/sdk`). Twins inherit durability via `resolveRecorderStore()` /
`POME_RECORDER_EVENTS_PATH`; the self-host CLI harness passes the run's
`events.jsonl` path into the same store. Disk rows are already
`TwinHttpEvent`-shaped so upload/finalize byte shape is unchanged.

## Docs

Full documentation at [docs.pome.sh](https://docs.pome.sh). Source and
issues at [pome-sh/pome-twins](https://github.com/pome-sh/pome-twins).

## License

Apache-2.0
