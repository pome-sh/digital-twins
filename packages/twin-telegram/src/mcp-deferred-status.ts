// SPDX-License-Identifier: Apache-2.0
// Telegram has no compliant upstream tools/list capture. This status record is
// the permitted fixture in place of a raw/meta/canonical tool table.
import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";
import deferredStatus from "../fixtures/mcp-tools-list.status.json" with { type: "json" };

export const telegramMcpToolFixture = loadMcpToolFixture({ status: deferredStatus });
