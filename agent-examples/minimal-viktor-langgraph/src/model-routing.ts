/**
 * Which client, which model id, which key — decided before any provider SDK is
 * imported (F-1216).
 *
 * This lives apart from `index.ts` because `index.ts` reads `POME_TASK` at module
 * scope and then runs the graph, so importing it to ask a routing question boots
 * the agent. Pure in, pure out: the decision is testable, and `test/model-routing.test.ts`
 * pins it.
 *
 * THE RULE, and it is the sibling example's rule: **the AI Gateway comes first.**
 * `agent-examples/minimal-viktor` short-circuits on `AI_GATEWAY_API_KEY` before it
 * looks at any per-provider key, because one gateway key routes every provider.
 * This example did not, so one holder of a single Vercel AI Gateway key could run
 * that example and not this one — with nothing in either README saying why. The
 * pair carries the framework-agnosticism claim, so the credential rule has to be
 * the same on both sides of it.
 */

/** The gateway's own origin. BARE — see `baseUrlFor` for why that matters. */
export const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";

/** Every env var this example reads a credential from. ONE source of truth: the
 *  same list routes a model and scrubs those values out of anything logged. */
export const CREDENTIAL_ENV_VARS = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

/**
 * Replace any credential VALUE with a named placeholder.
 *
 * The graph's catch logs whatever a provider SDK put in `err.message`, and this
 * example is meant to be run with a real key — so a client that echoes its
 * Authorization header into an error would print that key to stdout, and from
 * there into the recorded trace. We do not control the SDK's error text, so the
 * sink is sanitised instead. Guarded on length so a short or empty value cannot
 * turn every string into placeholders.
 */
export function redactCredentials(text: string, env: Env): string {
  let out = text;
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join(`[${name} redacted]`);
  }
  return out;
}

type Env = Record<string, string | undefined>;

export type ChatClient = "anthropic" | "openai";

export interface ModelRoute {
  /** Which LangChain chat class `index.ts` should construct. */
  client: ChatClient;
  /** The `model` handed to that class — provider-qualified only for the gateway. */
  modelId: string;
  /** The env var whose value is the API key. Named, not read, so this stays pure. */
  apiKeyEnv: "AI_GATEWAY_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  /** Base URL override. `undefined` on the direct path — the SDK default is right. */
  baseUrl: string | undefined;
}

/**
 * The gateway speaks both protocols, at different paths, and the difference is
 * measured rather than assumed:
 *
 * - **Anthropic: the BARE origin.** `@langchain/anthropic` appends `/v1/messages`
 *   itself. Passing `https://ai-gateway.vercel.sh/v1` produces `/v1/v1/messages`
 *   and a 404 whose body names the doubled path.
 * - **OpenAI: `/v1`.** `@langchain/openai` treats its base URL as the API root and
 *   appends `/chat/completions`, so the version segment belongs in the base.
 */
function baseUrlFor(client: ChatClient): string {
  return client === "anthropic" ? GATEWAY_ORIGIN : `${GATEWAY_ORIGIN}/v1`;
}

/** The provider a slug names, by prefix or by the shape of a bare id. */
function clientFor(slug: string): ChatClient | null {
  const slash = slug.indexOf("/");
  const prefix = slash >= 0 ? slug.slice(0, slash) : "";
  if (prefix === "anthropic" || slug.startsWith("claude")) return "anthropic";
  // `/^o\d/` rather than `/^o/`, so an `ollama/…` slug is not swept in.
  if (prefix === "openai" || /^gpt/.test(slug) || /^o\d/.test(slug)) return "openai";
  return null;
}

/** The id with its provider prefix removed, which is what a direct client wants. */
function bareId(slug: string): string {
  const slash = slug.indexOf("/");
  return slash >= 0 ? slug.slice(slash + 1) : slug;
}

export function routeModel(slug: string, env: Env): ModelRoute {
  const client = clientFor(slug);
  if (client === null) {
    throw new Error(
      `LANGGRAPH_MODEL=${slug} is not recognized. Use an anthropic/* (default) or openai/* slug.`,
    );
  }

  // Gateway first — the sibling example's order, and the reason this file exists.
  if (env.AI_GATEWAY_API_KEY) {
    return {
      client,
      // The gateway routes on a PROVIDER-QUALIFIED slug, so the qualifier has to
      // survive. The pre-F-1216 code split on the first "/" and dropped the
      // prefix, which is why the one invocation known to work had to double it
      // (`anthropic/anthropic/claude-sonnet-5`). Qualify it here instead, so a
      // reader can write the slug the obvious way.
      modelId: `${client}/${bareId(slug)}`,
      apiKeyEnv: "AI_GATEWAY_API_KEY",
      baseUrl: baseUrlFor(client),
    };
  }

  const apiKeyEnv = client === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (!env[apiKeyEnv]?.trim()) {
    throw new Error(
      `${apiKeyEnv} is required for ${slug}. Set it, or set AI_GATEWAY_API_KEY to route ` +
        `through the Vercel AI Gateway instead (one key, every provider — the same ` +
        `credential agent-examples/minimal-viktor takes).`,
    );
  }
  // The direct path is unchanged: the bare id, and the SDK's own base URL.
  return { client, modelId: bareId(slug), apiKeyEnv, baseUrl: undefined };
}
