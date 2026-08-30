// SPDX-License-Identifier: Apache-2.0
/**
 * Compile a prose seed description into a JSON seed object matching
 * `seedStateSchema`. Uses the Anthropic Messages API with the schema
 * carried in the system prompt and the reply validated locally.
 *
 * NOT structured output (`output_config.format`), deliberately: the seed
 * schema compiled as a constrained-decoding grammar exceeds the API's
 * undocumented grammar-size limit, and every request 400s with "The
 * compiled grammar is too large" before inference. The limit is on the
 * aggregate schema — a trivial schema compiles and the largest single
 * branch (`pull_requests`) compiles, but the whole seed schema does not,
 * on the pinned model and on newer ones alike — so any schema shrink
 * would only last until the seed grows a field. Local validation is the
 * path this module always ended on anyway (`parseGitHubSeedState`, and
 * the twin boot check in `verifySeedWithTwin` after it).
 *
 * Why Messages API and not the Agent SDK: this is a pure prose-to-JSON
 * transform with no tools needed during generation, so the agent loop
 * adds only cost and variance. The bundled Claude Code system prompt
 * also pushes per-call cost up ~3-10×.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseGitHubSeedState } from "./githubSeedCompat.js";
// `/seed`, not the package root — see `parseTask.ts`'s note.
import { seedSchema as seedStateSchema } from "@pome-sh/twin-github/seed";

export const COMPILER_MODEL = "claude-opus-4-7";

const MAX_TOKENS = 8192;

// `io: "input"` — what `parseSeed` accepts, so fields with schema defaults are
// optional. That is the shape rule 4 below already promises the model.
const SEED_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(seedStateSchema, { io: "input" }));

const SYSTEM_PROMPT = `You convert natural-language descriptions of a GitHub twin's seed state into JSON matching the provided schema.

Rules:
1. Anything marked "(exact)" or "exact text" or shown inside an inline code block as a value must be copied character-for-character. Do NOT rephrase, normalize whitespace, or fix typos.
2. For values described semantically (e.g. "GitHub-conventional colors", "a reasonable description"), pick realistic GitHub-style values.
3. When the prose says "exactly N" or "and no others", do not add extras.
4. When a field is not mentioned, omit it — schema defaults will fill in.
5. Do not invent entities not mentioned. If the prose describes one issue, output exactly one issue.
6. Issue \`number\` is required and must be set (use #N if the prose says so, otherwise start at 1).
7. PR \`number\` is optional; set it when the prose says "#N".
8. Issue \`assignees\` is an array of login strings; use [] when unassigned.
9. Use fenced code blocks in the prose to indicate the exact content of \`files[].content\`. Preserve trailing newlines verbatim.

Respond with a single JSON object that validates against this JSON Schema. Output only the JSON object — no prose, no markdown fences.

<schema>
${SEED_JSON_SCHEMA}
</schema>`;

export interface CompileResult {
  seed: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
  durationMs: number;
}

export async function compileSeed(prose: string, opts: { model?: string } = {}): Promise<CompileResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export your Anthropic API key before running `pome compile-seeds`."
    );
  }

  const model = opts.model ?? COMPILER_MODEL;
  const client = new Anthropic();
  const t0 = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prose }]
  });

  const durationMs = Date.now() - t0;

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Compiler output was truncated at max_tokens=${MAX_TOKENS}. ` +
        `The seed prose may describe more state than one compile can emit.`
    );
  }

  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");

  let candidate: unknown;
  try {
    candidate = JSON.parse(extractJsonPayload(text));
  } catch (err) {
    throw new Error(`Compiler did not return valid JSON: ${(err as Error).message}`);
  }

  // The schema travels as prompt text, so this local parse IS the validation —
  // it also ensures downstream code holds a `ParsedSeedState`-shaped value,
  // not `unknown`.
  const seed = parseGitHubSeedState(candidate);

  return {
    seed,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model,
    durationMs
  };
}

/** The prompt forbids fences, but a fenced reply is still a valid compile. */
function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]! : trimmed;
}
