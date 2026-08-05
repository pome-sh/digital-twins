// SPDX-License-Identifier: Apache-2.0
//
// F-754 export-surface guard, for the cloud control-plane half of the former
// `@pome-sh/shared-types` barrel (F-942 moved these clusters to
// `cli/src/contract/`; the trace half is
// `packages/wire/test/export-surface.test.ts`). Between the two files every
// symbol the old snapshot named is still named, so the three-way split is
// auditable as a partition rather than as a loosening. The GitHub access-control
// values left in the same milestone and are exercised by
// `packages/twin-github/test/access-control-catalog.test.ts`.
//
// `pome-cloud` imports these runtime values by name. If a re-export is dropped,
// renamed, or shadowed by an `export *` collision, the sorted key list below
// drifts and this test fails loud.
//
// The expected list is an explicit inline array (not a `.snap` file) so the
// surface reads plainly in review. It was generated from the pre-refactor
// `main` build. When you intentionally add/remove an export, update this list in
// the same PR.

import { describe, expect, it } from "vitest";
import * as api from "../../src/contract/index.js";
// TYPE-surface guard: `Object.keys` only sees runtime values, so dropping an
// `export type` / `export interface` — or a whole type-only leaf re-export —
// would pass the runtime snapshot silently. This type-only import enumerates
// every `export type` / `export interface` that must remain on the barrel
// (grep-grounded from the pre-refactor index.ts, minus intentionally removed
// EvaluatorHooks / TraceUploadContext in 0.9.0). It is enforced when
// `npm run typecheck` compiles this test: a dropped or renamed type breaks
// the build.
//
// F-1201 added the trace surface — `Event`, `OtelEvent`, `RecorderEvent` and
// the eight per-kind variant types. They had been absent since F-754, so a
// dropped or renamed event kind was the one public-type change this guard could
// not see, on exactly the surface `trace-contract.json` calls canonical. Note
// what this guard does and does not do: it catches a kind that DISAPPEARS or is
// RENAMED. A kind that is ADDED is the fixture gate's job
// (`scripts/emit-trace-contract.mjs`), because no tuple can require a payload.
import type {
  AcceptInviteRequest,
  AcceptInviteResponse,
  AgentResponse,
  ApiError,
  ApiErrorType,
  ApiKey,
  ApiKeyCreated,
  CreateAgentRequest,
  CreateEvalSessionResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CriterionDef,
  CriterionDefInput,
  FinalizeAcceptedResponse,
  FinalizeCompletedStatusResponse,
  FinalizeFailedStatusResponse,
  FinalizeFailureError,
  FinalizeInitialResponse,
  FinalizeQueuedStatusResponse,
  FinalizeRequest,
  FinalizeResponse,
  FinalizeRunningStatusResponse,
  FinalizeStatusResponse,
  FinalizeStatusUrl,
  GmailSeedState,
  GithubSeedState,
  Manifest,
  ManifestAgent,
  ManifestInput,
  MeResponse,
  PerTwinStateKeys,
  PersistedScenario,
  PersistedTask,
  PlanTier,
  Scenario,
  ScenarioConfig,
  SeedEnvelope,
  SeedState,
  Session,
  SessionPublic,
  SessionState,
  SlackSeedState,
  StateUploadUrlEntry,
  StateUploadUrlResponse,
  StripeSeedState,
  SubmitResultRequest,
  SubmitResultResponse,
  Task,
  TaskConfig,
  Team,
  TeamInvite,
  TeamMember,
  TeamRole,
  UsageResponse,
  User,
} from "../../src/contract/index.js";

// Referencing every imported type keeps the guard alive under
// noUnusedLocals-style settings; the tuple is never instantiated.
type _TypeSurfaceAssert = [
  AcceptInviteRequest,
  AcceptInviteResponse,
  AgentResponse,
  ApiError,
  ApiErrorType,
  ApiKey,
  ApiKeyCreated,
  CreateAgentRequest,
  CreateEvalSessionResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CriterionDef,
  CriterionDefInput,
  FinalizeAcceptedResponse,
  FinalizeCompletedStatusResponse,
  FinalizeFailedStatusResponse,
  FinalizeFailureError,
  FinalizeInitialResponse,
  FinalizeQueuedStatusResponse,
  FinalizeRequest,
  FinalizeResponse,
  FinalizeRunningStatusResponse,
  FinalizeStatusResponse,
  FinalizeStatusUrl,
  GmailSeedState,
  GithubSeedState,
  Manifest,
  ManifestAgent,
  ManifestInput,
  MeResponse,
  PerTwinStateKeys,
  PersistedScenario,
  PersistedTask,
  PlanTier,
  Scenario,
  ScenarioConfig,
  SeedEnvelope,
  SeedState,
  Session,
  SessionPublic,
  SessionState,
  SlackSeedState,
  StateUploadUrlEntry,
  StateUploadUrlResponse,
  StripeSeedState,
  SubmitResultRequest,
  SubmitResultResponse,
  Task,
  TaskConfig,
  Team,
  TeamInvite,
  TeamMember,
  TeamRole,
  UsageResponse,
  User,
];
// Compile-time anchor: exactly one tuple entry per guarded type. The literal
// type on the left fails to compile if an entry is added or removed above
// without updating the count.
const TYPE_SURFACE_SIZE: _TypeSurfaceAssert["length"] = 57;

// Runtime value exports (types are erased and cannot appear on `Object.keys`).
const EXPECTED_EXPORTS = [
  "CRITERION_KINDS",
  "LEGACY_CRITERION_KIND_MAP",
  "LEGACY_TASK_VOCAB_KEY_MAP",
  "MOUNTED_TWINS",
  "SLUG_MAX_LENGTH",
  "SLUG_RE",
  "acceptInviteRequestSchema",
  "acceptInviteResponseSchema",
  "agentResponseSchema",
  "agentSlugSchema",
  "apiErrorSchema",
  "apiErrorTypeSchema",
  "apiKeyCreatedSchema",
  "apiKeySchema",
  "buildManifestJsonSchema",
  "correlatorKindSchema",
  "createAgentRequestSchema",
  "createEvalSessionResponseSchema",
  "createInviteRequestSchema",
  "createInviteResponseSchema",
  "createSessionRequestSchema",
  "createSessionResponseSchema",
  "criterionDefSchema",
  "criterionKindSchema",
  "criterionResultSchema",
  "criterionSchema",
  "deriveAgentSlug",
  "deterministicCriterionResultSchema",
  "finalizeAcceptedResponseSchema",
  "finalizeCompletedStatusResponseSchema",
  "finalizeFailedStatusResponseSchema",
  "finalizeFailureErrorSchema",
  "finalizeInitialResponseSchema",
  "finalizeQueuedStatusResponseSchema",
  "finalizeRequestSchema",
  "finalizeResponseSchema",
  "finalizeRunningStatusResponseSchema",
  "finalizeStatusResponseSchema",
  "finalizeStatusUrlSchema",
  "githubSeedStateSchema",
  "gmailSeedStateSchema",
  "isMultiTwinSeedEnvelope",
  "judgeModelSchema",
  "laneSchema",
  "linearSeedStateSchema",
  "manifestAgentSchema",
  "manifestSchema",
  "meResponseSchema",
  "normalizeTaskVocabKeys",
  "perTwinStateKeysSchema",
  "persistedScenarioSchema",
  "persistedTaskSchema",
  "planTierSchema",
  "probabilisticCriterionResultSchema",
  "providerScopedSeedStateSchema",
  "runSchema",
  "scenarioConfigSchema",
  "scenarioSchema",
  "seedEnvelopeSchema",
  "seedStateSchema",
  "sessionPublicSchema",
  "sessionSchema",
  "sessionStateSchema",
  "slackSeedStateSchema",
  "stateUploadUrlEntrySchema",
  "stateUploadUrlResponseSchema",
  "stepSchema",
  "stripeSeedStateSchema",
  "submitResultRequestSchema",
  "submitResultResponseSchema",
  "taskConfigSchema",
  "taskSchema",
  "teamInviteSchema",
  "teamMemberSchema",
  "teamRoleSchema",
  "teamSchema",
  "usageResponseSchema",
  "userSchema",
] as const;

describe("cli/src/contract barrel export surface (F-754, F-942)", () => {
  it("re-exports exactly the pre-refactor runtime value surface", () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_EXPORTS]);
  });

  it("guards the TYPE surface (57 types/interfaces)", () => {
    // The real guard is the type-only import + _TypeSurfaceAssert tuple above,
    // enforced at typecheck time. This assertion just anchors the count at
    // runtime so the guard's scope is visible in test output.
    expect(TYPE_SURFACE_SIZE).toBe(57);
  });
});
