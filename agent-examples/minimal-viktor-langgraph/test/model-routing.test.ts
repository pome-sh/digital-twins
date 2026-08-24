// The credential model, pinned as a property (F-1216).
//
// This example and `agent-examples/minimal-viktor` are sold as a matched pair —
// this README's own opening line is "the same viktor.com-style AI employee …
// but built on LangGraph instead of the Vercel AI SDK". They are the pair that
// carries the framework-agnosticism claim, so a reader holding ONE model key
// must be able to run BOTH. Before this suite they defaulted to opposite
// credential models and neither said so: `minimal-viktor` short-circuits on
// `AI_GATEWAY_API_KEY`, and this example went straight to `ANTHROPIC_API_KEY`,
// so a single Vercel AI Gateway key ran one example and could not run the other.
//
// WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT: which model slug ships as the
// default. The two examples default to different models on purpose (this one to
// `claude-sonnet-5`, the sibling to `alibaba/qwen-3-32b`, which only the gateway
// can route) and that difference is not the defect. The defect was that the
// *credential* rule differed. So the property here is the resolution ORDER, not
// the destination.

import { describe, expect, it } from "vitest";

import { GATEWAY_ORIGIN, redactCredentials, routeModel } from "../src/model-routing.js";

const GATEWAY = { AI_GATEWAY_API_KEY: "gw-key" };
const DIRECT_ANTHROPIC = { ANTHROPIC_API_KEY: "sk-ant" };
const DIRECT_OPENAI = { OPENAI_API_KEY: "sk-oai" };

describe("routeModel — gateway first, then the per-provider key", () => {
  // The pair invariant. `minimal-viktor` answers this the same way, and its own
  // suite pins it there; the two together are what stop the pair drifting apart.
  it("accepts AI_GATEWAY_API_KEY alone — the sibling example's entry condition", () => {
    expect(() => routeModel("claude-sonnet-5", GATEWAY)).not.toThrow();
    const route = routeModel("claude-sonnet-5", GATEWAY);
    expect(route.apiKeyEnv).toBe("AI_GATEWAY_API_KEY");
  });

  it("prefers the gateway when both it and a provider key are present", () => {
    const route = routeModel("claude-sonnet-5", { ...GATEWAY, ...DIRECT_ANTHROPIC });
    expect(route.apiKeyEnv).toBe("AI_GATEWAY_API_KEY");
  });

  // Measured in F-1216: LangChain appends `/v1/messages` itself, so a base URL
  // of `…/v1` produces `/v1/v1/messages` and a 404 whose body names the doubled
  // path. The bare origin is not a style choice; it is the working value.
  it("points ChatAnthropic at the BARE gateway origin, never at /v1", () => {
    const route = routeModel("claude-sonnet-5", GATEWAY);
    expect(route.baseUrl).toBe(GATEWAY_ORIGIN);
    expect(route.baseUrl).not.toMatch(/\/v1\/?$/);
  });

  // Also measured in F-1216: the gateway routes on a provider-qualified slug, so
  // the qualifier must survive. The pre-fix code split on the first "/" and threw
  // the prefix away, which is why the working invocation had to double it up
  // (`anthropic/anthropic/claude-sonnet-5`). A reader should not have to know that.
  it("keeps the model id provider-qualified under the gateway", () => {
    expect(routeModel("claude-sonnet-5", GATEWAY).modelId).toBe("anthropic/claude-sonnet-5");
    expect(routeModel("anthropic/claude-sonnet-5", GATEWAY).modelId).toBe(
      "anthropic/claude-sonnet-5",
    );
    expect(routeModel("gpt-5", GATEWAY).modelId).toBe("openai/gpt-5");
    expect(routeModel("openai/gpt-5", GATEWAY).modelId).toBe("openai/gpt-5");
  });

  it("routes an openai slug through the gateway's OpenAI-compatible /v1 endpoint", () => {
    const route = routeModel("gpt-5", GATEWAY);
    expect(route.client).toBe("openai");
    expect(route.baseUrl).toBe(`${GATEWAY_ORIGIN}/v1`);
  });

  // The README's documented path. The fix adds a branch ABOVE this one, so the
  // risk it carries is breaking the path every existing reader follows.
  it("leaves the direct-key path untouched — bare id, no base URL override", () => {
    const route = routeModel("claude-sonnet-5", DIRECT_ANTHROPIC);
    expect(route).toEqual({
      client: "anthropic",
      modelId: "claude-sonnet-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: undefined,
    });
    expect(routeModel("anthropic/claude-sonnet-5", DIRECT_ANTHROPIC).modelId).toBe(
      "claude-sonnet-5",
    );
    expect(routeModel("openai/gpt-5", DIRECT_OPENAI)).toEqual({
      client: "openai",
      modelId: "gpt-5",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: undefined,
    });
  });

  it("still recognises the same slug shapes it always did", () => {
    for (const slug of ["claude-sonnet-5", "anthropic/claude-opus-4-8"]) {
      expect(routeModel(slug, DIRECT_ANTHROPIC).client).toBe("anthropic");
    }
    // `/^o\d/` rather than `/^o/`, so an `ollama/…` slug is not swept in.
    for (const slug of ["gpt-5", "openai/gpt-4o", "o3"]) {
      expect(routeModel(slug, DIRECT_OPENAI).client).toBe("openai");
    }
  });

  it("fails loudly on a slug no client claims, gateway or not", () => {
    expect(() => routeModel("ollama/llama-3", GATEWAY)).toThrow(/not recognized/);
    expect(() => routeModel("ollama/llama-3", DIRECT_ANTHROPIC)).toThrow(/not recognized/);
  });

  // A missing key is a named error rather than an undefined handed to the client,
  // which is what `requiredEnv` bought before the routing moved out here.
  it("names the env var it wanted when no credential is present", () => {
    expect(() => routeModel("claude-sonnet-5", {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => routeModel("gpt-5", {})).toThrow(/OPENAI_API_KEY/);
  });
});

describe("redactCredentials — a provider SDK's error text never carries a key", () => {
  const KEY = "sk-ant-0123456789abcdef";

  it("replaces the credential value with a named placeholder", () => {
    const out = redactCredentials(`401 from provider: Bearer ${KEY} rejected`, {
      ANTHROPIC_API_KEY: KEY,
    });
    expect(out).not.toContain(KEY);
    expect(out).toContain("[ANTHROPIC_API_KEY redacted]");
  });

  it("replaces EVERY occurrence, not just the first", () => {
    const out = redactCredentials(`${KEY} … ${KEY}`, { ANTHROPIC_API_KEY: KEY });
    expect(out).not.toContain(KEY);
  });

  // A short or empty value would otherwise match everywhere and turn the whole
  // message into placeholders — losing the diagnostic to protect a non-secret.
  it("ignores a value too short to be a credential", () => {
    expect(redactCredentials("a totally normal message", { ANTHROPIC_API_KEY: "x" })).toBe(
      "a totally normal message",
    );
    expect(redactCredentials("unchanged", { ANTHROPIC_API_KEY: "" })).toBe("unchanged");
  });

  it("leaves a message that carries no credential alone", () => {
    expect(redactCredentials("model not found", { ANTHROPIC_API_KEY: KEY })).toBe(
      "model not found",
    );
  });
});
