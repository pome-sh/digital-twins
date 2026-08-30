// SPDX-License-Identifier: Apache-2.0
/**
 * `compileSeed` must not register the seed schema as a structured-output
 * grammar.
 *
 * The GitHub seed schema has outgrown the Anthropic API's grammar-size limit:
 * sent via `output_config.format`, every request fails with a 400 "The
 * compiled grammar is too large" before any inference happens, which took
 * `pome compile-seeds` down for every file. The schema still has to reach the
 * model — as prose in the system prompt — and the reply is validated locally
 * against the same zod schema, which is the validation path this command has
 * always ended on anyway (`parseGitHubSeedState`, then the twin boot check).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicStandIn {
    messages = { create: createMock };
  },
}));

import { compileSeed, COMPILER_MODEL } from "../../src/task/seed-compiler.js";

const VALID_SEED_JSON = JSON.stringify({
  repositories: [{ owner: "acme", name: "api", issues: [{ number: 1, title: "tiny" }] }],
});

function textResponse(text: string, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 22 },
    ...overrides,
  };
}

describe("compileSeed request shape", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    createMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a plain message with no output_config grammar", async () => {
    createMock.mockResolvedValue(textResponse(VALID_SEED_JSON));

    const result = await compileSeed("One repo, acme/api, with a single open bug.");

    expect(createMock).toHaveBeenCalledTimes(1);
    const params = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.output_config).toBeUndefined();
    expect(params.model).toBe(COMPILER_MODEL);
    const seed = result.seed as { repositories: Array<{ owner: string }> };
    expect(seed.repositories[0]!.owner).toBe("acme");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(22);
  });

  it("carries the seed JSON schema in the system prompt instead", async () => {
    createMock.mockResolvedValue(textResponse(VALID_SEED_JSON));

    await compileSeed("One repo, acme/api.");

    const params = createMock.mock.calls[0]![0] as { system: string };
    // Two fields that only the schema, not the prose rules, would name.
    expect(params.system).toContain('"pull_requests"');
    expect(params.system).toContain('"renamed_from"');
  });
});

describe("compileSeed response handling", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    createMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unwraps a fenced JSON reply", async () => {
    createMock.mockResolvedValue(textResponse("```json\n" + VALID_SEED_JSON + "\n```"));

    const result = await compileSeed("One repo, acme/api.");

    const seed = result.seed as { repositories: Array<{ name: string }> };
    expect(seed.repositories[0]!.name).toBe("api");
  });

  it("rejects a schema-invalid reply with the offending field named", async () => {
    createMock.mockResolvedValue(textResponse(JSON.stringify({ repositories: [{ name: "api" }] })));

    await expect(compileSeed("One repo.")).rejects.toThrow(/owner/);
  });

  it("rejects a non-JSON reply as a compile error, not a stack trace", async () => {
    createMock.mockResolvedValue(textResponse("Sure! Here is the seed you asked for."));

    await expect(compileSeed("One repo.")).rejects.toThrow(/valid JSON/);
  });

  it("rejects a reply truncated at the token ceiling before trying to parse it", async () => {
    createMock.mockResolvedValue(textResponse('{"repositories": [', { stop_reason: "max_tokens" }));

    await expect(compileSeed("One repo.")).rejects.toThrow(/truncated/);
  });
});
