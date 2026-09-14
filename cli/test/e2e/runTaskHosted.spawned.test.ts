import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { sign as signJwt } from "hono/jwt";
import { readVerdictArtifact } from "../../src/hosted/evalResultCache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "../../src/cli/main.ts");
// Absolute loader path: child cwd is a temp dir without node_modules/tsx.
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const TWIN_AUTH_SECRET = "test-secret-32-chars-minimum-length";

let cloudServer: ServerType | undefined;
let receivedResult: unknown = null;
let finalizeResponseOverrides: Record<string, unknown> = {};
// What `GET /_pome/events` serves. Default empty (the trivially-passing tests).
let eventsResponse: unknown[] = [];
// Decompressed bodies the CLI PUT to the signed upload URLs, keyed by blob kind.
let uploadedBlobs: Record<string, string> = {};

async function startFakeCloud(): Promise<number> {
  const app = new Hono();
  let port = 0;
  app.post("/v1/sessions", async (c) => {
    const sid = "ses_e2e";
    const token = await signJwt(
      { sid, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
      TWIN_AUTH_SECRET
    );
    return c.json({
      session_id: sid,
      session_token: "pst_test_e2e",
      twin_url: `http://127.0.0.1:${port}/s/${sid}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      agent_token: token,
      openapi_url: `http://127.0.0.1:${port}/openapi.json`,
      per_twin: {},
    });
  });
  app.get("/s/:sid/_pome/state", (c) =>
    c.json({
      repositories: [
        {
          owner: "acme",
          name: "api",
          full_name: "acme/api",
          labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
          issues: [{ number: 1, title: "x", labels: [{ name: "bug" }], assignee_login: null }],
        },
      ],
    })
  );
  app.get("/s/:sid/_pome/events", (c) => c.json(eventsResponse));
  // Mint signed upload URLs that point back at this fake cloud's PUT sink so the
  // runner's real upload lane (redact → gzip → PUT → thread key onto /finalize).
  app.post("/v1/sessions/:id/result-upload-url", (c) =>
    c.json({
      url: `http://127.0.0.1:${port}/_upload/events`,
      key: `team-tm_test/session-${c.req.param("id")}/events.jsonl`,
    }),
  );
  app.put("/_upload/:kind", async (c) => {
    const gz = Buffer.from(await c.req.arrayBuffer());
    uploadedBlobs[c.req.param("kind")] = gunzipSync(gz).toString("utf8");
    return c.body(null, 200);
  });
  app.post("/v1/sessions/:id/finalize", async (c) => {
    receivedResult = await c.req.json();
    return c.json(
      {
        run_id: "run_e2e",
        score: 100,
        judge_model: "test-judge",
        dashboard_url: "http://127.0.0.1/runs/run_e2e",
        ...finalizeResponseOverrides,
      },
      201,
    );
  });
  app.delete("/v1/sessions/:id", (c) =>
    c.json({ id: c.req.param("id"), state: "expired" })
  );

  port = await new Promise<number>((res) => {
    cloudServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      res(info.port)
    );
  });
  return port;
}

describe("pome run, hosted (e2e via spawn)", () => {
  let tmp: string;
  let port: number;

  beforeEach(async () => {
    receivedResult = null;
    finalizeResponseOverrides = {};
    eventsResponse = [];
    uploadedBlobs = {};
    tmp = await mkdtemp(join(tmpdir(), "pome-e2e-"));
    // `pome run` gates on the doctor preflight (config present, routing wired, egress
    // floor; local twin boot is skipped on hosted runs).
    await writeFile(
      join(tmp, "pome.json"),
      JSON.stringify({ agent: { slug: "e2e-agent" }, command: "true" }, null, 2),
      "utf8"
    );
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(
      join(tmp, "src", "agent.ts"),
      "const baseUrl = process.env.POME_GITHUB_REST_URL;\nexport { baseUrl };\n",
      "utf8"
    );
    port = await startFakeCloud();
  });

  afterEach(async () => {
    cloudServer?.close();
    cloudServer = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it("exits 0, prints PASS + cloud dashboard URL, and never POSTs agent_stdout", async () => {
    const taskPath = join(tmp, "scn.md");
    // Trivially-passing scenario: 'no unsupported endpoint' + 'no new labels'
    // are true given empty events + identical state from the fake cloud.
    await writeFile(
      taskPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [code] No unsupported endpoint was called",
        "- [code] No new labels were created",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8"
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        taskPath,
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      }
    );

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => (stdout += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    expect(code, `stderr was:\n${stderr}\nstdout was:\n${stdout}`).toBe(0);
    expect(stderr).toMatch(/PASS/);
    expect(stderr).toMatch(/cloud:\s+http/);

    // BYOK guard: agent_stdout never crosses the wire.
    expect(receivedResult).not.toBeNull();
    expect(receivedResult as Record<string, unknown>).not.toHaveProperty(
      "agent_stdout"
    );
  }, 90_000);

  it("prints INCOMPLETE and exits 1 when cloud score is 100 but a criterion was skipped", async () => {
    finalizeResponseOverrides = {
      criteria_results: [
        {
          criterion: { type: "D", text: "No unsupported endpoint was called" },
          outcome: "skipped",
          passed: false,
          skipped: true,
          reason: "cloud could not evaluate this criterion",
        },
      ],
    };
    const taskPath = join(tmp, "scn.md");
    await writeFile(
      taskPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [code] No unsupported endpoint was called",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        taskPath,
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      },
    );

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    // This response CARRIES `criteria_results` with nothing evaluated, so the A5
    // guard applies and `pome run` exits 1 on it exactly as `pome eval` does.
    // A response omitting `criteria_results` entirely is a different path:
    // `scoreFromFinalizeResponse` sets `evaluated` and `can_pass` true there
    // (`uploadAndFinalize.ts`), which this case does not exercise.
    expect(code, `stderr was:\n${stderr}`).toBe(1);
    // The label and the copy. "cannot pass" was a verdict about the
    // AGENT for a gap in the GRADER.
    expect(stderr).toMatch(/INCOMPLETE Trivial/);
    expect(stderr).toContain("score: incomplete —");
    expect(stderr).toContain("1 of 1 criteria not evaluated");
    expect(stderr).not.toContain("cannot pass");
    expect(stderr).toContain("cloud score: 100/100");

    // `verdict.json` must name the third state and carry its denominator. Writing
    // `score: 100, pass_threshold: 100, passed: false` with neither leaves a CI
    // reader no way to tell an ungraded run from a scoring bug.
    const v = await readVerdictArtifact(join(tmp, "runs", "scn", "ses_e2e"));
    expect(v).not.toBeNull();
    expect(v?.verdict.score).toBe(100);
    expect(v?.verdict.pass_threshold).toBe(100);
    expect(v?.verdict.state).toBe("incomplete");
    expect(v?.verdict.state).not.toBe("pass");
    expect(v?.verdict.passed).toBe(false);
    expect(v?.verdict.evaluated).toBe(0);
    expect(v?.verdict.not_evaluated).toBe(1);
    expect(v?.verdict.pre_satisfied).toBe(0);
    expect(v?.verdict.total).toBe(1);
  }, 90_000);

  // The sibling of the INCOMPLETE test above.
  it("prints PASS and exits 0 when the only skipped criterion is pre-satisfied (already_true_in_seed)", async () => {
    // The wire shape exactly as pome-cloud serializes it: no `outcome` field
    // (`criterionResultSchema` has none on either side, and the CLI's
    // `finalizeResponseSchema` strips unknown keys), so the exemption has to
    // work off `skipped` + `reason` — which is the whole point.
    finalizeResponseOverrides = {
      criteria_results: [
        {
          criterion: { type: "code", text: "No unsupported endpoint was called" },
          passed: true,
          skipped: false,
          reason: "matched",
        },
        {
          criterion: { type: "code", text: "github.no-new-issues" },
          passed: false,
          skipped: true,
          reason: "already_true_in_seed",
        },
      ],
    };
    const taskPath = join(tmp, "scn.md");
    await writeFile(
      taskPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [code] No unsupported endpoint was called",
        "- [code] github.no-new-issues",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        taskPath,
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      },
    );

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    expect(code, `stderr was:\n${stderr}`).toBe(0);
    expect(stderr).toMatch(/PASS/);
    expect(stderr).not.toMatch(/INCOMPLETE/);
    expect(stderr).not.toContain("score: incomplete —");

    // This is the row the dashboard and the CLI have to agree on
    // (`cross-surface-agreement.test.ts`'s "seed-excluded criterion beside three passes").
    const v = await readVerdictArtifact(join(tmp, "runs", "scn", "ses_e2e"));
    expect(v).not.toBeNull();
    expect(v?.verdict.state).toBe("pass");
    expect(v?.verdict.passed).toBe(true);
    expect(v?.verdict.evaluated).toBe(1);
    expect(v?.verdict.not_evaluated).toBe(0);
    expect(v?.verdict.pre_satisfied).toBe(1);
    expect(v?.verdict.total).toBe(2);
  }, 90_000);
});
