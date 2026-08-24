/**
 * Pome bundled example: minimal-viktor-langgraph.
 *
 * The same viktor.com-style "AI employee" merge bot as `agent-examples/minimal-viktor`
 * — review the open PRs in a repo, merge the safe ones, block the unsafe ones,
 * flag the malicious ones, and report every outcome to Slack — but built on
 * LangGraph instead of the Vercel AI SDK, and observed via OpenInference OTel
 * instrumentation instead of the AI SDK's `experimental_telemetry`.
 *
 * Two twins in one run (native multi-twin):
 *   GitHub twin  — provisioned by `pome run` (POME_GITHUB_REST_URL / POME_AUTH_TOKEN)
 *   Slack twin   — provisioned by `pome run` (POME_SLACK_REST_URL / POME_SLACK_TOKEN),
 *                  with VIKTOR_SLACK_* honored as a manual fallback
 *
 * Behavior contract (identical to minimal-viktor; the six scenarios assert it):
 *   merge     → Slack message starting "successfully merged" + repo/PR/title
 *   block     → REQUEST_CHANGES review + Slack "merge blocked: <reason>" + PR link
 *   malicious → never merge; REQUEST_CHANGES + Slack alert naming the author and
 *               asking the team to BLOCK them
 *
 * Default model claude-sonnet-5. Credentials resolve gateway-first, exactly as
 * `agent-examples/minimal-viktor` does: AI_GATEWAY_API_KEY routes every provider
 * through the Vercel AI Gateway, otherwise ANTHROPIC_API_KEY / OPENAI_API_KEY is
 * used directly. Set LANGGRAPH_MODEL to any anthropic/* or openai/* slug. POME_PREFLIGHT=1
 * prints "preflight ok" plus the POME_ / VIKTOR_ / OTEL_ env var NAMES received
 * (names only, never values) and exits 0.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { buildGraph } from "./graph.js";
import { redactCredentials, routeModel } from "./model-routing.js";
import { initTelemetry } from "./telemetry.js";

if (process.env.POME_PREFLIGHT === "1") {
  const names = Object.keys(process.env)
    .filter((k) => k.startsWith("POME_") || k.startsWith("VIKTOR_") || k.startsWith("OTEL_"))
    .sort();
  console.log("preflight ok");
  console.log(`preflight env: ${names.join(",")}`);
  process.exit(0);
}

const task = requiredEnv("POME_TASK");
const ghUrl = requiredEnv("POME_GITHUB_REST_URL").replace(/\/$/, "");
const ghToken = process.env.POME_AUTH_TOKEN;
const slackUrl = (process.env.POME_SLACK_REST_URL ?? process.env.VIKTOR_SLACK_REST_URL)?.replace(/\/$/, "");
const slackToken =
  process.env.POME_SLACK_TOKEN ?? process.env.VIKTOR_SLACK_TOKEN ?? process.env.POME_AUTH_TOKEN;
if (!slackUrl) {
  throw new Error(
    "Slack twin URL is required: set POME_SLACK_REST_URL (native multi-twin) or VIKTOR_SLACK_REST_URL (manual fallback).",
  );
}

const modelSlug = (process.env.LANGGRAPH_MODEL ?? process.env.VIKTOR_MODEL ?? "claude-sonnet-5").trim();
const slackChannel = (process.env.VIKTOR_SLACK_CHANNEL ?? "eng-alerts").trim();

await main();

async function main() {
  // Instrument LangChain BEFORE the graph runs so every node/LLM/tool call is
  // captured, then export to pome if a run endpoint was injected.
  const telemetry = initTelemetry();
  try {
    const model = await resolveModel(modelSlug);
    const graph = buildGraph(model, { ghUrl, ghToken, slackUrl: slackUrl!, slackToken }, slackChannel);
    // Positive-evidence marker `scripts/smoke-examples.mjs` classifies
    // REACHED-OUTBOUND on, printed immediately before this example's first
    // outbound call (the graph's `intake` node calls the GitHub twin before
    // the model is ever invoked). This example has no @pome-sh dependency to
    // emit it for free, so it is a literal print, gated so real users never
    // see it.
    if (process.env.POME_SMOKE_MARK_OUTBOUND === "1") console.error("POME_SMOKE_REACHED_OUTBOUND");
    const final = await graph.invoke({ task });
    console.log(
      JSON.stringify({
        task,
        model: modelSlug,
        repo: `${final.owner}/${final.repo}`,
        decisions: (final.decisions ?? []).map((d) => ({
          pr: d.number,
          outcome: d.outcome,
          reason: d.reason,
        })),
        reports: final.reports ?? [],
      }),
    );
  } catch (err) {
    // A model/graph failure is a failed trial, not a silent crash. Scrubbed:
    // the message is a provider SDK's, and this example runs with a real key.
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ error: redactCredentials(message, process.env) }));
    process.exitCode = 1;
  } finally {
    await telemetry.shutdown();
  }
}

// WHICH client, WHICH id and WHICH key is `model-routing.ts` — pure, and pinned
// by `test/model-routing.test.ts`. This function only builds the object, so the
// credential rule can be tested without booting the graph. Gateway first, then
// the per-provider key: the same order `agent-examples/minimal-viktor` uses, so
// one key runs both halves of the pair (F-1216).
async function resolveModel(slug: string): Promise<BaseChatModel> {
  const route = routeModel(slug, process.env);
  const apiKey = requiredEnv(route.apiKeyEnv);

  if (route.client === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    // No `temperature`: it is removed on claude-sonnet-5 (and every Opus 4.7+
    // model) and the API rejects it with a 400, which killed the one LLM call
    // this graph makes. Determinism comes from the structured-output schema and
    // the templated Slack messages, not from sampling params.
    return new ChatAnthropic({
      model: route.modelId,
      apiKey,
      // Omitted entirely on the direct path so the SDK default stands.
      ...(route.baseUrl === undefined ? {} : { anthropicApiUrl: route.baseUrl }),
    });
  }
  const { ChatOpenAI } = await import("@langchain/openai");
  return new ChatOpenAI({
    model: route.modelId,
    apiKey,
    temperature: 0,
    ...(route.baseUrl === undefined ? {} : { configuration: { baseURL: route.baseUrl } }),
  });
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}
