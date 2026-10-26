"use client";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  Background,
  Controls,
  ControlButton,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useConnection,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import {
  Film,
  ImageIcon,
  MessageSquareText,
  StickyNote,
  Files,
  GalleryHorizontalEnd,
  Check,
  CircleAlert,
  Clock3,
  Map as MapIcon,
  Play,
  LoaderCircle,
} from "lucide-react";
import {
  getNodePorts,
  connectionIssue,
  type GraphCapability,
} from "@/lib/studio/graph";
import { privateCaptureAssetContentUrl } from "@/components/media/private-media-preview";
import {
  type StudioAsset,
  type StudioGraph,
  type StudioNode,
  type StudioNodeRun,
  type StudioViewport,
} from "@/lib/studio/contracts";
import { nodeLabels, statusLabel } from "./state";
import styles from "./canvas.module.css";

type CardData = {
  node: StudioNode;
  ports: ReturnType<typeof getNodePorts>;
  run?: StudioNodeRun;
  thumbnail?: StudioAsset;
  reference?: StudioAsset;
  thumbnailLabel?: string;
  connectedPrompt?: string;
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
const emptyMediaLabels: Record<StudioNode["type"], string> = {
  prompt: "Describe the image or scene you want to create",
  note: "Keep an idea beside your work",
  image: "Your image will appear here",
  video: "Your video starts here",
  asset: "Add an image, video or audio reference",
  output: "Your finished results come together here",
};

function ImageThumbnail({
  asset,
  label,
}: {
  asset: StudioAsset;
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = privateCaptureAssetContentUrl(asset.id);
  return (
    <div className={styles.thumbnail}>
      {src && !failed ? (
        <Image
          src={src}
          alt={asset.filename || "Saved image"}
          width={544}
          height={306}
          unoptimized
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={styles.previewUnavailable}>
          <ImageIcon size={24} aria-hidden="true" />
          Preview unavailable
        </span>
      )}
      {label ? <span className={styles.thumbnailLabel}>{label}</span> : null}
    </div>
  );
}

const StudioCard = memo(function StudioCard({
  id,
  data,
  selected,
}: NodeProps<FlowNode>) {
  const connecting = useConnection();
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = data.ports.map((p) => `${p.direction}:${p.id}`).join("|");
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, portSignature, updateNodeInternals]);
  const Icon = icons[data.node.type];
  const textStep = data.node.type === "prompt" || data.node.type === "note";
  const inputs = data.ports.filter((port) => port.direction === "input");
  const outputs = data.ports.filter((port) => port.direction === "output");
  const status = data.run?.status;
  const working = status === "submitting" || status === "running" || status === "persisting";
  const needsAttention = status === "failed" || status === "blocked" || status === "moderated" || status === "uncertain";
  const StateIcon = data.stale || needsAttention
    ? CircleAlert
    : status === "succeeded"
      ? Check
      : working
        ? LoaderCircle
        : Clock3;
  const stateLabel = !data.node.enabled
    ? "Excluded from run"
    : data.stale
      ? "Settings changed"
      : status
        ? statusLabel(status)
        : "Not run yet";
  const results = data.run?.outputAssets.length || 0;
  const prompt = data.connectedPrompt || data.node.config.prompt;
  const hasVideo = data.run?.outputAssets.some((asset) => asset.mediaType.startsWith("video/"));
  const mediaLabel = data.reference
    ? `${data.reference.mediaType.startsWith("video/") ? "Video" : data.reference.mediaType.startsWith("audio/") ? "Audio" : "Image"} reference attached`
    : hasVideo ? "Video ready to preview" : emptyMediaLabels[data.node.type];
  const showType = data.node.title.toLowerCase() !== nodeLabels[data.node.type].toLowerCase();
  function portView(port: CardData["ports"][number]) {
    const input = port.direction === "input";
    const compatible = Boolean(
      connecting.inProgress &&
      connecting.fromNode &&
      connecting.fromHandle &&
      input === (connecting.fromHandle.type === "source") &&
      data.valid(
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
      ),
    );
    const label = port.id === "media" && data.node.type === "output"
      ? "Results"
      : port.label.charAt(0).toUpperCase() + port.label.slice(1);
    return (
      <div
        className={styles.port}
        data-direction={port.direction}
        key={`${port.direction}:${port.id}`}
        title={`${label} · ${port.type}${port.required ? " · Required" : ""}`}
      >
        <Handle
          type={input ? "target" : "source"}
          position={input ? Position.Left : Position.Right}
          id={port.id}
          className={compatible ? styles.compatibleHandle : undefined}
          aria-label={`${data.node.title}: ${label} ${port.direction}${port.required ? ", required" : ""}`}
        />
        <span>{label}</span>
        {port.required ? <span className={styles.required} aria-hidden="true">*</span> : null}
      </div>
    );
  }
  return (
    <article
      className={styles.node}
      data-selected={selected || undefined}
      data-kind={data.node.type}
      data-disabled={!data.node.enabled || undefined}
      data-connecting={connecting.inProgress || undefined}
      aria-label={data.node.title}
    >
      <header className={styles.nodeHeader}>
        <Icon size={17} aria-hidden="true" />
        <div>
          <strong>{data.node.title || nodeLabels[data.node.type]}</strong>
          {showType ? <span>{nodeLabels[data.node.type]}</span> : null}
        </div>
      </header>
      {textStep ? (
        <div className={styles.textBody}>
          <p data-empty={!data.node.config.prompt || undefined}>
            {data.node.config.prompt || (data.node.type === "note"
              ? "Keep an idea or a reminder beside your work."
              : "Describe the image or scene you want to create.")}
          </p>
        </div>
      ) : (
        <div className={styles.mediaBody}>
          {data.thumbnail ? (
            <ImageThumbnail key={data.thumbnail.id} asset={data.thumbnail} label={data.thumbnailLabel} />
          ) : (
            <div className={styles.mediaPlaceholder}>
              {hasVideo ? <Play size={26} aria-hidden="true" /> : <Icon size={26} aria-hidden="true" />}
              <span>{mediaLabel}</span>
              {data.reference ? <p>{data.reference.filename}</p> : prompt && !hasVideo ? <p>{prompt}</p> : null}
            </div>
          )}
        </div>
      )}
      {data.node.type !== "note" ? (
        <div className={styles.nodeState} data-status={data.stale ? "stale" : status}>
          <span className={styles.status} title={data.run?.error || stateLabel}>
            <StateIcon size={13} aria-hidden="true" className={working && !data.stale ? styles.working : undefined} />
            {stateLabel}
          </span>
          {results ? <span className={styles.resultCount}>{results} {results === 1 ? "result" : "results"}</span> : null}
        </div>
      ) : null}
      {data.ports.length ? (
        <div className={styles.ports}>
          <div>{inputs.map(portView)}</div>
          <div>{outputs.map(portView)}</div>
        </div>
      ) : null}
    </article>
  );
});
const nodeTypes: NodeTypes = { studio: StudioCard };
const EMPTY_ASSETS: readonly StudioAsset[] = [];
const MIN_CANVAS_ZOOM = 0.1;
const fitOptions = { padding: 0.2, minZoom: MIN_CANVAS_ZOOM, maxZoom: 1 };
export default function StudioCanvas({
  graph,
  capabilities,
  assets = EMPTY_ASSETS,
  viewport,
  nodeRuns,
  staleIds,
  selectedNodes,
  selectedEdges,
  onSelection,
  onOpenNode,
  onGraph,
  onCheckpoint,
  onViewport,
  onError,
  readOnly,
}: {
  graph: StudioGraph;
  capabilities: readonly GraphCapability[];
  assets?: readonly StudioAsset[];
  viewport: StudioViewport;
  nodeRuns: Record<string, StudioNodeRun>;
  staleIds: Set<string>;
  selectedNodes: string[];
  selectedEdges: string[];
  onSelection: (nodes: string[], edges: string[]) => void;
  onOpenNode?: (nodeId: string) => void;
  onGraph: (graph: StudioGraph, record?: boolean) => void;
  onCheckpoint: () => void;
  onViewport: (viewport: StudioViewport) => void;
  onError: (message: string) => void;
  readOnly: boolean;
}) {
  const [overview, setOverview] = useState(false);
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
  const nodePresentations = useMemo<FlowNode[]>(
    () => {
      const byAssetId = new Map(assets.map((asset) => [asset.id, asset]));
      const byNodeId = new Map(graph.nodes.map((node) => [node.id, node]));
      const incomingEdges = new Map<string, StudioGraph["edges"]>();
      for (const edge of graph.edges) {
        const group = incomingEdges.get(edge.target) || [];
        group.push(edge);
        incomingEdges.set(edge.target, group);
      }
      for (const group of incomingEdges.values()) group.sort((a, b) => a.order - b.order);
      const image = (candidates: readonly StudioAsset[]) =>
        candidates.find((asset) => asset.mediaType.startsWith("image/"));
      return graph.nodes.map((node) => {
        const run = nodeRuns[node.id];
        const references = incomingEdges.get(node.id) || [];
        const connectedPrompt = references
          .filter((edge) => edge.targetPort === "prompt")
          .map((edge) => byNodeId.get(edge.source)?.config.prompt)
          .filter(Boolean)
          .join("\n\n");
        const upstreamImages = references
          .filter((edge) => edge.targetPort !== "prompt")
          .flatMap((edge) => {
            const source = byNodeId.get(edge.source);
            if (!source) return [];
            if (source.type === "asset") {
              const asset = byAssetId.get(source.config.assetId || "");
              return asset && (!source.config.assetVersion || source.config.assetVersion === asset.contentSha256)
                ? [asset] : [];
            }
            const candidates = nodeRuns[source.id]?.outputAssets || [];
            return candidates.length > 1 && (edge.sourcePort === "selected" || edge.sourcePort === "video")
              ? candidates.filter((asset) => asset.id === source.config.selectedOutputId)
              : candidates;
          });
        const savedOutputs = run?.outputAssets || [];
        const selectedOutput = savedOutputs.find((asset) => asset.id === node.config.selectedOutputId);
        const savedImage = selectedOutput?.mediaType.startsWith("image/")
          ? selectedOutput : image(savedOutputs);
        const referenceImage = image(run?.inputAssets || []) || image(upstreamImages);
        const candidateReference = byAssetId.get(node.config.assetId || "");
        const chosenReference = candidateReference && (!node.config.assetVersion || node.config.assetVersion === candidateReference.contentSha256)
          ? candidateReference : undefined;
        const thumbnail = node.type === "asset"
          ? chosenReference?.mediaType.startsWith("image/") ? chosenReference : undefined
          : savedImage || referenceImage;
        const thumbnailLabel = node.type === "video" && thumbnail
          ? "Reference image"
          : !savedImage && referenceImage && node.type !== "asset"
            ? "Reference image" : undefined;
        return {
          id: node.id,
          type: "studio" as const,
          position: node.position,
          data: {
            node,
            ports: getNodePorts(node, capabilities),
            run,
            thumbnail,
            reference: node.type === "asset" ? chosenReference : undefined,
            thumbnailLabel,
            connectedPrompt,
            stale: staleIds.has(node.id),
            valid,
          },
        };
      });
    },
    [graph.nodes, graph.edges, capabilities, assets, nodeRuns, staleIds, valid],
  );
  const nodes = useMemo<FlowNode[]>(() => {
    const selected = new Set(selectedNodes);
    return nodePresentations.map((node) => ({
      ...node,
      selected: selected.has(node.id),
    }));
  }, [nodePresentations, selectedNodes]);
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        selected: selectedEdges.includes(edge.id),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        type: "default",
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
    <div
      className={styles.canvas}
      data-testid="studio-canvas"
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
          !(event.target instanceof HTMLElement) ||
          !event.target.classList.contains("react-flow__node")
        ) return;
        const nodeId = event.target.dataset.id;
        if (nodeId && onOpenNode) {
          event.preventDefault();
          onOpenNode(nodeId);
        }
      }}
    >
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(event, node) => {
          if (
            event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
            (event.target instanceof Element && event.target.closest(
              '.react-flow__handle, button, a, input, select, textarea, [contenteditable="true"]',
            ))
          ) return;
          onOpenNode?.(node.id);
        }}
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
        <Controls showInteractive={false} fitViewOptions={fitOptions} orientation="horizontal">
          <ControlButton
            onClick={() => setOverview((value) => !value)}
            title={overview ? "Hide overview" : "Show overview"}
            aria-label={overview ? "Hide overview" : "Show overview"}
            aria-pressed={overview}
          >
            <MapIcon size={16} aria-hidden="true" />
          </ControlButton>
        </Controls>
        {overview ? (
          <MiniMap
            pannable
            zoomable
            className={styles.minimap}
            nodeColor="var(--surface-overlay)"
            maskColor="transparent"
            ariaLabel="Flow overview"
          />
        ) : null}
      </ReactFlow>
      {!graph.nodes.length ? (
        <div className={styles.canvasEmpty}>
          <MessageSquareText size={28} aria-hidden="true" />
          <h2>Bring an idea to life</h2>
          <p>Choose Add step to start with a prompt, a reference or a generator.</p>
        </div>
      ) : null}
    </div>
  );
}
