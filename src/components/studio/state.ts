import {
  STUDIO_MAX_NODES,
  emptyStudioGraph,
  studioCanonicalJson,
  studioScopeSchema,
  type StudioGraph,
  type StudioAsset,
  type StudioNode,
  type StudioNodeType,
  type StudioRun,
  type StudioScope,
} from "@/lib/studio/contracts";

export type GraphHistory = {
  graph: StudioGraph;
  past: StudioGraph[];
  future: StudioGraph[];
};
export type GraphAction =
  | { type: "replace"; graph: StudioGraph; record?: boolean }
  | { type: "reset"; graph: StudioGraph }
  | { type: "checkpoint" }
  | { type: "undo" }
  | { type: "redo" };
const LIMIT = 80;
export function initialGraphHistory(graph = emptyStudioGraph()): GraphHistory {
  return { graph, past: [], future: [] };
}
export function graphHistoryReducer(
  state: GraphHistory,
  action: GraphAction,
): GraphHistory {
  if (action.type === "reset") return initialGraphHistory(action.graph);
  if (action.type === "checkpoint")
    return {
      ...state,
      past: [...state.past, state.graph].slice(-LIMIT),
      future: [],
    };
  if (action.type === "undo") {
    const graph = state.past.at(-1);
    return graph
      ? {
          graph,
          past: state.past.slice(0, -1),
          future: [state.graph, ...state.future].slice(0, LIMIT),
        }
      : state;
  }
  if (action.type === "redo") {
    const graph = state.future[0];
    return graph
      ? {
          graph,
          past: [...state.past, state.graph].slice(-LIMIT),
          future: state.future.slice(1),
        }
      : state;
  }
  if (studioCanonicalJson(state.graph) === studioCanonicalJson(action.graph))
    return state;
  return {
    graph: action.graph,
    past:
      action.record === false
        ? state.past
        : [...state.past, state.graph].slice(-LIMIT),
    future: [],
  };
}
export const nodeLabels: Record<StudioNodeType, string> = {
  prompt: "Prompt",
  asset: "Reference",
  image: "Generate image",
  video: "Generate video",
  output: "Output gallery",
  note: "Note",
};
export function readableModelChanges(
  changes: readonly string[],
  fields: readonly { key: string; label: string }[],
): string[] {
  const labels = new Map(fields.map((field) => [field.key, field.label]));
  return changes.map((change) => {
    const separator = change.indexOf(" ");
    if (separator < 0) return change;
    const key = change.slice(0, separator);
    const label =
      labels.get(key) ||
      key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .replace(/^./, (letter) => letter.toUpperCase());
    return label + change.slice(separator);
  });
}
export const nodeDescriptions: Record<StudioNodeType, string> = {
  prompt: "Write a reusable prompt",
  asset: "Use an uploaded or saved file",
  image: "Create an image or edit a reference",
  video: "Create a video from text or an image",
  output: "Collect and download results",
  note: "Leave instructions on the canvas",
};
export function newStudioNode(
  type: StudioNodeType,
  index: number,
  id: string,
  capabilityId?: string,
): StudioNode {
  return {
    id,
    type,
    title: nodeLabels[type],
    enabled: true,
    position: {
      x: 80 + (index % 4) * 290,
      y: 70 + Math.floor(index / 4) * 200,
    },
    config: {
      parameters: {},
      ...(capabilityId ? { capabilityId } : {}),
      ...(type === "prompt" || type === "note" ? { prompt: "" } : {}),
    },
  };
}
export function removeGraphElements(
  graph: StudioGraph,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): StudioGraph {
  const nodes = new Set(nodeIds),
    edges = new Set(edgeIds);
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !nodes.has(n.id)),
    edges: graph.edges.filter(
      (e) => !edges.has(e.id) && !nodes.has(e.source) && !nodes.has(e.target),
    ),
  };
}
export function duplicateGraphNodes(
  graph: StudioGraph,
  selected: readonly string[],
  makeId: () => string,
): StudioGraph {
  const originals = graph.nodes.filter((n) => selected.includes(n.id));
  if (originals.length + graph.nodes.length > STUDIO_MAX_NODES)
    throw new Error(`A flow supports up to ${STUDIO_MAX_NODES} nodes.`);

  // Enforce a hard cap of 160 total connections after duplication without allocating IDs
  const selectedSet = new Set(originals.map((n) => n.id));
  const internalEdgesToCopy = graph.edges.filter(
    (e) => selectedSet.has(e.source) && selectedSet.has(e.target),
  ).length;
  if (graph.edges.length + internalEdgesToCopy > 160)
    throw new Error("A flow supports up to 160 connections.");

  // Safe to allocate new IDs and build the duplicated subgraph
  const ids = new Map(originals.map((n) => [n.id, makeId()]));
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      ...originals.map((n) => ({
        ...n,
        id: ids.get(n.id)!,
        title: `${n.title} copy`.slice(0, 160),
        position: { x: n.position.x + 48, y: n.position.y + 48 },
        config: { ...n.config, parameters: { ...n.config.parameters } },
      })),
    ],
    edges: [
      ...graph.edges,
      ...graph.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          ...e,
          id: makeId(),
          source: ids.get(e.source)!,
          target: ids.get(e.target)!,
        })),
    ],
  };
}
export function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        "input, textarea, select, [contenteditable=true], [role=textbox]",
      ),
    )
  );
}
export function scopeLabel(scope: StudioScope, node?: StudioNode) {
  return scope.mode === "flow"
    ? "Run flow"
    : scope.regenerate
      ? `Regenerate ${node?.title || "node"}`
      : scope.mode === "to-here"
        ? `Run to ${node?.title || "here"}`
        : `Run ${node?.title || "node"}`;
}
export function newestNodeRun(runs: readonly StudioRun[], nodeId: string) {
  return [...runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((run) => run.nodes.map((node) => ({ run, node })))
    .find(({ node }) => node.nodeId === nodeId && node.outputAssets.length);
}
export function statusLabel(status: string) {
  return (
    (
      {
        persisting: "Saving results",
        uncertain: "Submission unconfirmed",
        submitting: "Submitting",
        succeeded: "Completed",
        partial: "Partially completed",
        blocked: "Blocked",
        canceled: "Canceled",
        moderated: "Stopped by provider",
        running: "Running",
        failed: "Failed",
        queued: "Queued",
      } as Record<string, string>
    )[status] || status
  );
}
export function mergeRunEvents<T extends { seq: number }>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  return [...new Map([...current, ...next].map((e) => [e.seq, e])).values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-200);
}
export function saveFingerprint(name: string, graph: StudioGraph) {
  return studioCanonicalJson({ name, graph });
}
export function durationLabel(start: string, end?: string) {
  const seconds = Math.max(
    0,
    Math.round(
      ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000,
    ),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Enrich an old run snapshot only from the same authorized asset version. */
export function enrichStudioAsset(
  asset: StudioAsset,
  library: readonly StudioAsset[],
): StudioAsset {
  const current = library.find(
    (value) =>
      value.id === asset.id && value.contentSha256 === asset.contentSha256,
  );
  if (!current) return asset;
  return {
    ...asset,
    metadata: current.metadata ?? asset.metadata,
    width: current.width ?? asset.width,
    height: current.height ?? asset.height,
    durationSeconds: current.durationSeconds ?? asset.durationSeconds,
  };
}

export type PendingStudioSubmission = {
  path: string;
  body: {
    quoteId: string;
    scope: StudioScope;
    maxCostUsd: number | null;
    allowUnknownCost: boolean;
    maxGenerations: number;
  };
  key: string;
};
/** A restored receipt can retry only the same flow and request; it cannot become a new generation. */
export function readPendingSubmission(
  value: unknown,
  flowId: string,
): PendingStudioSubmission | undefined {
  if (!value || typeof value !== "object") return undefined;
  const saved = value as Partial<PendingStudioSubmission>,
    body = saved.body;
  if (
    saved.path !== `/api/studio/flows/${encodeURIComponent(flowId)}/runs` ||
    typeof saved.key !== "string" ||
    !saved.key ||
    !body ||
    typeof body.quoteId !== "string" ||
    !body.quoteId ||
    !studioScopeSchema.safeParse(body.scope).success ||
    typeof body.allowUnknownCost !== "boolean" ||
    !Number.isInteger(body.maxGenerations) ||
    body.maxGenerations < 1 ||
    body.maxGenerations > 8 ||
    !(
      body.maxCostUsd === null ||
      (Number.isFinite(body.maxCostUsd) && body.maxCostUsd >= 0)
    )
  )
    return undefined;
  return {
    path: saved.path,
    key: saved.key,
    body: {
      quoteId: body.quoteId,
      scope: { ...body.scope },
      maxCostUsd: body.maxCostUsd,
      allowUnknownCost: body.allowUnknownCost,
      maxGenerations: body.maxGenerations,
    },
  };
}
