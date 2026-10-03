"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Focus,
  GitBranch,
  Layers3,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  EntityRelationTypeId,
  EntityTypeId,
} from "@/lib/entities/ontology";
import type {
  MemoryGraphEdgeRelation,
  MemoryGraphNodeKind,
} from "@/lib/memory/types";
import { createUniverseSelectionGuard, universeDetailForSelection } from "@/components/memory-universe-selection";
import { universeSphereFitDistance } from "@/components/memory-universe-camera";
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
  disclosure: { labels: "explicit_node_selection"; summaries: "explicit_node_selection" };
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
  fit: () => void;
  zoomBy: (factor: number) => void;
};

const evidenceColors: Record<MemoryGraphNodeKind, string> = {
  concept: "--foreground",
  tag: "--accent",
  system: "--muted",
  workflow: "--line-strong",
  tool: "--foreground",
  memory: "--accent",
  trace: "--muted",
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
  person: "--foreground",
  organization: "--muted",
  account: "--line-strong",
  project: "--accent",
  work_item: "--foreground",
  event: "--muted",
  meeting: "--accent",
  place: "--line-strong",
  asset: "--foreground",
  decision: "--accent",
  commitment: "--foreground",
  preference: "--muted",
  risk: "--line-strong",
  goal: "--accent",
  product: "--foreground",
  case: "--muted",
  opportunity: "--line-strong",
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
  const inspectorRef = useRef<HTMLElement>(null);
  const inspectorHeadingRef = useRef<HTMLHeadingElement>(null);
  const selectorHeadingRef = useRef<HTMLHeadingElement>(null);
  const selectorButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const selectionOriginRef = useRef<{ element: HTMLElement; id: string; page?: number } | null>(null);
  const focusFrameRef = useRef(0);
  const focusRevisionRef = useRef(0);
  const [selectionGuard] = useState(createUniverseSelectionGuard);
  const sceneControllerRef = useRef<UniverseSceneController | null>(null);
  const selectNodeRef = useRef<(id: string, origin: HTMLElement) => void>(() => undefined);
  const [payload, setPayload] = useState<UniversePayload>();
  const [mode, setMode] = useState<GraphMode>("evidence");
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<SelectedDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [readLoading, setReadLoading] = useState(true);
  const [readError, setReadError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [sceneError, setSceneError] = useState<string>();
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const [rebuildError, setRebuildError] = useState<string>();
  const [rebuildNotice, setRebuildNotice] = useState<string>();
  const [nodePage, setNodePage] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const hiddenKindsRef = useRef(hiddenKinds);
  const activeRef = useRef(props.active);
  const selectedIdRef = useRef(selectedId);
  const modeRef = useRef(mode);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/memory/graph?view=universe", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The universe could not be loaded.");
      if (controller.signal.aborted) return;
      if (body.version !== "memory-universe:2" || !Array.isArray(body.evidence?.nodes) || !Array.isArray(body.verified?.nodes)) {
        throw new Error("The map returned an unsupported snapshot.");
      }
      setPayload(body as UniversePayload);
      setReadError(undefined);
      setSceneError(undefined);
      setSceneReady(false);
      if (selectedIdRef.current && !body[modeRef.current].nodes.some((node: SceneNode) => node.id === selectedIdRef.current)) {
        const focusedElement = document.activeElement;
        const restoreFocus = document.hasFocus() && Boolean(inspectorRef.current?.contains(focusedElement));
        const focusRevision = focusRevisionRef.current;
        const prunedMode = modeRef.current;
        const origin = selectionOriginRef.current;
        selectionGuard.clear();
        cancelAnimationFrame(focusFrameRef.current);
        selectionOriginRef.current = null;
        selectedIdRef.current = undefined;
        setSelectedId(undefined);
        setDetail(undefined);
        setDetailError(undefined);
        setDetailLoading(false);
        if (restoreFocus) {
          focusFrameRef.current = requestAnimationFrame(() => {
            if (
              controller.signal.aborted || selectedIdRef.current ||
              modeRef.current !== prunedMode || !activeRef.current ||
              focusRevisionRef.current !== focusRevision || !document.hasFocus() ||
              (document.activeElement !== document.body && document.activeElement !== focusedElement)
            ) return;
            // A refresh replaces the canvas, so it is not a surviving origin.
            const target = origin?.element.isConnected && !mountRef.current?.contains(origin.element)
              ? origin.element
              : selectorHeadingRef.current;
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({ block: "nearest", behavior: "instant" });
          });
        }
      }
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setReadError(message(loadError));
    }).finally(() => {
      if (!controller.signal.aborted) setReadLoading(false);
    });
    return () => controller.abort();
  }, [reloadKey, selectionGuard]);

  useEffect(() => {
    const markFocusChange = () => { focusRevisionRef.current += 1; };
    document.addEventListener("focusin", markFocusChange, true);
    document.addEventListener("pointerdown", markFocusChange, true);
    return () => {
      document.removeEventListener("focusin", markFocusChange, true);
      document.removeEventListener("pointerdown", markFocusChange, true);
      selectionGuard.clear();
      cancelAnimationFrame(focusFrameRef.current);
    };
  }, [selectionGuard]);

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

  async function selectNode(id: string, origin?: HTMLElement, page?: number) {
    if (!graph.nodes.some((node) => node.id === id)) return;
    const request = selectionGuard.begin(mode, id);
    selectedIdRef.current = id;
    if (origin) selectionOriginRef.current = { element: origin, id, page };
    setSelectedId(id);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailLoading(true);
    if (origin) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = requestAnimationFrame(() => {
        if (!selectionGuard.isCurrent(request)) return;
        inspectorHeadingRef.current?.focus({ preventScroll: true });
        inspectorHeadingRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
      });
    }
    const view = mode === "evidence" ? "universe_node" : "universe_entity";
    try {
      const response = await fetch(
        `/api/memory/graph?view=${view}&id=${encodeURIComponent(id)}`,
        { cache: "no-store", signal: request.controller.signal },
      );
      const body = await response.json();
      if (!selectionGuard.isCurrent(request)) return;
      if (!response.ok) throw new Error(body.error || "Point details could not be loaded.");
      setDetail(universeDetailForSelection(body, request) as SelectedDetail);
    } catch (detailError) {
      if (selectionGuard.isCurrent(request)) setDetailError(message(detailError));
    } finally {
      if (selectionGuard.isCurrent(request)) setDetailLoading(false);
    }
  }
  useEffect(() => {
    selectNodeRef.current = (id, origin) => void selectNode(id, origin);
  });

  useEffect(() => {
    if (!mountRef.current || !payload || !graph.nodes.length) return;
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
      let themeStyle = getComputedStyle(mount);
      const sceneColor = (token: string) => new THREE.Color(resolveThemeColor(themeStyle, token));
      scene.fog = new THREE.FogExp2(themeStyle.backgroundColor, 0.007);
      const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 320);
      camera.position.set(0, 14, 42);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setClearColor(themeStyle.backgroundColor, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      mount.replaceChildren(renderer.domElement);
      renderer.domElement.setAttribute(
        "aria-label",
        mode === "evidence"
          ? "Interactive three-dimensional evidence map"
          : "Interactive three-dimensional map of explicit relationships",
      );
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.tabIndex = 0;
      renderer.domElement.setAttribute("aria-describedby", "universe-canvas-help");

      const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      let reducedMotion = motionQuery.matches;
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !reducedMotion;
      controls.dampingFactor = 0.075;
      controls.enablePan = true;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.screenSpacePanning = true;
      controls.rotateSpeed = 0.62;
      controls.panSpeed = 0.78;
      controls.zoomSpeed = 0.9;
      controls.minDistance = 2.5;
      controls.maxDistance = 120;
      controls.autoRotate = false;

      const positions = layoutNodes(nodes, THREE);
      const graphBounds = new THREE.Box3();
      positions.forEach((position) => graphBounds.expandByPoint(position));
      const graphSphere = graphBounds.isEmpty()
        ? new THREE.Sphere(new THREE.Vector3(), 12)
        : graphBounds.getBoundingSphere(new THREE.Sphere());
      const homeTarget = graphSphere.center.clone();
      const homePosition = new THREE.Vector3();
      const homeDirection = new THREE.Vector3(0, 0.43, 1).normalize();

      // The visible point size and the generous pointer hit target share the
      // same graph weight; keyboard selection uses the loaded metadata list.
      const hitGeometry = new THREE.IcosahedronGeometry(0.25, 1);
      const hitMaterial = new THREE.MeshBasicMaterial();
      hitMaterial.colorWrite = false;
      hitMaterial.depthWrite = false;
      hitMaterial.depthTest = false;
      const hitMesh = new THREE.InstancedMesh(hitGeometry, hitMaterial, nodes.length);
      hitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      hitMesh.renderOrder = -1;

      const pointPositions = new Float32Array(nodes.length * 3);
      const pointColors = new Float32Array(nodes.length * 3);
      const pointSizes = new Float32Array(nodes.length);
      nodes.forEach((node, index) => {
        (positions.get(node.id) || new THREE.Vector3()).toArray(pointPositions, index * 3);
      });
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute("position", new THREE.BufferAttribute(pointPositions, 3));
      pointGeometry.setAttribute("color", new THREE.BufferAttribute(pointColors, 3));
      pointGeometry.setAttribute("nodeSize", new THREE.BufferAttribute(pointSizes, 1));
      const pointMaterial = new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.NormalBlending,
        depthWrite: false,
        toneMapped: false,
        vertexColors: true,
        vertexShader: `
          attribute float nodeSize;
          varying vec3 vColor;

          void main() {
            vColor = color;
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = nodeSize * min(28.0, 360.0 / max(1.0, -viewPosition.z));
            gl_Position = projectionMatrix * viewPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vColor;

          void main() {
            float distanceFromCenter = distance(gl_PointCoord, vec2(0.5));
            if (distanceFromCenter > 0.5) discard;
            gl_FragColor = vec4(vColor, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      const nodePoints = new THREE.Points(pointGeometry, pointMaterial);
      nodePoints.renderOrder = 2;
      nodePoints.frustumCulled = false;
      const dummy = new THREE.Object3D();
      let currentHidden: ReadonlySet<string> = hiddenKindsRef.current;
      let currentSelection = selectedIdRef.current;
      let currentHighlight = selectedIdRef.current;

      const setNodeInstances = () => {
        nodes.forEach((node, index) => {
          const position = positions.get(node.id) || new THREE.Vector3();
          dummy.position.copy(position);
          const emphasis = node.id === currentHighlight ? 1.7 : 1;
          const scale = currentHidden.has(node.kind)
            ? 0
            : Math.min(3.5, 0.9 + Math.sqrt(Math.max(node.weight, 0.05)) * 0.92) * emphasis;
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          hitMesh.setMatrixAt(index, dummy.matrix);
          const color = sceneColor(node.id === currentHighlight ? "--accent" : colorTokenForKind(node.kind, mode));
          color.toArray(pointColors, index * 3);
          pointSizes[index] = scale;
        });
        hitMesh.instanceMatrix.needsUpdate = true;
        hitMesh.updateMatrixWorld(true);
        pointGeometry.getAttribute("color").needsUpdate = true;
        pointGeometry.getAttribute("nodeSize").needsUpdate = true;
      };
      scene.add(hitMesh, nodePoints);

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
      const edgeColor = (edge: SceneEdge) => sceneColor("--line-strong").lerp(
        sceneColor("--foreground"),
        Math.min(0.72, 0.2 + edge.weight * 0.38),
      );
      edgeSegments.forEach(({ edge }) => {
        const color = edgeColor(edge);
        edgeColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      });
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePoints, 3));
      edgeGeometry.setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3));
      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: mode === "evidence" ? 0.8 : 0.9,
        blending: THREE.NormalBlending,
        toneMapped: false,
      });
      edgeMaterial.fog = false;
      const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      scene.add(lines);

      let highlightGeometry = new THREE.BufferGeometry();
      const highlightMaterial = new THREE.LineBasicMaterial({
        color: sceneColor("--accent"),
        transparent: true,
        opacity: 0.82,
        blending: THREE.NormalBlending,
      });
      const highlightLines = new THREE.LineSegments(highlightGeometry, highlightMaterial);
      scene.add(highlightLines);

      const selectionRingGeometry = new THREE.TorusGeometry(0.48, 0.024, 10, 48);
      const selectionRingMaterial = new THREE.MeshBasicMaterial({
        color: sceneColor("--accent"),
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
        selectionRing.visible = Boolean(position && id === currentSelection);
        if (position) {
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
        const nextHighlightGeometry = new THREE.BufferGeometry().setFromPoints(points);
        highlightGeometry.dispose();
        highlightGeometry = nextHighlightGeometry;
        highlightLines.geometry = nextHighlightGeometry;
        edgeMaterial.opacity = id ? 0.08 : mode === "evidence" ? 0.8 : 0.9;
        setNodeInstances();
      };

      const setHiddenKinds = (hidden: ReadonlySet<string>) => {
        currentHidden = hidden;
        setNodeInstances();
        setEdgeSegments();
        setHighlight(currentHighlight);
      };
      setHiddenKinds(hiddenKindsRef.current);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerStart: { x: number; y: number } | undefined;
      const findHit = (event: PointerEvent) => {
        const rect = renderer?.domElement.getBoundingClientRect();
        if (!rect) return undefined;
        pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(hitMesh, false)[0];
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
        if (node && !currentHidden.has(node.kind)) selectNodeRef.current(node.id, renderer!.domElement);
      };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerup", onPointerUp);

      type CameraTransition = {
        startedAt: number;
        duration: number;
        fromPosition: import("three").Vector3;
        fromTarget: import("three").Vector3;
        toPosition: import("three").Vector3;
        toTarget: import("three").Vector3;
      };
      let cameraTransition: CameraTransition | undefined;

      const cancelCameraTransition = () => {
        cameraTransition = undefined;
      };
      const onControlsStart = () => {
        controls.autoRotate = false;
        cancelCameraTransition();
      };
      controls.addEventListener("start", onControlsStart);

      const transitionCamera = (
        toPosition: import("three").Vector3,
        toTarget: import("three").Vector3,
        duration = 520,
      ) => {
        controls.autoRotate = false;
        if (reducedMotion || duration === 0) {
          camera.position.copy(toPosition);
          controls.target.copy(toTarget);
          cameraTransition = undefined;
          controls.update();
          return;
        }
        cameraTransition = {
          startedAt: performance.now(),
          duration,
          fromPosition: camera.position.clone(),
          fromTarget: controls.target.clone(),
          toPosition: toPosition.clone(),
          toTarget: toTarget.clone(),
        };
      };

      const updateHomePosition = () => {
        const paddedRadius = graphSphere.radius + 1;
        const distance = Math.max(18, universeSphereFitDistance(
          paddedRadius,
          camera.getEffectiveFOV(),
          camera.aspect,
        ));
        homePosition.copy(homeTarget).add(homeDirection.clone().multiplyScalar(distance));
        controls.maxDistance = Math.max(120, distance * 2.8);
        camera.far = Math.max(320, controls.maxDistance + paddedRadius * 2);
        camera.updateProjectionMatrix();
      };

      const focusNode = (id?: string) => {
        currentSelection = id;
        setHighlight(id);
        const position = id ? positions.get(id) : undefined;
        if (!position) return;
        const offset = camera.position.clone().sub(controls.target);
        if (offset.lengthSq() < 0.01) offset.copy(homeDirection);
        const focusDistance = THREE.MathUtils.clamp(offset.length() * 0.46, 6.8, 11.5);
        transitionCamera(
          position.clone().add(offset.normalize().multiplyScalar(focusDistance)),
          position,
          440,
        );
      };
      const fit = () => {
        updateHomePosition();
        transitionCamera(homePosition, homeTarget, 620);
      };
      const zoomBy = (factor: number) => {
        cancelCameraTransition();
        const offset = camera.position.clone().sub(controls.target);
        const distance = THREE.MathUtils.clamp(
          Math.max(offset.length(), controls.minDistance) * factor,
          controls.minDistance,
          controls.maxDistance,
        );
        if (offset.lengthSq() < 0.01) offset.copy(homeDirection);
        camera.position.copy(controls.target).add(offset.normalize().multiplyScalar(distance));
        controls.update();
      };

      let initialFitComplete = false;
      const resize = () => {
        if (!renderer) return;
        const width = mount.clientWidth;
        const height = mount.clientHeight;
        // A hidden parent can mount the renderer before it has real dimensions.
        if (width <= 1 || height <= 1) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        if (!initialFitComplete) {
          updateHomePosition();
          camera.position.copy(homePosition);
          controls.target.copy(homeTarget);
          controls.update();
          initialFitComplete = true;
        }
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();

      let rendering = false;
      let contextLost = false;
      const draw = () => {
        if (disposed || !renderer || !rendering || contextLost) return;
        const now = performance.now();
        if (cameraTransition) {
          const progress = Math.min(1, (now - cameraTransition.startedAt) / cameraTransition.duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          camera.position.lerpVectors(
            cameraTransition.fromPosition,
            cameraTransition.toPosition,
            eased,
          );
          controls.target.lerpVectors(
            cameraTransition.fromTarget,
            cameraTransition.toTarget,
            eased,
          );
          if (progress >= 1) {
            cameraTransition = undefined;
          }
        }
        controls.autoRotate = false;
        if (selectionRing.visible) selectionRing.lookAt(camera.position);
        controls.update();
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(draw);
      };
      const setActive = (nextActive: boolean) => {
        if (nextActive && !rendering && !contextLost) {
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
        fit,
        zoomBy,
      };
      const updateTheme = () => {
        themeStyle = getComputedStyle(mount);
        renderer?.setClearColor(themeStyle.backgroundColor, 1);
        scene.fog?.color.set(themeStyle.backgroundColor);
        const colors = edgeGeometry.getAttribute("color");
        edgeSegments.forEach(({ edge }, index) => {
          const color = edgeColor(edge);
          colors.setXYZ(index * 2, color.r, color.g, color.b);
          colors.setXYZ(index * 2 + 1, color.r, color.g, color.b);
        });
        colors.needsUpdate = true;
        highlightMaterial.color.copy(sceneColor("--accent"));
        selectionRingMaterial.color.copy(sceneColor("--accent"));
        setNodeInstances();
      };
      const themeObserver = new MutationObserver(updateTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const contrastQuery = window.matchMedia("(forced-colors: active)");
      schemeQuery.addEventListener("change", updateTheme);
      contrastQuery.addEventListener("change", updateTheme);
      const updateMotion = () => {
        reducedMotion = motionQuery.matches;
        controls.enableDamping = !reducedMotion;
        if (reducedMotion && cameraTransition) {
          camera.position.copy(cameraTransition.toPosition);
          controls.target.copy(cameraTransition.toTarget);
          cameraTransition = undefined;
          controls.update();
        }
      };
      motionQuery.addEventListener("change", updateMotion);
      const onContextLost = (event: Event) => {
        event.preventDefault();
        contextLost = true;
        setActive(false);
        setSceneReady(false);
        setSceneError("The 3D renderer lost its context. You can still browse and inspect the loaded points.");
      };
      renderer.domElement.addEventListener("webglcontextlost", onContextLost);

      disposeScene = () => {
        cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();
        renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer?.domElement.removeEventListener("pointermove", onPointerMove);
        renderer?.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer?.domElement.removeEventListener("pointerup", onPointerUp);
        controls.removeEventListener("start", onControlsStart);
        controls.dispose();
        hitGeometry.dispose();
        hitMaterial.dispose();
        pointGeometry.dispose();
        pointMaterial.dispose();
        edgeGeometry.dispose();
        edgeMaterial.dispose();
        highlightGeometry.dispose();
        highlightMaterial.dispose();
        selectionRingGeometry.dispose();
        selectionRingMaterial.dispose();
        themeObserver.disconnect();
        schemeQuery.removeEventListener("change", updateTheme);
        contrastQuery.removeEventListener("change", updateTheme);
        motionQuery.removeEventListener("change", updateMotion);
        renderer?.domElement.removeEventListener("webglcontextlost", onContextLost);
        renderer?.dispose();
        renderer?.domElement.remove();
        sceneControllerRef.current = null;
      };
      focusNode(selectedIdRef.current);
      setActive(activeRef.current);
      setSceneReady(true);
      setSceneError(undefined);
    }).catch((sceneError) => {
      if (!disposed) {
        cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();
        setSceneReady(false);
        setSceneError(message(sceneError));
        if (disposeScene) disposeScene();
        else {
          renderer?.dispose();
          renderer?.domElement.remove();
          sceneControllerRef.current = null;
        }
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      disposeScene?.();
    };
  }, [graph, mode, payload, sceneKey]);

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

  const visibleNodes = useMemo(() => graph.nodes.filter(
    (node) => !hiddenKinds.has(node.kind),
  ), [graph.nodes, hiddenKinds]);
  const pageCount = Math.max(1, Math.ceil(visibleNodes.length / 40));
  const currentPage = Math.min(nodePage, pageCount - 1);
  const pageNodes = visibleNodes.slice(currentPage * 40, (currentPage + 1) * 40);
  const drawnEdgeCount = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    return [...graph.edges]
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
      .slice(0, mode === "evidence" ? 5_000 : 2_000)
      .filter((edge) => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId)).length;
  }, [graph.edges, mode, visibleNodes]);
  const connections = useMemo(() => {
    if (!selectedId) return [];
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.filter((edge) =>
      edge.sourceNodeId === selectedId || edge.targetNodeId === selectedId
    ).slice(0, 8).map((edge) => {
      const otherId = edge.sourceNodeId === selectedId
        ? edge.targetNodeId
        : edge.sourceNodeId;
      return { id: otherId, relation: edge.relation, kind: nodeById.get(otherId)?.kind || "point" };
    });
  }, [graph.edges, graph.nodes, selectedId]);
  const connectionTotal = selectedId
    ? graph.edges.filter((edge) =>
        edge.sourceNodeId === selectedId || edge.targetNodeId === selectedId
      ).length
    : 0;

  function changeMode(nextMode: GraphMode) {
    if (nextMode === mode) return;
    clearSelection(false);
    modeRef.current = nextMode;
    setMode(nextMode);
    setHiddenKinds(new Set());
    hiddenKindsRef.current = new Set();
    setNodePage(0);
    setSceneReady(false);
    setSceneError(undefined);
  }

  function toggleKind(kind: string) {
    if (!hiddenKinds.has(kind) && graph.nodes.find((node) => node.id === selectedId)?.kind === kind) clearSelection(false);
    setNodePage(0);
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function clearSelection(restoreFocus = true) {
    selectionGuard.clear();
    cancelAnimationFrame(focusFrameRef.current);
    selectedIdRef.current = undefined;
    setSelectedId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailLoading(false);
    const origin = selectionOriginRef.current;
    selectionOriginRef.current = null;
    if (!restoreFocus || !origin) return;
    if (origin.page !== undefined) setNodePage(origin.page);
    focusFrameRef.current = requestAnimationFrame(() => {
      const target = origin.element.isConnected ? origin.element : selectorButtonsRef.current.get(origin.id) || selectorHeadingRef.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  }

  function refreshMap() {
    setReadLoading(true);
    setReloadKey((current) => current + 1);
  }

  function fitView() {
    sceneControllerRef.current?.fit();
  }

  function zoomView(factor: number) {
    sceneControllerRef.current?.zoomBy(factor);
  }

  async function rebuildGraph() {
    if (rebuilding) return;
    setRebuilding(true);
    setRebuildError(undefined);
    setRebuildNotice(undefined);
    try {
      const response = await fetch("/api/memory/graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "memory-universe" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The evidence map could not be rebuilt.");
      setRebuildNotice("Evidence map rebuild completed.");
      refreshMap();
    } catch (rebuildError) {
      setRebuildError(message(rebuildError));
    } finally {
      setRebuilding(false);
    }
  }

  const build = payload?.evidence.stats.latestBuild;
  const health = payload ? buildHealth(build) : { label: readLoading ? "Loading build status…" : "Build status unavailable", tone: "calm" };
  const explicitEmpty = mode === "verified" && graph.edges.length === 0;

  return (
    <section className={styles.shell} aria-labelledby="memory-universe-title">
      <header className={styles.header}>
        <div className={styles.heading}>
          <p>Memory relationships</p>
          <h2 id="memory-universe-title">Universe</h2>
          <span>Explore connections, then select a point to inspect its evidence.</span>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.health} ${health.tone === "danger" ? styles.healthDanger : ""}`}>{health.label}</span>
          <button type="button" onClick={refreshMap} disabled={readLoading}><RefreshCw size={17} aria-hidden="true" /> Refresh map</button>
          <button type="button" onClick={() => void rebuildGraph()} disabled={rebuilding} aria-describedby="universe-rebuild-status">
            <GitBranch size={17} aria-hidden="true" />{rebuilding ? "Rebuilding map…" : "Rebuild map"}
          </button>
        </div>
      </header>
      <p id="universe-rebuild-status" className={styles.resourceStatus} role="status">{rebuilding ? "Rebuilding the evidence map. This may take a moment." : rebuildNotice || ""}</p>
      <div className={styles.error} role="alert">{rebuildError ? <><CircleAlert size={18} aria-hidden="true" /><span>Rebuild failed. {rebuildError}</span></> : null}</div>
      <div className={styles.error} role="alert">{readError ? <><CircleAlert size={18} aria-hidden="true" /><span>{readError} {payload ? "The last loaded snapshot is still available." : "The graph could not be checked."}</span><button type="button" onClick={refreshMap} disabled={readLoading}>Retry map read</button></> : null}</div>
      <p className={styles.resourceStatus} role="status">{readLoading ? payload ? "Refreshing the map. Showing the last loaded snapshot." : "Loading the graph snapshot…" : payload && readError ? "Showing the last loaded snapshot." : ""}</p>

      <div className={styles.modeBar}>
        <div className={styles.modeSwitch} role="group" aria-label="Universe data layer">
          <button type="button" aria-pressed={mode === "evidence"} className={mode === "evidence" ? styles.activeMode : undefined} onClick={() => changeMode("evidence")} aria-label="Evidence map">
            <Layers3 size={17} aria-hidden="true" /><span><strong>Evidence map</strong><small>Observed connections</small></span>
          </button>
          <button type="button" aria-pressed={mode === "verified"} className={mode === "verified" ? styles.activeMode : undefined} onClick={() => changeMode("verified")} aria-label="Explicit relationships">
            <ShieldCheck size={17} aria-hidden="true" /><span><strong>Explicit relationships</strong><small>Typed source claims</small></span>
          </button>
        </div>
        <p className={styles.layerNote}>{mode === "evidence"
          ? "A line means signals appeared together or were recalled together. It is a clue, not a fact."
          : "Lines represent explicit source claims. They may include facts, procedures, opinions or predictions; a connection does not establish truth."}</p>
      </div>

      {payload ? <>
        <dl className={styles.counter} aria-label="Loaded graph coverage">
          <div><dt>Points matching filters</dt><dd>{visibleNodes.length.toLocaleString()} of {graph.nodes.length.toLocaleString()} loaded</dd></div>
          <div><dt>Drawn links</dt><dd>{sceneReady ? drawnEdgeCount.toLocaleString() : sceneError ? "Unavailable" : graph.nodes.length ? "Preparing…" : "0"} of {graph.edges.length.toLocaleString()} loaded</dd></div>
          <div><dt>Snapshot generated</dt><dd>{formatDate(payload.generatedAt)}{readLoading || readError ? " · Last loaded" : ""}</dd></div>
          {mode === "evidence" && build ? <div><dt>Latest build duration</dt><dd>{formatDuration(build.latencyMs)}</dd></div> : null}
        </dl>
        <p className={styles.coverageNote}>{mode === "evidence"
          ? "This snapshot is bounded to 10,000 evidence points and 20,000 links. The canvas draws up to 5,000 of its strongest links; filters can hide more."
          : "Explicit relationships use a sample of up to 200 claims. The canvas draws up to 2,000 loaded links; filters can hide more."}</p>
        {mode === "verified" && payload.verified.stats.relationLimitSaturated ? <p className={styles.limitNotice} role="status">The 200-claim query limit was reached. Additional relationships may exist outside this snapshot.</p> : null}
        {kindMeta.length ? <div className={styles.legend} role="group" aria-label="Graph filters">{kindMeta.map(({ kind, label, color, count }) => (
          <button type="button" key={kind} className={hiddenKinds.has(kind) ? styles.hiddenKind : undefined} onClick={() => toggleKind(kind)} aria-pressed={!hiddenKinds.has(kind)} aria-label={label}>
            <i style={{ background: color }} aria-hidden="true" />{label}<small>{count.toLocaleString()}</small><span>{hiddenKinds.has(kind) ? "Hidden" : "Shown"}</span>
          </button>
        ))}</div> : null}
      </> : null}

      <div className={styles.stage}>
        <div ref={mountRef} className={styles.canvas} />
        {!payload ? <div className={styles.stageState}>{readLoading ? "Loading the graph snapshot…" : "The graph is unavailable. Retry the map read above."}</div> : null}
        {payload && graph.nodes.length > 0 && !sceneReady && !sceneError ? <div className={styles.stageState} role="status">Preparing the 3D view. Loaded points are available below.</div> : null}
        {payload && !graph.nodes.length ? <div className={styles.stageState}><h3>{mode === "evidence" ? "No evidence points in this snapshot" : "No explicit entities in this snapshot"}</h3><p>{mode === "evidence" ? "Evidence points will appear after eligible memory and recall activity are indexed." : "Add a connected fact to record an explicit relationship."}</p></div> : null}
      </div>
      <div className={styles.error} role="alert">{sceneError ? <><CircleAlert size={18} aria-hidden="true" /><span>3D view unavailable. {sceneError} The loaded-point selector remains available.</span><button type="button" onClick={() => { setSceneReady(false); setSceneError(undefined); setSceneKey((current) => current + 1); }}>Retry graph rendering</button></> : null}</div>
      <div className={styles.cameraBar}>
        <p id="universe-canvas-help">Drag to rotate, Shift-drag to pan, or scroll to zoom. Use Browse loaded points below to inspect points with a keyboard.</p>
        <div className={styles.cameraControls} role="group" aria-label="Universe camera controls">
          <button type="button" onClick={() => zoomView(0.72)} aria-label="Zoom in" disabled={!sceneReady}><ZoomIn size={18} aria-hidden="true" /></button>
          <button type="button" onClick={() => zoomView(1.38)} aria-label="Zoom out" disabled={!sceneReady}><ZoomOut size={18} aria-hidden="true" /></button>
          <button type="button" onClick={fitView} disabled={!sceneReady}><Focus size={17} aria-hidden="true" /> Fit view</button>
        </div>
      </div>
      {explicitEmpty && payload ? <section className={styles.emptyExplicit} aria-label="Explicit relationship coverage">
        <h3>No explicit links in this snapshot</h3>
        <p>{payload.verified.stats.nodes ? `${payload.verified.stats.nodes.toLocaleString()} typed entities are loaded, but this snapshot contains no links between them.` : "Record a connected fact to index its entities and explicit relationship."}</p>
        {props.onAddConnectedFact ? <button type="button" onClick={props.onAddConnectedFact}><Plus size={16} aria-hidden="true" /> Add connected fact</button> : null}
      </section> : null}

      <div className={styles.explorer}>
        <section className={styles.selector} aria-labelledby="universe-selector-title">
          <header><h3 id="universe-selector-title" ref={selectorHeadingRef} tabIndex={-1}>Browse loaded points</h3><p id="universe-selection-note">Only opaque IDs, kinds and source counts are shown here. Labels and summaries load when you select a point.</p></header>
          <p className={styles.selectorStatus} role="status">{payload ? visibleNodes.length ? `Showing ${currentPage * 40 + 1}–${currentPage * 40 + pageNodes.length} of ${visibleNodes.length.toLocaleString()} visible loaded points${readLoading || readError ? " · Last loaded" : ""}` : graph.nodes.length ? "All loaded points are hidden by filters." : "No points were returned in this snapshot." : readLoading ? "Loading point metadata…" : "Point metadata is unavailable."}</p>
          <ol className={styles.pointList} aria-label="Loaded graph points" start={currentPage * 40 + 1}>{pageNodes.map((node, index) => (
            <li key={node.id}>
              <button type="button" ref={(element) => { if (element) selectorButtonsRef.current.set(node.id, element); else selectorButtonsRef.current.delete(node.id); }} aria-label={`Inspect point ${currentPage * 40 + index + 1}: ${labelForKind(node.kind, mode)}`} aria-pressed={selectedId === node.id} aria-describedby="universe-selection-note" onClick={(event) => void selectNode(node.id, event.currentTarget, currentPage)}>
                <span><strong>Point {currentPage * 40 + index + 1} · {labelForKind(node.kind, mode)}</strong><small>{node.sourceCount.toLocaleString()} {node.sourceCount === 1 ? "source" : "sources"}</small></span>
                <code>{node.id}</code>
              </button>
            </li>
          ))}</ol>
          {payload && visibleNodes.length > 40 ? <nav className={styles.pagination} aria-label="Loaded point pages"><button type="button" onClick={() => setNodePage(currentPage - 1)} disabled={currentPage === 0}>Previous points</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" onClick={() => setNodePage(currentPage + 1)} disabled={currentPage >= pageCount - 1}>Next points</button></nav> : null}
        </section>

        {selectedId ? <aside ref={inspectorRef} className={styles.inspector} aria-labelledby="universe-point-details-title">
          <header><h3 id="universe-point-details-title" ref={inspectorHeadingRef} tabIndex={-1}>Point details</h3><button type="button" className={styles.close} onClick={() => clearSelection()} aria-label="Close point details"><X size={18} aria-hidden="true" /></button></header>
          <p className={styles.selectedIdentity}><code>{selectedId}</code></p>
          <p className={styles.detailStatus} role="status">{detailLoading ? "Loading the selected point…" : detail ? "Selected point details loaded." : ""}</p>
          <div className={styles.error} role="alert">{detailError ? <><CircleAlert size={18} aria-hidden="true" /><span>{detailError}</span><button type="button" onClick={() => void selectNode(selectedId)} disabled={detailLoading}>Retry point details</button></> : null}</div>
          {detail ? <>
            <p className={styles.detailKind}>{labelForKind(detail.kind, mode)}{detail.state ? ` · ${startCase(detail.state)}` : ""}</p>
            <h4>{detail.label}</h4>
            <p className={styles.detailSummary}>{detail.summary || "No summary was returned for this point."}</p>
            <dl>
              <div><dt>Evidence sources</dt><dd>{detail.sourceCount.toLocaleString()}</dd></div>
              <div><dt>Direct links in loaded snapshot</dt><dd>{connectionTotal.toLocaleString()}</dd></div>
              {detail.weight !== undefined ? <div><dt>Signal weight</dt><dd>{detail.weight.toLocaleString()}</dd></div> : null}
              <div><dt>Last indexed</dt><dd>{formatDate(detail.updatedAt)}</dd></div>
            </dl>
            {connections.length ? <section className={styles.connections} aria-label="Loaded connections"><h5>Connections in this snapshot</h5><p>Showing {connections.length} of {connectionTotal.toLocaleString()} loaded connections. Other connections may exist outside this sample.</p><ul>{connections.map((connection, index) => <li key={`${connection.id}:${connection.relation}:${index}`}><strong>{startCase(connection.relation)} → {labelForKind(connection.kind, mode)}</strong><code>{connection.id}</code></li>)}</ul></section> : null}
            {detail.tags?.length ? <div className={styles.tags} aria-label="Point tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
          </> : null}
        </aside> : <div className={styles.inspectorEmpty}><h3>Inspect a point</h3><p>Select a loaded point or a point on the canvas to read its label, summary and available connections.</p></div>}
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
    group.forEach((node, index) => {
      const ratio = (index + 0.5) / Math.max(group.length, 1);
      const angle = index * 2.399963 + seeded(node.id) * Math.PI * 2;
      const isConceptField = kind === "concept" && group.length > 100;
      const baseRadius = isConceptField ? 2.4 : 12.5 + kindIndex * 1.85;
      const radius = isConceptField
        ? baseRadius + Math.sqrt(ratio) * 9.8 + (seeded(`${node.id}:r`) - 0.5) * 0.65
        : baseRadius + (ratio - 0.5) * 1.5 + (seeded(`${node.id}:r`) - 0.5) * 0.55;
      const inclination = (kindIndex % 2 ? -1 : 1) * (0.07 + kindIndex * 0.012);
      const depth = (seeded(`${node.id}:depth`) - 0.5) * (isConceptField ? 4.8 : 2.2);
      positions.set(node.id, new THREE.Vector3(
        Math.cos(angle) * radius,
        depth + Math.sin(angle) * radius * inclination,
        Math.sin(angle) * radius,
      ));
    });
  });
  return positions;
}

function colorTokenForKind(kind: string, mode: GraphMode) {
  if (mode === "evidence" && kind in evidenceColors) {
    return evidenceColors[kind as MemoryGraphNodeKind];
  }
  if (mode === "verified" && kind in entityColors) {
    return entityColors[kind as EntityTypeId];
  }
  return "--muted";
}

function colorForKind(kind: string, mode: GraphMode) {
  return `var(${colorTokenForKind(kind, mode)})`;
}

function resolveThemeColor(style: CSSStyleDeclaration, token: string) {
  const value = style.getPropertyValue(token).trim();
  return /^(#|rgb|hsl)/.test(value) ? value : style.color;
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
  if (!build) return { label: "No evidence build recorded", tone: "calm" as const };
  if (build.status === "failed") return { label: "Latest evidence build failed", tone: "danger" as const };
  const age = Date.now() - new Date(build.createdAt).getTime();
  if (age > 86_400_000) return { label: "Evidence build over a day old", tone: "calm" as const };
  return { label: "Evidence build completed", tone: "calm" as const };
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
