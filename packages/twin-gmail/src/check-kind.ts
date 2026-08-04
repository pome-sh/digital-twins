// SPDX-License-Identifier: Apache-2.0
//
// The one type every Gmail check declaration is written against, mirroring
// twin-github's and twin-slack's `check-kind.ts`. It exists so the declaration
// files can be split by what they assert about without each re-deriving the
// binding to the state tree — and so a declaration that forgets to name
// `GmailCheckState` cannot compile.

import type { CheckDefinition } from "@pome-sh/sdk/checks";
import type { GmailCheckState } from "./check-state.js";

export type Check<TArgs extends Record<string, string>> = CheckDefinition<GmailCheckState, TArgs>;
