// SPDX-License-Identifier: Apache-2.0

export const SUPPORTED_SURFACES = [
  "getMe",
  "getChat",
  "sendMessage",
  "editMessageText",
  "deleteMessage",
  "deleteMessages",
  "forwardMessage",
  "copyMessage",
];

export const unsupportedEnvelope = {
  status: 501,
  body: {
    ok: false as const,
    error_code: 501,
    description: "Not Found",
    _twin: {
      fidelity: "unsupported" as const,
      supported_surfaces: SUPPORTED_SURFACES,
    },
  },
} as const;
