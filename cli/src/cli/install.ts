// SPDX-License-Identifier: Apache-2.0
// F-893 — `pome install` (Gen-1 agent-driven wiring) is retired.
//
// It used to run a headless coding-agent session whose knowledge layer was the
// `pome-setup` skill, staging the edits in a shadow copy and gating them behind
// a terminal diff (FDRS-642/661). F-859 turned `pome-setup` into a redirect
// tombstone — so the wiring no longer actually ran, it just injected a pointer.
// This command is now a thin redirect to the Gen-2 path; the shadow-diff engine
// (`embedded-wiring.ts`) and the Agent SDK provisioning (`agent-sdk.ts`) were
// deleted with it.
//
// Wiring your own agent to pome is now: connect the pome control MCP, install
// the Gen-2 coach skill set, then run `pome-intake` (managed agents) or the
// coach's REST-launch preflight (self-hosted REST agents).

/** The Gen-2 wiring path `pome install` now points at. Printed to stderr,
 *  matching the rest of the CLI's informational output. */
const GEN2_REDIRECT = [
  "pome install (Gen-1 agent-driven wiring) is retired.",
  "",
  "Wire your own agent to pome the Gen-2 way:",
  "  1. claude mcp add --transport http pome https://mcp.pome.sh/mcp",
  "                                           # connect the pome control MCP",
  "  2. npx skills add pome-sh/digital-twins  # install the Gen-2 coach skills",
  "  3. run the pome-intake skill to register the examinee and check twin",
  "     coverage (self-hosted REST agent: use the coach's REST-launch preflight).",
  "",
  "Already have pome.json? `pome register agent <name>` and `pome doctor` still apply.",
  "See `pome docs getting-started`.",
];

/** Print the Gen-2 wiring path. Exported for the `pome install` command and its
 *  unit test. Never errors — a retired command should land the user on the
 *  right path, not exit non-zero. */
export function runInstall(): void {
  for (const line of GEN2_REDIRECT) console.error(line);
}
