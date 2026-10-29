import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  STUDIO_MAX_EDGES,
  STUDIO_MAX_NODES,
  studioGraphSchema,
  type StudioGraph,
} from "@/lib/studio/contracts";
import { validateGraph } from "@/lib/studio/graph";
import { createStudioNode } from "@/lib/studio/templates";
import { errorMessage } from "./client";
import {
  duplicateGraphNodes,
  graphHistoryReducer,
  type GraphAction,
  type GraphHistory,
} from "./state";

/** Synthetic complete bipartite graph: nine image references, nine galleries. */
function fixture(): StudioGraph {
  const references = Array.from({ length: 9 }, (_, index) => ({
    ...createStudioNode("asset", `reference-${index}`, index * 120, -100),
    title: index === 0 ? "R".repeat(158) : `Reference ${index}`,
    config: {
      assetId: `synthetic-asset-${index}`,
      assetMediaType: "image/png",
      assetVersion: `synthetic-version-${index}`,
      selectedOutputId: `synthetic-output-${index}`,
      instruction: `Synthetic reference instruction ${index}`,
      parameters: { seed: index, label: `sample-${index}`, enabled: true },
    },
  }));
  const galleries = Array.from({ length: 9 }, (_, index) => ({
    ...createStudioNode("output", `gallery-${index}`, index * 120, 300),
    config: {
      instruction: `Synthetic gallery instruction ${index}`,
      parameters: { label: `gallery-${index}`, enabled: false },
    },
  }));
  return {
    schemaVersion: 1,
    projectContext: {
      projectId: "synthetic-project",
      profileRevision: 3,
      category: "custom",
      brandName: "Synthetic studio",
      audience: "Test audience",
      contentPillars: ["Synthetic examples"],
      voice: "Clear",
      visualStyle: "Simple",
      guidelines: "Test fixtures only",
      channels: [{ platform: "Test platform", handle: "synthetic-channel" }],
    },
    nodes: [...references, ...galleries],
    edges: references.flatMap((source, sourceIndex) =>
      galleries.map((target, targetIndex) => ({
        id: `edge-${sourceIndex}-${targetIndex}`,
        source: source.id,
        sourcePort: "image",
        target: target.id,
        targetPort: "media",
        order: sourceIndex * 9 + targetIndex,
      })),
    ),
  };
}

function expectValid(graph: StudioGraph) {
  expect(studioGraphSchema.parse(graph)).toStrictEqual(graph);
  expect(validateGraph(graph, [])).toStrictEqual([]);
}

/**
 * Handler-level evidence, NOT a rendered UI test. Execute the existing workspace
 * callbacks, extracted by AST rather than reimplementing their try/catch or
 * dispatch logic. React, DOM, effects, canvas and network are not exercised.
 * Dependencies are explicit; unexpected new free variables fail the test.
 */
function workspaceCallback<T>(name: string, dependencies: Record<string, unknown>): T {
  const path = "src/components/studio/workspace.tsx";
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const callbacks: ts.ArrowFunction[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useCallback"
    ) {
      const callback = node.initializer.arguments[0];
      if (callback && ts.isArrowFunction(callback)) callbacks.push(callback);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callbacks, `one existing ${name} workspace callback`).toHaveLength(1);
  const compiled = ts.transpileModule(
    `const callback = ${callbacks[0].getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  return compileFunction(
    `${compiled}\nreturn callback;`,
    Object.keys(dependencies),
  )(...Object.values(dependencies)) as T;
}

function harness(graph: StudioGraph, selectedNodes = graph.nodes.map((node) => node.id)) {
  const prior = structuredClone(graph);
  prior.nodes[0].title = "Synthetic prior graph";
  const older = structuredClone(prior);
  older.nodes[0].position.x -= 24;
  const future = structuredClone(graph);
  future.nodes[0].title = "Synthetic future graph";
  const later = structuredClone(future);
  later.nodes[0].position.y += 24;
  const state = {
    history: { graph, past: [older, prior], future: [future, later] } as GraphHistory,
    selectedNodes: [...selectedNodes],
    selectedEdges: [graph.edges[0].id, graph.edges.at(-1)!.id],
    storedOutputs: [{ id: "synthetic-stored-output", mediaType: "image/png" }],
    execution: { status: "running", runId: "synthetic-run", completedNodeIds: ["reference-0"] },
  };
  const dispatch = vi.fn((action: GraphAction) => {
    state.history = graphHistoryReducer(state.history, action);
  });
  const setQuote = vi.fn();
  const setIssues = vi.fn();
  const changeGraph = vi.fn(workspaceCallback<(next: StudioGraph, record?: boolean) => void>(
    "changeGraph",
    { readOnly: false, dispatch, setQuote, setIssues },
  ));
  let sequence = 0;
  const makeId = vi.fn(() => `synthetic-copy-${++sequence}`);
  const setNotice = vi.fn();
  const duplicateSelection = workspaceCallback<() => void>("duplicateSelection", {
    readOnly: false,
    graph,
    selectedNodes: state.selectedNodes,
    duplicateGraphNodes,
    crypto: { randomUUID: makeId },
    changeGraph,
    setNotice,
    errorMessage,
  });
  return { state, dispatch, changeGraph, makeId, setNotice, setQuote, setIssues, duplicateSelection };
}

type Harness = ReturnType<typeof harness>;

function expectRejected(h: Harness, before: Harness["state"], originalHistory: GraphHistory) {
  // Soft assertions ensure the baseline also evaluates every rejection invariant.
  expect.soft(h.makeId).not.toHaveBeenCalled();
  expect.soft(h.changeGraph).not.toHaveBeenCalled();
  expect.soft(h.dispatch).not.toHaveBeenCalled();
  expect.soft(h.setQuote).not.toHaveBeenCalled();
  expect.soft(h.setIssues).not.toHaveBeenCalled();
  expect.soft(h.state).toStrictEqual(before);
  expect.soft(h.state.history).toBe(originalHistory);
  expect.soft(h.state.history.graph).toBe(originalHistory.graph);
  expect.soft(h.state.history.past).toBe(originalHistory.past);
  expect.soft(h.state.history.future).toBe(originalHistory.future);
  // Full deep equality includes project fields, all IDs, positions, configs,
  // edge ports/order, both selections and every populated undo/redo entry.
  expect.soft(originalHistory.graph).toStrictEqual(before.history.graph);
  expect.soft(originalHistory.past).toStrictEqual(before.history.past);
  expect.soft(originalHistory.future).toStrictEqual(before.history.future);
}

function expectSuccessfulDuplicate(h: Harness, expectedNodes: number, expectedEdges: number) {
  const before = structuredClone(h.state);
  const original = h.state.history.graph;
  const oldHistory = h.state.history;
  const originals = original.nodes.filter((node) => h.state.selectedNodes.includes(node.id));
  const internal = original.edges.filter((edge) =>
    h.state.selectedNodes.includes(edge.source) && h.state.selectedNodes.includes(edge.target),
  );
  expectValid(original);
  h.duplicateSelection();
  const result = h.state.history.graph;
  expect(h.setNotice).not.toHaveBeenCalled();
  expect(h.changeGraph).toHaveBeenCalledExactlyOnceWith(result);
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "replace", graph: result, record: true });
  expect(h.makeId).toHaveBeenCalledTimes(originals.length + internal.length);
  expect(result.nodes).toHaveLength(expectedNodes);
  expect(result.edges).toHaveLength(expectedEdges);
  expectValid(result);
  expect(original).toStrictEqual(before.history.graph);
  expect(result.nodes.slice(0, original.nodes.length)).toStrictEqual(before.history.graph.nodes);
  expect(result.edges.slice(0, original.edges.length)).toStrictEqual(before.history.graph.edges);
  expect({ ...result, nodes: [], edges: [] }).toStrictEqual({ ...before.history.graph, nodes: [], edges: [] });
  expect(h.state.selectedNodes).toStrictEqual(before.selectedNodes);
  expect(h.state.selectedEdges).toStrictEqual(before.selectedEdges);

  const copies = result.nodes.slice(original.nodes.length);
  const mapping = new Map(originals.map((node, index) => [node.id, copies[index].id]));
  const allIds = [...result.nodes, ...result.edges].map((element) => element.id);
  expect(new Set(allIds).size).toBe(allIds.length);
  copies.forEach((copy, index) => {
    const node = originals[index];
    expect(copy).toStrictEqual({
      ...node,
      id: copy.id,
      title: `${node.title} copy`.slice(0, 160),
      position: { x: node.position.x + 48, y: node.position.y + 48 },
    });
    expect(copy).not.toBe(node);
    expect(copy.position).not.toBe(node.position);
    expect(copy.config).not.toBe(node.config);
    expect(copy.config.parameters).not.toBe(node.config.parameters);
  });
  const copiedEdges = result.edges.slice(original.edges.length);
  expect(copiedEdges).toHaveLength(internal.length);
  copiedEdges.forEach((edge, index) => {
    expect(edge).not.toBe(internal[index]);
    expect(edge).toStrictEqual({
      ...internal[index],
      id: edge.id,
      source: mapping.get(internal[index].source),
      target: mapping.get(internal[index].target),
    });
  });

  const after = structuredClone(result);
  expect(h.state.history.past).toStrictEqual([...before.history.past, before.history.graph]);
  expect(h.state.history.past[0]).toBe(oldHistory.past[0]);
  expect(h.state.history.past[1]).toBe(oldHistory.past[1]);
  expect(h.state.history.past.at(-1)).toBe(original);
  expect(h.state.history.future).toStrictEqual([]);
  expect(oldHistory).toStrictEqual(before.history);
  h.dispatch({ type: "undo" });
  expect(h.state.history).toStrictEqual({ graph: before.history.graph, past: before.history.past, future: [after] });
  h.dispatch({ type: "redo" });
  expect(h.state.history).toStrictEqual({ graph: after, past: [...before.history.past, before.history.graph], future: [] });
  expect(h.dispatch.mock.calls.filter(([action]) => action.type === "replace")).toHaveLength(1);
  expect(h.state.storedOutputs).toStrictEqual(before.storedOutputs);
  expect(h.state.execution).toStrictEqual(before.execution);
  expect(Object.keys(h.state.history).sort()).toStrictEqual(["future", "graph", "past"]);
  expect(h.state.selectedNodes).toStrictEqual(before.selectedNodes);
  expect(h.state.selectedEdges).toStrictEqual(before.selectedEdges);

  copies.forEach((copy) => {
    copy.config.parameters.label = "Changed copy only";
    copy.config.instruction = "Changed copy instruction";
  });
  expect(original).toStrictEqual(before.history.graph);
  expect(h.state.history.past).toStrictEqual([...before.history.past, before.history.graph]);
  return { result, mapping, copiedEdges };
}

describe("duplicate connection limit — helper/reducer and source workspace handlers (not rendered UI)", () => {
  it("control: the shared 18-node/81-edge fixture passes schema and full semantic validation", () => {
    const graph = fixture();
    expect(STUDIO_MAX_EDGES).toBe(160);
    expect(STUDIO_MAX_NODES).toBe(50);
    expect(graph.nodes).toHaveLength(18);
    expect(graph.nodes.filter((node) => node.type === "asset")).toHaveLength(9);
    expect(graph.nodes.filter((node) => node.type === "output")).toHaveLength(9);
    expect(graph.edges).toHaveLength(81);
    expect(new Set(graph.edges.map((edge) => `${edge.source}:${edge.target}`)).size).toBe(81);
    expectValid(graph);
  });

  it("regression: rejects a proposed 36-node/162-edge duplicate before IDs or history replacement", () => {
    const h = harness(fixture());
    const before = structuredClone(h.state);
    const history = h.state.history;
    expectValid(history.graph);
    expect.soft(() => h.changeGraph(duplicateGraphNodes(
      history.graph, h.state.selectedNodes, h.makeId,
    ))).toThrow(/160 connections/i);
    expectRejected(h, before, history);
  });

  it("workspace handler regression: catches the 160-connection error and never reaches changeGraph", () => {
    const h = harness(fixture());
    const before = structuredClone(h.state);
    const history = h.state.history;
    expect(() => h.duplicateSelection()).not.toThrow();
    expect.soft(h.setNotice).toHaveBeenCalledExactlyOnceWith({
      tone: "error", text: expect.stringMatching(/160 connections/i),
    });
    expectRejected(h, before, history);
  });

  it("control: removing one real edge allows exactly 36 nodes/160 connections and one undoable replacement", () => {
    const graph = fixture();
    const removed = graph.edges.pop()!;
    expect(graph.edges).toHaveLength(80);
    const { result, mapping } = expectSuccessfulDuplicate(harness(graph), 36, 160);
    // Both extra connections are real, unique image-to-gallery connections;
    // the schema must retain its 160 bound, not be relaxed to accept the bug.
    const overLimit = {
      ...result,
      edges: [...result.edges, removed, {
        ...removed,
        id: "synthetic-extra-copy-edge",
        source: mapping.get(removed.source)!,
        target: mapping.get(removed.target)!,
      }],
    };
    const parsed = studioGraphSchema.safeParse(overLimit);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "too_big", path: ["edges"], maximum: 160 }),
    ]));
  });

  it("control: eight references and nine galleries copy only 72 internal edges, producing 35 nodes/153 edges", () => {
    const graph = fixture();
    const selected = graph.nodes.filter((node) => node.id !== "reference-8").map((node) => node.id);
    const { result, mapping, copiedEdges } = expectSuccessfulDuplicate(harness(graph, selected), 35, 153);
    expect(copiedEdges).toHaveLength(72);
    expect(mapping.has("reference-8")).toBe(false);
    expect(copiedEdges.every((edge) => [...mapping.values()].includes(edge.source))).toBe(true);
    expect(result.edges.filter((edge) => edge.source === "reference-8")).toStrictEqual(
      graph.edges.filter((edge) => edge.source === "reference-8"),
    );
    expect(result.edges.filter((edge) => edge.source === "reference-8")).toHaveLength(9);
  });

  it.each([
    { notes: 32, selectedCount: 1, label: "50 existing nodes plus one copy" },
    { notes: 15, selectedCount: 18, label: "node rejection precedes simultaneous 162-edge overflow" },
  ])("control: $label rejects before allocation and leaves populated history unchanged", ({ notes, selectedCount }) => {
    const graph = fixture();
    graph.nodes.push(...Array.from({ length: notes }, (_, index) =>
      createStudioNode("note", `synthetic-note-${index}`, -200, index * 40),
    ));
    expectValid(graph);
    const h = harness(graph, graph.nodes.slice(0, selectedCount).map((node) => node.id));
    const before = structuredClone(h.state);
    const history = h.state.history;
    expect(() => h.changeGraph(duplicateGraphNodes(graph, h.state.selectedNodes, h.makeId))).toThrow(/50 nodes/i);
    expectRejected(h, before, history);
    h.duplicateSelection();
    expect(h.setNotice).toHaveBeenCalledExactlyOnceWith({ tone: "error", text: expect.stringMatching(/50 nodes/i) });
    expectRejected(h, before, history);
  });

  it("control: exactly 50 nodes and 160 edges is valid and records only one replacement", () => {
    const graph = fixture();
    graph.edges.pop();
    graph.nodes.push(...Array.from({ length: 7 }, (_, index) => ({
      ...createStudioNode("note", `synthetic-note-${index}`, -200, index * 40),
      enabled: index % 2 === 0,
      config: { prompt: `Synthetic note ${index}`, parameters: { label: `note-${index}` } },
    })));
    expect(graph.nodes).toHaveLength(25);
    expect(graph.edges).toHaveLength(80);
    expectSuccessfulDuplicate(harness(graph), 50, 160);
  });
});
