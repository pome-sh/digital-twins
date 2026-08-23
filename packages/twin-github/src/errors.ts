// SPDX-License-Identifier: Apache-2.0
export class TwinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: unknown[],
    /**
     * Overrides the generic `https://docs.github.com/rest` below. Real GitHub
     * points at the SPECIFIC operation on some errors, and where this twin
     * reproduces such an error verbatim it has to reproduce that too — the
     * envelope is compared leaf by leaf, so a generic url is a diff.
     */
    readonly documentationUrl?: string
  ) {
    super(message);
  }
}

/**
 * What GitHub sends when it is not naming an operation, and what this twin
 * sends when it does not know one.
 *
 * Not a fallback nobody meant: GitHub itself answers exactly this on 14 of 59
 * measured errors — every 401, every unrouted path, and `GET /users/:username`
 * (the transcript). `withOperationDocs` below only overwrites THIS value,
 * so a url a throw site already knew survives.
 */
export const GENERIC_DOCUMENTATION_URL = "https://docs.github.com/rest";

/**
 * Build GitHub's error body: `{message, documentation_url, status, errors?}`.
 *
 * `status` is rendered as a **STRING**, which looks like a bug and is not.
 * Measured live against `api.github.com` on 2026-08-12: **59 of 59**
 * error responses across 400 / 401 / 403 / 404 / 409 / 422 sent it quoted, with
 * no exceptions and no absences, and GitHub's own published OpenAPI description
 * declares it that way too — `basic-error` has `status: {type: string}`. Two
 * independent sources, so the twin quotes it as well.
 *
 * ⚠️ The `status` here is the BODY LEAF, not the HTTP status. `twin.ts`'s
 * `githubErrorEnvelope` returns `{status, body}` and the outer one stays a
 * number, because that is what the engine writes to the status line.
 */
export function githubError(message: string, status: number, errors?: unknown[], documentationUrl?: string) {
  return {
    message,
    documentation_url: documentationUrl ?? GENERIC_DOCUMENTATION_URL,
    status: String(status),
    ...(errors ? { errors } : {})
  };
}

/**
 * Attach the operation's `documentation_url` to an already-projected envelope. The DOOR knows the operation; the error does not.
 *
 * Deliberately envelope-side rather than error-side on the REST leg: it has to
 * reach the zod branch and the JSON-parse branch too, which raise no
 * `TwinError` and have no field to carry a url in — and GitHub's 14 measured
 * 422s were operation-specific like its 404s.
 *
 * Two things it will not do:
 * - **overwrite a url the throw site already knew.** `domain/git.ts` stamps the
 *   contents-door `sha` and base64 errors; those are the same
 *   operation this would stamp, and re-stamping them would make the throw-site
 *   constants dead code that looks live.
 * - **name an operation on a 501.** The twin's own refusals — an unrouted path,
 *   an MCP `method` it does not model — are not GitHub errors being proxied,
 *   and the unrouted class is one of the three measured GENERIC ones.
 */
export function withOperationDocs(
  envelope: { status: number; body: unknown },
  documentationUrl: string
): { status: number; body: unknown } {
  if (envelope.status === 501) return envelope;
  const body = envelope.body;
  if (!body || typeof body !== "object") return envelope;
  const current = (body as { documentation_url?: unknown }).documentation_url;
  if (current !== GENERIC_DOCUMENTATION_URL) return envelope;
  return { status: envelope.status, body: { ...body, documentation_url: documentationUrl } };
}

/**
 * The same attachment, error-side, for the MCP door.
 *
 * The MCP leg cannot use the envelope form: the SDK projects a tool error
 * through the twin-wide `errorEnvelope` with no per-tool hook, and the operation
 * is not even KNOWN until the arguments parse — `issue_read` stands for three
 * different operations depending on `method`. So `executeTool` stamps the error
 * it is about to rethrow, after the parse and around the dispatch.
 *
 * Same two refusals as above, for the same reasons.
 */
export function withDocumentationUrl(error: unknown, documentationUrl: string): unknown {
  if (!(error instanceof TwinError)) return error;
  if (error.documentationUrl !== undefined || error.status === 501) return error;
  return new TwinError(error.message, error.status, error.errors, documentationUrl);
}

export function notFound(message = "Not Found"): never {
  throw new TwinError(message, 404);
}

export function conflict(message: string, documentationUrl?: string): never {
  throw new TwinError(message, 409, undefined, documentationUrl);
}

/**
 * GitHub's answer to a required body field the caller did not send: 422, this
 * message, and NO `errors` array.
 *
 * Measured live 2026-08-12 on four unrelated surfaces, which is what
 * makes this a general rule rather than one route's quirk — `PUT /contents/*`
 * and `DELETE /contents/*` (`sha`), `POST /issues` (`title`), `POST /pulls`
 * (`head`) all answered `Invalid request.\n\n"<field>" wasn't supplied.`
 *
 * ⚠️ Only the two `sha` call sites in `domain/git.ts` use this today. The rest
 * of the family still renders `validationFailed`'s generic `Validation Failed`
 * plus an `errors` array, because those errors are raised by the zod branch in
 * `twin.ts`'s `githubErrorEnvelope` and migrating it moves every required field
 * on every route at once. That is a global change with its own decision, not
 * something to widen into from here.
 */
export function missingRequestField(field: string, documentationUrl?: string): never {
  throw new TwinError(`Invalid request.\n\n"${field}" wasn't supplied.`, 422, undefined, documentationUrl);
}

export function validationFailed(field: string, code: string, value?: unknown): never {
  throw new TwinError("Validation Failed", 422, [
    {
      resource: "Request",
      field,
      code,
      ...(value === undefined ? {} : { value })
    }
  ]);
}
