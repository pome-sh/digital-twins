// SPDX-License-Identifier: Apache-2.0
// The packaged first-run demo task.
//
// `assets/demo/first-run-demo.md` (+ its hand-written seed sidecar) is the
// CANONICAL demo task content. The cloud's server-owned judge definition
// (pome-cloud apps/control-plane/src/lib/demo.ts,
// DEMO_TASK_DEFINITIONS["first-run-demo"]) is regenerated from that markdown;
// at finalize the cloud IGNORES the client body entirely and judges the
// server copy, so the CLI-side pin here is informational (mint sends
// task_hash: "").

import { assetPath } from "../cli/assets.js";

/** Server-allowlisted demo task name (mint + gateway + finalize key). */
export const DEMO_TASK_NAME = "first-run-demo";

/** The repo the packaged seed creates; handed to the bundled agent. */
export const DEMO_REPO = "acme/api";

/**
 * Absolute path of the packaged demo task markdown, at
 * `<packageRoot>/assets/demo/` in every layout (see src/cli/assets.ts — it
 * cannot be resolved relative to this module once the CLI is bundled).
 */
export function demoTaskPath(): string {
  return assetPath("demo", "first-run-demo.md");
}
