// SPDX-License-Identifier: Apache-2.0
// Unit tests for the shared upload/finalize helpers.

import { gunzipSync } from "node:zlib";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  redactJsonl,
  scoreFromFinalizeResponse,
  uploadRunBlobs,
  type UploadClient,
} from "../../../src/hosted/uploadAndFinalize.js";
import { evaluationCounts, scoreStatus } from "../../../src/hosted/evalResultView.js";
import { HostedOrchError } from "../../../src/hosted/errors.js";
import { finalizeResponseSchema, type FinalizeResponse } from "../../../src/contract/index.js";

describe("redactJsonl", () => {
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

// Pome-cloud moved a seed-pre-satisfied criterion out of the dashboard's abstention
// denominator (`isRunIncomplete` in apps/dashboard/src/lib/run-status.ts:
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

describe("scoreFromFinalizeResponse — the seed-pre-satisfied exemption", () => {
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

  it("reads an `errored` criterion off the wire now that `outcome` survives the parse", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion it made was
    // true when it was written: `criterionResultSchema` had no `outcome` field,
    // so zod stripped the key and `errored` was a display state no wire fixture
    // could reach. `outcome` had to be declared for the narrator exemption to
    // be readable at all, and declaring it makes every spelling of the field
    // survive, not just the narrator's two.
    //
    // What does NOT change is the verdict, which is the part worth pinning: the
    // row moves from the `skipped` bucket to the `errored` one, and `errored` is
    // never exempted, so the run is still INCOMPLETE and still cannot pass.
    // That was the stated reason for keeping the term in the arithmetic while
    // nothing could produce it — "a cloud that starts emitting it must not
    // thereby acquire a pass" — and it now holds against a real payload rather
    // than a fabricated display-model row.
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

    expect(parsed.criteria_results?.[1]?.outcome).toBe("errored");
    const score = scoreFromFinalizeResponse(parsed);
    expect(score.errored).toBe(1);
    expect(score.skipped).toBe(0);
    // The bucket moved; the verdict did not. `errored` is not one of the two
    // exemptions, so it still blocks a pass.
    expect(score.can_pass).toBe(false);
    expect(scoreStatus(score, 100)).toBe("incomplete");
    // And the row is still counted: `total` names every criterion the run
    // recorded whichever bucket the row landed in.
    expect(evaluationCounts(score).total).toBe(2);
  });

  it("falls back to the booleans for an `outcome` spelling it has never heard of", () => {
    // The tolerant-reader half of the same change. A closed enum here would
    // have rejected the whole /finalize response; a pass-through would have let
    // an unknown string become a display state by arriving. Neither: the value
    // survives on the row, and every predicate reads the two booleans, which
    // already say whether the row is in the denominator.
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
          outcome: "deliberated",
          passed: false,
          skipped: true,
          reason: "a state this CLI has never heard of",
        },
      ],
    });
    expect(parsed.criteria_results?.[1]?.outcome).toBe("deliberated");
    const score = scoreFromFinalizeResponse(parsed);
    expect(score.skipped).toBe(1);
    expect(score.advisory).toBe(0);
    expect(score.abstained).toBe(0);
    // Not exempted, so the run keeps its INCOMPLETE — the fail-safe direction
    // for a state whose meaning this version cannot know.
    expect(scoreStatus(score, 100)).toBe("incomplete");
  });

  it("a run with ONLY pre-satisfied criteria and nothing else evaluated is still incomplete (nothing was actually graded)", () => {
    // total_required stays 0 and can_pass stays false — the pre-existing A5 guard
    // (`totalRequired > 0`) is untouched by this exemption.
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

 it("keeps the compat: no criteria_results at all still means can_pass true", () => {
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
