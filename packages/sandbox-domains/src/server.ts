// SPDX-License-Identifier: Apache-2.0
//
// The tape-row shape, and the reason the last frozen `@pome-sh/sdk` pin can
// retire.
//
// pome-cloud has two live consumers of `@pome-sh/sdk/server` and both want the
// same single function: `apps/control-plane/src/lib/twin-tape-pull.ts` and
// `apps/mcp/src/lib/capture.ts` wrap a recorded event into the unified
// `TwinHttpEvent` NDJSON row that uploaded `events.jsonl` carries. Nothing else
// on that barrel is imported there, and the barrel is the whole engine — which
// is why both manifests were pinned to a frozen `@pome-sh/sdk@0.11.1` (the
// sixth pin) rather than to anything anyone could move.
//
// It arrives through `@pome-sh/sdk/server` because that is the only public
// subpath exporting it — `toTwinHttpEventRow` is defined in the sdk's
// `recorder.ts`, which has no `exports` entry of its own. tsup's treeshaking
// decides how much of that barrel actually lands in the bundle, and
// `scripts/ci/check-sandbox-domains-tarball.mjs` asserts the answer rather than
// either of us predicting it: the point of the gate is that the shipped
// dependency set is measured, not assumed.
export { toTwinHttpEventRow } from "@pome-sh/sdk/server";
export type { RecorderEvent } from "@pome-sh/sdk";
