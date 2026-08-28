// SPDX-License-Identifier: Apache-2.0
//
// The framework half. Everything here is about LangSmith's own mechanics, and
// every case is one that would otherwise be discovered by spending sandbox quota.

import { describe, expect, it } from "vitest";

import { DATASET } from "../src/dataset.js";
import {
  DATASET_BASE_NAME,
  datasetName,
  ensureDataset,
  missingUploads,
  requireLangSmithKey,
  summarizeFeedback,
} from "../src/langsmith.js";
import type { DatasetStore } from "../src/langsmith.js";

describe("datasetName", () => {
  it("is the base name plus a short digest of the row set", () => {
    expect(datasetName(DATASET)).toMatch(new RegExp(`^${DATASET_BASE_NAME}-[0-9a-f]{8}$`));
  });

  it("is stable across calls, so a second run reuses the same dataset", () => {
    expect(datasetName(DATASET)).toBe(datasetName(DATASET));
  });

  // THE STALE-DATASET CASE, and it is this platform's own. `evaluate()` reads its
  // examples out of LangSmith rather than out of this array, so a reader who adds
  // a world and re-runs would otherwise evaluate the OLD six rows and be shown a
  // six-row summary that looks entirely healthy. Forking the name on a row-set
  // change makes that impossible instead of unlikely.
  it("forks when the row set changes, so an edited dataset cannot be silently reused", () => {
    const extra = [...DATASET, { ...DATASET[0]!, inputs: { world: "new-world", policy: "retry-on-5xx" as const } }];

    expect(datasetName(extra)).not.toBe(datasetName(DATASET));
  });

  it("does not fork on row ORDER, which is not part of the row set", () => {
    expect(datasetName([...DATASET].reverse())).toBe(datasetName(DATASET));
  });
});

describe("missingUploads", () => {
  it("is empty when LangSmith already holds every row", () => {
    const existing = DATASET.map((row) => ({ inputs: { ...row.inputs } }));

    expect(missingUploads(existing, DATASET, "ds_1")).toEqual([]);
  });

  // An interrupted first upload is the only way to reach a half-filled dataset
  // once the name carries the row-set digest — and it is reachable, because a
  // reader hits Ctrl-C. Left alone it is permanent: the name matches, so the
  // dataset is reused forever with rows missing.
  it("names exactly the rows an interrupted upload left behind", () => {
    const existing = DATASET.slice(0, 2).map((row) => ({ inputs: { ...row.inputs } }));

    const missing = missingUploads(existing, DATASET, "ds_1");

    expect(missing).toHaveLength(DATASET.length - 2);
    expect(missing[0]).toMatchObject({ dataset_id: "ds_1", inputs: DATASET[2]!.inputs });
  });

  it("carries each row's metadata up with it", () => {
    expect(missingUploads([], DATASET, "ds_1")[0]?.metadata).toEqual(DATASET[0]!.metadata);
  });
});

describe("ensureDataset", () => {
  function stubStore(existingRows: Array<{ inputs: Record<string, unknown> }> | null) {
    const calls: string[] = [];
    const uploaded: unknown[][] = [];
    const store: DatasetStore = {
      async hasDataset() {
        calls.push("hasDataset");
        return existingRows !== null;
      },
      async readDataset() {
        calls.push("readDataset");
        return { id: "ds_existing" };
      },
      async createDataset() {
        calls.push("createDataset");
        return { id: "ds_new" };
      },
      async *listExamples() {
        calls.push("listExamples");
        yield* existingRows ?? [];
      },
      async createExamples(uploads) {
        calls.push("createExamples");
        uploaded.push([...uploads]);
        return uploads;
      },
    };
    return { store, calls, uploaded };
  }

  it("creates the dataset and uploads every row the first time", async () => {
    const { store, calls, uploaded } = stubStore(null);

    const result = await ensureDataset({ client: store, name: "ds", rows: DATASET });

    expect(result).toMatchObject({ datasetId: "ds_new", created: true, uploaded: DATASET.length });
    expect(calls).toContain("createDataset");
    expect(uploaded[0]).toHaveLength(DATASET.length);
  });

  it("reuses an existing dataset and uploads nothing when it already holds the rows", async () => {
    const { store, calls } = stubStore(DATASET.map((row) => ({ inputs: { ...row.inputs } })));

    const result = await ensureDataset({ client: store, name: "ds", rows: DATASET });

    expect(result).toMatchObject({ datasetId: "ds_existing", created: false, uploaded: 0 });
    expect(calls).not.toContain("createExamples");
  });

  it("tops up an interrupted upload rather than reusing a half-filled dataset", async () => {
    const { store, uploaded } = stubStore(DATASET.slice(0, 2).map((row) => ({ inputs: { ...row.inputs } })));

    const result = await ensureDataset({ client: store, name: "ds", rows: DATASET });

    expect(result.uploaded).toBe(DATASET.length - 2);
    expect(uploaded[0]).toHaveLength(DATASET.length - 2);
  });
});

describe("requireLangSmithKey", () => {
  // Unlike Braintrust's `Eval()`, `evaluate()` has no local-only mode: it calls
  // `client.createProject()` before the first prediction, so there is no run
  // without an account. Naming that in one sentence beats a bare 401 from
  // api.smith.langchain.com.
  it("names the missing credential", () => {
    expect(requireLangSmithKey({})).toMatch(/LANGSMITH_API_KEY/);
  });

  it("accepts LANGSMITH_API_KEY", () => {
    expect(requireLangSmithKey({ LANGSMITH_API_KEY: "lsv2_pt_x" })).toBeNull();
  });

  // The legacy name is not a courtesy: `getLangSmithEnvironmentVariable("API_KEY")`
  // reads `LANGSMITH_API_KEY || LANGCHAIN_API_KEY`, so an environment carrying
  // only the LANGCHAIN_ name is one the SDK works in. Refusing it would refuse a
  // working setup.
  it("accepts the legacy LANGCHAIN_API_KEY the SDK still reads", () => {
    expect(requireLangSmithKey({ LANGCHAIN_API_KEY: "ls__x" })).toBeNull();
  });

  it("treats a blank key as absent", () => {
    expect(requireLangSmithKey({ LANGSMITH_API_KEY: "   " })).toMatch(/LANGSMITH_API_KEY/);
  });
});

describe("summarizeFeedback", () => {
  const rows = [
    {
      evaluationResults: {
        results: [
          { key: "pome/refund-exists", score: 1 },
          { key: "pome/refund-count-is-one", score: 0 },
          { key: "pome/charge-succeeded", score: 1 },
          { key: "pome/checked-before-retrying", value: "advisory" },
        ],
      },
    },
    {
      evaluationResults: {
        results: [
          { key: "pome/refund-exists", score: 1 },
          { key: "pome/refund-count-is-one", score: 1 },
          { key: "pome/charge-succeeded", score: null },
          { key: "pome/checked-before-retrying", value: "abstained" },
        ],
      },
    },
  ];

  it("averages each numeric key over the rows that answered", () => {
    const summary = summarizeFeedback(rows);

    expect(summary).toContainEqual(
      expect.objectContaining({ key: "pome/refund-count-is-one", kind: "numeric", mean: 0.5, counted: 2 }),
    );
  });

  // A null is not a zero. LangSmith leaves it out of the key's aggregate and so
  // does this, or a criterion nobody could evaluate would read as a failure the
  // twin never observed — and the row count would hide that it happened.
  it("leaves a null out of the mean and says how many rows it dropped", () => {
    expect(summarizeFeedback(rows)).toContainEqual(
      expect.objectContaining({ key: "pome/charge-succeeded", mean: 1, counted: 1, unanswered: 1 }),
    );
  });

  it("tallies a categorical key by value instead of averaging it", () => {
    expect(summarizeFeedback(rows)).toContainEqual({
      key: "pome/checked-before-retrying",
      kind: "categorical",
      values: { advisory: 1, abstained: 1 },
    });
  });

  it("has nothing to say about an eval that produced no feedback", () => {
    expect(summarizeFeedback([])).toEqual([]);
    expect(summarizeFeedback([{ evaluationResults: { results: [] } }])).toEqual([]);
  });
});
