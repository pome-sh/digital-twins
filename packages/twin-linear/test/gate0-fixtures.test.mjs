import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

/**
 * Frozen Linear MCP launch tool SET (Gate-1 Wave 4 — Gate 0 + delete_comment /
 * documents). Sorted, because since F-1480 the freeze is a set and not a
 * sequence: the fixture is a projection of Linear's own captured tools/list, so
 * the ORDER belongs to the capture and re-typing it here would pin this twin to
 * a sequence it does not choose. Which 22 tools ship is still ours, so that half
 * stays hand-written where a reviewer can see it move.
 */
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
  assert.equal(canonical.meta.liveToolCount, LINEAR_LAUNCH_TOOLS.length);
  assert.equal(LINEAR_LAUNCH_TOOLS.length, 22);
  const names = canonical.result.tools.map((t) => t.name);
  assert.deepEqual([...canonical.meta.liveToolOrder].sort(), LINEAR_LAUNCH_TOOLS);
  assert.deepEqual([...names].sort(), LINEAR_LAUNCH_TOOLS);
  for (const tool of canonical.result.tools) {
    assert.ok(tool.inputSchema, tool.name);
    assert.ok(tool.description, tool.name);
  }
});

test("MCP canonical tool ORDER is the upstream capture's, not re-sorted", () => {
  // The half the set assertion above deliberately gives up, put back as a
  // property rather than a literal. Sorting the freeze without this would let a
  // producer that re-ordered — an edit, not a subtraction — pass unnoticed.
  const canonical = readJson("fixtures/mcp-tools-list.canonical.json");
  const upstream = readJson("../../fixtures/mcp-tools-list/linear.raw.json");
  const upstreamNames = upstream.result.tools.map((t) => t.name);
  const served = canonical.result.tools.map((t) => t.name);

  assert.equal(upstreamNames.length, 58);
  assert.deepEqual(
    served,
    upstreamNames.filter((name) => served.includes(name)),
  );
  assert.deepEqual(canonical.meta.liveToolOrder, served);
});

test("graphql-surface freezes launch queries and mutations", () => {
  const surface = readJson("fixtures/graphql-surface.json");
  assert.ok(surface.queries.includes("viewer"));
  assert.ok(surface.queries.includes("issues"));
  assert.ok(surface.mutations.includes("issueCreate"));
  assert.ok(surface.mutations.includes("issueAddLabel"));
  assert.ok(surface.mutations.includes("webhookCreate"));
  assert.ok(surface.mutations.includes("commentDelete"));
});
