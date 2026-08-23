// SPDX-License-Identifier: Apache-2.0
export { LinearDomain } from "./domain/index.js";
export type { ActorContext, PendingCode } from "./domain/index.js";
export { openLinearTwinDatabase, migrate, resetDatabase } from "./db.js";
export {
  LinearTwinError,
  linearErrorEnvelope,
  unauthorizedEnvelope,
  unsupportedEnvelope,
} from "./errors.js";
export { looksLikeLinearToken, resolveLinearCredential } from "./auth-credential.js";
export { assertWebhookUrl, webhookUrlError } from "./webhook-url.js";
export { linearToolFixture, linearTools, LINEAR_MCP_TOOL_COUNT } from "./mcp.js";
export { projectLinearRecording } from "./recording.js";
export {
  defaultSeedState,
  linearSeedSchema,
  loadSeedFromEnv,
  parseSeed,
} from "./seed.js";
export type { ParsedLinearStateSeed } from "./seed.js";
export { exportLinearState, linearStateDelta } from "./state.js";
export type { LinearStateExport } from "./state.js";
export {
  createLinearTwinApp,
  createLinearTwinDefinition,
  withPublicOAuth,
} from "./twin.js";
export { registerLinearRoutes } from "./routes.js";
// The declared check vocabulary. Re-exported from the root as
// twin-slack does, alongside the `@pome-sh/twin-linear/checks` subpath that
// pome-cloud and the CLI both import. The `LinearCheckState*` types are a
// CHECK's reading of the exported tree, and are deliberately distinct from the
// `LinearIssue` / `LinearUser` / `LinearComment` row types below: the export
// carries `stateId` and `labelIds` where those carry names.
export { LINEAR_CHECKS } from "./checks.js";
export type {
  Check,
  LinearCheckState,
  LinearCheckStateComment,
  LinearCheckStateIssue,
  LinearCheckStateLabel,
  LinearCheckStateTeam,
  LinearCheckStateUser,
  LinearCheckStateWorkflowState,
} from "./checks.js";
export type {
  LinearStateSeed,
  LinearTwinDatabase,
  LinearIssue,
  LinearUser,
  LinearTeam,
  LinearComment,
} from "./types.js";
export {
  DEFAULT_LINEAR_CLOCK,
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_TOKEN,
  DEFAULT_LINEAR_SID,
  DEFAULT_LINEAR_PORT,
  LINEAR_PROVIDER_TOKEN_PREFIX,
  STATE_EXPORT_CAP,
} from "./types.js";
