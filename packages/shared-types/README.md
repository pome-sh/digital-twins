<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/shared-types

**Internal to the `pome` CLI. Not a standalone install.**

The shared wire-format contract for [Pome](https://pome.sh) — Zod schemas
and TypeScript types for traces, recorder events, runs, task seeds,
OTel span mapping, and secret redaction. The `pome` CLI, the twin engine
(`@pome-sh/sdk`), the first-party twins, the Claude adapter, and the Pome
cloud all speak this vocabulary; the wire format is the contract, not any
one library.

This package is an implementation detail of
[`@pome-sh/cli`](https://www.npmjs.com/package/@pome-sh/cli) and ships inside
the CLI tarball. The stable, machine-readable form of the contract is
`trace-contract.json` (emitted by `npm run emit:trace-contract` and checked in
CI) — depend on that artifact, not on this package.

`zod` (^4.1.13) is a peer dependency. In-repo entry points:
`recorder-events`, `run`, `otel`, `otel/fixtures`, and `redaction`. The
machine-readable trace contract ships as `trace-contract.json` inside the
package. Its `eventKinds` map is enumerated from the zod event union at build
time and lists the wire fixture backing each kind — adding a member without a
fixture fails `check:trace-contract` (see `test/fixtures/v1/README.md`).

## Docs

Full documentation at [docs.pome.sh](https://docs.pome.sh). Source and
issues at [pome-sh/pome-twins](https://github.com/pome-sh/pome-twins).

## License

Apache-2.0
