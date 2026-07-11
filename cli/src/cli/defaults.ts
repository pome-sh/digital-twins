// SPDX-License-Identifier: Apache-2.0
/** Production defaults (override with env / CLI flags at call sites). */
// Public hosted control-plane endpoint (override via --api-url / POME_API_URL).
// Intentional: a default service URL is not "embedded cloud config" — that
// criterion prohibits credentials and non-overridable environment wiring, not
// an overrideable public API base.
export const DEFAULT_CONTROL_PLANE_URL = "https://api.pome.sh";
export const DEFAULT_DASHBOARD_URL = "https://app.pome.sh";
export const DEFAULT_DOCS_SITE_ORIGIN = "https://docs.pome.sh";
