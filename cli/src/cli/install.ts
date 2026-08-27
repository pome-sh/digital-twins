// SPDX-License-Identifier: Apache-2.0
// `pome install` (Gen-1 agent-driven wiring) is retired.
//
// It used to run a headless coding-agent session whose knowledge layer was the
// `pome-setup` skill, staging the edits in a shadow copy and gating them behind
// a terminal diff. `pome-setup` then became a redirect
// tombstone — so the wiring no longer actually ran, it just injected a pointer.
// This command is now a thin redirect to the current path; the shadow-diff
// engine (`embedded-wiring.ts`) and the Agent SDK provisioning (`agent-sdk.ts`)
// were deleted with it.
//
// The message below is the only user-facing surface for the retirement:
// `scripts/check-docs-retired-surface.ts` keeps docs.pome.sh from documenting
// retired commands at all, so a reader who runs this one has nowhere else to
// land. It therefore names only things they can then look up on docs.pome.sh.
// It used to end at "the pome-intake / REST-launch preflight" — internal
// vocabulary for a step that lives inside an installed skill
// (`pome-run-task/references/launch-rest.md`) and appears on no published page,
// which left the reader with two commands they could run and a third step they
// could not find. "Gen-1"/"Gen-2" are ours too: the docs site never uses either.

/** The wiring path `pome install` now points at. Printed to stderr, matching
 *  the rest of the CLI's informational output.
 *
 *  Every step here is documented on docs.pome.sh, and
 *  `install-command.test.ts` holds it that way: the skills it names are checked
 *  against the `skills/` directory, and the internal terms it dropped are
 *  asserted absent. */
const RETIRED_REDIRECT = [
  "pome install is retired. Wiring your agent to Pome is two commands:",
  "",
  "  1. claude mcp add --transport http pome https://mcp.pome.sh/mcp",
  "                                           # connect the Pome MCP server",
  "  2. npx skills add pome-sh/digital-twins --skill '*'",
  "                                           # install the coach skills",
  "                                           # (--skill '*' takes all six; the",
  "                                           #  picker opens with none ticked)",
  "",
  "Then ask your agent to run the `pome` skill. It routes to `pome-intake`,",
  "which registers the agent under test and checks twin coverage for it.",
  "",
  "Already have a repo with a pome.json? `pome register agent <name>` then",
  "`pome doctor` is the same wiring from the CLI side.",
  "",
  "Walkthrough:      https://docs.pome.sh/quickstart/claude-code",
  "Your own agent:   https://docs.pome.sh/existing-agent",
];

/** Print the current wiring path. Exported for the `pome install` command and
 *  its unit test. Never errors — a retired command should land the user on the
 *  right path, not exit non-zero. */
export function runInstall(): void {
  for (const line of RETIRED_REDIRECT) console.error(line);
}
