// SPDX-License-Identifier: Apache-2.0
//
// The one type every GitHub check declaration is written against (F-1075).
//
// It exists so `check-issues.ts`, `check-pulls.ts` and `check-repos.ts` can be
// separate files without each re-deriving the binding between a declaration and
// the state tree it reads — and so a declaration that forgets to name
// `GitHubCheckState` cannot compile.

import type { CheckDefinition } from "@pome-sh/sdk/checks";
import type { GitHubCheckState } from "./check-state.js";

export type Check<TArgs extends Record<string, string>> = CheckDefinition<GitHubCheckState, TArgs>;
