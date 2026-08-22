import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function sha256File(rel: string) {
  return createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
}

const LAUNCH_TOOLS = [
  "create_draft",
  "list_drafts",
  "get_thread",
  "get_message",
  "search_threads",
  "label_thread",
  "unlabel_thread",
  "apply_sensitive_thread_label",
  "list_labels",
  "label_message",
  "unlabel_message",
  "apply_sensitive_message_label",
  "create_label",
];

test("rest-surface freezes launch methods and names watch/stop as 501 gaps", () => {
  const surface = readJson("fixtures/rest-surface.json");
  expect(surface.meta.discoverySha256).toBe(sha256File("fixtures/gmail-discovery-v1.raw.json"));
  const byId = new Map<string, any>(surface.methods.map((m: any) => [m.id, m]));
  for (const id of ["users.watch", "users.stop"]) {
    const m = byId.get(id);
    expect(m, id).toBeTruthy();
    expect(m.launchStatus).toBe("named_gap_501");
  }
  expect(byId.has("users.getProfile")).toBe(true);
  expect(byId.has("users.messages.attachments.get")).toBe(true);
  expect(byId.has("users.history.list")).toBe(true);
  // Resumable protocols are marked unsupported_501
  const send = byId.get("users.messages.send");
  expect(send.mediaUpload.protocols.simple.launchStatus).toBe("supported");
  expect(send.mediaUpload.protocols.resumable.launchStatus).toBe("unsupported_501");
});

test("MCP canonical launch listing is exactly 13 tools in live relative order", () => {
  const canonical = readJson("fixtures/mcp-tools-list.canonical.json");
  const meta = readJson("fixtures/mcp-tools-list.meta.json");
  expect(canonical.meta.protocolVersion).toBe("2025-03-26");
  expect(meta.rawFileSha256).toBe(sha256File("fixtures/mcp-tools-list.raw.json"));
  expect(canonical.meta.liveToolCount).toBe(13);
  expect(meta.liveToolCount).toBe(13);
  const names = canonical.result.tools.map((t: any) => t.name);
  expect(names).toEqual(LAUNCH_TOOLS);
  expect(canonical.meta.liveToolOrder).toEqual(LAUNCH_TOOLS);
  for (const tool of canonical.result.tools) {
    expect(tool.inputSchema, tool.name).toBeTruthy();
    expect(tool.outputSchema, tool.name).toBeTruthy();
    expect(tool.annotations, tool.name).toBeTruthy();
  }
});

test("fidelity inventory covers launch MCP tools and watch/stop 501 gaps", () => {
  const inv = readJson("fidelity.inventory.json");
  const toolNames = new Set(inv.tools.map((t: any) => t.name));
  for (const name of LAUNCH_TOOLS) {
    expect(toolNames.has(name), name).toBe(true);
    const row = inv.tools.find((t: any) => t.name === name);
    expect(row.heat).toBe("hot");
    expect(row.fidelity).toBe("semantic");
  }
  const watch = inv.rest.find((r: any) => r.discoveryId === "users.watch");
  const stop = inv.rest.find((r: any) => r.discoveryId === "users.stop");
  expect(watch.heat).toBe("cold");
  expect(watch.fidelity).toBe("unsupported");
  expect(stop.heat).toBe("cold");
  expect(stop.fidelity).toBe("unsupported");
  expect(watch.justification).toMatch(/501/);
});
