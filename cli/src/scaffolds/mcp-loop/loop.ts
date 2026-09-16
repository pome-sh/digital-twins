// SPDX-License-Identifier: Apache-2.0
//
// Model-agnostic MCP tool-call loop (spec §2 — the "mcp-loop" scaffold).
//
// Speaks the SAME agent contract as the existing example agents: it reads
// POME_TASK, the twin's POME_<TWIN>_MCP_URL, and POME_AUTH_TOKEN from the
// environment (the CLI runner sets these per cell). It connects to the twin's
// stateless MCP endpoint (JSON-RPC over Streamable HTTP), exposes the twin's
// tools to the model via the Vercel AI SDK, and runs a tool-call loop until the
// model finishes or hits the turn budget.
//
// NO new runtime dep: the MCP client is a ~40-line JSON-RPC-over-fetch client
// against the twin's stateless Streamable-HTTP server (see
// packages/twin-github/src/mcp.ts — single POST per request, `application/json`
// response, `tools/list` → { tools }, `tools/call` → { content:[{text}], isError }).
//
import {
  generateText,
  stepCountIs,
  dynamicTool,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
} from "ai";

// ---------------------------------------------------------------------------
// MCP client (dependency-free JSON-RPC over fetch, stateless Streamable HTTP).
// ---------------------------------------------------------------------------

export type McpToolDef = {
  name: string;
  description?: string;
  // camelCase JSON Schema, exactly as the twin's tools/list returns it.
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = {
  // Concatenated text content from the tool-call result.
  text: string;
  isError: boolean;
};

export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown): Promise<McpCallResult>;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcOk = { jsonrpc: "2.0"; id: number; result: unknown };
type JsonRpcErr = {
  jsonrpc: "2.0";
  id: number | null;
  error: { code: number; message: string };
};

// A minimal Streamable-HTTP MCP client. Each request is one POST; the twin is
// stateless (no Mcp-Session-Id, no SSE for single requests). We still send an
// `initialize` once for protocol-correctness even though the twin doesn't
// require session state.
export function createHttpMcpClient(opts: {
  url: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}): McpClient {
  const doFetch = opts.fetchImpl ?? fetch;
  let nextId = 1;
  let initialized = false;

  async function rpc(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The twin replies with application/json for single requests, but a
      // spec-compliant client advertises it accepts SSE too.
      accept: "application/json, text/event-stream",
    };
    if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;

    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) {
      throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as JsonRpcOk | JsonRpcErr;
    if ("error" in body) {
      throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
    }
    return body.result;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    await rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pome-mcp-loop", version: "1" },
    });
    initialized = true;
  }

  return {
    async listTools(): Promise<McpToolDef[]> {
      await ensureInitialized();
      const result = (await rpc("tools/list")) as { tools?: unknown };
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return tools.flatMap((t): McpToolDef[] => {
        if (
          t &&
          typeof t === "object" &&
          typeof (t as { name?: unknown }).name === "string"
        ) {
          const obj = t as Record<string, unknown>;
          const schema =
            obj.inputSchema && typeof obj.inputSchema === "object"
              ? (obj.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} };
          return [
            {
              name: obj.name as string,
              description:
                typeof obj.description === "string" ? obj.description : undefined,
              inputSchema: schema,
            },
          ];
        }
        return [];
      });
    },

    async callTool(name: string, args: unknown): Promise<McpCallResult> {
      await ensureInitialized();
      const result = (await rpc("tools/call", { name, arguments: args ?? {} })) as {
        content?: unknown;
        isError?: unknown;
      };
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((part) =>
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
            ? ((part as { text: string }).text)
            : "",
        )
        .join("");
      return { text, isError: result.isError === true };
    },
  };
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

// 12 turns: matches the example agents' 8-turn loop with headroom for
// multi-step (T5) scenarios. Wall-clock is the runner's scenario-timeout SIGTERM
// (spec §2 / plan) — the loop does not run a second timeout.
export const DEFAULT_MAX_TURNS = 12;

export type RunLoopOptions = {
  model: LanguageModel;
  mcp: McpClient;
  task: string;
  system?: string;
  maxTurns?: number;
};

export type RunLoopResult = {
  text: string;
  toolCallCount: number;
  steps: number;
  finishReason: string;
};

// Build the AI SDK tool set from the twin's MCP tools. Each tool's `execute`
// dispatches back through the MCP client.
function buildToolSet(
  tools: McpToolDef[],
  mcp: McpClient,
  onToolCall: () => void,
): Record<string, ReturnType<typeof dynamicTool>> {
  const set: Record<string, ReturnType<typeof dynamicTool>> = {};
  for (const t of tools) {
    set[t.name] = dynamicTool({
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: jsonSchema(t.inputSchema as never),
      execute: async (input: unknown) => {
        onToolCall();
        const result = await mcp.callTool(t.name, input);
        // Hand the raw tool text back to the model; the AI SDK serializes it.
        return result.text;
      },
    });
  }
  return set;
}

// Run the tool-call loop. The model + MCP client are injected so this is fully
// unit-testable with a mocked model and a fake MCP client (no network, no key).
export async function runMcpLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  const mcpTools = await options.mcp.listTools();
  let toolCallCount = 0;
  const toolSet = buildToolSet(mcpTools, options.mcp, () => {
    toolCallCount += 1;
  });

  const messages: ModelMessage[] = [{ role: "user", content: options.task }];

  const result = await generateText({
    model: options.model,
    system: options.system,
    messages,
    tools: toolSet,
    // Keep stepping while the model emits tool calls, up to the turn budget.
    stopWhen: stepCountIs(maxTurns),
  });

  return {
    text: result.text,
    toolCallCount,
    steps: result.steps.length,
    // The ai-level finishReason is a string union (the provider-level
    // {unified, raw} object is flattened by generateText).
    finishReason: result.finishReason,
  };
}

// ---------------------------------------------------------------------------
// Env-contract resolution (shared by the entrypoint; pure over an env map).
// ---------------------------------------------------------------------------

export type LoopEnvContract = {
  task: string;
  mcpUrl: string;
  authToken?: string;
  model: string;
  promptPath?: string;
};

// Discover the twin MCP URL from POME_<TWIN>_MCP_URL. The runner currently sets
// POME_GITHUB_MCP_URL; this is generic over twins (Stripe/Slack land the same
// shape). POME_TWIN_NAMES, when present, picks the active twin; otherwise the
// first POME_*_MCP_URL wins.
export function resolveMcpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = (env.POME_TWIN_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const name of names) {
    const v = env[`POME_${name}_MCP_URL`];
    if (v && v.trim()) return v.trim();
  }
  // Fall back to any POME_<X>_MCP_URL in the environment.
  for (const [k, v] of Object.entries(env)) {
    if (/^POME_[A-Z0-9]+_MCP_URL$/.test(k) && v && v.trim()) return v.trim();
  }
  return null;
}

// Resolve the full env contract or throw a clear error naming the missing var.
export function resolveLoopEnv(
  env: NodeJS.ProcessEnv = process.env,
): LoopEnvContract {
  const task = env.POME_TASK?.trim();
  if (!task) throw new Error("mcp-loop: POME_TASK is required");

  const mcpUrl = resolveMcpUrl(env);
  if (!mcpUrl) {
    throw new Error(
      "mcp-loop: no POME_<TWIN>_MCP_URL found in the environment (e.g. POME_GITHUB_MCP_URL)",
    );
  }

  const model = env.POME_MATRIX_MODEL?.trim();
  if (!model) {
    throw new Error("mcp-loop: POME_MATRIX_MODEL is required (set by the matrix)");
  }

  return {
    task,
    mcpUrl,
    authToken: env.POME_AUTH_TOKEN?.trim() || undefined,
    model,
    promptPath: env.POME_MATRIX_PROMPT_PATH?.trim() || undefined,
  };
}
