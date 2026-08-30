import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionResponse } from "../../src/types/shared.js";
import { HostedDiscardRefusedError } from "../../src/hosted/errors.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  resolveCredentials: vi.fn(),
}));

vi.mock("../../src/cli/credentials.js", () => ({
  resolveCredentials: mocks.resolveCredentials,
}));

vi.mock("../../src/cli/agent-identity.js", () => ({
  resolveRunAgentIdentity: vi.fn(async () => ({})),
}));

vi.mock("../../src/hosted/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hosted/client.js")>();
  return {
    ...actual,
    createHostedClient: vi.fn(() => ({
      createSession: mocks.createSession,
      deleteSession: mocks.deleteSession,
    })),
  };
});

import { runSessionCreate, runSessionStop } from "../../src/cli/session.js";

const session: CreateSessionResponse = {
  session_id: "ses_test",
  session_token: "ses_test",
  twin_url: "https://twin.example.com/s/ses_test",
  expires_at: "2026-06-24T16:30:00.000Z",
  openapi_url: "https://twin.example.com/s/ses_test/openapi.json",
  agent_token: "agent_secret_token",
  per_twin: {
    github: {
      api_url: "https://twin.example.com/s/ses_test/github",
      mcp_url: "https://twin.example.com/s/ses_test/github/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/github/openapi.json",
    },
    stripe: {
      api_url: "https://twin.example.com/s/ses_test/stripe",
      mcp_url: "https://twin.example.com/s/ses_test/stripe/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/stripe/openapi.json",
    },
    slack: {
      api_url: "https://twin.example.com/s/ses_test/slack",
      mcp_url: "https://twin.example.com/s/ses_test/slack/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/slack/openapi.json",
    },
    gmail: {
      api_url: "https://twin.example.com/s/ses_test/gmail",
      mcp_url: "https://twin.example.com/s/ses_test/gmail/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/gmail/openapi.json",
    },
  },
  provider_credentials: {
    github: {
      token: "github_secret_token",
      header: "Authorization",
      scheme: "Bearer",
    },
    stripe: {
      api_key: "stripe_secret_key",
      header: "Authorization",
      scheme: "Bearer",
    },
    slack: {
      token: "slack_secret_token",
      header: "Authorization",
      scheme: "Bearer",
    },
  },
};

describe("runSessionCreate secret output", () => {
  const originalExitCode = process.exitCode;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    mocks.resolveCredentials.mockResolvedValue({
      apiBaseUrl: "https://api.example.com",
      apiKey: "control_plane_secret",
    });
    mocks.createSession.mockResolvedValue(session);
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
    mocks.resolveCredentials.mockReset();
    mocks.createSession.mockReset();
    process.exitCode = originalExitCode;
  });

  it("keeps JSON output redacted", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      json: true,
    });

    const output = stdout.join("\n");
    expect(output).toContain("***redacted***");
    expect(output).not.toContain("agent_secret_token");
    expect(output).not.toContain("github_secret_token");
    expect(output).not.toContain("stripe_secret_key");
  });

  it("writes env exports only to a restricted secrets file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-session-"));
    const secretsFile = join(dir, "session.env");

    try {
      await runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["stripe"],
        json: false,
        secretsFile,
      });

      const combinedOutput = [...stdout, ...stderr].join("\n");
      expect(combinedOutput).toContain(secretsFile);
      expect(combinedOutput).not.toContain("agent_secret_token");
      expect(combinedOutput).not.toContain("github_secret_token");
      expect(combinedOutput).not.toContain("stripe_secret_key");

      const contents = await readFile(secretsFile, "utf8");
      expect(contents).toContain("POME_AUTH_TOKEN=\"agent_secret_token\"");
      expect(contents).toContain("POME_STRIPE_API_KEY=\"stripe_secret_key\"");
      expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
      expect(process.exitCode).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ── Multi-twin (M3): slack allowed, repeated --twin, slack redaction, env ──
  it("allows the slack twin (MOUNTED_TWINS) and creates a session for it", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["slack"],
      json: true,
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ twins: ["slack"] }),
    );
  });

  it("stands up a multi-twin session from repeated --twin values", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github", "slack"],
      json: true,
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ twins: ["github", "slack"] }),
    );
  });

  it("de-dupes repeated twins and rejects an unknown twin", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github", "github"],
      json: true,
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ twins: ["github"] }),
    );

    await expect(
      runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["notion"],
        json: true,
      }),
    ).rejects.toThrow(/Unknown twin "notion"/);
  });

  it("redacts provider_credentials.slack.token in JSON output", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["slack"],
      json: true,
    });
    const output = stdout.join("\n");
    expect(output).toContain("***redacted***");
    expect(output).not.toContain("slack_secret_token");
  });

  it("writes a slack env export with POME_SLACK_* and the JWT as the slack bearer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-session-slack-"));
    const secretsFile = join(dir, "session.env");
    try {
      await runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["github", "slack"],
        json: false,
        secretsFile,
      });
      const contents = await readFile(secretsFile, "utf8");
      // Distinct per-twin endpoints, plus the slack bearer = the session JWT
      // (the proxy only verifies the JWT — never provider_credentials.slack.token).
      expect(contents).toContain(
        'POME_GITHUB_REST_URL="https://twin.example.com/s/ses_test/github"',
      );
      expect(contents).toContain(
        'POME_SLACK_REST_URL="https://twin.example.com/s/ses_test/slack"',
      );
      expect(contents).toContain(
        'POME_SLACK_MCP_URL="https://twin.example.com/s/ses_test/slack/mcp"',
      );
      expect(contents).toContain('POME_SLACK_TOKEN="agent_secret_token"');
      expect(contents).not.toContain("slack_secret_token");
      expect(contents).toContain('POME_TWIN_NAMES="github,slack"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes Gmail endpoints and aliases the session JWT without provider credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-session-gmail-"));
    const secretsFile = join(dir, "session.env");
    try {
      await runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["gmail"],
        json: false,
        secretsFile,
      });
      const contents = await readFile(secretsFile, "utf8");
      expect(contents).toContain(
        'POME_GMAIL_REST_URL="https://twin.example.com/s/ses_test/gmail"',
      );
      expect(contents).toContain(
        'POME_GMAIL_MCP_URL="https://twin.example.com/s/ses_test/gmail/mcp"',
      );
      expect(contents).toContain('POME_GMAIL_TOKEN="agent_secret_token"');
      expect(session.provider_credentials).not.toHaveProperty("gmail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runSessionStop", () => {
  beforeEach(() => {
    mocks.deleteSession.mockReset();
    mocks.resolveCredentials.mockResolvedValue({
      apiBaseUrl: "https://api.example.com",
      apiKey: "pme_test",
    });
  });

  it("does not request a discard by default", async () => {
    mocks.deleteSession.mockResolvedValue(undefined);
    await runSessionStop({
      apiBaseUrl: "https://api.example.com",
      sessionId: "ses_a",
    });
    expect(mocks.deleteSession).toHaveBeenCalledWith("ses_a", false, {
      discard: false,
    });
  });

  it("requests a discard when --discard was passed", async () => {
    mocks.deleteSession.mockResolvedValue(undefined);
    await runSessionStop({
      apiBaseUrl: "https://api.example.com",
      sessionId: "ses_a",
      discard: true,
    });
    expect(mocks.deleteSession).toHaveBeenCalledWith("ses_a", false, {
      discard: true,
    });
  });

  it("prints 'Stopped sandbox' when a confirmed discard succeeds", async () => {
    // deleteSession resolving means the client already replayed the
    // discard_token and the second attempt landed a real 204/200 — the
    // ordinary success path, not a refusal.
    mocks.deleteSession.mockResolvedValue(undefined);
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    await runSessionStop({
      apiBaseUrl: "https://api.example.com",
      sessionId: "ses_a",
      discard: true,
    });
    spy.mockRestore();
    expect(errors.join("\n")).toContain("Stopped sandbox ses_a");
  });

  it("prints the refusal naming the task and the keep-it path, and exits nonzero", async () => {
    mocks.deleteSession.mockRejectedValue(
      new HostedDiscardRefusedError(
        "Session is still open.",
        "ses_a",
        "running",
        "support-triage-p1",
        252,
        "dsc_tok",
      ),
    );
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    await expect(
      runSessionStop({
        apiBaseUrl: "https://api.example.com",
        sessionId: "ses_a",
      }),
    ).rejects.toBeInstanceOf(HostedDiscardRefusedError);
    spy.mockRestore();
    const printed = errors.join("\n");
    expect(printed).toContain("ses_a");
    expect(printed).toContain("support-triage-p1");
    expect(printed).toContain("has not been graded");
    expect(printed).toContain("--discard");
    expect(printed).not.toContain("Stopped session");
  });
});
