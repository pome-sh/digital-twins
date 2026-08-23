// SPDX-License-Identifier: Apache-2.0
import { ZodError } from "zod";

export class LinearTwinError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "LinearTwinError";
  }

  toGraphQLError(): { message: string; extensions: Record<string, unknown> } {
    return {
      message: this.message,
      extensions: {
        code: this.code,
        http: { status: this.status },
        ...this.extensions,
      },
    };
  }
}

/**
 * Linear's 401, measured live against `api.linear.app/graphql` on 2026-08-13
 * — `POST` with `{ viewer { id } }`, once with a garbage bearer and
 * once with no `Authorization` header at all. **Both answered byte-identically:**
 *
 * ```json
 * {"errors":[{"message":"Authentication required, not authenticated",
 *   "extensions":{"type":"authentication error","code":"AUTHENTICATION_ERROR",
 *   "statusCode":401,"userError":true,
 *   "userPresentableMessage":"You need to authenticate to access this operation.",
 *   "meta":{},"http":{"status":401}}}]}
 * ```
 *
 * Three things that fixes, all measured:
 *
 * - the message was `Bad credentials` — GitHub's string, on a Linear twin,
 * which is the leak this envelope exists to stop. It was also `Session id mismatch`
 *   on the sid-mismatch leg; Linear has no session-id concept and sends ONE
 *   body for every authentication failure, so the twin sends one too. (The
 *   `message` parameter stays for callers who need a different one; both auth
 *   hooks take the default.)
 * - `extensions.statusCode` was absent. This is Linear's answer to the
 *   "does the vendor send a status leaf" question, and it does — twice, as
 *   `statusCode` and as `http.status`, both NUMBERS. The twin sent only the
 *   second.
 * - `type`, `userError`, `userPresentableMessage` and `meta` were absent.
 *
 * ⚠️ NO `documentation_url`. Linear does not send that key, so the leaves
 * twin-github carries must not appear here.
 */
export function unauthorizedEnvelope(
  message = "Authentication required, not authenticated"
): {
  status: number;
  body: unknown;
} {
  return {
    status: 401,
    body: {
      errors: [
        {
          message,
          extensions: {
            type: "authentication error",
            code: "AUTHENTICATION_ERROR",
            statusCode: 401,
            userError: true,
            userPresentableMessage: "You need to authenticate to access this operation.",
            meta: {},
            http: { status: 401 },
          },
        },
      ],
    },
  };
}

/**
 * The admin gate's 403, in this twin's own GraphQL error family.
 *
 * Declared rather than defaulted: `/admin/*` is a twin-only route, so the gate
 * in `@pome-sh/sdk` used to answer it, and that default was GitHub's envelope —
 * `{message:"Forbidden", documentation_url:""}` — on a GraphQL twin that sends
 * neither a top-level `message` nor a `documentation_url` anywhere.
 *
 * ⚠️ The BODY SHAPE here is this twin's own (`LinearTwinError` → `errors[]` with
 * an `extensions.code`, the same projection every other Linear error takes); the
 * 403 was NOT measured against upstream, because reaching a Linear permission
 * refusal needs a real authenticated principal that lacks the permission, and
 * the probes were unauthenticated by design. What is measured is that this
 * twin's neighbours in the same family are right, and that GitHub's envelope is
 * wrong here.
 */
export function forbiddenEnvelope(message = "Forbidden"): {
  status: number;
  body: unknown;
} {
  return linearErrorEnvelope(new LinearTwinError(403, "FORBIDDEN", message));
}

export function unsupportedEnvelope(method: string, path: string): {
  status: number;
  body: unknown;
} {
  return {
    status: 501,
    body: {
      message: `Unsupported Linear twin route: ${method} ${path}`,
      errors: [
        {
          message: "Not implemented",
          extensions: { code: "UNIMPLEMENTED", http: { status: 501 } },
        },
      ],
      fidelity: "unsupported",
      method,
      path,
    },
  };
}

export function linearErrorEnvelope(error: unknown): { status: number; body: unknown } {
  if (error instanceof LinearTwinError) {
    return {
      status: error.status,
      body: { errors: [error.toGraphQLError()] },
    };
  }
  if (error instanceof ZodError || (error instanceof Error && error.name === "ZodError")) {
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? "Invalid request")
        : "Invalid request";
    return {
      status: 400,
      body: {
        errors: [
          {
            message,
            extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
          },
        ],
      },
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        errors: [
          {
            message: "Invalid JSON",
            extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
          },
        ],
      },
    };
  }
  if (error instanceof Error && error.name === "UnknownToolError") {
    return {
      status: 404,
      body: {
        errors: [
          {
            message: error.message,
            extensions: { code: "NOT_FOUND", http: { status: 404 } },
          },
        ],
      },
    };
  }
  return {
    status: 500,
    body: {
      errors: [
        {
          message: error instanceof Error ? error.message : "Internal Server Error",
          extensions: { code: "INTERNAL_SERVER_ERROR", http: { status: 500 } },
        },
      ],
    },
  };
}

export function badUserInput(message: string, extensions: Record<string, unknown> = {}): never {
  throw new LinearTwinError(400, "BAD_USER_INPUT", message, extensions);
}

export function notFound(message: string): never {
  throw new LinearTwinError(404, "NOT_FOUND", message);
}

export function authenticationError(message = "Authentication required"): never {
  throw new LinearTwinError(401, "AUTHENTICATION_ERROR", message);
}

export function forbidden(message = "Forbidden"): never {
  throw new LinearTwinError(403, "FORBIDDEN", message);
}
