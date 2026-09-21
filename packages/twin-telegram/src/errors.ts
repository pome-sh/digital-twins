// SPDX-License-Identifier: Apache-2.0

export class TwinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly description: string,
    readonly errorCode: number,
  ) {
    super(message);
  }
}

export function telegramFail(status: number, errorCode: number, description: string): never {
  throw new TwinError(description, status, description, errorCode);
}
