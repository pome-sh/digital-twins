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
     * envelope is compared leaf by leaf, so a generic url is a diff (F-1460).
     */
    readonly documentationUrl?: string
  ) {
    super(message);
  }
}

export function githubError(message: string, status: number, errors?: unknown[], documentationUrl?: string) {
  return {
    message,
    documentation_url: documentationUrl ?? "https://docs.github.com/rest",
    status,
    ...(errors ? { errors } : {})
  };
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
 * Measured live 2026-08-12 (F-1491) on four unrelated surfaces, which is what
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
