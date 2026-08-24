/**
 * Which credential routes this run — decided before any provider SDK is imported
 * (F-1216).
 *
 * The behaviour is unchanged from the version that lived inline in `index.ts`.
 * It moved here so it can be asserted without booting the agent: `index.ts` reads
 * `POME_TASK` at module scope and then runs, so importing it to ask a routing
 * question starts a run.
 *
 * THE RULE: **the AI Gateway comes first.** One `AI_GATEWAY_API_KEY` routes every
 * provider, and this example's default (`alibaba/qwen-3-32b`) has no other route
 * at all. `agent-examples/minimal-viktor-langgraph` — the same agent on LangGraph,
 * and the other half of the pair that carries the framework-agnosticism claim —
 * now applies the same order, and pins it in its own `test/model-routing.test.ts`.
 * Two examples presented as one pair must not disagree about how a reader supplies
 * a key.
 */

type Env = Record<string, string | undefined>;

/** Every env var this example reads a credential from. ONE source of truth: the
 *  same list routes a model and scrubs those values out of anything logged. */
export const CREDENTIAL_ENV_VARS = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENAI_API_KEY",
] as const;

/**
 * Replace any credential VALUE with a named placeholder.
 *
 * The run's catch logs whatever a provider SDK put in `err.message`, and this
 * example is meant to be run with a real key — so a client that echoes its
 * Authorization header into an error would print that key to stdout, and from
 * there into the recorded trace. We do not control the SDK's error text, so the
 * sink is sanitised instead. Guarded on length so a short or empty value cannot
 * turn every string into placeholders. The LangGraph sibling carries the
 * identical helper; the pair agrees on credentials, including how it fails.
 */
export function redactCredentials(text: string, env: Env): string {
  let out = text;
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join(`[${name} redacted]`);
  }
  return out;
}

export type ModelRoute =
  | { via: "gateway"; modelId: string }
  | {
      via: "direct";
      provider: "anthropic" | "google" | "openai";
      modelId: string;
      apiKeyEnv: "ANTHROPIC_API_KEY" | "GOOGLE_GENERATIVE_AI_API_KEY" | "OPENAI_API_KEY";
    };


export function routeModel(slug: string, env: Env): ModelRoute {
  // Gateway first. The slug goes through WHOLE: the AI SDK routes on the provider
  // prefix, so stripping it here would break the thing that makes one key enough.
  if (env.AI_GATEWAY_API_KEY) return { via: "gateway", modelId: slug };

  const slash = slug.indexOf("/");
  const prefix = slash >= 0 ? slug.slice(0, slash) : "";
  const id = slash >= 0 ? slug.slice(slash + 1) : slug;

  const direct = (
    provider: "anthropic" | "google" | "openai",
    apiKeyEnv: "ANTHROPIC_API_KEY" | "GOOGLE_GENERATIVE_AI_API_KEY" | "OPENAI_API_KEY",
  ): ModelRoute => {
    if (!env[apiKeyEnv]?.trim()) {
      throw new Error(
        `${apiKeyEnv} is required for ${slug}. Set it, or set AI_GATEWAY_API_KEY to route ` +
          `through the Vercel AI Gateway instead (one key, every provider).`,
      );
    }
    return { via: "direct", provider, modelId: id, apiKeyEnv };
  };

  if (prefix === "anthropic" || slug.startsWith("claude")) {
    return direct("anthropic", "ANTHROPIC_API_KEY");
  }
  if (prefix === "google" || slug.startsWith("gemini")) {
    return direct("google", "GOOGLE_GENERATIVE_AI_API_KEY");
  }
  if (prefix === "openai" || slug.startsWith("gpt") || slug.startsWith("o")) {
    return direct("openai", "OPENAI_API_KEY");
  }
  throw new Error(
    `VIKTOR_MODEL=${slug} needs AI_GATEWAY_API_KEY (the Vercel AI Gateway routes alibaba/* and every other provider with one key).`,
  );
}
