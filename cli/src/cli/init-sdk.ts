// SPDX-License-Identifier: Apache-2.0
//
// Per-SDK scaffold writers for `pome init --sdk <name>`. Each writer produces
// a minimal-but-runnable starter set so a Claude Agent SDK / OpenAI Agents /
// other-framework user reaches a green hosted run in under five minutes.
//
// `claude-managed` remains deferred (waiting on Anthropic's Managed Agents API).
// Add new SDKs by appending a case in writeSdkScaffold below.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SUPPORTED_SDKS = ["claude", "claude-managed"] as const;
export type SupportedSdk = (typeof SUPPORTED_SDKS)[number];

export interface ScaffoldResult {
  agentSdkValue: string;
  agentCommand: string;
  exampleAgentRelativePath: string;
  postInstallHint: string;
}

const CLAUDE_SDK_AGENT_RELATIVE = "examples/agents/claude-sdk-agent.ts";

const CLAUDE_SDK_AGENT_SOURCE = `\
// SPDX-License-Identifier: Apache-2.0
//
// Scaffolded by \`pome init --sdk claude\`. Minimal Claude Agent SDK starter
// wired through @pome-sh/adapter-claude-sdk so \`pome run\` captures adapter
// signals. Swap the tool body for your own agent logic.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";
import { z } from "zod";

withPome();

const restUrl = process.env.POME_GITHUB_REST_URL;
const authToken = process.env.POME_AUTH_TOKEN;
const task =
  process.env.POME_TASK?.trim() ||
  "List open issues in acme/api and summarize their titles.";

if (!restUrl) {
  throw new Error(
    "POME_GITHUB_REST_URL is required (injected by \`pome run\`, or set it when driving a twin yourself).",
  );
}

if (process.env.POME_PREFLIGHT === "1") {
  const res = await fetch(\`\${restUrl.replace(/\\/+$/, "")}/rate_limit\`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(authToken ? { authorization: \`Bearer \${authToken}\` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(\`preflight failed: HTTP \${res.status}\`);
  }
  console.log("preflight ok");
  process.exit(0);
}

const listOpenIssues = tool(
  "list_open_issues",
  "List open issues on the GitHub twin for owner/repo.",
  {
    owner: z.string(),
    repo: z.string(),
  },
  async ({ owner, repo }) => {
    const res = await fetch(
      \`\${restUrl.replace(/\\/+$/, "")}/repos/\${owner}/\${repo}/issues?state=open\`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(authToken ? { authorization: \`Bearer \${authToken}\` } : {}),
        },
      },
    );
    const body = await res.text();
    if (!res.ok) {
      return {
        content: [{ type: "text" as const, text: \`HTTP \${res.status}: \${body}\` }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: body }] };
  },
);

const server = createSdkMcpServer({
  name: "github-twin",
  version: "0.1.0",
  tools: [listOpenIssues],
});

for await (const message of query({
  prompt: task,
  options: {
    permissionMode: "bypassPermissions",
    maxTurns: 10,
    allowedTools: ["list_open_issues"],
    mcpServers: {
      "github-twin": {
        type: "sdk",
        name: "github-twin",
        instance: server.instance,
      },
    },
  },
})) {
  if (message.type === "result" && message.subtype === "success" && message.result) {
    console.log(message.result);
  }
}
`;

export async function writeSdkScaffold(
  sdk: SupportedSdk,
): Promise<ScaffoldResult> {
  switch (sdk) {
    case "claude":
      return writeClaudeSdkScaffold();
    case "claude-managed":
      throw new ClaudeManagedDeferredError();
  }
}

async function writeClaudeSdkScaffold(): Promise<ScaffoldResult> {
  const path = join(process.cwd(), CLAUDE_SDK_AGENT_RELATIVE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, CLAUDE_SDK_AGENT_SOURCE, "utf8");
  return {
    agentSdkValue: "claude",
    agentCommand: `npx tsx ${CLAUDE_SDK_AGENT_RELATIVE}`,
    exampleAgentRelativePath: CLAUDE_SDK_AGENT_RELATIVE,
    postInstallHint:
      "Next steps:\n" +
      "  1. npm install @pome-sh/adapter-claude-sdk @anthropic-ai/claude-agent-sdk zod\n" +
      "  2. pome login\n" +
      "  3. pome register agent <name>\n" +
      "  4. pome run tasks/01-bug-happy-path.md\n" +
      "\n" +
      "See `pome docs getting-started` for a narrative walkthrough.",
  };
}

export class ClaudeManagedDeferredError extends Error {
  constructor() {
    super(
      "Claude Managed Agent is not yet supported — three blockers " +
        "(no injection point inside Anthropic-hosted runtime, no sidechannel " +
        "for adapter signals, Managed Agents API still moving). Follow the " +
        "tracking issue for v2 timing. For now, use `pome init` (without --sdk) " +
        "or `pome init --sdk claude`.",
    );
    this.name = "ClaudeManagedDeferredError";
  }
}
