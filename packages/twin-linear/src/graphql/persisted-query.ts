// SPDX-License-Identifier: Apache-2.0
//
// `extensions`, the fourth member of the GraphQL-over-HTTP request
// envelope, and the only one Linear answers on its own.
//
// # What was measured, and what it falsified
//
// Linear's 400 was first read as "automatic persisted queries are
// switched off" — an unhandled path rather than a contract. A re-measurement
// of `https://api.linear.app/graphql` on **2026-08-11** falsifies that. Linear
// runs APQ, in VERIFY-ONLY mode: it checks that `sha256Hash` is the SHA-256 of
// the `query` it was sent with, and the 400 is that check failing. Send the
// correct hash and the request is served like any other.
//
//   query + sha256Hash("{__typename}")         -> 401, i.e. on to the auth check
//   query + sha256Hash "abc"                   -> 400 INTERNAL_SERVER_ERROR
//   sha256Hash alone, no query                 -> 200 PersistedQueryNotFound
//
// That third line is why modelling this needs no persisted-query store. Linear
// never REGISTERS the pair: a hash-only request answers `PersistedQueryNotFound`
// even straight after the same hash arrived with its query. So "implement
// persisted queries", the option the `[DECISION]` rejected as an order of
// magnitude more work, is not what upstream has either — there is nothing to
// store, only a hash to verify.
//
// The full transcript, every case below with its response, is in
// `docs/undeclared-route-inputs.md`.
//
// # Why this is a module and not four `if`s in the route
//
// Two surfaces answer it (`GET` and `POST /graphql`) and they disagree in ways
// no shared helper would guess — `extensions: null` is IGNORED in a POST body
// and REJECTED in a query string, and each surface words its own 400s. Keeping
// the whole table in one pure function is what lets the suite drive it as one
// table, and what stops the two surfaces drifting apart the next time one of
// them is touched.
//
// It is a pure function of the parsed envelope on purpose: no hono, no request
// object, nothing to read around the declaration with. Where it runs — ahead of
// `bearerAuth`, mounted in `../twin.ts` — is that file's business.

import { createHash } from "node:crypto";

/**
 * The answer Linear gives instead of serving the request, or `null` to serve
 * it. `null` is the ordinary outcome: an envelope with no `extensions`, or one
 * whose persisted-query descriptor Linear accepts.
 */
export type PersistedQueryAnswer = { readonly status: number; readonly body: unknown } | null;

/** Where the value came from, which decides how it decodes and how a refusal reads. */
export type ExtensionsLocation = "body" | "query";

/**
 * Linear's answer to a persisted-query descriptor it cannot satisfy.
 *
 * `INTERNAL_SERVER_ERROR` with `userError: false`, on what is plainly a client
 * mistake, still reads like an unhandled path rather than a designed contract —
 * this twin MIRRORS an observed behaviour here and does not endorse it. A
 * future re-measure that answers something else is a signal to re-decide, not
 * drift to suppress.
 */
const UNSATISFIABLE: PersistedQueryAnswer = {
  status: 400,
  body: {
    errors: [
      {
        message: "Internal server error",
        extensions: {
          http: { status: 400, headers: {} },
          code: "INTERNAL_SERVER_ERROR",
          type: "internal error",
          userError: false,
        },
      },
    ],
  },
};

/**
 * APQ's lookup miss: the hash arrived with no query to verify it against.
 *
 * HTTP **200** with the error inside the envelope, which is the protocol
 * working — an Apollo client reads this and retries with the query attached.
 */
const NOT_FOUND: PersistedQueryAnswer = {
  status: 200,
  body: {
    errors: [
      {
        message: "PersistedQueryNotFound",
        extensions: {
          http: { status: 200, headers: {} },
          code: "PERSISTED_QUERY_NOT_FOUND",
          type: "graphql error",
          userError: true,
        },
      },
    ],
  },
};

/** Linear's wording for an `extensions` value it could not even look inside. */
function badRequest(message: string): PersistedQueryAnswer {
  return {
    status: 400,
    body: {
      errors: [
        {
          message,
          extensions: {
            http: { status: 400, headers: {} },
            code: "BAD_REQUEST",
            type: "internal error",
            userError: false,
          },
        },
      ],
    },
  };
}

/**
 * Decide what a `/graphql` request's `extensions` earns, before authentication.
 *
 * @param query the envelope's `query`, absent for a hash-only APQ request.
 * @param extensions the declared `extensions` input — a JSON string on the GET
 *   surface (a query string carries nothing else), any JSON value in a body.
 */
export function checkPersistedQuery(envelope: {
  readonly query: string | undefined;
  readonly extensions: unknown;
  readonly location: ExtensionsLocation;
}): PersistedQueryAnswer {
  const decoded = decodeExtensions(envelope.extensions, envelope.location);
  if (decoded.kind === "answer") return decoded.answer;
  if (decoded.value === null) return null;

  // Measured: an `extensions` object carrying no `persistedQuery` — `{}`,
  // `{foo:1}`, `persistedQuery: null` — leaves Linear's answer exactly where
  // the bare request's was. The key that is acted on is `persistedQuery`, not
  // `extensions`.
  const descriptor = decoded.value.persistedQuery;
  if (descriptor === undefined || descriptor === null) return null;
  if (!isRecord(descriptor)) return UNSATISFIABLE;

  // Version and hash are validated before the query is looked at, so a
  // descriptor Linear cannot read answers the same whether or not a query came
  // with it. Only version 1 of the protocol exists; a 2 answers the same 400 as
  // a missing one, even alongside a correct hash.
  const { version, sha256Hash } = descriptor;
  if (version !== 1 || typeof sha256Hash !== "string") return UNSATISFIABLE;

  if (!envelope.query) return NOT_FOUND;
  // Lowercase hex, compared literally: a correct hash in the wrong case earns
  // the same 400 as a wrong one, which is what was measured.
  return sha256Hash === sha256Hex(envelope.query) ? null : UNSATISFIABLE;
}

type Decoded =
  | { readonly kind: "value"; readonly value: Record<string, unknown> | null }
  | { readonly kind: "answer"; readonly answer: PersistedQueryAnswer };

/**
 * Get to the `extensions` object, or to the answer Linear gives for not being
 * able to.
 *
 * The two surfaces genuinely differ, and the difference is measured rather than
 * reasoned: a POST body's `extensions: null` is IGNORED, while `extensions=null`
 * in a query string is refused for not being a JSON-encoded object.
 */
function decodeExtensions(raw: unknown, location: ExtensionsLocation): Decoded {
  if (raw === undefined) return { kind: "value", value: null };

  if (location === "query") {
    if (typeof raw !== "string") return { kind: "value", value: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        kind: "answer",
        answer: badRequest("The extensions search parameter contains invalid JSON."),
      };
    }
    if (!isRecord(parsed)) {
      return {
        kind: "answer",
        answer: badRequest("The extensions search parameter should contain a JSON-encoded object."),
      };
    }
    return { kind: "value", value: parsed };
  }

  if (raw === null) return { kind: "value", value: null };
  if (typeof raw === "string") {
    return {
      kind: "answer",
      answer: badRequest(
        "`extensions` in a POST body should be provided as an object, not a recursively JSON-encoded string."
      ),
    };
  }
  if (!isRecord(raw)) {
    return {
      kind: "answer",
      answer: badRequest("`extensions` in a POST body must be an object if provided."),
    };
  }
  return { kind: "value", value: raw };
}

function sha256Hex(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
