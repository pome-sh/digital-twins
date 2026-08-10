// SPDX-License-Identifier: Apache-2.0
// Unit tests for the shared upload/finalize helpers (FDRS-656 review fixes).

import { gunzipSync } from "node:zlib";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  redactJsonl,
  scoreFromFinalizeResponse,
  uploadRunBlobs,
  type UploadClient,
} from "../../../src/hosted/uploadAndFinalize.js";
import { scoreStatus } from "../../../src/hosted/evalResultView.js";
import { HostedOrchError } from "../../../src/hosted/errors.js";
import { finalizeResponseSchema, type FinalizeResponse } from "../../../src/contract/index.js";

describe("redactJsonl (FDRS-656 review)", () => {
  it("drops whitespace-only lines so validation and upload agree on row counts", () => {
    // validateJsonl trims lines before parsing, so a " " line passes
    // validation — it must never reach cloud as a non-JSON row.
    const out = redactJsonl('   \n{"a":1}\n\t\n');
    expect(out).toBe('{"a":1}\n');
  });

  it("keeps redacting secrets per line", () => {
    const out = redactJsonl('{"api_key":"redaction_fixture_secret"}\n');
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("redaction_fixture_secret");
  });

  it("returns empty string for whitespace-only payloads", () => {
    expect(redactJsonl(" \n  \n")).toBe("");
  });
});

// putBlob gzip-encodes every upload so the storage-edge WAF content rule
// (which 403s some plaintext twin-state payloads) never sees the raw body.
// The paired cloud reader release transparently gunzips via content-encoding.
describe("uploadRunBlobs — gzip blob uploads", () => {
  const BLOBS = {
    eventsJsonl: '{"kind":"TwinHttpEvent","twin":"slack"}\n',
    stateInitialJson: "{}",
    stateFinalJson: "{}",
    signalsJsonl: "",
    metaJson: '{"spec_version":1,"is_admin":true}',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs a gzip-magic body that gunzips back to the original text, with content-encoding: gzip", async () => {
    let sentBody: Uint8Array | null = null;
    let sentHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const ri = init as RequestInit;
      sentBody = new Uint8Array(ri.body as ArrayBuffer);
      sentHeaders = ri.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    });

    const client: UploadClient = {
      requestEventsUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestStateUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestSignalsUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestMetaUploadUrl: async () => ({
        url: "https://signed.example/put-meta",
        key: "team-tm_x/session-ses_1/meta.json",
      }),
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBe("team-tm_x/session-ses_1/meta.json");

    expect(sentBody).not.toBeNull();
    const body = sentBody as unknown as Uint8Array;
    // gzip magic bytes.
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
    // Round-trips to the exact original text.
    expect(gunzipSync(Buffer.from(body)).toString("utf8")).toBe(BLOBS.metaJson);
    // content-encoding header present; content-type preserved.
    expect(sentHeaders["content-encoding"]).toBe("gzip");
    expect(sentHeaders["content-type"]).toBe("application/json");
  });
});

// D18.1 — meta.json upload is best-effort, exactly like the other three
// blobs: a happy-path PUT resolves to the returned key, and ANY failure
// (crucially including the 404 a control plane that predates
// `POST /v1/sessions/:id/meta-upload-url` returns — the route ships in a
// parallel pome-cloud PR) degrades to metaKey=null instead of throwing.
describe("uploadRunBlobs — meta.json (D18.1)", () => {
  const BLOBS = {
    eventsJsonl: '{"kind":"TwinHttpEvent"}\n',
    stateInitialJson: "{}",
    stateFinalJson: "{}",
    signalsJsonl: "",
    metaJson: '{"spec_version":1}',
  };

  function baseClient(): UploadClient {
    return {
      requestEventsUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestStateUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestSignalsUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestMetaUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads meta.json and returns the storage key on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const client: UploadClient = {
      ...baseClient(),
      requestMetaUploadUrl: async () => ({
        url: "https://signed.example/put-meta",
        key: "team-tm_x/session-ses_1/meta.json",
      }),
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBe("team-tm_x/session-ses_1/meta.json");
  });

  it("a 404 from meta-upload-url (older control plane) tolerates silently — metaKey=null, no throw", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client: UploadClient = {
      ...baseClient(),
      requestMetaUploadUrl: async () => {
        throw new HostedOrchError("no route", undefined, 404);
      },
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBeNull();
    // The 404 happened minting the URL — no PUT was ever attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a PUT failure after a successful mint also degrades to metaKey=null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 }),
    );
    const client: UploadClient = {
      ...baseClient(),
      requestMetaUploadUrl: async () => ({
        url: "https://signed.example/put-meta",
        key: "team-tm_x/session-ses_1/meta.json",
      }),
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBeNull();
  });
});

// F-1392 — pome-cloud's F-1296 moved a seed-pre-satisfied criterion out of
// the dashboard's abstention denominator (`isRunIncomplete` in
// apps/dashboard/src/lib/run-status.ts: `notEvaluated - preSatisfied > 0`).
// The CLI never learned: `scoreFromFinalizeResponse` counted every `skipped`
// result with no exemption, so a run the dashboard renders PASS came out
// `can_pass: false` → `incomplete` → exit 1 in CI. These tests pin the fix
// AND its narrowness: only the one named reason is exempt.
function finalizeResponse(
  criteria_results: FinalizeResponse["criteria_results"],
  score = 100,
): FinalizeResponse {
  return {
    run_id: "run_x",
    score,
    dashboard_url: "https://app.pome.sh/runs/run_x",
    criteria_results,
  };
}

describe("scoreFromFinalizeResponse — the seed-pre-satisfied exemption (F-1392)", () => {
  it("yields can_pass: true and scoreStatus 'pass' when the only non-passing criterion is pre-satisfied", () => {
    const finalized = finalizeResponse([
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
    ]);

    const score = scoreFromFinalizeResponse(finalized);
    expect(score.preSatisfied).toBe(1);
    expect(score.skipped).toBe(1);
    expect(score.can_pass).toBe(true);
    expect(scoreStatus(score, 100)).toBe("pass");
  });

  it("STILL calls the run incomplete when a DIFFERENT skip reason is present (no loosening)", () => {
    const finalized = finalizeResponse([
      {
        criterion: { type: "code", text: "No unsupported endpoint was called" },
        passed: true,
        skipped: false,
        reason: "matched",
      },
      {
        criterion: { type: "code", text: "some other criterion" },
        passed: false,
        skipped: true,
        reason: "cloud could not evaluate this criterion",
      },
    ]);

    const score = scoreFromFinalizeResponse(finalized);
    expect(score.preSatisfied).toBe(0);
    expect(score.can_pass).toBe(false);
    expect(scoreStatus(score, 100)).toBe("incomplete");
  });

  it("STILL calls the run incomplete when a judge-unavailable criterion sits beside a pre-satisfied one", () => {
    // The wire shape a judge failure actually arrives in: `skipped: true`
    // with its own reason. It is not the exempt reason, so it blocks the pass
    // exactly like any other abstention.
    const finalized = finalizeResponse([
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
      {
        criterion: { type: "model", text: "Severity is set correctly" },
        passed: false,
        skipped: true,
        reason: "judge_unavailable",
        confidence: 0,
        judge_model: "test-judge",
      },
    ]);

    const score = scoreFromFinalizeResponse(finalized);
    expect(score.preSatisfied).toBe(1);
    expect(score.skipped).toBe(2);
    expect(score.can_pass).toBe(false);
    expect(scoreStatus(score, 100)).toBe("incomplete");
  });

  it("cannot see an `errored` criterion at all — `outcome` does not survive the wire", () => {
    // F-1392 review: a fixture that sets `outcome: "errored"` only typechecks
    // through a cast, and a cast in a fixture is usually a fixture describing
    // a state the system cannot produce. This is that case, pinned rather
    // than cast past. `outcome` is `evalResultView`'s own additive
    // discriminator (FDRS-591/611); neither this repo's
    // `criterionResultSchema` nor pome-cloud's carries it, and
    // `finalizeResponseSchema` is a tolerant reader that STRIPS unknown keys,
    // so a cloud emitting `outcome` today would have it dropped before
    // `scoreFromFinalizeResponse` ever saw it. `errored` is therefore always
    // 0 on the hosted path, and the `errored` term in `can_pass` is a guard
    // for a producer that does not exist yet — not a branch a wire fixture
    // can exercise. If this test ever goes red, the wire grew the field and
    // the errored path became real.
    const parsed = finalizeResponseSchema.parse({
      run_id: "run_x",
      score: 100,
      dashboard_url: "https://app.pome.sh/runs/run_x",
      criteria_results: [
        {
          criterion: { type: "code", text: "No unsupported endpoint was called" },
          passed: true,
          skipped: false,
          reason: "matched",
        },
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          outcome: "errored",
          passed: false,
          skipped: true,
          reason: "judge_unavailable",
          confidence: 0,
          judge_model: "test-judge",
        },
      ],
    });

    expect(parsed.criteria_results?.[1]).not.toHaveProperty("outcome");
    const score = scoreFromFinalizeResponse(parsed);
    expect(score.errored).toBe(0);
    expect(score.skipped).toBe(1);
    // Still incomplete — via the skipped bucket, which is the only bucket the
    // wire can put it in.
    expect(score.can_pass).toBe(false);
    expect(scoreStatus(score, 100)).toBe("incomplete");
  });

  it("a run with ONLY pre-satisfied criteria and nothing else evaluated is still incomplete (nothing was actually graded)", () => {
    // total_required stays 0 and can_pass stays false — the pre-existing A5
    // guard (`totalRequired > 0`) is untouched by this exemption. F-1392
    // narrows what counts as an ABSTENTION; it does not relax the older rule
    // that a run with nothing passed or failed at all cannot pass regardless.
    //
    // The dashboard reads this shape `incomplete` too since F-1399; it used
    // to render FAILED at 0/100, which is the claim this comment carried
    // until F-1413 caught it going false. That agreement is checked rather
    // than restated: the whole table, including this row, is in
    // `cross-surface-agreement.test.ts`.
    const finalized = finalizeResponse([
      {
        criterion: { type: "code", text: "github.no-new-issues" },
        passed: false,
        skipped: true,
        reason: "already_true_in_seed",
      },
    ]);

    const score = scoreFromFinalizeResponse(finalized);
    expect(score.can_pass).toBe(false);
    expect(score.evaluated).toBe(false);
    expect(scoreStatus(score, 100)).toBe("incomplete");
  });

  it("keeps the FDRS-618 compat: no criteria_results at all still means can_pass true", () => {
    const finalized: FinalizeResponse = {
      run_id: "run_x",
      score: 100,
      dashboard_url: "https://app.pome.sh/runs/run_x",
    };
    const score = scoreFromFinalizeResponse(finalized);
    expect(score.can_pass).toBe(true);
    expect(score.preSatisfied).toBe(0);
  });
});
