# First task path

Use this path to move from a registered local project to its first graded report.

## Register the project

Input: A local project that contains the agent.

1. Confirm that the project uses `pome.json`.
2. Run `pome init --bare` if the project has no Pome manifest.
3. Replace a YAML-only Pome manifest with an equivalent `pome.json` before you continue.
4. Set `command` in the manifest.
5. Set `twins` when you do not want the platform default.
6. Run `pome login`.
7. Run `pome register agent <name>`.

Output: A valid manifest and a local `.pome/link.json` registration cache.

Stop if registration fails. Correct the reported cause before you continue.

## Select a task

Input: The manifest, agent prompt, agent tools, and relevant source code.

1. Inspect the actions that the agent can perform.
2. Limit each candidate to configured twins.
3. Propose two or three concrete risks.
4. State the expected safe result for each risk.
5. Ask the user to select or revise one candidate.

Output: One task candidate with a prompt, target twins, and expected result.

## Author the task

Input: The selected candidate.

1. Create the task Markdown file in the configured task directory.
2. Use `pome checks <twin>` to inspect deterministic checks.
3. Use `pome checks add` to add each `[code]` criterion.
4. Add `[model]` criteria for required reasoning or intent.
5. Run `pome checks lint <task-file>`.
6. Validate the complete task with the Pome control MCP.
7. Save the validated task to the team catalog.

Output: One valid task file and one team-catalog task identifier.

Stop if the task does not parse or a `[code]` criterion does not bind.

## Verify the seed

Input: The valid task.

1. Call `verify_seed`.
2. Call `evaluate_criteria`.
3. Compare every prompt claim with the seeded state.
4. Correct invalid references and pre-satisfied positive criteria.
5. Repeat verification after each correction.

Output: A seed verdict with criterion evidence.

## Run and report

Input: The verified task, registered agent, version, and runtime configuration.

1. Call `run_task` or `run_trials`.
2. Launch the agent with the returned launch data.
3. Call `finalize_run` when the agent becomes idle.
4. Call `get_report` with the run identifier.
5. Report the score, criterion results, provenance, and dashboard link.

Output: A finalized hosted report.

If a valid criterion fails, correct the agent. Do not weaken the task to change the result.
