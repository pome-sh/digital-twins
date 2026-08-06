// SPDX-License-Identifier: Apache-2.0
//
// The adapter's re-export of the one correlation symbol that is part of its
// PUBLIC surface. F-950 moved the correlation core to
// `@pome-sh/wire/correlation`; `CORRELATION_HEADER` stays exported from
// `@pome-sh/adapter-claude-sdk` because consumers already import it (the
// clean-room pack test compiles a consumer that does).
//
// WHY THIS FILE EXISTS RATHER THAN `export { CORRELATION_HEADER } from
// "@pome-sh/wire/correlation"` ON THE BARREL. `noExternal` governs the JS bundle
// only; tsup's declaration bundler keeps bare specifiers external. Re-exporting
// straight from the barrel therefore emits a literal
// `export { CORRELATION_HEADER } from '@pome-sh/wire/correlation'` into
// `dist/index.d.ts` — a specifier that resolves nowhere for a consumer. Wire is
// published (F-949), but to GitHub Packages, which requires a GitHub token even
// to read: an end user resolving that specifier gets a 401, not a package. So
// the conclusion is unchanged and this file is still required. The JS is fine
// (inlined), so
// nothing breaks until the consumer runs `tsc`, which is the failure mode the
// pack test's non-`skipLibCheck` consumer compile exists to catch. (Setting
// `dts.resolve` instead makes the dts bundler drag in the whole wire barrel and
// emit ambiguous-namespace warnings, so it is the worse trade.)
//
// Assigning through a local `const` gives the declaration emitter a local
// binding to widen — it writes the literal type `"x-pome-correlation-id"`
// inline, with no import to resolve. The value is still wire's, so the two can
// never drift.

import { CORRELATION_HEADER as WIRE_CORRELATION_HEADER } from "@pome-sh/wire/correlation";

/**
 * The header the adapter stamps on outgoing requests to allowlisted twin
 * origins, and that every twin's recorder reads back as
 * `TwinHttpEvent.tool_call_id`. Canonically defined in
 * `@pome-sh/wire/correlation`.
 */
export const CORRELATION_HEADER = WIRE_CORRELATION_HEADER;
