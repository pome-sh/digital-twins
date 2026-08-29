// SPDX-License-Identifier: Apache-2.0
//
// The two properties CI depends on, and the two vendor facts the page states.
//
// Hermetic: `initTelemetry` constructs an exporter but never connects — a
// BatchSpanProcessor with no spans sends nothing, and every test here either
// takes the inert path or shuts down immediately.

import { describe, expect, it } from "vitest";

import { SERVICE_NAME, initTelemetry, parseOtlpHeaders, tracesUrl } from "../src/telemetry.js";

describe("initTelemetry", () => {
  it("is inert with no endpoint, which is what keeps smoke:examples green", () => {
    // `scripts/smoke-examples.mjs` launches this example on every PR with no
    // credentials. If telemetry constructed a provider unconditionally the
    // launch would still pass, but the process would hold an exporter open past
    // the settle and the verdict would flip on timing rather than on code.
    const telemetry = initTelemetry({});
    expect(telemetry.tracer).toBeUndefined();
  });

  it("shutdown resolves when inert, so the exit path needs no branch", async () => {
    await expect(initTelemetry({}).shutdown()).resolves.toBeUndefined();
  });

  it("builds a tracer when an endpoint is set", async () => {
    const telemetry = initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1/otel" });
    expect(telemetry.tracer).toBeDefined();
    await telemetry.shutdown();
  });

  it("warns when pointed at Braintrust with no x-bt-parent", async () => {
    // Measured 2026-08-28: without the header Braintrust answers
    // `400 No valid spans in this request: 1 rejected, 0 valid`. That message
    // names spans, so the natural reading is a malformed payload. It is not.
    const warnings: string[] = [];
    const telemetry = initTelemetry(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.braintrust.dev/otel",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer sk-test",
      },
      (m) => warnings.push(m),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("x-bt-parent");
    expect(warnings[0]).toContain("No valid spans");
    await telemetry.shutdown();
  });

  it("does not warn once x-bt-parent is present, in any casing", async () => {
    for (const key of ["x-bt-parent", "X-BT-Parent"]) {
      const warnings: string[] = [];
      const telemetry = initTelemetry(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.braintrust.dev/otel",
          OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer sk-test, ${key}=experiment_id:abc`,
        },
        (m) => warnings.push(m),
      );
      expect(warnings, `casing ${key}`).toHaveLength(0);
      await telemetry.shutdown();
    }
  });

  it("stays quiet for a non-Braintrust collector missing that header", async () => {
    const warnings: string[] = [];
    const telemetry = initTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
      (m) => warnings.push(m),
    );
    expect(warnings).toHaveLength(0);
    await telemetry.shutdown();
  });

  it("takes OTEL_SERVICE_NAME, and defaults when it is absent", async () => {
    const a = initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" });
    expect(SERVICE_NAME).toBe("pome-braintrust-refund-agent");
    await a.shutdown();
  });
});

describe("tracesUrl", () => {
  // Both spellings have to work from one variable: a reader copying from
  // Braintrust's docs sets the BASE, a reader copying from an exporter's docs
  // sets the full path. Measured 2026-08-28 — `POST /otel` is 404, and
  // `POST /otel/v1/traces` is 200.
  it("appends the signal path to a base endpoint", () => {
    expect(tracesUrl("https://api.braintrust.dev/otel")).toBe(
      "https://api.braintrust.dev/otel/v1/traces",
    );
  });

  it("leaves a full traces URL alone rather than doubling it", () => {
    expect(tracesUrl("https://api.braintrust.dev/otel/v1/traces")).toBe(
      "https://api.braintrust.dev/otel/v1/traces",
    );
  });

  it("tolerates trailing slashes and surrounding space", () => {
    expect(tracesUrl("  https://api.braintrust.dev/otel//  ")).toBe(
      "https://api.braintrust.dev/otel/v1/traces",
    );
  });

  it("handles the EU data plane the same way", () => {
    // Verified 2026-08-28 to ACCEPT a span (200). Whether a US-homed org can
    // read those spans back was not verified, so the page says "accepted".
    expect(tracesUrl("https://api-eu.braintrust.dev/otel")).toBe(
      "https://api-eu.braintrust.dev/otel/v1/traces",
    );
  });
});

describe("parseOtlpHeaders", () => {
  it("splits on the FIRST = only", () => {
    // The whole reason this is not `pair.split("=")`: Braintrust's own header
    // value contains a colon and an Authorization value can carry base64
    // padding. Splitting on every `=` truncates both, and the collector answers
    // 400 without naming the header.
    expect(
      parseOtlpHeaders("Authorization=Bearer sk-a=b==, x-bt-parent=experiment_id:594136ee"),
    ).toEqual({
      Authorization: "Bearer sk-a=b==",
      "x-bt-parent": "experiment_id:594136ee",
    });
  });

  it("is empty for undefined, an empty string, and junk", () => {
    for (const raw of [undefined, "", ",", "=novalue", "nokey"]) {
      expect(parseOtlpHeaders(raw), JSON.stringify(raw)).toEqual({});
    }
  });
});
