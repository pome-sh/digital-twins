// SPDX-License-Identifier: Apache-2.0
/**
 * Layer-3 defense for compile-seeds: boot an in-memory twin and load the
 * generated seed through its real `GitHubDomain.seed()` path. Catches the
 * cross-reference and domain-invariant errors that schema validation alone
 * cannot — e.g. issue.labels referencing a label not in repo.labels, PR head
 * referencing a branch with no files.
 *
 * Throws if the twin rejects the seed; otherwise returns silently.
 *
 * ASYNC because the twin import is DYNAMIC. This is the one seed-side
 * module that genuinely needs the github twin's domain and SQLite schema — every
 * other one wants only the zod schema and reads it from `@pome-sh/twin-github/seed`.
 * A top-level import here put 205 KB of domain into the CLI's startup path via
 * `main.ts → compile-seeds.ts`, on every invocation including `pome --version`,
 * to serve one command. `import()` inside the function is the same shape
 * `cli/src/twin/registry.ts` uses to keep each twin's boot lazy.
 */

export async function verifySeedWithTwin(seed: unknown): Promise<void> {
  const { GitHubDomain, openGitHubCloneDatabase } = await import("@pome-sh/twin-github");
  // `:memory:` SQLite — torn down when this function returns and `db`
  // goes out of scope. No filesystem side-effects, no cleanup needed.
  const db = openGitHubCloneDatabase(":memory:");
  try {
    new GitHubDomain(db).seed(seed as never);
  } catch (err) {
    throw new Error(
      `Seed verification failed: the in-memory twin rejected the compiled seed. ` +
        `Adjust the prose to fix the underlying problem.\n  ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
