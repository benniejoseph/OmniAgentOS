"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CircleAlert,
  Focus,
  GitBranch,
  Layers3,
  LoaderCircle,
  Maximize2,
  Plus,
  RefreshCw,
  Rotate3D,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  EntityRelationTypeId,
  EntityTypeId,
} from "@/lib/entities/ontology";
import type {
  MemoryGraphEdgeRelation,
  MemoryGraphNodeKind,
} from "@/lib/memory/types";
import styles from "@/components/memory-universe.module.css";

type GraphMode = "evidence" | "verified";

type EvidenceNode = {
  id: string;
  kind: MemoryGraphNodeKind;
  weight: number;
  sourceCount: number;
  updatedAt: string;
};

type EvidenceEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: MemoryGraphEdgeRelation;
  weight: number;
  evidenceCount: number;
};

type VerifiedNode = {
  id: string;
  kind: EntityTypeId;
  degree: number;
  sourceCount: number;
  updatedAt: string;
};

type VerifiedEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: EntityRelationTypeId;
  epistemicKind: string;
  confidenceBasisPoints: number;
};

type GraphBuildHealth = {
  status: "completed" | "failed";
  source: string;
  nodeCount: number;
  edgeCount: number;
  latencyMs: number;
  createdAt: string;
};

type UniversePayload = {
  version: "memory-universe:2";
  generatedAt: string;
  evidence: {
    nodes: EvidenceNode[];
    edges: EvidenceEdge[];
    stats: {
      nodes: number;
      edges: number;
      kinds: Record<string, number>;
      relations: Record<string, number>;
      latestUpdatedAt: string | null;
      latestBuild: GraphBuildHealth | null;
    };
  };
  verified: {
    nodes: VerifiedNode[];
    edges: VerifiedEdge[];
    stats: {
      nodes: number;
      edges: number;
      kinds: Record<string, number>;
      relations: Record<string, number>;
      relationLimitSaturated: boolean;
    };
  };
};

type SelectedDetail = {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  state?: string;
  sourceCount: number;
  weight?: number;
  updatedAt: string;
  tags?: string[];
};

type SceneNode = {
  id: string;
  kind: string;
  weight: number;
  sourceCount: number;
  updatedAt: string;
};

type SceneEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: string;
  weight: number;
};

type UniverseSceneController = {
  setHiddenKinds: (hiddenKinds: ReadonlySet<string>) => void;
  setSelection: (id?: string) => void;
  setActive: (active: boolean) => void;
  reset: () => void;
};

const evidenceColors: Record<MemoryGraphNodeKind, string> = {
  concept: "#90ead0",
  tag: "#ffd18a",
  system: "#99c7ff",
  workflow: "#d4b4ff",
  tool: "#ff9fae",
  memory: "#fff4c6",
  trace: "#91a6c9",
};

const evidenceLabels: Record<MemoryGraphNodeKind, string> = {
  concept: "Concepts",
  tag: "Tags",
  system: "Systems",
  workflow: "Workflows",
  tool: "Tools",
  memory: "Memories",
  trace: "Recall traces",
};

const entityColors: Record<EntityTypeId, string> = {
  person: "#8cf0d0",
  organization: "#7bb9ff",
  account: "#82cfff",
  project: "#d9b4ff",
  work_item: "#f6b86b",
  event: "#ff9cac",
  meeting: "#f4d06f",
  place: "#88dfed",
  asset: "#bfceff",
  decision: "#f3a0ff",
  commitment: "#ffd18a",
  preference: "#a8e69c",
  risk: "#ff8f8f",
  goal: "#8fe3b1",
  product: "#90c7ff",
  case: "#c2a8ff",
  opportunity: "#ffbd8d",
};

const entityLabels: Record<EntityTypeId, string> = {
  person: "People",
  organization: "Organizations",
  account: "Accounts",
  project: "Projects",
  work_item: "Work items",
  event: "Events",
  meeting: "Meetings",
  place: "Places",
  asset: "Assets",
  decision: "Decisions",
  commitment: "Commitments",
  preference: "Preferences",
  risk: "Risks",
  goal: "Goals",
  product: "Products",
  case: "Cases",
  opportunity: "Opportunities",
};

export function MemoryUniverse(props: {
  active: boolean;
  onAddConnectedFact?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneControllerRef = useRef<UniverseSceneController | null>(null);
  const selectNodeRef = useRef<(id: string) => void>(() => undefined);
  const [payload, setPayload] = useState<UniversePayload>();
  const [mode, setMode] = useState<GraphMode>("evidence");
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<SelectedDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const hiddenKindsRef = useRef(hiddenKinds);
  const activeRef = useRef(props.active);
  const selectedIdRef = useRef(selectedId);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/memory/graph?view=universe", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The universe could not be loaded.");
      setPayload(body as UniversePayload);
      setError(undefined);
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setError(message(loadError));
    });
    return () => controller.abort();
  }, [reloadKey]);

  const graph = useMemo(() => {
    if (!payload) return { nodes: [] as SceneNode[], edges: [] as SceneEdge[] };
    if (mode === "evidence") {
      return {
        nodes: payload.evidence.nodes,
        edges: payload.evidence.edges.map((edge) => ({
          ...edge,
          weight: edge.weight + Math.min(edge.evidenceCount, 10) * 0.025,
        })),
      };
    }
    return {
      nodes: payload.verified.nodes.map((node) => ({
        ...node,
        weight: 0.55 + Math.min(node.degree, 12) * 0.12,
      })),
      edges: payload.verified.edges.map((edge) => ({
        ...edge,
        weight: edge.confidenceBasisPoints / 10_000,
      })),
    };
  }, [mode, payload]);

  const kindMeta = useMemo(() => {
    if (!payload) return [];
    const counts = mode === "evidence"
      ? payload.evidence.stats.kinds
      : payload.verified.stats.kinds;
    return Object.entries(counts).map(([kind, count]) => ({
      kind,
      count,
      color: colorForKind(kind, mode),
      label: labelForKind(kind, mode),
    }));
  }, [mode, payload]);

  async function selectNode(id: string) {
    setSelectedId(id);
    setDetail(undefined);
    setDetailLoading(true);
    const view = mode === "evidence" ? "universe_node" : "universe_entity";
    try {
      const response = await fetch(
        `/api/memory/graph?view=${view}&id=${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Point details could not be loaded.");
      setDetail((body.node || body.entity) as SelectedDetail);
    } catch (detailError) {
      setError(message(detailError));
    } finally {
      setDetailLoading(false);
    }
  }
  useEffect(() => {
    selectNodeRef.current = (id) => void selectNode(id);
  });

  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    let disposed = false;
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | undefined;
    let renderer: import("three").WebGLRenderer | undefined;
    let disposeScene: (() => void) | undefined;

    void Promise.all([
      import("three"),
      import("three/examples/jsm/controls/OrbitControls.js"),
    ]).then(([THREE, { OrbitControls }]) => {
      if (disposed) return;
      const nodes = graph.nodes;
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x061117, 0.022);
      const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 180);
      camera.position.set(0, 5, 31);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setClearColor(0x061117, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.replaceChildren(renderer.domElement);
      renderer.domElement.setAttribute(
        "aria-label",
        mode === "evidence"
          ? "Interactive three-dimensional evidence map"
          : "Interactive three-dimensional map of verified relationships",
      );
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.tabIndex = 0;

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.06;
      controls.minDistance = 5;
      controls.maxDistance = 66;
      controls.autoRotate = !reducedMotion;
      controls.autoRotateSpeed = 0.12;

      const positions = layoutNodes(nodes, THREE);
      const geometry = new THREE.IcosahedronGeometry(0.13, 1);
      const material = new THREE.MeshBasicMaterial({ vertexColors: true });
      const mesh = new THREE.InstancedMesh(geometry, material, nodes.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const dummy = new THREE.Object3D();
      let currentHidden = hiddenKindsRef.current;
      let currentSelection = selectedIdRef.current;
      let currentHighlight = selectedIdRef.current;

      const setNodeInstances = () => {
        nodes.forEach((node, index) => {
          const position = positions.get(node.id) || new THREE.Vector3();
          dummy.position.copy(position);
          const emphasis = node.id === currentHighlight ? 1.7 : 1;
          const scale = currentHidden.has(node.kind)
            ? 0
            : Math.min(3.2, 0.72 + Math.sqrt(Math.max(node.weight, 0.05)) * 0.8) * emphasis;
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          mesh.setMatrixAt(index, dummy.matrix);
          const color = new THREE.Color(colorForKind(node.kind, mode));
          if (node.id === currentHighlight) color.offsetHSL(0, 0.04, 0.2);
          mesh.setColorAt(index, color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      };
      scene.add(mesh);

      const renderedEdges = [...graph.edges]
        .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
        .slice(0, mode === "evidence" ? 5_000 : 2_000);
      const edgeSegments = renderedEdges.flatMap((edge) => {
        const source = positions.get(edge.sourceNodeId);
        const target = positions.get(edge.targetNodeId);
        const sourceNode = nodeById.get(edge.sourceNodeId);
        const targetNode = nodeById.get(edge.targetNodeId);
        return source && target && sourceNode && targetNode
          ? [{ edge, source, target, sourceNode, targetNode }]
          : [];
      });
      const edgePoints = new Float32Array(edgeSegments.length * 6);
      const edgeColors: number[] = [];
      edgeSegments.forEach(({ edge }) => {
        const intensity = Math.min(0.72, 0.2 + edge.weight * 0.38);
        edgeColors.push(0.24, intensity + 0.18, intensity, 0.24, intensity + 0.18, intensity);
      });
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePoints, 3));
      edgeGeometry.setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3));
      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: mode === "evidence" ? 0.1 : 0.22,
        blending: THREE.AdditiveBlending,
      });
      const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      scene.add(lines);

      const highlightGeometry = new THREE.BufferGeometry();
      const highlightMaterial = new THREE.LineBasicMaterial({
        color: 0xb9ffe9,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
      });
      const highlightLines = new THREE.LineSegments(highlightGeometry, highlightMaterial);
      scene.add(highlightLines);

      const glowGeometry = new THREE.SphereGeometry(0.34, 18, 18);
      const glowMaterial = new THREE.MeshBasicMaterial({
        color: 0xd8fff4,
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glow = new THREE.Mesh(glowGeometry, glowMaterial);
      glow.visible = false;
      scene.add(glow);

      const selectionRingGeometry = new THREE.TorusGeometry(0.48, 0.024, 10, 48);
      const selectionRingMaterial = new THREE.MeshBasicMaterial({
        color: 0x90ead0,
        transparent: true,
        opacity: 0.82,
      });
      const selectionRing = new THREE.Mesh(selectionRingGeometry, selectionRingMaterial);
      selectionRing.visible = false;
      scene.add(selectionRing);

      const setEdgeSegments = () => {
        edgeSegments.forEach((segment, index) => {
          const offset = index * 6;
          if (
            currentHidden.has(segment.sourceNode.kind) ||
            currentHidden.has(segment.targetNode.kind)
          ) {
            edgePoints.fill(0, offset, offset + 6);
          } else {
            edgePoints.set([
              segment.source.x,
              segment.source.y,
              segment.source.z,
              segment.target.x,
              segment.target.y,
              segment.target.z,
            ], offset);
          }
        });
        edgeGeometry.getAttribute("position").needsUpdate = true;
      };

      const setHighlight = (id?: string) => {
        currentHighlight = id;
        const position = id ? positions.get(id) : undefined;
        glow.visible = Boolean(position);
        selectionRing.visible = Boolean(position && id === currentSelection);
        if (position) {
          glow.position.copy(position);
          selectionRing.position.copy(position);
          selectionRing.lookAt(camera.position);
        }
        const points: import("three").Vector3[] = [];
        if (id) {
          for (const segment of edgeSegments) {
            if (
              !currentHidden.has(segment.sourceNode.kind) &&
              !currentHidden.has(segment.targetNode.kind) &&
              (segment.edge.sourceNodeId === id || segment.edge.targetNodeId === id)
            ) points.push(segment.source, segment.target);
          }
        }
        highlightGeometry.setFromPoints(points);
        edgeMaterial.opacity = id ? 0.025 : mode === "evidence" ? 0.1 : 0.22;
        setNodeInstances();
      };

      const setHiddenKinds = (hidden: ReadonlySet<string>) => {
        currentHidden = hidden;
        setNodeInstances();
        setEdgeSegments();
        setHighlight(currentHighlight);
      };
      setHiddenKinds(hiddenKindsRef.current);

      const decorations = createObservatory(THREE, Math.max(kindMeta.length, 4));
      scene.add(decorations.group);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerStart: { x: number; y: number } | undefined;
      const findHit = (event: PointerEvent) => {
        const rect = renderer?.domElement.getBoundingClientRect();
        if (!rect) return undefined;
        pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(mesh, false)[0];
        return hit?.instanceId === undefined ? undefined : nodes[hit.instanceId];
      };
      const onPointerDown = (event: PointerEvent) => {
        pointerStart = { x: event.clientX, y: event.clientY };
      };
      const onPointerMove = (event: PointerEvent) => {
        const node = findHit(event);
        renderer!.domElement.style.cursor = node ? "pointer" : "grab";
        setHighlight(node?.id || currentSelection);
      };
      const onPointerLeave = () => setHighlight(currentSelection);
      const onPointerUp = (event: PointerEvent) => {
        if (!pointerStart || Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y,
        ) > 5) return;
        const node = findHit(event);
        if (node) selectNodeRef.current(node.id);
      };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerup", onPointerUp);

      const cameraGoal = camera.position.clone();
      const targetGoal = new THREE.Vector3();
      const focusNode = (id?: string) => {
        currentSelection = id;
        setHighlight(id);
        const position = id ? positions.get(id) : undefined;
        if (!position) return;
        targetGoal.copy(position);
        const direction = camera.position.clone().sub(controls.target).normalize();
        cameraGoal.copy(position).add(direction.multiplyScalar(8.5));
      };
      const reset = () => {
        currentSelection = undefined;
        currentHighlight = undefined;
        cameraGoal.set(0, 5, 31);
        targetGoal.set(0, 0, 0);
        setHighlight(undefined);
      };

      const resize = () => {
        if (!renderer) return;
        const width = Math.max(mount.clientWidth, 1);
        const height = Math.max(mount.clientHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();

      let rendering = false;
      const draw = () => {
        if (disposed || !renderer || !rendering) return;
        camera.position.lerp(cameraGoal, reducedMotion ? 1 : 0.045);
        controls.target.lerp(targetGoal, reducedMotion ? 1 : 0.055);
        glow.scale.setScalar(1 + Math.sin(performance.now() * 0.0024) * 0.16);
        selectionRing.rotation.z += reducedMotion ? 0 : 0.003;
        controls.update();
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(draw);
      };
      const setActive = (nextActive: boolean) => {
        if (nextActive && !rendering) {
          rendering = true;
          draw();
        } else if (!nextActive && rendering) {
          rendering = false;
          cancelAnimationFrame(animationFrame);
        }
      };
      sceneControllerRef.current = {
        setHiddenKinds,
        setSelection: focusNode,
        setActive,
        reset,
      };
      focusNode(selectedIdRef.current);
      setActive(activeRef.current);

      disposeScene = () => {
        cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();
        renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer?.domElement.removeEventListener("pointermove", onPointerMove);
        renderer?.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer?.domElement.removeEventListener("pointerup", onPointerUp);
        controls.dispose();
        geometry.dispose();
        material.dispose();
        edgeGeometry.dispose();
        edgeMaterial.dispose();
        highlightGeometry.dispose();
        highlightMaterial.dispose();
        glowGeometry.dispose();
        glowMaterial.dispose();
        selectionRingGeometry.dispose();
        selectionRingMaterial.dispose();
        decorations.dispose();
        renderer?.dispose();
        renderer?.domElement.remove();
        sceneControllerRef.current = null;
      };
    }).catch((sceneError) => {
      if (!disposed) setError(message(sceneError));
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      disposeScene?.();
    };
  }, [graph, kindMeta.length, mode]);

  useEffect(() => {
    hiddenKindsRef.current = hiddenKinds;
    sceneControllerRef.current?.setHiddenKinds(hiddenKinds);
  }, [hiddenKinds]);

  useEffect(() => {
    activeRef.current = props.active;
    sceneControllerRef.current?.setActive(props.active);
  }, [props.active]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    sceneControllerRef.current?.setSelection(selectedId);
  }, [selectedId]);

  const shownNodeCount = graph.nodes.filter(
    (node) => !hiddenKinds.has(node.kind),
  ).length;
  const graphStats = mode === "evidence" ? payload?.evidence.stats : payload?.verified.stats;
  const connections = useMemo(() => {
    if (!selectedId) return [];
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.filter((edge) =>
      edge.sourceNodeId === selectedId || edge.targetNodeId === selectedId
    ).slice(0, 8).map((edge) => {
      const otherId = edge.sourceNodeId === selectedId
        ? edge.targetNodeId
        : edge.sourceNodeId;
      return { relation: edge.relation, kind: nodeById.get(otherId)?.kind || "point" };
    });
  }, [graph.edges, graph.nodes, selectedId]);
  const connectionTotal = selectedId
    ? graph.edges.filter((edge) =>
        edge.sourceNodeId === selectedId || edge.targetNodeId === selectedId
      ).length
    : 0;

  function changeMode(nextMode: GraphMode) {
    setMode(nextMode);
    setHiddenKinds(new Set());
    setSelectedId(undefined);
    setDetail(undefined);
  }

  function toggleKind(kind: string) {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function resetView() {
    setSelectedId(undefined);
    setDetail(undefined);
    sceneControllerRef.current?.reset();
  }

  async function rebuildGraph() {
    setRebuilding(true);
    try {
      const response = await fetch("/api/memory/graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "memory-universe" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The evidence map could not be rebuilt.");
      setReloadKey((current) => current + 1);
      setError(undefined);
    } catch (rebuildError) {
      setError(message(rebuildError));
    } finally {
      setRebuilding(false);
    }
  }

  const build = payload?.evidence.stats.latestBuild;
  const health = buildHealth(build);
  const verifiedEmpty = mode === "verified" && graph.edges.length === 0;

  return (
    <section className={styles.shell} aria-labelledby="memory-universe-title">
      <header className={styles.header}>
        <div className={styles.heading}>
          <p><Sparkles size={16} /> Memory observatory</p>
          <h2 id="memory-universe-title">A universe with evidence at its center.</h2>
          <span>Orbit the map, isolate a layer, and select any point to inspect what supports it.</span>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.health} ${health.tone === "danger" ? styles.healthDanger : ""}`}>
            <i /> {health.label}
          </span>
          <button type="button" onClick={() => void rebuildGraph()} disabled={rebuilding}>
            {rebuilding ? <LoaderCircle size={17} className={styles.spin} /> : <RefreshCw size={17} />}
            Rebuild map
          </button>
          <button type="button" onClick={resetView}><Focus size={17} /> Reset view</button>
        </div>
      </header>

      <div className={styles.modeBar}>
        <div className={styles.modeSwitch} role="tablist" aria-label="Universe data layer">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "evidence"}
            className={mode === "evidence" ? styles.activeMode : undefined}
            onClick={() => changeMode("evidence")}
          >
            <Layers3 size={17} /><span><strong>Evidence map</strong><small>Observed topic links</small></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "verified"}
            className={mode === "verified" ? styles.activeMode : undefined}
            onClick={() => changeMode("verified")}
          >
            <ShieldCheck size={17} /><span><strong>Verified relationships</strong><small>Explicit typed facts only</small></span>
          </button>
        </div>
        <p className={styles.layerNote}>
          {mode === "evidence"
            ? "A line means two signals appeared together or were recalled together. It is a clue, not a fact."
            : "Every line is an explicit relationship with source lineage. Asael does not invent missing links."}
        </p>
      </div>

      <div className={styles.stage}>
        <div ref={mountRef} className={styles.canvas} />
        {!payload && !error ? (
          <div className={styles.loading}>
            <LoaderCircle size={24} className={styles.spin} />
            Mapping the observatory…
          </div>
        ) : null}
        {error ? <div className={styles.error}><CircleAlert size={20} /> {error}</div> : null}

        {payload ? (
          <div className={styles.counter}>
            <Rotate3D size={17} />
            <span><strong>{shownNodeCount.toLocaleString()}</strong> visible points</span>
            <span><strong>{(graphStats?.edges || 0).toLocaleString()}</strong> links</span>
            {mode === "evidence" && build ? (
              <span><Activity size={14} /> {formatDuration(build.latencyMs)} build</span>
            ) : null}
          </div>
        ) : null}

        {verifiedEmpty && payload ? (
          <div className={styles.emptyVerified}>
            <div><ShieldCheck size={24} /></div>
            <p>Verified space is intentionally quiet</p>
            <h3>No explicit relationships have been recorded yet.</h3>
            <span>
              {payload.verified.stats.nodes
                ? `${payload.verified.stats.nodes} typed entities are indexed, but none are joined by a verified claim.`
                : "Add a connected fact and Mnemosyne will index its entities and evidence-backed relationship."}
            </span>
            {props.onAddConnectedFact ? (
              <button type="button" onClick={props.onAddConnectedFact}>
                <Plus size={16} /> Add connected fact
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={styles.legend} aria-label="Graph filters">
          {kindMeta.map(({ kind, label, color, count }) => (
            <button
              type="button"
              key={kind}
              className={hiddenKinds.has(kind) ? styles.hiddenKind : undefined}
              onClick={() => toggleKind(kind)}
              aria-pressed={!hiddenKinds.has(kind)}
            >
              <i style={{ background: color }} />
              {label}
              <small>{count.toLocaleString()}</small>
            </button>
          ))}
        </div>

        {selectedId ? (
          <aside className={styles.inspector} aria-live="polite">
            <button
              type="button"
              className={styles.close}
              onClick={resetView}
              aria-label="Close point details"
            ><X size={18} /></button>
            {detailLoading ? (
              <div className={styles.detailLoading}>
                <LoaderCircle size={21} className={styles.spin} /> Inspecting point…
              </div>
            ) : detail ? (
              <>
                <p><i style={{ background: colorForKind(detail.kind, mode) }} /> {labelForKind(detail.kind, mode)}</p>
                <h3>{detail.label}</h3>
                <span>{detail.summary || (mode === "verified"
                  ? "A typed entity created from explicit source evidence."
                  : "This point groups related evidence and recall activity.")}</span>
                <dl>
                  <div><dt>Evidence sources</dt><dd>{detail.sourceCount}</dd></div>
                  <div><dt>Direct links</dt><dd>{connectionTotal}</dd></div>
                  {detail.weight !== undefined ? <div><dt>Signal weight</dt><dd>{Math.round(detail.weight * 100)}%</dd></div> : null}
                  <div><dt>Last indexed</dt><dd>{formatDate(detail.updatedAt)}</dd></div>
                </dl>
                {connections.length ? (
                  <section className={styles.connections}>
                    <p><GitBranch size={15} /> Connected path</p>
                    {connections.map((connection, index) => (
                      <span key={`${connection.relation}:${connection.kind}:${index}`}>
                        <i /> {startCase(connection.relation)} <small>→ {labelForKind(connection.kind, mode)}</small>
                      </span>
                    ))}
                  </section>
                ) : null}
                {detail.tags?.length ? (
                  <div className={styles.tags}>{detail.tags.map((tag) => <em key={tag}>{tag}</em>)}</div>
                ) : null}
              </>
            ) : null}
          </aside>
        ) : null}
        <div className={styles.cornerMark}><Maximize2 size={15} /> Three.js spatial index</div>
      </div>
    </section>
  );
}

function layoutNodes(
  nodes: readonly SceneNode[],
  THREE: typeof import("three"),
) {
  const positions = new Map<string, import("three").Vector3>();
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort();
  const grouped = new Map(kinds.map((kind) => [
    kind,
    nodes.filter((node) => node.kind === kind)
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id)),
  ]));
  kinds.forEach((kind, kindIndex) => {
    const group = grouped.get(kind) || [];
    const baseRadius = 3.4 + kindIndex * Math.min(1.8, 9.8 / Math.max(kinds.length, 1));
    group.forEach((node, index) => {
      const ratio = (index + 0.5) / Math.max(group.length, 1);
      const angle = index * 2.399963 + seeded(node.id) * Math.PI * 2;
      const radius = baseRadius + (ratio - 0.5) * 1.7 + (seeded(`${node.id}:r`) - 0.5) * 0.7;
      const inclination = (kindIndex % 2 ? -1 : 1) * (0.12 + kindIndex * 0.018);
      positions.set(node.id, new THREE.Vector3(
        Math.cos(angle) * radius,
        Math.sin(angle * 1.7) * (0.55 + ratio * 2.1) + Math.sin(angle) * radius * inclination,
        Math.sin(angle) * radius,
      ));
    });
  });
  return positions;
}

function createObservatory(
  THREE: typeof import("three"),
  ringCount: number,
) {
  const group = new THREE.Group();
  const resources: Array<{ dispose: () => void }> = [];
  const coreGeometry = new THREE.SphereGeometry(0.72, 28, 28);
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0x8df0d1,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const core = new THREE.Mesh(coreGeometry, coreMaterial);
  group.add(core);
  resources.push(coreGeometry, coreMaterial);

  for (let index = 0; index < Math.min(ringCount + 1, 10); index += 1) {
    const radius = 3.4 + index * Math.min(1.8, 9.8 / Math.max(ringCount, 1));
    const curve = new THREE.EllipseCurve(0, 0, radius, radius * (0.93 + index % 2 * 0.035));
    const ringGeometry = new THREE.BufferGeometry().setFromPoints(
      curve.getPoints(160).map((point) => new THREE.Vector3(point.x, 0, point.y)),
    );
    const ringMaterial = new THREE.LineBasicMaterial({
      color: index % 2 ? 0x315b63 : 0x295248,
      transparent: true,
      opacity: index === 0 ? 0.28 : 0.12,
    });
    const ring = new THREE.LineLoop(ringGeometry, ringMaterial);
    ring.rotation.z = (index % 2 ? -1 : 1) * (0.035 + index * 0.008);
    group.add(ring);
    resources.push(ringGeometry, ringMaterial);
  }

  const starPositions: number[] = [];
  for (let index = 0; index < 1_250; index += 1) {
    const radius = 28 + seeded(`star:${index}`) * 48;
    const theta = seeded(`theta:${index}`) * Math.PI * 2;
    const phi = Math.acos(1 - 2 * seeded(`phi:${index}`));
    starPositions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: 0xa7e7d6,
    size: 0.06,
    transparent: true,
    opacity: 0.46,
  });
  group.add(new THREE.Points(starGeometry, starMaterial));
  resources.push(starGeometry, starMaterial);
  return {
    group,
    dispose: () => resources.forEach((resource) => resource.dispose()),
  };
}

function colorForKind(kind: string, mode: GraphMode) {
  if (mode === "evidence" && kind in evidenceColors) {
    return evidenceColors[kind as MemoryGraphNodeKind];
  }
  if (mode === "verified" && kind in entityColors) {
    return entityColors[kind as EntityTypeId];
  }
  return "#a8beb9";
}

function labelForKind(kind: string, mode: GraphMode) {
  if (mode === "evidence" && kind in evidenceLabels) {
    return evidenceLabels[kind as MemoryGraphNodeKind];
  }
  if (mode === "verified" && kind in entityLabels) {
    return entityLabels[kind as EntityTypeId];
  }
  return startCase(kind);
}

function buildHealth(build?: GraphBuildHealth | null) {
  if (!build) return { label: "Not built yet", tone: "danger" as const };
  if (build.status === "failed") return { label: "Map needs repair", tone: "danger" as const };
  const age = Date.now() - new Date(build.createdAt).getTime();
  if (age > 86_400_000) return { label: "Map ready · refresh available", tone: "calm" as const };
  return { label: "Map current", tone: "calm" as const };
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function seeded(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function startCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
