// The credential model, pinned as a property (F-1216).
//
// The other half of a pair. `agent-examples/minimal-viktor-langgraph` is sold as
// "the same viktor.com-style AI employee … but built on LangGraph instead of the
// Vercel AI SDK", and it carries the same assertion in its own
// `test/model-routing.test.ts`. Two examples presented as one pair must not
// disagree about how a reader supplies a model key — that disagreement is what
// F-1216 measured, and it was invisible until you tried the second example.
//
// This example was already the CORRECT half: it has short-circuited on
// `AI_GATEWAY_API_KEY` since it shipped. Nothing about its behaviour changes
// here. What changes is that the behaviour is now pinned, so the pair can only
// drift apart through a red test rather than silently.

import { describe, expect, it } from "vitest";

import { type ModelRoute, redactCredentials, routeModel } from "../src/model-routing.js";

/** Narrows the union so a test can read `apiKeyEnv` without a cast. A gateway
 *  route reaching here is itself the failure, so it is asserted rather than
 *  silently treated as "no key". */
function direct(route: ModelRoute): Extract<ModelRoute, { via: "direct" }> {
  if (route.via !== "direct") throw new Error(`expected a direct route, got ${route.via}`);
  return route;
}

const GATEWAY = { AI_GATEWAY_API_KEY: "gw-key" };
const DIRECT_ANTHROPIC = { ANTHROPIC_API_KEY: "sk-ant" };

describe("routeModel — gateway first, then the per-provider key", () => {
  // The pair invariant, asserted identically on both sides.
  it("accepts AI_GATEWAY_API_KEY alone — the sibling example's entry condition", () => {
    expect(() => routeModel("claude-sonnet-5", GATEWAY)).not.toThrow();
    expect(routeModel("claude-sonnet-5", GATEWAY).via).toBe("gateway");
  });

  it("prefers the gateway when both it and a provider key are present", () => {
    expect(routeModel("claude-sonnet-5", { ...GATEWAY, ...DIRECT_ANTHROPIC }).via).toBe("gateway");
  });

  // The default model is the reason the short-circuit has to come first: nothing
  // but the gateway can route an `alibaba/*` slug, so a per-provider branch would
  // reach the throw at the bottom for this example's own default.
  it("routes the default alibaba slug, which no per-provider branch can", () => {
    const route = routeModel("alibaba/qwen-3-32b", GATEWAY);
    expect(route).toEqual({ via: "gateway", modelId: "alibaba/qwen-3-32b" });
  });

  // The gateway takes the slug WHOLE — the AI SDK does the routing from the
  // provider prefix, so stripping it here would break it. The LangGraph half
  // reaches the same destination by re-qualifying a bare id; both end up
  // provider-qualified, which is what the gateway requires.
  it("hands the gateway the provider-qualified slug unchanged", () => {
    expect(routeModel("anthropic/claude-sonnet-5", GATEWAY).modelId).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("falls back to a per-provider key with the prefix stripped", () => {
    expect(routeModel("anthropic/claude-sonnet-5", DIRECT_ANTHROPIC)).toEqual({
      via: "direct",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(direct(routeModel("gemini-2.5-flash", { GOOGLE_GENERATIVE_AI_API_KEY: "k" })).apiKeyEnv).toBe(
      "GOOGLE_GENERATIVE_AI_API_KEY",
    );
    expect(direct(routeModel("gpt-5", { OPENAI_API_KEY: "k" })).apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  // The error a reader actually hits, and the one sentence that has to name the
  // gateway — this example's default cannot be run any other way.
  it("names AI_GATEWAY_API_KEY when a slug has no direct SDK here", () => {
    expect(() => routeModel("alibaba/qwen-3-32b", {})).toThrow(/AI_GATEWAY_API_KEY/);
  });

  it("names the provider env var when the slug has an SDK but no key", () => {
    expect(() => routeModel("claude-sonnet-5", {})).toThrow(/ANTHROPIC_API_KEY/);
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
