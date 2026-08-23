// SPDX-License-Identifier: Apache-2.0
// Additive agent-identity fields on the /v1 wire.

import { describe, expect, it } from "vitest";
import {
  agentResponseSchema,
  createAgentRequestSchema,
  createSessionRequestSchema,
} from "../../../src/contract/index.js";

describe("createAgentRequestSchema — manifest identity fields", () => {
 it("still accepts the legacy minimal payload", () => {
    expect(createAgentRequestSchema.safeParse({ name: "PR Review Agent" }).success).toBe(true);
  });

  it("accepts the full manifest-shaped registration payload", () => {
    const parsed = createAgentRequestSchema.parse({
      name: "PR Review Agent",
      slug: "pr-review-agent",
      description: "Reviews PRs against team conventions",
      version: "0.2.0",
      framework: "langgraph",
      twins: ["github"],
    });
    expect(parsed.slug).toBe("pr-review-agent");
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.framework).toBe("langgraph");
  });

  it("caps the human-ish slug input at 64 chars (server derives the canonical slug)", () => {
    expect(
      createAgentRequestSchema.safeParse({ name: "A", slug: "a".repeat(65) }).success,
    ).toBe(false);
    // Human-ish input is allowed — derivation to SLUG_RE happens server-side.
    expect(
      createAgentRequestSchema.safeParse({ name: "A", slug: "My Agent" }).success,
    ).toBe(true);
  });
});

describe("createSessionRequestSchema.agent_version", () => {
  it("accepts an agent_version per-run override", () => {
    const parsed = createSessionRequestSchema.parse({
      twins: ["github"],
      task_id: "task-1",
      agent_version: "0.2.0",
    }) as { agent_version?: string };
    expect(parsed.agent_version).toBe("0.2.0");
  });

  it("stays optional — legacy session mints are unchanged", () => {
    const parsed = createSessionRequestSchema.parse({
      task_id: "task-1",
    }) as { agent_version?: string };
    expect(parsed.agent_version).toBeUndefined();
  });
});

describe("agentResponseSchema — resolver fields", () => {
  const base = {
    id: "agt_YRZsOPRGSaxiSKCNcXfaB",
    slug: "pr-review-agent",
    display_name: "PR Review Agent",
    judge_model: "google/gemini-2.5-flash",
  };

 it("still accepts the legacy response (old cloud)", () => {
    const parsed = agentResponseSchema.parse(base);
    expect(parsed.created).toBeUndefined();
  });

  it("accepts the resolver response with created + identity fields", () => {
    const parsed = agentResponseSchema.parse({
      ...base,
      framework: "langgraph",
      description: "Reviews PRs against team conventions",
      version: "0.2.0",
      created: true,
      enabled_services: ["github"],
    });
    expect(parsed.created).toBe(true);
    expect(parsed.framework).toBe("langgraph");
  });

  it("accepts null description/version (unset on the server)", () => {
    const parsed = agentResponseSchema.parse({
      ...base,
      description: null,
      version: null,
      created: false,
    });
    expect(parsed.description).toBeNull();
    expect(parsed.created).toBe(false);
  });

  // The control plane's `agents.framework` column lost its NOT NULL DEFAULT
  // 'claude-agent-sdk', and `toResponse` now emits `framework: row.framework ?? null`.
 it("accepts framework: null — the shape for 'never declared'", () => {
    const parsed = agentResponseSchema.parse({
      ...base,
      framework: null,
      description: null,
      transport: null,
      clone_scope: null,
      created: false,
      resolved_via: "slug",
    });
    expect(parsed.framework).toBeNull();
  });

  // The three cloud answers stay three (D3): a declared value, `null` = the cloud says
  // nothing was ever declared, and absent = the cloud did not answer at.
  it("keeps null (never declared) distinct from absent (cloud did not answer)", () => {
    expect(agentResponseSchema.parse({ ...base, framework: null }).framework).toBeNull();
    expect(agentResponseSchema.parse(base).framework).toBeUndefined();
  });

  // pome-cloud 422s a non-string framework on the REQUEST side rather than
  // normalizing it to unset ("could not read it" is not "nothing declared").
  // The response side is the mirror of that: a non-string never parses as
  // absent here either.
  it("rejects a non-string framework rather than reading it as absent", () => {
    expect(agentResponseSchema.safeParse({ ...base, framework: 42 }).success).toBe(false);
    expect(createAgentRequestSchema.safeParse({ name: "A", framework: 42 }).success).toBe(false);
  });
});

describe("agentResponseSchema — slug-rename hint fields", () => {
  const base = {
    id: "agt_YRZsOPRGSaxiSKCNcXfaB",
    slug: "pr-review-agent",
    display_name: "PR Review Agent",
    judge_model: "google/gemini-2.5-flash",
  };

  it("surfaces resolved_via + hint when the alias resolver returns them", () => {
    const parsed = agentResponseSchema.parse({
      ...base,
      resolved_via: "alias",
      hint: 'Resolved "pr-reviewer" via a slug alias; the canonical slug is now "pr-review-agent".',
    });
    expect(parsed.resolved_via).toBe("alias");
    expect(parsed.hint).toContain("pr-review-agent");
  });

  it("accepts the slug / created resolver kinds too", () => {
    expect(agentResponseSchema.parse({ ...base, resolved_via: "slug" }).resolved_via).toBe("slug");
    expect(agentResponseSchema.parse({ ...base, resolved_via: "created" }).resolved_via).toBe(
      "created",
    );
  });

  it("tolerates their absence (older cloud) — both read undefined", () => {
    const parsed = agentResponseSchema.parse(base);
    expect(parsed.resolved_via).toBeUndefined();
    expect(parsed.hint).toBeUndefined();
  });

  it("tolerates an unknown resolver mode (open enum) instead of rejecting the response", () => {
    // A future control plane may add a resolver mode. Since resolved_via only
    // drives an informational CLI notice, an unknown value must not fail the
    // whole parse (which would break register/install).
    const parsed = agentResponseSchema.parse({ ...base, resolved_via: "merged" });
    expect(parsed.resolved_via).toBe("merged");
  });
});
