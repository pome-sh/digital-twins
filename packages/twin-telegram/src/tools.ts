// SPDX-License-Identifier: Apache-2.0
// Source names, descriptions, JSON schemas, and annotations come only from the
// source-derived fixture. Implementations below provide the twin-local behavior.
import { deriveMcpToolTable, loadMcpToolFixture, type McpToolImplementation } from "@pome-sh/sdk/mcp-tool-fixture";
import { z } from "zod";
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import type { TelegramDomain } from "./domain.js";
import { accountFrom } from "./tool-adapters.js";

export const telegramMcpToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

type SourceResult = { result: string };

function sourceResult(value: unknown): SourceResult {
  // telegram-mcp's registered output schema is `{ result: string }`. Preserve
  // source text when the source operation returns text; structured twin values
  // are encoded in that string envelope.
  return { result: typeof value === "string" ? value : JSON.stringify(value) };
}

const implementations: Record<string, McpToolImplementation<TelegramDomain>> = {
  list_accounts: {
    schema: z.looseObject({}),
    mutation: false,
    handler: (domain) =>
      sourceResult(
        domain
          .listAccounts()
          .map(({ account, first_name }) => `${account}: ${first_name} (+N/A) — unknown`)
          .join("\n"),
      ),
    contentText: (output) => (output as SourceResult).result,
  },
  get_me: {
    schema: z.looseObject({ account: z.string().optional() }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const { account } = args as unknown as { account?: string };
      return sourceResult(domain.getMe({ kind: "user", account: accountFrom({ account }, ctx) }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
};

export const telegramTools = deriveMcpToolTable(telegramMcpToolFixture, implementations);
