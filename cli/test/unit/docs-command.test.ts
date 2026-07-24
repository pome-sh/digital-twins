// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCS_TOPICS } from "../../src/cli/docs-topics.js";
import { findTopic, runDocsCommand, suggestTopics } from "../../src/cli/docs.js";

describe("pome docs helpers", () => {
  const originalExitCode = process.exitCode;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      stdout.push(String(msg));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it("findTopic resolves id and keywords", () => {
    expect(findTopic("getting-started", DOCS_TOPICS)?.id).toBe("getting-started");
    expect(findTopic("install", DOCS_TOPICS)?.id).toBe("getting-started");
  });

  it("keeps routing the retired skills-setup/skills-test keywords (F-893)", () => {
    // The skills-setup / skills-test topics were removed with the Gen-1 CLI
    // wiring commands; every keyword that used to reach them must still resolve
    // (never an unknown-topic exit 2). Some migrated onto a new topic; others
    // already matched a surviving keyword via substring.
    expect(findTopic("wire", DOCS_TOPICS)?.id).toBe("existing-agent");
    expect(findTopic("test-with-pome", DOCS_TOPICS)?.id).toBe("cli-run");
    expect(findTopic("/test-with-pome", DOCS_TOPICS)?.id).toBe("cli-run");
    expect(findTopic("pome-test", DOCS_TOPICS)?.id).toBe("cli-run");
    expect(findTopic("eval", DOCS_TOPICS)?.id).toBe("cli-inspect");
    // Already-resolving keywords (via existing substrings) must not regress.
    expect(findTopic("register", DOCS_TOPICS)?.id).toBe("existing-agent");
    expect(findTopic("pome-setup", DOCS_TOPICS)).not.toBeNull();
    expect(findTopic("setup", DOCS_TOPICS)).not.toBeNull();
    expect(findTopic("run scenarios", DOCS_TOPICS)).not.toBeNull();
  });

  it("suggestTopics lists nearby ids for unknown input", () => {
    const msg = suggestTopics("instal", DOCS_TOPICS);
    expect(msg).toContain("Did you mean");
    expect(msg).toContain("getting-started");
  });

  it("suggestTopics falls back to index hint when no overlap", () => {
    const msg = suggestTopics("zzzz-not-a-topic", DOCS_TOPICS);
    expect(msg).toContain("pome docs");
    expect(msg).toContain("zzzz-not-a-topic");
  });

  it("prints the canonical URL for a topic", async () => {
    await runDocsCommand("getting-started", {});

    expect(stdout).toEqual(["https://docs.pome.sh/getting-started"]);
    expect(stderr).toEqual([]);
  });

  it("prints topic URL rows without requiring bundled docs", async () => {
    await runDocsCommand(undefined, { urlOnly: true });

    expect(stdout).toContain("getting-started\thttps://docs.pome.sh/getting-started");
    expect(stdout.some((line) => line.includes("docs/cli/run"))).toBe(true);
  });
});
