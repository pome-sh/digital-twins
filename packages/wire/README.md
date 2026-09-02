<!--
SPDX-License-Identifier: Apache-2.0
-->

# `@pome-sh/wire`

`@pome-sh/wire` defines trace data shared across Pome processes. It contains Zod schemas, TypeScript types, secret redaction, OpenTelemetry mappings, and tool-call correlation.

This package is published only to GitHub Packages at `npm.pkg.github.com`. It is not published to npm.

The CLI bundles this package. End users do not install it or need GitHub Packages credentials. Other Pome repositories use the published package.

`zod` is a peer dependency.

## Scope

The package contains:

- recorder event schemas, including `TwinHttpEvent`
- secret redaction
- OpenTelemetry event schemas and mappings
- tool-call correlation helpers
- run-completeness helpers
- `trace-contract.json`, which describes the recorder event kinds

Sessions, tasks, runs, API error envelopes, and the `pome.json` schema are not part of the trace format. Those definitions remain in [`cli/src/contract/`](../../cli/src/contract/).

## Use

```ts
import { recorderEventSchema, redactSecrets } from "@pome-sh/wire";
import { eventSchema } from "@pome-sh/wire/recorder-events";

const event = recorderEventSchema.parse(row);
const safe = redactSecrets(JSON.stringify(event));
```

Available subpaths are:

- `./recorder-events`
- `./otel`
- `./otel/fixtures`
- `./redaction`
- `./correlation`
- `./run-completeness`

## Correlation

`@pome-sh/wire/correlation` associates an outbound request with the agent tool call that caused it.

The module stores the tool-call ID in `AsyncLocalStorage`. Its fetch hook adds `x-pome-correlation-id` only to configured twin origins.

```ts
import {
  generateToolCallId,
  installCorrelationFetchHook,
  withCorrelation,
} from "@pome-sh/wire/correlation";

installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });

const id = readFrameworkToolCallId(call) ?? generateToolCallId();
return withCorrelation(id, () => handler(args));
```

An adapter supplies `readFrameworkToolCallId`. The correlation module does not depend on an agent framework.

This subpath is not on the root barrel because it initializes `AsyncLocalStorage` and patches `fetch`.

## Run completeness

`@pome-sh/wire/run-completeness` exports shared values and predicates for criterion results:

- `PRE_SATISFIED_REASON`
- `ADVISORY_SCORE_STATE`
- `ABSTAINED_SCORE_STATE`
- `tallyCriteriaResults`
- `isIncompleteTally`

This subpath is not on the root barrel because twins do not evaluate completed runs.

## Trace contract

[`trace-contract.json`](trace-contract.json) lists each recorder event kind and its fixture.

Run this check after a recorder schema change:

```bash
npm run check:trace-contract -w @pome-sh/wire
```

License: Apache-2.0.
