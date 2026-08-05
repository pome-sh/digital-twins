// SPDX-License-Identifier: Apache-2.0
//
// The CLI's contract hub. `../contract/` owns the /v1 cloud control-plane
// surface; `@pome-sh/wire` owns the trace surface (recorder events, the OTel
// extension, redaction) that the twins also depend on. Re-exported together so a
// CLI module names one import site, not two.
export * from "../contract/index.js";
export * from "@pome-sh/wire";
