// SPDX-License-Identifier: Apache-2.0
import type { DeclarableRouter } from "@pome-sh/sdk/route-inputs";
import type { RouteContext } from "@pome-sh/sdk";
import type { GmailDomain } from "./domain/index.js";
import { registerDraftRoutes } from "./rest-routes-drafts.js";
import { GmailRouteKit } from "./rest-routes-kit.js";
import { registerMessageRoutes } from "./rest-routes-messages.js";
import { registerResourceRoutes } from "./rest-routes-resources.js";

/**
 * `DeclarableRouter` rather than `Hono`: every route is mounted by its own
 * declaration, so the registrar needs nothing hono-specific — and the 1:1 test
 * can hand it a router that only records what was registered.
 */
export function registerGmailRoutes(app: DeclarableRouter, context: RouteContext<GmailDomain>): void {
  const kit = new GmailRouteKit(context);
  registerMessageRoutes(app, kit);
  registerDraftRoutes(app, kit);
  registerResourceRoutes(app, kit);
}
