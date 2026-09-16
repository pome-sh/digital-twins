// SPDX-License-Identifier: Apache-2.0
//
// The connect block `pome twin start` prints under its banner (F-1827).
//
// A stranger who reaches "listening at …" has a URL and a token and hand-wires
// them into whichever client they use. This module renders the exact text each
// client takes, from the same values the banner already printed, so the next
// step is a paste and not a docs lookup:
//
//   - Claude Code  the `claude mcp add --transport http … --header` one-liner,
//                  in the form `claude mcp add --help` prints. The token is
//                  inline: that command stores it in ~/.claude.json, never in
//                  the repo.
//   - Codex        the `[mcp_servers.<name>]` table for ~/.codex/config.toml —
//                  exactly what `codex mcp add <name> --url … --bearer-token-env-var`
//                  writes (checked against codex-cli 0.153.2). Codex reads the
//                  token from the shell, so no token lands in the file.
//   - .mcp.json    the project-scoped stanza Claude Code reads from the repo.
//                  `${POME_AUTH_TOKEN}` rather than the literal, because that
//                  file is the one people commit and a committed 24-hour JWT is
//                  the F-1806 class of leak; Claude Code expands `${VAR}` there.
//   - the SDK line how the vendor's own client library is pointed at the twin,
//                  taken from each twin's README or official-client test.
//
// Pure — no I/O — so the unit test asserts the text and `twinStart` only prints
// it.

import type { TwinName } from "./registry.js";

export type ConnectSnippetInput = {
  name: TwinName;
  /** Uppercase env prefix the banner printed: `POME_<envName>_{REST,MCP}_URL`. */
  envName: string;
  port: number;
  restUrl: string;
  mcpUrl: string;
  token: string;
  /** Provider-specific bearer alias the banner printed, when the twin has one. */
  tokenEnvName?: string;
};

/** The MCP server name every snippet registers the twin under. */
export function mcpServerName(name: TwinName): string {
  return `pome-${name}`;
}

export function claudeCodeCommand(input: ConnectSnippetInput): string {
  return `claude mcp add --transport http ${mcpServerName(input.name)} ${input.mcpUrl} --header "Authorization: Bearer ${input.token}"`;
}

export function codexConfigBlock(input: ConnectSnippetInput): string {
  return [
    `[mcp_servers.${mcpServerName(input.name)}]`,
    `url = "${input.mcpUrl}"`,
    `bearer_token_env_var = "POME_AUTH_TOKEN"`,
  ].join("\n");
}

export function mcpJsonStanza(input: ConnectSnippetInput): string {
  const stanza = {
    mcpServers: {
      [mcpServerName(input.name)]: {
        type: "http",
        url: input.mcpUrl,
        headers: { Authorization: "Bearer ${POME_AUTH_TOKEN}" },
      },
    },
  };
  return JSON.stringify(stanza, null, 2);
}

/**
 * One line (two for Gmail) that points the vendor SDK at the twin, written
 * against the `POME_*` env lines the banner printed so it survives a restart
 * on a new port. Each form is the one that twin's README or official-client
 * test runs.
 */
export function sdkLines(input: ConnectSnippetInput): { label: string; lines: string[] } {
  const rest = `process.env.POME_${input.envName}_REST_URL`;
  switch (input.name) {
    case "github":
      return {
        label: "GitHub's SDK (Octokit)",
        lines: [`new Octokit({ baseUrl: ${rest}, auth: process.env.POME_AUTH_TOKEN })`],
      };
    case "slack":
      return {
        label: "Slack's SDK (WebClient)",
        lines: [`new WebClient(process.env.POME_AUTH_TOKEN, { slackApiUrl: ${rest} + "/" })`],
      };
    case "stripe":
      return {
        label: "Stripe's SDK",
        lines: [
          `new Stripe(process.env.POME_AUTH_TOKEN, { host: "127.0.0.1", port: ${input.port}, protocol: "http" })`,
        ],
      };
    case "gmail":
      return {
        label: "googleapis (Gmail)",
        lines: [
          `const gmail = google.gmail({ version: "v1", auth }); // auth: an OAuth2 client with access_token = ${input.tokenEnvName ?? "POME_AUTH_TOKEN"}`,
          `gmail.users.messages.list({ userId: "me" }, { rootUrl: ${rest} + "/" }); // rootUrl goes on each call`,
        ],
      };
    case "linear":
      return {
        label: "Linear's SDK",
        lines: [
          `new LinearClient({ apiKey: process.env.${input.tokenEnvName ?? "POME_AUTH_TOKEN"}, apiUrl: ${rest} + "/graphql" })`,
        ],
      };
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** The whole block, in the order a reader picks a client. */
export function renderConnectSnippets(input: ConnectSnippetInput): string {
  const sdk = sdkLines(input);
  return [
    "Connect your agent (pick one):",
    "",
    "Claude Code:",
    indent(claudeCodeCommand(input)),
    "",
    "Codex (append to ~/.codex/config.toml; codex reads POME_AUTH_TOKEN from the shell it runs in):",
    indent(codexConfigBlock(input)),
    "",
    ".mcp.json (Claude Code project scope, in the repo; export POME_AUTH_TOKEN first):",
    indent(mcpJsonStanza(input)),
    "",
    `Your own code, through ${sdk.label}:`,
    indent(sdk.lines.join("\n")),
  ].join("\n");
}
