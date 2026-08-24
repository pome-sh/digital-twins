// SPDX-License-Identifier: Apache-2.0
import { defineTwin, type TwinDefinition } from "@pome-sh/sdk";
import type { UnauthorizedKind } from "@pome-sh/sdk/server";
import { createApp, type RecorderStore } from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { openGmailTwinDatabase } from "./db.js";
import { GmailDomain } from "./domain/index.js";
import { gmailErrorEnvelope } from "./errors.js";
import { DEFAULT_GMAIL_EMAIL } from "./identity.js";
import { gmailTools } from "./mcp.js";
import { projectGmailRecording } from "./recording.js";
import { registerGmailRoutes } from "./rest-routes.js";
import { gmailSeedSchema, type ParsedGmailStateSeed } from "./seed.js";
import { gmailStateDelta } from "./state.js";
import type { GmailStateSeed, GmailTwinDatabase } from "./types.js";

export { registerGmailRoutes };

/**
 * Gmail's 401, measured live against `gmail.googleapis.com` on 2026-08-13
 * with `GET /gmail/v1/users/me/profile`, both ways.
 *
 * Google DISTINGUISHES a bad credential from a missing one, on three leaves at
 * once — `message`, `errors[0].message` and `errors[0].reason` — and this twin
 * used to send the bad-credential body for both:
 *
 *   bad `Authorization: Bearer <garbage>` → 401
 *     message  "Request had invalid authentication credentials. Expected OAuth 2 …"
 *     errors[0] {message:"Invalid Credentials", reason:"authError"}
 *
 *   no `Authorization` header at all → 401
 *     message  "Request is missing required authentication credential. Expected OAuth 2 …"
 *     errors[0] {message:"Login Required.", reason:"required"}
 *
 * ⚠️ NO `documentation_url` AND NO TOP-LEVEL `status` — Google sends neither,
 * on either body. The only `status` is the nested gRPC one this twin already
 * sends (`UNAUTHENTICATED`), and that is measured. So the GitHub-shaped leaves
 * twin-github carries must not appear here; what was removed from
 * this twin is the `documentation_url: ""` it was inheriting from the SDK's
 * admin gate on its 403 (see `admin.forbidden` below).
 *
 * ⚠️ ONE MEASURED LEAF DELIBERATELY NOT REPRODUCED: the missing-credential body
 * also carries a `details[]` block whose `metadata.method` names the backend
 * method the request was routed to (`caribou.api.proto.MailboxService.GetProfile`).
 * Authentication fails before dispatch here exactly as it does on GitHub, so
 * this layer does not know the operation, and inventing one would be the
 * divergence pointing the other way. Registered as a divergence instead.
 */
const OAUTH_TAIL =
  "Expected OAuth 2 access token, login cookie or other valid authentication credential. " +
  "See https://developers.google.com/identity/sign-in/web/devconsole-project.";

function unauthorized(kind: UnauthorizedKind = "invalid"): { status: number; body: unknown } {
  const missing = kind === "no_token";
  return {
    status: 401,
    body: {
      error: {
        code: 401,
        message: missing
          ? `Request is missing required authentication credential. ${OAUTH_TAIL}`
          : `Request had invalid authentication credentials. ${OAUTH_TAIL}`,
        errors: [
          {
            message: missing ? "Login Required." : "Invalid Credentials",
            domain: "global",
            reason: missing ? "required" : "authError",
            location: "Authorization",
            locationType: "header",
          },
        ],
        status: "UNAUTHENTICATED",
      },
    },
  };
}

/**
 * Gmail's 403, in the shape this twin already renders every other Google error
 * in (`gmailErrorEnvelope` + `googleStatus`, which maps 403 → PERMISSION_DENIED).
 *
 * Declared rather than defaulted. `/admin/*` is a twin-only route, so
 * the gate in `@pome-sh/sdk` used to answer it — and that default was GitHub's
 * envelope, `{message:"Forbidden", documentation_url:""}`, on a Google twin.
 * Google sends neither a bare `message` at the top level nor a
 * `documentation_url` at all, so the leak was wrong on both leaves.
 */
function adminForbidden(): { status: number; body: unknown } {
  return {
    status: 403,
    body: {
      error: {
        code: 403,
        message: "Forbidden",
        errors: [{ message: "Forbidden", domain: "global", reason: "forbidden" }],
        status: "PERMISSION_DENIED",
      },
    },
  };
}

export const gmailTwinDefinition: TwinDefinition<
  GmailTwinDatabase,
  ParsedGmailStateSeed,
  GmailDomain
> = defineTwin({
  id: "gmail",
  version: process.env.POME_TWIN_VERSION ?? "0.1.0",
  implementation: "gmail_twin",
  packageName: "@pome-sh/twin-gmail",
  fidelity: { default: "semantic" },
  seed: gmailSeedSchema,
  domain: ({ db, seed }) => {
    const domain = new GmailDomain(db ?? openGmailTwinDatabase(":memory:"));
    if (seed) domain.seed(seed);
    return domain;
  },
  routes: registerGmailRoutes,
  tools: gmailTools,
  state: ({ domain }) => domain.exportState(),
  admin: {
    reset: ({ domain, reportDelta }) => {
      const before = domain.exportState();
      domain.resetToDefault();
      reportDelta(gmailStateDelta(before, domain.exportState()));
      return { ok: true };
    },
    seed: ({ domain, seed, reportDelta }) => {
      const before = domain.exportState();
      domain.seed(seed);
      reportDelta(gmailStateDelta(before, domain.exportState()));
      return { ok: true };
    },
    forbidden: adminForbidden,
  },
  recordingProjection: projectGmailRecording,
  errorEnvelope: gmailErrorEnvelope,
  unsupported: ({ method, path }) => ({
    status: 501,
    body: {
      error: {
        code: 501,
        message: `Unsupported Gmail twin route: ${method} ${path}`,
        errors: [{ domain: "global", reason: "notImplemented", message: "Not implemented" }],
        status: "UNIMPLEMENTED",
      },
    },
  }),
  auth: {
    unauthorized,
    // A credential that belongs to another session is a credential this one
    // cannot use — the INVALID body, not the missing one.
    sidMismatch: () => unauthorized("invalid"),
    sessionExtras: (claims) => ({
      gmail_email:
        typeof claims.gmail_email === "string" && claims.gmail_email.length > 0
          ? claims.gmail_email.toLowerCase()
          : DEFAULT_GMAIL_EMAIL,
    }),
  },
});

export type CreateGmailTwinAppOptions = {
  db?: GmailTwinDatabase;
  recorder?: RecorderStore;
  runId?: string;
  seed?: GmailStateSeed;
};

export function createGmailTwinApp(options: CreateGmailTwinAppOptions = {}): Hono {
  return createApp(gmailTwinDefinition, {
    db: options.db ?? openGmailTwinDatabase(":memory:"),
    recorder: options.recorder,
    runId: options.runId ?? "spawn",
    seed: options.seed as ParsedGmailStateSeed | undefined,
  });
}
