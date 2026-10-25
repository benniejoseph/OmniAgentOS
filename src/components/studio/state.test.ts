import { describe, expect, it } from "vitest";
import { emptyStudioGraph, type StudioGraph } from "@/lib/studio/contracts";
import { createStudioNode } from "@/lib/studio/templates";
import {
  duplicateGraphNodes,
  enrichStudioAsset,
  graphHistoryReducer,
  initialGraphHistory,
  mergeRunEvents,
  readableModelChanges,
  readPendingSubmission,
  removeGraphElements,
} from "./state";

function graph(): StudioGraph {
  return {
    schemaVersion: 1,
    nodes: [
      createStudioNode("prompt", "prompt", 0, 0),
      createStudioNode("image", "image", 300, 0),
    ],
    edges: [
      {
        id: "e",
        source: "prompt",
        sourcePort: "text",
        target: "image",
        targetPort: "prompt",
        order: 0,
      },
    ],
  };
}
describe("Studio graph editing", () => {
  it("uses inspector labels for model normalization and removed settings", () => {
    expect(
      readableModelChanges(
        [
          "outputCount changed to 1.",
          "imageSize is not supported and was removed.",
          "customSetting is not supported and was removed.",
        ],
        [
          { key: "outputCount", label: "Outputs" },
          { key: "imageSize", label: "Image size" },
        ],
      ),
    ).toEqual([
      "Outputs changed to 1.",
      "Image size is not supported and was removed.",
      "Custom Setting is not supported and was removed.",
    ]);
  });
  it("adds recorded provenance to old previews only from the same asset version", () => {
    const asset = {
      id: "asset-a",
      filename: "result.png",
      mediaType: "image/png",
      byteCount: 4,
      contentSha256: "original",
    };
    expect(
      enrichStudioAsset(asset, [
        { ...asset, metadata: { model: "recorded-model" } },
      ]).metadata,
    ).toEqual({ model: "recorded-model" });
    expect(
      enrichStudioAsset(asset, [
        {
          ...asset,
          contentSha256: "different",
          metadata: { model: "wrong-version" },
        },
      ]),
    ).toBe(asset);
  });
  it("undoes graph changes without changing stored outputs or execution state", () => {
    const original = graph();
    const assets = [{ id: "asset-a" }];
    const run = { status: "running", outputAssets: assets };
    const changed = {
      ...original,
      nodes: original.nodes.slice(0, 1),
      edges: [],
    };
    const state = graphHistoryReducer(initialGraphHistory(original), {
      type: "replace",
      graph: changed,
    });
    expect(graphHistoryReducer(state, { type: "undo" }).graph).toEqual(
      original,
    );
    expect(
      graphHistoryReducer(graphHistoryReducer(state, { type: "undo" }), {
        type: "redo",
      }).graph,
    ).toEqual(changed);
    expect(run).toEqual({
      status: "running",
      outputAssets: [{ id: "asset-a" }],
    });
  });
  it("groups a drag into one history entry", () => {
    const original = graph();
    let state = graphHistoryReducer(initialGraphHistory(original), {
      type: "checkpoint",
    });
    for (let i = 1; i <= 50; i++)
      state = graphHistoryReducer(state, {
        type: "replace",
        record: false,
        graph: {
          ...original,
          nodes: original.nodes.map((n) => ({
            ...n,
            position: { x: i, y: i },
          })),
        },
      });
    expect(state.past).toHaveLength(1);
    expect(graphHistoryReducer(state, { type: "undo" }).graph).toEqual(
      original,
    );
  });
  it("node deletion removes its connections without changing any asset identity", () => {
    const original = graph();
    original.nodes[1].config.selectedOutputId = "asset-kept";
    const changed = removeGraphElements(original, ["prompt"], []);
    expect(changed.edges).toEqual([]);
    expect(changed.nodes[0].config.selectedOutputId).toBe("asset-kept");
    expect(original.nodes).toHaveLength(2);
  });
  it("connection selection can be removed without deleting nodes", () => {
    const original = graph();
    const changed = removeGraphElements(original, [], ["e"]);
    expect(changed.nodes).toEqual(original.nodes);
    expect(changed.edges).toEqual([]);
  });
  it("duplicates only selected nodes and their internal edges with independent configs", () => {
    const original = graph();
    let id = 0;
    const changed = duplicateGraphNodes(
      original,
      ["prompt", "image"],
      () => `copy-${++id}`,
    );
    expect(changed.nodes).toHaveLength(4);
    expect(changed.edges).toHaveLength(2);
    expect(changed.edges[1]).toMatchObject({
      source: "copy-1",
      target: "copy-2",
    });
    changed.nodes[2].config.parameters.sample = 2;
    expect(original.nodes[0].config.parameters).toEqual({});
  });
  it("enforces the node bound before making a partial duplicate", () => {
    const original = {
      ...emptyStudioGraph(),
      nodes: Array.from({ length: 50 }, (_, i) =>
        createStudioNode("note", String(i), i, 0),
      ),
    };
    expect(() => duplicateGraphNodes(original, ["0"], () => "new")).toThrow(
      "50 nodes",
    );
    expect(original.nodes).toHaveLength(50);
  });
  it("merges repeated and out-of-order event reads into an ordered bounded timeline", () => {
    expect(
      mergeRunEvents(
        [
          { seq: 1, message: "one" },
          { seq: 3, message: "three" },
        ],
        [
          { seq: 2, message: "two" },
          { seq: 3, message: "three" },
        ],
      ).map((e) => e.seq),
    ).toEqual([1, 2, 3]);
    expect(
      mergeRunEvents(
        [],
        Array.from({ length: 250 }, (_, seq) => ({ seq })),
      ),
    ).toHaveLength(200);
  });
  it("recovers the exact paid submission identity across refresh without permitting a different flow", () => {
    const saved = {
      path: "/api/studio/flows/flow-a/runs",
      key: "unchanged-key",
      body: {
        quoteId: "quote-a",
        scope: { mode: "flow", regenerate: false },
        maxCostUsd: 2,
        allowUnknownCost: false,
        maxGenerations: 1,
      },
    };
    expect(
      readPendingSubmission(JSON.parse(JSON.stringify(saved)), "flow-a"),
    ).toEqual(saved);
    expect(readPendingSubmission(saved, "flow-b")).toBeUndefined();
    expect(
      readPendingSubmission(
        { ...saved, body: { ...saved.body, maxGenerations: NaN } },
        "flow-a",
      ),
    ).toBeUndefined();
    expect(
      readPendingSubmission(
        { ...saved, path: "https://other.example/runs" },
        "flow-a",
      ),
    ).toBeUndefined();
  });
});
