// SPDX-License-Identifier: Apache-2.0
//
// The one type every Slack check declaration is written against, mirroring
// twin-github's `check-kind.ts`. It exists so the declaration files can be split
// by what they assert about without each re-deriving the binding to the state
// tree — and so a declaration that forgets to name `SlackCheckState` cannot
// compile.

import type { CheckDefinition } from "@pome-sh/sdk/checks";
import type { SlackCheckState } from "./check-state.js";

export type Check<TArgs extends Record<string, string>> = CheckDefinition<SlackCheckState, TArgs>;
