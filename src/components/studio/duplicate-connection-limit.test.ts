import { describe, expect, it } from "vitest";
import { STUDIO_MAX_EDGES, type StudioGraph } from "@/lib/studio/contracts";
import { createStudioNode } from "@/lib/studio/templates";
import { duplicateGraphNodes } from "./state";

function baseGraph(edgesBeforeInternal: number): StudioGraph {
  const nodes = [
    createStudioNode("prompt", "A", 0, 0),
    createStudioNode("image", "B", 300, 0),
    createStudioNode("output", "C", 600, 0),
    createStudioNode("note", "X", 0, 200),
    createStudioNode("note", "Y", 300, 200),
  ];
  const edges = [] as StudioGraph["edges"];
  // Filler edges to approach the global connection limit without involving A/B/C
  for (let i = 0; i < edgesBeforeInternal; i++) {
    edges.push({
      id: `f${i}`,
      source: "X",
      sourcePort: "p",
      target: "Y",
      targetPort: "p",
      order: i,
    });
  }
  // Internal edges among the selected subgraph (A,B,C)
  edges.push(
    {
      id: "ab",
      source: "A",
      sourcePort: "text",
      target: "B",
      targetPort: "prompt",
      order: 0,
    },
    {
      id: "bc",
      source: "B",
      sourcePort: "image",
      target: "C",
      targetPort: "input",
      order: 1,
    },
    {
      id: "ac",
      source: "A",
      sourcePort: "text",
      target: "C",
      targetPort: "input",
      order: 2,
    },
  );
  return { schemaVersion: 1, nodes, edges };
}

describe("duplicateGraphNodes enforces connection limit", () => {
  it("throws before any mutation when duplicating would exceed the global connection limit", () => {
    // Initial edges total equals the limit; duplicating A,B,C would add 3 more internal edges.
    const filler = STUDIO_MAX_EDGES - 3; // plus 3 internal = exactly at the limit pre-duplication
    const original = baseGraph(filler);
    let seq = 0;
    const makeId = () => `copy-${++seq}`;

    expect(() => duplicateGraphNodes(original, ["A", "B", "C"], makeId)).toThrow(
      `${STUDIO_MAX_EDGES} connections`,
    );
    // The original graph must remain unchanged
    expect(original.nodes).toHaveLength(5);
    expect(original.edges).toHaveLength(STUDIO_MAX_EDGES);
  });

  it("allows duplication when the resulting total connections equals the limit", () => {
    // Start 3 under the limit; duplication adds exactly 3 internal edges to hit the cap.
    const filler = STUDIO_MAX_EDGES - 6; // +3 internal = MAX-3 before, then +3 duplicated = MAX
    const original = baseGraph(filler);
    let seq = 0;
    const makeId = () => `copy-${++seq}`;

    const changed = duplicateGraphNodes(original, ["A", "B", "C"], makeId);
    expect(changed.nodes).toHaveLength(8); // +3 duplicated nodes
    expect(changed.edges).toHaveLength(STUDIO_MAX_EDGES);

    // The last three edges are the duplicated internal edges A->B, B->C, A->C
    const last3 = changed.edges.slice(-3);
    expect(last3.map((e) => [e.source, e.target])).toEqual([
      ["copy-1", "copy-2"],
      ["copy-2", "copy-3"],
      ["copy-1", "copy-3"],
    ]);
  });
});
