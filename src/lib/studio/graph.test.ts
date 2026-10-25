import { describe, expect, it } from "vitest";
import {
  studioGraphSchema,
  type StudioGraph,
  type StudioAsset,
} from "./contracts";
import {
  connectionIssue,
  effectivePrompt,
  executionIdentity,
  getNodePorts,
  hasFreshStudioResult,
  planExecution,
  switchNodeCapability,
  validateGraph,
  type GraphCapability,
} from "./graph";
import { createStudioTemplate, createStudioNode } from "./templates";
const caps: GraphCapability[] = [
  {
    id: "demo-image",
    schemaVersion: 1,
    mediaKind: "image",
    available: true,
    maxOutputs: 4,
    inputRoles: [
      {
        portId: "reference",
        role: "reference",
        mediaKind: "image",
        required: false,
        maxConnections: 4,
      },
    ],
    parameters: [
      { key: "outputCount", type: "number", min: 1, max: 4, default: 1 },
      {
        key: "aspectRatio",
        type: "select",
        default: "16:9",
        options: ["16:9", "1:1"],
      },
    ],
  },
  {
    id: "demo-video",
    schemaVersion: 1,
    mediaKind: "video",
    available: true,
    maxOutputs: 1,
    inputRoles: [
      {
        portId: "start",
        role: "start_frame",
        mediaKind: "image",
        required: true,
        maxConnections: 1,
      },
    ],
    parameters: [],
  },
];
const flow = () => createStudioTemplate("image-to-video", caps);
const scope = { mode: "flow" as const, regenerate: false };
const result: StudioAsset = {
  id: "asset-one",
  filename: "sample.png",
  byteCount: 100,
  contentSha256: "a".repeat(64),
  mediaType: "image/png",
  demo: true,
};

describe("Studio graph and execution planning", () => {
  it("round-trips graph configuration, prompt line breaks and ordered connections", () => {
    const graph = flow();
    graph.nodes[0].config.prompt = "First line\n  indented second line";
    expect(studioGraphSchema.parse(JSON.parse(JSON.stringify(graph)))).toEqual(
      graph,
    );
    expect(validateGraph(graph, caps)).toEqual([]);
    expect(planExecution(graph, scope, caps).nodeIds).toEqual([
      "prompt",
      "image",
      "video",
      "output",
    ]);
  });
  it("rejects cycles, self connections, missing ports and incompatible collections", () => {
    const graph = flow();
    expect(
      connectionIssue(
        graph,
        {
          id: "cycle",
          source: "video",
          sourcePort: "video",
          target: "image",
          targetPort: "reference",
          order: 8,
        },
        caps,
      )?.code,
    ).toBe("incompatible_port");
    const second = createStudioNode("image", "second", 0, 0, caps);
    graph.nodes.push(second);
    graph.edges.push({
      id: "forward",
      source: "image",
      sourcePort: "selected",
      target: "second",
      targetPort: "reference",
      order: 9,
    });
    expect(
      connectionIssue(
        graph,
        {
          id: "back",
          source: "second",
          sourcePort: "selected",
          target: "image",
          targetPort: "reference",
          order: 10,
        },
        caps,
      )?.code,
    ).toBe("cycle");
    expect(
      connectionIssue(
        graph,
        {
          id: "self",
          source: "image",
          sourcePort: "selected",
          target: "image",
          targetPort: "reference",
          order: 10,
        },
        caps,
      )?.code,
    ).toBe("self_connection");
    expect(
      connectionIssue(
        graph,
        {
          id: "bad",
          source: "image",
          sourcePort: "images",
          target: "video",
          targetPort: "start",
          order: 10,
        },
        caps,
      )?.code,
    ).toBe("incompatible_port");
    expect(
      connectionIssue(
        graph,
        {
          id: "gone",
          source: "image",
          sourcePort: "absent",
          target: "video",
          targetPort: "start",
          order: 10,
        },
        caps,
      )?.code,
    ).toBe("missing_port");
  });
  it("rejects excess single-value connections and exact duplicate edges", () => {
    const graph = flow();
    graph.nodes.push({
      ...createStudioNode("prompt", "other", 0, 0),
      config: { parameters: {}, prompt: "Other" },
    });
    expect(
      connectionIssue(
        graph,
        {
          id: "extra",
          source: "other",
          sourcePort: "text",
          target: "image",
          targetPort: "prompt",
          order: 9,
        },
        caps,
      )?.code,
    ).toBe("single_input");
    expect(
      connectionIssue(graph, { ...graph.edges[0], id: "duplicate" }, caps)
        ?.code,
    ).toBe("duplicate_connection");
  });
  it("uses connected primary text plus visible local instruction exactly once", () => {
    const graph = flow();
    graph.nodes[0].config.prompt = "Connected\nPrompt";
    graph.nodes[1].config.prompt = "Unused local";
    graph.nodes[1].config.instruction = "Append here";
    expect(effectivePrompt(graph, "image")).toBe(
      "Connected\nPrompt\n\nAppend here",
    );
    const before = executionIdentity(graph, "image");
    graph.nodes[1].config.prompt = "Changed unused";
    expect(executionIdentity(graph, "image")).toBe(before);
  });
  it("retains freshness through dragging/title changes and invalidates only affected downstream branches", () => {
    const graph = createStudioTemplate("two-directions", caps);
    const before = Object.fromEntries(
      graph.nodes.map((n) => [n.id, executionIdentity(graph, n.id)]),
    );
    graph.nodes.forEach((n) => {
      n.position.x += 300;
      n.title += " renamed";
    });
    for (const node of graph.nodes)
      expect(executionIdentity(graph, node.id)).toBe(before[node.id]);
    graph.nodes.find((n) => n.id === "image")!.config.instruction =
      "Changed direction";
    expect(executionIdentity(graph, "video")).not.toBe(before.video);
    expect(executionIdentity(graph, "video-b")).toBe(before["video-b"]);
  });
  it("selection changes downstream identity but does not regenerate the source image", () => {
    const graph = flow();
    const imageKey = executionIdentity(graph, "image");
    const videoKey = executionIdentity(graph, "video");
    graph.nodes[1].config.selectedOutputId = "variation-two";
    expect(executionIdentity(graph, "image")).toBe(imageKey);
    expect(executionIdentity(graph, "video")).not.toBe(videoKey);
  });
  it("selection does not stale a collection consumer that still receives every output", () => {
    const graph = flow();
    graph.nodes = graph.nodes.filter((n) => n.id !== "video");
    graph.edges = graph.edges.filter(
      (e) => e.source !== "video" && e.target !== "video",
    );
    const key = executionIdentity(graph, "output");
    graph.nodes[1].config.selectedOutputId = "variation-two";
    expect(executionIdentity(graph, "output")).toBe(key);
  });
  it("refuses multiple variations feeding a single input without an exact fresh selection", () => {
    const graph = flow();
    graph.nodes[1].config.parameters.outputCount = 2;
    expect(
      planExecution(graph, scope, caps).issues.some(
        (e) => e.code === "output_selection_required",
      ),
    ).toBe(true);
    const prior = {
      image: {
        configurationHash: executionIdentity(graph, "image"),
        outputAssets: [result, { ...result, id: "asset-two" }],
      },
    };
    graph.nodes[1].config.selectedOutputId = "asset-two";
    expect(planExecution(graph, scope, caps, prior).issues).toEqual([]);
    expect(
      planExecution(
        graph,
        { ...scope, regenerate: true },
        caps,
        prior,
      ).issues.some((e) => e.code === "output_selection_required"),
    ).toBe(true);
  });
  it("run node requires ready upstream generation while run-to-here plans its dependencies", () => {
    const graph = flow();
    const selected = {
      mode: "node" as const,
      nodeId: "video",
      regenerate: false,
    };
    expect(
      planExecution(graph, selected, caps).issues.some(
        (e) => e.code === "upstream_required",
      ),
    ).toBe(true);
    expect(
      planExecution(graph, { ...selected, mode: "to-here" }, caps).nodeIds,
    ).toEqual(["prompt", "image", "video"]);
    expect(
      planExecution(graph, selected, caps, {
        image: {
          configurationHash: executionIdentity(graph, "image"),
          outputAssets: [result],
        },
      }).issues,
    ).toEqual([]);
  });
  it("reuses matching success, and deliberate regeneration creates work again", () => {
    const graph = flow();
    const prior = {
      image: {
        configurationHash: executionIdentity(graph, "image"),
        outputAssets: [result],
        runId: "previous",
      },
    };
    expect(planExecution(graph, scope, caps, prior).reusedNodeIds).toContain(
      "image",
    );
    expect(
      planExecution(
        graph,
        { mode: "node", nodeId: "image", regenerate: true },
        caps,
        prior,
      ).reusedNodeIds,
    ).toEqual([]);
    graph.nodes[0].config.prompt = "New prompt";
    expect(planExecution(graph, scope, caps, prior).reusedNodeIds).toEqual([]);
  });
  it("does not reuse downstream video after an unchanged creative request generates a new image", () => {
    const graph = flow();
    const previous = {
      image: {
        configurationHash: executionIdentity(graph, "image"),
        inputAssets: [],
        outputAssets: [result],
      },
      video: {
        configurationHash: executionIdentity(graph, "video"),
        inputAssets: [result],
        outputAssets: [
          { ...result, id: "video-result", mediaType: "video/mp4" },
        ],
      },
    };
    expect(hasFreshStudioResult(graph, "video", previous)).toBe(true);
    previous.image.outputAssets = [
      { ...result, id: "new-generation", contentSha256: "b".repeat(64) },
    ];
    expect(hasFreshStudioResult(graph, "video", previous)).toBe(false);
    expect(planExecution(graph, scope, caps, previous).reusedNodeIds).toEqual([
      "image",
    ]);
  });
  it("model switch retains compatible parameters and identifies incompatible settings", () => {
    const node = createStudioNode("image", "one", 0, 0, caps);
    node.config.parameters = { aspectRatio: "1:1", seed: 42, outputCount: 3 };
    const switched = switchNodeCapability(node, {
      ...caps[0],
      parameters: [
        {
          key: "aspectRatio",
          type: "select",
          options: ["1:1", "16:9"],
          default: "16:9",
        },
        { key: "outputCount", type: "number", min: 1, max: 1, default: 1 },
      ],
    });
    expect(switched.node.config.parameters).toEqual({
      aspectRatio: "1:1",
      outputCount: 1,
    });
    expect(switched.changes).toEqual([
      "outputCount changed to 1.",
      "seed is not supported and was removed.",
    ]);
  });
  it("validates missing inputs, disabled dependencies and unavailable models before work", () => {
    const graph = flow();
    graph.nodes[0].config.prompt = "";
    graph.nodes[1].enabled = false;
    const issues = planExecution(
      graph,
      scope,
      caps.map((c) => ({
        ...c,
        available: false,
        unavailableReason: "Connect Google in Settings.",
      })),
    ).issues;
    expect(issues.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        "missing_prompt",
        "disabled_dependency",
        "provider_unavailable",
      ]),
    );
  });
  it("asset ports reflect actual declared media type and gallery explicitly accepts collections", () => {
    const node = createStudioNode("asset", "asset", 0, 0);
    node.config.assetMediaType = "video/mp4";
    expect(getNodePorts(node, caps)[0].type).toBe("video");
    expect(
      getNodePorts(createStudioNode("output", "out", 0, 0), caps)[0].accepts,
    ).toContain("images");
  });
  it("handles a representative 50-node DAG without recursive cycle overflow", () => {
    const graph: StudioGraph = {
      schemaVersion: 1,
      nodes: Array.from({ length: 50 }, (_, i) => ({
        ...createStudioNode("image", `n${i}`, i * 300, 0, caps),
        config: {
          capabilityId: "demo-image",
          prompt: "A sample",
          parameters: {},
        },
      })),
      edges: Array.from({ length: 49 }, (_, i) => ({
        id: `e${i}`,
        source: `n${i}`,
        sourcePort: "selected",
        target: `n${i + 1}`,
        targetPort: "reference",
        order: 0,
      })),
    };
    expect(planExecution(graph, scope, caps).nodeIds).toHaveLength(50);
    expect(planExecution(graph, scope, caps).issues).toEqual([]);
  });
  it("draft edits cannot mutate a serialized run snapshot", () => {
    const draft = flow();
    const snapshot = studioGraphSchema.parse(JSON.parse(JSON.stringify(draft)));
    draft.nodes[0].config.prompt = "Changed after admission";
    draft.nodes.splice(1, 1);
    expect(snapshot.nodes).toHaveLength(4);
    expect(snapshot.nodes[0].config.prompt).not.toBe(
      draft.nodes[0].config.prompt,
    );
  });
});
