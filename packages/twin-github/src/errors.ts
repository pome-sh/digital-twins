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

export function conflict(message: string): never {
  throw new TwinError(message, 409);
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
