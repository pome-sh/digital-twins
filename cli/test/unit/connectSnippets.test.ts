// SPDX-License-Identifier: Apache-2.0
// The connect block `pome twin start` prints is paste-ready text for three
// clients plus the vendor SDK (F-1827). These pin the exact forms: the
// `claude mcp add` shape `claude mcp add --help` documents, the TOML table
// `codex mcp add --url … --bearer-token-env-var` writes, a `.mcp.json` stanza
// that parses, and the rule that the token itself lands only where it is
// stored outside the repo.

import { describe, expect, it } from "vitest";
import {
  claudeCodeCommand,
  codexConfigBlock,
  exportLine,
  mcpJsonStanza,
  mcpServerName,
  renderConnectSnippets,
  sdkLines,
  type ConnectSnippetInput,
} from "../../src/twin/connectSnippets.js";
import { TWIN_REGISTRY, type TwinName } from "../../src/twin/registry.js";

const TWIN_NAMES = Object.keys(TWIN_REGISTRY) as TwinName[];
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.not-a-real-token.sig";

function inputFor(name: ConnectSnippetInput["name"], port = 3333): ConnectSnippetInput {
  const entry = TWIN_REGISTRY[name];
  return {
    name,
    envName: entry.envName,
    port,
    restUrl: `http://127.0.0.1:${port}/s/standalone`,
    mcpUrl: `http://127.0.0.1:${port}/s/standalone/mcp`,
    token: TOKEN,
    ...(entry.tokenEnvName ? { tokenEnvName: entry.tokenEnvName } : {}),
  };
}

describe("connect snippets", () => {
  it("names every twin's MCP server pome-<twin>", () => {
    for (const name of TWIN_NAMES) expect(mcpServerName(name)).toBe(`pome-${name}`);
  });

  it("prints the claude mcp add one-liner in the form `claude mcp add --help` documents", () => {
    expect(claudeCodeCommand(inputFor("github"))).toBe(
      `claude mcp add --transport http pome-github http://127.0.0.1:3333/s/standalone/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("prints the Codex table `codex mcp add --url … --bearer-token-env-var` writes, with no token in it", () => {
    const block = codexConfigBlock(inputFor("slack", 3334));
    expect(block).toBe(
      [
        "[mcp_servers.pome-slack]",
        'url = "http://127.0.0.1:3334/s/standalone/mcp"',
        'bearer_token_env_var = "POME_AUTH_TOKEN"',
      ].join("\n"),
    );
    expect(block).not.toContain(TOKEN);
  });

  it("prints a .mcp.json stanza that parses and carries ${POME_AUTH_TOKEN}, not the token", () => {
    const stanza = mcpJsonStanza(inputFor("linear", 3336));
    expect(stanza).not.toContain(TOKEN);
    const parsed = JSON.parse(stanza) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers["pome-linear"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:3336/s/standalone/mcp",
      headers: { Authorization: "Bearer ${POME_AUTH_TOKEN}" },
    });
  });

  it("points each twin's vendor SDK at the twin through the printed POME_* env lines", () => {
    const expectations: Record<ConnectSnippetInput["name"], string> = {
      github: "new Octokit({ baseUrl: process.env.POME_GITHUB_REST_URL, auth: process.env.POME_AUTH_TOKEN })",
      slack: 'new WebClient(process.env.POME_AUTH_TOKEN, { slackApiUrl: process.env.POME_SLACK_REST_URL + "/" })',
      stripe:
        'new Stripe(process.env.POME_AUTH_TOKEN, { host: "127.0.0.1", port: Number(new URL(process.env.POME_STRIPE_REST_URL).port), protocol: "http" })',
      gmail: 'gmail.users.messages.list({ userId: "me" }, { rootUrl: process.env.POME_GMAIL_REST_URL + "/" });',
      linear: 'new LinearClient({ apiKey: process.env.POME_LINEAR_TOKEN, apiUrl: process.env.POME_LINEAR_REST_URL + "/graphql" })',
    };
    for (const name of TWIN_NAMES) {
      const { lines } = sdkLines(inputFor(name, 3335));
      expect(lines.join("\n")).toContain(expectations[name]);
    }
    // Gmail's OAuth2 client takes the twin's own bearer alias.
    expect(sdkLines(inputFor("gmail")).lines[0]).toContain("access_token = POME_GMAIL_TOKEN");
  });

  it("prints one export line with every POME_* value, so child processes see the token", () => {
    expect(exportLine(inputFor("github"))).toBe(
      `export POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone POME_GITHUB_MCP_URL=http://127.0.0.1:3333/s/standalone/mcp POME_AUTH_TOKEN=${TOKEN}`,
    );
    // Twins with a provider-specific alias export that too.
    expect(exportLine(inputFor("linear"))).toContain(` POME_LINEAR_TOKEN=${TOKEN}`);
    expect(exportLine(inputFor("gmail"))).toContain(` POME_GMAIL_TOKEN=${TOKEN}`);
  });

  it("renders the block in the order a reader picks a client; the token appears only where it is pasted into a shell", () => {
    const block = renderConnectSnippets(inputFor("github"));
    const at = (needle: string) => {
      const i = block.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("Claude Code:")).toBeLessThan(at("Export it once:"));
    expect(at("Export it once:")).toBeLessThan(at("Codex ("));
    expect(at("Codex (")).toBeLessThan(at(".mcp.json ("));
    expect(at(".mcp.json (")).toBeLessThan(at("Your own code, through GitHub's SDK (Octokit):"));
    // Twice: the `claude mcp add` line and the `export` line. Never in the
    // Codex table or the .mcp.json stanza, which land in files.
    expect(block.split(TOKEN).length - 1).toBe(2);
    expect(block).toContain(claudeCodeCommand(inputFor("github")));
    expect(block).toContain(exportLine(inputFor("github")));
    // Pasted lines carry only leading whitespace, which every target ignores.
    for (const line of block.split("\n")) expect(line).not.toMatch(/\s$/);
  });
});
