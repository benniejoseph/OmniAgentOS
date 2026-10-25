"use client";
import { memo, useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useConnection,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Film,
  ImageIcon,
  MessageSquareText,
  StickyNote,
  Files,
  GalleryHorizontalEnd,
} from "lucide-react";
import {
  getNodePorts,
  connectionIssue,
  type GraphCapability,
} from "@/lib/studio/graph";
import {
  type StudioGraph,
  type StudioNode,
  type StudioNodeRun,
  type StudioViewport,
} from "@/lib/studio/contracts";
import { nodeLabels, statusLabel } from "./state";
import styles from "./studio.module.css";

type CardData = {
  node: StudioNode;
  ports: ReturnType<typeof getNodePorts>;
  run?: StudioNodeRun;
  stale?: boolean;
  valid: (connection: Connection) => boolean;
};
type FlowNode = Node<CardData, "studio">;
const icons = {
  prompt: MessageSquareText,
  image: ImageIcon,
  video: Film,
  asset: Files,
  output: GalleryHorizontalEnd,
  note: StickyNote,
};
const StudioCard = memo(function StudioCard({
  data,
  selected,
}: NodeProps<FlowNode>) {
  const connecting = useConnection();
  const Icon = icons[data.node.type];
  return (
    <article
      className={styles.canvasNode}
      data-selected={selected || undefined}
      data-kind={data.node.type}
      aria-label={data.node.title}
    >
      <header>
        <Icon size={16} aria-hidden="true" />
        <strong>{data.node.title}</strong>
      </header>
      <p className={styles.support}>
        {nodeLabels[data.node.type]}
        {!data.node.enabled ? " · Disabled" : ""}
      </p>
      {data.node.config.prompt ? (
        <p className={styles.nodePrompt}>{data.node.config.prompt}</p>
      ) : null}
      {data.run ? (
        <div className={styles.nodeState}>
          <span data-status={data.run.status}>
            {statusLabel(data.run.status)}
          </span>
          {data.stale ? (
            <span className={styles.stale}>Draft changed</span>
          ) : null}
          {data.run.outputAssets.length ? (
            <span>
              {data.run.outputAssets.length} result
              {data.run.outputAssets.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.ports}>
        {data.ports.map((port) => {
          const input = port.direction === "input";
          const compatible =
            connecting.inProgress &&
            connecting.fromNode &&
            connecting.fromHandle &&
            input === (connecting.fromHandle.type === "source")
              ? data.valid(
                  connecting.fromHandle.type === "source"
                    ? {
                        source: connecting.fromNode.id,
                        sourceHandle: connecting.fromHandle.id ?? null,
                        target: data.node.id,
                        targetHandle: port.id,
                      }
                    : {
                        source: data.node.id,
                        sourceHandle: port.id,
                        target: connecting.fromNode.id,
                        targetHandle: connecting.fromHandle.id ?? null,
                      },
                )
              : false;
          return (
            <div
              className={styles.port}
              data-direction={port.direction}
              key={`${port.direction}:${port.id}`}
            >
              <Handle
                type={input ? "target" : "source"}
                position={input ? Position.Left : Position.Right}
                id={port.id}
                className={compatible ? styles.compatibleHandle : undefined}
                aria-label={`${data.node.title}: ${port.label} ${port.direction}`}
              />
              <span>
                {port.label}
                {port.required ? " *" : ""}
              </span>
              <small>{port.type}</small>
            </div>
          );
        })}
      </div>
    </article>
  );
});
const nodeTypes: NodeTypes = { studio: StudioCard };
const MIN_CANVAS_ZOOM = 0.1;
const fitOptions = { padding: 0.2, minZoom: MIN_CANVAS_ZOOM, maxZoom: 1 };
export default function StudioCanvas({
  graph,
  capabilities,
  viewport,
  nodeRuns,
  staleIds,
  selectedNodes,
  selectedEdges,
  onSelection,
  onGraph,
  onCheckpoint,
  onViewport,
  onError,
  readOnly,
}: {
  graph: StudioGraph;
  capabilities: readonly GraphCapability[];
  viewport: StudioViewport;
  nodeRuns: Record<string, StudioNodeRun>;
  staleIds: Set<string>;
  selectedNodes: string[];
  selectedEdges: string[];
  onSelection: (nodes: string[], edges: string[]) => void;
  onGraph: (graph: StudioGraph, record?: boolean) => void;
  onCheckpoint: () => void;
  onViewport: (viewport: StudioViewport) => void;
  onError: (message: string) => void;
  readOnly: boolean;
}) {
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode, Edge>>();
  const edgeFor = useCallback(
    (c: Connection | Edge) => ({
      id: "connecting",
      source: c.source,
      target: c.target,
      sourcePort: c.sourceHandle || "",
      targetPort: c.targetHandle || "",
      order: graph.edges.length,
    }),
    [graph.edges.length],
  );
  const valid = useCallback(
    (c: Connection | Edge) => !connectionIssue(graph, edgeFor(c), capabilities),
    [graph, capabilities, edgeFor],
  );
  const nodes = useMemo<FlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "studio",
        position: node.position,
        selected: selectedNodes.includes(node.id),
        data: {
          node,
          ports: getNodePorts(node, capabilities),
          run: nodeRuns[node.id],
          stale: staleIds.has(node.id),
          valid,
        },
      })),
    [graph.nodes, capabilities, nodeRuns, staleIds, selectedNodes, valid],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        selected: selectedEdges.includes(edge.id),
        markerEnd: { type: MarkerType.ArrowClosed },
        type: "smoothstep",
        label: edge.order ? String(edge.order + 1) : undefined,
      })),
    [graph.edges, selectedEdges],
  );
  const onNodesChange: OnNodesChange<FlowNode> = useCallback(
    (changes) => {
      const selection = changes.filter((change) => change.type === "select");
      if (selection.length) {
        const next = new Set(selectedNodes);
        for (const change of selection) {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        const ids = [...next];
        if (
          ids.length !== selectedNodes.length ||
          ids.some((id) => !selectedNodes.includes(id))
        )
          onSelection(ids, selectedEdges);
      }
      if (readOnly) return;
      const positions = new Map(
        changes.flatMap((change) =>
          change.type === "position" && change.position
            ? [[change.id, change.position] as const]
            : [],
        ),
      );
      if (positions.size)
        onGraph(
          {
            ...graph,
            nodes: graph.nodes.map((node) =>
              positions.get(node.id)
                ? { ...node, position: positions.get(node.id)! }
                : node,
            ),
          },
          false,
        );
    },
    [graph, onGraph, readOnly, selectedNodes, selectedEdges, onSelection],
  );
  const onEdgesChange: OnEdgesChange<Edge> = useCallback(
    (changes) => {
      const selection = changes.filter((change) => change.type === "select");
      if (!selection.length) return;
      const next = new Set(selectedEdges);
      for (const change of selection) {
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      const ids = [...next];
      if (
        ids.length !== selectedEdges.length ||
        ids.some((id) => !selectedEdges.includes(id))
      )
        onSelection(selectedNodes, ids);
    },
    [onSelection, selectedNodes, selectedEdges],
  );
  return (
    <div className={styles.canvas} data-testid="studio-canvas">
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodesChange={onNodesChange}
        onNodeDragStart={() => onCheckpoint()}
        onEdgesChange={onEdgesChange}
        onConnect={(c) => {
          const edge = { ...edgeFor(c), id: crypto.randomUUID() };
          const issue = connectionIssue(graph, edge, capabilities);
          if (issue) onError(issue.message);
          else onGraph({ ...graph, edges: [...graph.edges, edge] });
        }}
        onConnectEnd={(_, state) => {
          if (
            state.toHandle &&
            state.fromNode &&
            state.toNode &&
            !state.isValid
          ) {
            const issue = connectionIssue(
              graph,
              edgeFor(
                state.fromHandle?.type === "target"
                  ? {
                      source: state.toNode.id,
                      sourceHandle: state.toHandle.id ?? null,
                      target: state.fromNode.id,
                      targetHandle: state.fromHandle.id ?? null,
                    }
                  : {
                      source: state.fromNode.id,
                      sourceHandle: state.fromHandle?.id || null,
                      target: state.toNode.id,
                      targetHandle: state.toHandle.id ?? null,
                    },
              ),
              capabilities,
            );
            if (issue) onError(issue.message);
          }
        }}
        isValidConnection={valid}
        onMoveEnd={(_, view) => onViewport(view)}
        defaultViewport={viewport}
        minZoom={MIN_CANVAS_ZOOM}
        maxZoom={2}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={null}
        multiSelectionKeyCode="Shift"
        selectionOnDrag
        onlyRenderVisibleElements
        fitView={
          graph.nodes.length > 0 &&
          viewport.x === 0 &&
          viewport.y === 0 &&
          viewport.zoom === 1
        }
        fitViewOptions={fitOptions}
        ariaLabelConfig={{
          "controls.zoomIn.ariaLabel": "Zoom in",
          "controls.zoomOut.ariaLabel": "Zoom out",
          "controls.fitView.ariaLabel": "Fit flow in view",
        }}
      >
        <Background gap={24} size={1} color="var(--line)" />
        <Controls showInteractive={false} fitViewOptions={fitOptions} />
        <MiniMap
          pannable
          zoomable
          className={styles.minimap}
          nodeColor="var(--surface-overlay)"
          maskColor="transparent"
        />
      </ReactFlow>
      {!graph.nodes.length ? (
        <div className={styles.canvasEmpty}>
          <h2>Start with a prompt</h2>
          <p>Add nodes from the library, or open an editable starter flow.</p>
        </div>
      ) : null}
      <button
        type="button"
        className={styles.fitButton}
        onClick={() => void instance?.fitView({ ...fitOptions, duration: 0 })}
      >
        Fit flow
      </button>
    </div>
  );
}
