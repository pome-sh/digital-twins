// SPDX-License-Identifier: Apache-2.0
import type { DeclarableRouter } from "@pome-sh/sdk/route-inputs";
import {
  asInputError,
  emailFrom,
  normalizeListBinding,
  paginate,
  stringArray,
  stringField,
  type JsonObject,
} from "./rest-common.js";
import { invalidArgument } from "./errors.js";
import type { GmailRouteKit } from "./rest-routes-kit.js";
import { historyResource, labelDetail, labelSummary } from "./rest-serializers.js";
import { GMAIL_ROUTES } from "./route-inputs.js";
import type { SeedFilter } from "./types.js";

export function registerResourceRoutes(app: DeclarableRouter, kit: GmailRouteKit): void {
  const { serializers, domain } = kit;

  kit.read(app, GMAIL_ROUTES.getProfile, ({ path }, c) => ({
    body: domain.profile(emailFrom(path.userId, c)),
  }));

  kit.read(app, GMAIL_ROUTES.listThreads, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    const { q, includeSpamTrash, labelIds } = query;
    let threads = asInputError(() => domain.searchThreads(email, q, { includeTrash: includeSpamTrash }));
    if (labelIds.length) {
      threads = threads.filter((thread) => labelIds.every((label) => thread.labelIds.includes(label)));
    }
    const snapshot = domain.currentHistoryIdFor(email);
    const binding = normalizeListBinding("threads.list", email, { query: q, includeSpamTrash, labelIds });
    const { page, nextPageToken } = paginate(threads, {
      maxResults: query.maxResults,
      pageToken: query.pageToken,
      binding,
      snapshot,
    });
    return {
      body: {
        ...(page.length
          ? {
              threads: page.map((thread) => ({
                id: thread.id,
                historyId: domain.latestThreadHistory(email, thread.id),
                ...(thread.messages.at(-1)?.snippet ? { snippet: thread.messages.at(-1)!.snippet } : {}),
              })),
            }
          : {}),
        resultSizeEstimate: threads.length,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    };
  });

  kit.read(app, GMAIL_ROUTES.getThread, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    return {
      body: serializers.thread(
        email,
        domain.getThread(email, path.id),
        query.format,
        query.metadataHeaders
      ),
    };
  });

  kit.write(app, GMAIL_ROUTES.modifyThread, ({ path, body }, c) => {
    const email = emailFrom(path.userId, c);
    const thread = domain.modifyThreadLabels(email, path.id, body.addLabelIds, body.removeLabelIds);
    return { body: serializers.thread(email, thread, "minimal") };
  });

  kit.write(app, GMAIL_ROUTES.trashThread, ({ path }, c) => {
    const email = emailFrom(path.userId, c);
    return {
      body: serializers.thread(
        email,
        domain.modifyThreadLabels(email, path.id, ["TRASH"], ["INBOX"]),
        "minimal"
      ),
    };
  });

  kit.write(app, GMAIL_ROUTES.untrashThread, ({ path }, c) => {
    const email = emailFrom(path.userId, c);
    return {
      body: serializers.thread(email, domain.modifyThreadLabels(email, path.id, [], ["TRASH"]), "minimal"),
    };
  });

  kit.write(app, GMAIL_ROUTES.deleteThread, ({ path }, c) => {
    domain.deleteThread(emailFrom(path.userId, c), path.id);
    return { status: 204, body: null };
  });

  kit.read(app, GMAIL_ROUTES.listLabels, ({ path }, c) => ({
    body: { labels: domain.labels(emailFrom(path.userId, c)).map(labelSummary) },
  }));

  kit.read(app, GMAIL_ROUTES.getLabel, ({ path }, c) => ({
    body: labelDetail(domain.label(emailFrom(path.userId, c), path.id)),
  }));

  kit.write(app, GMAIL_ROUTES.createLabel, ({ path, body }, c) => {
    const email = emailFrom(path.userId, c);
    if (body.type !== undefined && body.type !== "user") invalidArgument("Only user labels can be created");
    const created = domain.createLabel(email, body.name, body.color);
    return { body: labelDetail(domain.label(email, created.id)) };
  });

  kit.write(app, GMAIL_ROUTES.updateLabel, ({ path, body }, c) => {
    const label = domain.updateLabel(
      emailFrom(path.userId, c),
      path.id,
      { name: body.name, color: body.color },
      true
    );
    return { body: labelDetail(label) };
  });

  kit.write(app, GMAIL_ROUTES.patchLabel, ({ path, body }, c) => {
    const label = domain.updateLabel(
      emailFrom(path.userId, c),
      path.id,
      { name: body.name, color: body.color },
      false
    );
    return { body: labelDetail(label) };
  });

  kit.write(app, GMAIL_ROUTES.deleteLabel, ({ path }, c) => {
    domain.deleteLabel(emailFrom(path.userId, c), path.id);
    return { status: 204, body: null };
  });

  registerHistory(app, kit);
  registerSettings(app, kit);

  kit.unsupported(app, GMAIL_ROUTES.watch, "users.watch requires Pub/Sub and is not supported");
  kit.unsupported(app, GMAIL_ROUTES.stop, "users.stop requires Pub/Sub and is not supported");
}

function registerHistory(app: DeclarableRouter, kit: GmailRouteKit): void {
  kit.read(app, GMAIL_ROUTES.listHistory, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    const { startHistoryId, historyTypes, labelId } = query;
    const allowed = new Set(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
    if (historyTypes.some((type) => !allowed.has(type))) invalidArgument("Invalid historyTypes");
    const result = kit.context.domain.listHistory(email, startHistoryId, {
      types: historyTypes.length ? historyTypes : undefined,
    });
    const resources = result.history
      .filter((event) => !labelId || event.labelIds.includes(labelId))
      .map(historyResource)
      .filter((item): item is Record<string, unknown> => item !== null);
    const binding = normalizeListBinding("history.list", email, { startHistoryId, historyTypes, labelId });
    const { page, nextPageToken } = paginate(resources, {
      maxResults: query.maxResults,
      pageToken: query.pageToken,
      binding,
      snapshot: result.historyId,
    });
    return {
      body: {
        ...(page.length ? { history: page } : {}),
        historyId: result.historyId,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    };
  });
}

function registerSettings(app: DeclarableRouter, kit: GmailRouteKit): void {
  const { domain } = kit;

  kit.read(app, GMAIL_ROUTES.listFilters, ({ path }, c) => ({
    body: { filter: domain.filters(emailFrom(path.userId, c)) },
  }));

  kit.read(app, GMAIL_ROUTES.getFilter, ({ path }, c) => ({
    body: domain.filter(emailFrom(path.userId, c), path.id),
  }));

  kit.write(app, GMAIL_ROUTES.createFilter, ({ path, body }, c) => ({
    body: asInputError(() =>
      domain.createFilter(
        emailFrom(path.userId, c),
        filterCriteria(body.criteria ?? {}),
        filterAction(body.action ?? {})
      )
    ),
  }));

  kit.write(app, GMAIL_ROUTES.deleteFilter, ({ path }, c) => {
    domain.deleteFilter(emailFrom(path.userId, c), path.id);
    return { status: 204, body: null };
  });

  kit.read(app, GMAIL_ROUTES.listForwardingAddresses, ({ path }, c) => ({
    body: { forwardingAddresses: domain.forwardingAddresses(emailFrom(path.userId, c)) },
  }));

  kit.read(app, GMAIL_ROUTES.getForwardingAddress, ({ path }, c) => ({
    body: domain.forwardingAddress(
      emailFrom(path.userId, c),
      decodeURIComponent(path.forwardingEmail)
    ),
  }));

  kit.read(app, GMAIL_ROUTES.listSendAs, ({ path }, c) => ({
    body: { sendAs: domain.sendAs(emailFrom(path.userId, c)) },
  }));

  kit.read(app, GMAIL_ROUTES.getSendAs, ({ path }, c) => ({
    body: domain.sendAsAddress(emailFrom(path.userId, c), decodeURIComponent(path.sendAsEmail)),
  }));
}

/**
 * A filter's criteria, field by field.
 *
 * Deliberately still imperative: the declaration names `criteria`, which is the
 * top-level input pome-cloud compares, and this walk is what produces
 * `Invalid sizeComparison` rather than a generic schema failure.
 */
function filterCriteria(body: JsonObject): SeedFilter["criteria"] {
  const criteria: NonNullable<SeedFilter["criteria"]> = {};
  for (const key of ["from", "to", "subject", "query", "negatedQuery"] as const) {
    const value = stringField(body, key);
    if (value !== undefined) criteria[key] = value;
  }
  for (const key of ["hasAttachment", "excludeChats"] as const) {
    const value = body[key];
    if (value !== undefined && typeof value !== "boolean") invalidArgument(`Invalid ${key}`);
    if (typeof value === "boolean") criteria[key] = value;
  }
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || (body.size as number) < 0) invalidArgument("Invalid size");
    criteria.size = body.size as number;
  }
  if (body.sizeComparison !== undefined) {
    if (body.sizeComparison !== "larger" && body.sizeComparison !== "smaller") invalidArgument("Invalid sizeComparison");
    criteria.sizeComparison = body.sizeComparison;
  }
  return criteria;
}

function filterAction(body: JsonObject): SeedFilter["action"] {
  const addLabelIds = body.addLabelIds === undefined ? undefined : stringArray(body, "addLabelIds");
  const removeLabelIds = body.removeLabelIds === undefined ? undefined : stringArray(body, "removeLabelIds");
  const forward = stringField(body, "forward");
  return {
    ...(addLabelIds ? { addLabelIds } : {}),
    ...(removeLabelIds ? { removeLabelIds } : {}),
    ...(forward ? { forward } : {}),
  };
}
