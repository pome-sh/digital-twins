import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

/** Frozen Linear MCP launch tool SET (Gate-1 Wave 4 — Gate 0 + delete_comment /
 *  documents). */
const LINEAR_LAUNCH_TOOLS = [
  "create_issue_label",
  "delete_comment",
  "get_document",
  "get_issue",
  "get_issue_status",
  "get_project",
  "get_team",
  "get_user",
  "list_comments",
  "list_cycles",
  "list_documents",
  "list_issue_labels",
  "list_issue_statuses",
  "list_issues",
  "list_projects",
  "list_teams",
  "list_users",
  "save_comment",
  "save_document",
  "save_issue",
  "save_project",
  "search_documentation",
];

test("MCP canonical launch tool set matches Gate-1 freeze", () => {
  const canonical = readJson("fixtures/mcp-tools-list.canonical.json");
  expect(canonical.meta.liveToolCount).toBe(LINEAR_LAUNCH_TOOLS.length);
  expect(LINEAR_LAUNCH_TOOLS.length).toBe(22);
  const names = canonical.result.tools.map((t: any) => t.name);
  expect([...canonical.meta.liveToolOrder].sort()).toEqual(LINEAR_LAUNCH_TOOLS);
  expect([...names].sort()).toEqual(LINEAR_LAUNCH_TOOLS);
  for (const tool of canonical.result.tools) {
    expect(tool.inputSchema, tool.name).toBeTruthy();
    expect(tool.description, tool.name).toBeTruthy();
  }
});

test("MCP canonical tool ORDER is the upstream capture's, not re-sorted", () => {
  // The half the set assertion above deliberately gives up, put back as a
  // property rather than a literal. Sorting the freeze without this would let a
  // producer that re-ordered — an edit, not a subtraction — pass unnoticed.
  const canonical = readJson("fixtures/mcp-tools-list.canonical.json");
  const upstream = readJson("../../fixtures/mcp-tools-list/linear.raw.json");
  const upstreamNames = upstream.result.tools.map((t: any) => t.name);
  const served = canonical.result.tools.map((t: any) => t.name);

  expect(upstreamNames.length).toBe(58);
  expect(served).toEqual(upstreamNames.filter((name: string) => served.includes(name)));
  expect(canonical.meta.liveToolOrder).toEqual(served);
});

test("graphql-surface freezes launch queries and mutations", () => {
  const surface = readJson("fixtures/graphql-surface.json");
  expect(surface.queries).toContain("viewer");
  expect(surface.queries).toContain("issues");
  expect(surface.mutations).toContain("issueCreate");
  expect(surface.mutations).toContain("issueAddLabel");
  expect(surface.mutations).toContain("webhookCreate");
  expect(surface.mutations).toContain("commentDelete");
});
