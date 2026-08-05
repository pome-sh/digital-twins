<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/wire

The trace surface every Pome process agrees on — Zod schemas and TypeScript
types for recorder events, the OpenTelemetry extension of that union, and
secret redaction. The `pome` CLI, the twin engine (`@pome-sh/sdk`), the
first-party twins and the Claude adapter all speak this vocabulary; the wire
format is the contract, not any one library.

Internal (`private: true`): it is never published. The CLI inlines it into its
single bundle (`cli/tsup.config.ts` `noExternal`), and the twin images copy its
built `dist/`.

## What is NOT here

Sessions, tasks, runs, the `/v1` REST surface, error envelopes and the
`pome.json` manifest are the cloud control-plane contract, not the wire trace
surface. They live in [`cli/src/contract/`](../../cli/src/contract) (F-942).
GitHub's sandbox access-control catalog lives in
[`packages/twin-github/src/access-control.ts`](../twin-github/src/access-control.ts),
next to the tools it describes.

## Usage

```ts
import { recorderEventSchema, redactSecrets } from "@pome-sh/wire";
import { eventSchema } from "@pome-sh/wire/recorder-events";

const event = recorderEventSchema.parse(row);
const safe = redactSecrets(JSON.stringify(event));
```

Subpath exports: `recorder-events`, `otel`, `otel/fixtures`, and `redaction`.
`zod` (^4.1.13) is a peer dependency.

## trace-contract.json

The machine-readable descriptor of this package's trace surface. Its
`eventKinds` map is enumerated from the zod event union at emit time and lists
the wire fixture backing each kind — adding a union member without a fixture
fails `npm run check:trace-contract -w @pome-sh/wire` (see
`test/fixtures/v1/README.md`).

## License

Apache-2.0.
