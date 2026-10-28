import { describe, expect, it } from "vitest";
import { emptyStudioGraph, studioGraphSchema, type StudioGraph } from "@/lib/studio/contracts";
import { createStudioNode } from "@/lib/studio/templates";
import { duplicateGraphNodes } from "./state";

function fullyConnectedRefsToGalleries(): StudioGraph {
  const graph: StudioGraph = {
    ...emptyStudioGraph(),
    nodes: [],
    edges: [],
  };
  // 9 references (assets) and 9 output galleries
  for (let i = 1; i <= 9; i++)
    graph.nodes.push(createStudioNode("asset", `ref-${i}`, i * 160, 0));
  for (let j = 1; j <= 9; j++)
    graph.nodes.push(createStudioNode("output", `out-${j}`, j * 160, 200));
  // Connect every reference to every gallery (9 x 9 = 81)
  for (let i = 1; i <= 9; i++)
    for (let j = 1; j <= 9; j++)
      graph.edges.push({
        id: `e-${i}-${j}`,
        source: `ref-${i}`,
        sourcePort: "image",
        target: `out-${j}`,
        targetPort: "media",
        order: j - 1,
      });
  return graph;
}

function selectionAll18(): string[] {
  return [
    ...Array.from({ length: 9 }, (_, i) => `ref-${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `out-${i + 1}`),
  ];
}

describe("duplicateGraphNodes edge-cap limit", () => {
  it("accepts a valid duplicate exactly up to 160 connections", () => {
    const original = fullyConnectedRefsToGalleries(); // 18 nodes, 81 edges
    // Control: schema shape is valid (semantic requirements checked elsewhere)
    expect(studioGraphSchema.safeParse(original).success).toBe(true);

    // Remove one edge to hit the 160-connection limit after duplication
    original.edges = original.edges.filter((e) => e.id !== "e-1-1");
    expect(original.edges).toHaveLength(80);

    let nextId = 0;
    const result = duplicateGraphNodes(original, selectionAll18(), () => `copy-${++nextId}`);

    expect(result.nodes).toHaveLength(36);
    expect(result.edges).toHaveLength(160);

    // New nodes are offset and independent copies
    const originalLen = original.nodes.length;
    for (const id of selectionAll18()) {
      const idx = original.nodes.findIndex((n) => n.id === id);
      const before = original.nodes[idx]!;
      const after = result.nodes[originalLen + idx]!;
      // ID mapping is sequential per original order
      expect(after.id).toMatch(/^copy-\d+$/);
      expect(after.position).toEqual({ x: before.position.x + 48, y: before.position.y + 48 });
      // configs are deep-copied
      (after.config as { parameters: Record<string, unknown> }).parameters.probe = 1;
      expect(before.config.parameters).toEqual({});
    }

    // Only internal edges were copied; mapping preserves endpoints within the duplicate set
    const copied = result.edges.slice(original.edges.length);
    expect(copied.every((e) => e.source.startsWith("copy-") && e.target.startsWith("copy-"))).toBe(
      true,
    );
  });

  it("rejects creating more than 160 connections from an 81-edge selection without mutating state", () => {
    const original = fullyConnectedRefsToGalleries(); // 18 nodes, 81 edges
    const snapshot = JSON.stringify(original);
    let allocations = 0;
    const makeId = () => {
      allocations++;
      return `id-${allocations}`;
    };
    expect(() => duplicateGraphNodes(original, selectionAll18(), makeId)).toThrow(/160/);
    // No IDs should be allocated and the input graph must remain unchanged on failure
    expect(allocations).toBe(0);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
