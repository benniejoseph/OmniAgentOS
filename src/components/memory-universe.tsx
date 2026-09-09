"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Focus,
  LoaderCircle,
  Maximize2,
  Rotate3D,
  Sparkles,
  X,
} from "lucide-react";
import type {
  MemoryGraphEdgeRelation,
  MemoryGraphNodeKind,
} from "@/lib/memory/types";
import styles from "@/components/memory-universe.module.css";

type UniverseNode = {
  id: string;
  kind: MemoryGraphNodeKind;
  weight: number;
  sourceCount: number;
  updatedAt: string;
};

type UniverseEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: MemoryGraphEdgeRelation;
  weight: number;
  evidenceCount: number;
};

type UniversePayload = {
  version: "memory-universe:1";
  generatedAt: string;
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  stats: {
    nodes: number;
    edges: number;
    kinds: Record<string, number>;
    relations: Record<string, number>;
    latestUpdatedAt: string | null;
  };
};

type UniverseNodeDetail = {
  id: string;
  kind: MemoryGraphNodeKind;
  label: string;
  summary: string;
  tags: string[];
  weight: number;
  sourceCount: number;
  updatedAt: string;
};

type UniverseSceneController = {
  setHiddenKinds: (hiddenKinds: ReadonlySet<MemoryGraphNodeKind>) => void;
  setActive: (active: boolean) => void;
  reset: () => void;
};

const kindColors: Record<MemoryGraphNodeKind, string> = {
  concept: "#90ead0",
  tag: "#ffd18a",
  system: "#99c7ff",
  workflow: "#d4b4ff",
  tool: "#ff9fae",
  memory: "#fff4c6",
  trace: "#91a6c9",
};

const kindLabels: Record<MemoryGraphNodeKind, string> = {
  concept: "Concepts",
  tag: "Tags",
  system: "Systems",
  workflow: "Workflows",
  tool: "Tools",
  memory: "Memories",
  trace: "Recall traces",
};

export function MemoryUniverse({ active }: { active: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneControllerRef = useRef<UniverseSceneController | null>(null);
  const [payload, setPayload] = useState<UniversePayload>();
  const [hiddenKinds, setHiddenKinds] = useState<Set<MemoryGraphNodeKind>>(
    new Set(),
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<UniverseNodeDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const hiddenKindsRef = useRef(hiddenKinds);
  const activeRef = useRef(active);

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
  }, []);

  useEffect(() => {
    if (!mountRef.current || !payload) return;
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
      const nodes = payload.nodes;
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x071318, 0.026);
      const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 160);
      camera.position.set(0, 4, 29);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setClearColor(0x071318, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.replaceChildren(renderer.domElement);
      renderer.domElement.setAttribute(
        "aria-label",
        "Interactive three-dimensional map of linked memory and knowledge concepts",
      );
      renderer.domElement.setAttribute("role", "img");

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.055;
      controls.minDistance = 5;
      controls.maxDistance = 58;
      controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      controls.autoRotateSpeed = 0.16;

      const positions = layoutNodes(nodes, THREE);
      const geometry = new THREE.IcosahedronGeometry(0.12, 1);
      const material = new THREE.MeshBasicMaterial({ vertexColors: true });
      const mesh = new THREE.InstancedMesh(geometry, material, nodes.length);
      const dummy = new THREE.Object3D();
      const setNodeInstances = (hidden: ReadonlySet<MemoryGraphNodeKind>) => {
        nodes.forEach((node, index) => {
          const position = positions.get(node.id) || new THREE.Vector3();
          dummy.position.copy(position);
          const scale = hidden.has(node.kind)
            ? 0
            : Math.min(
                2.8,
                0.7 + Math.sqrt(Math.max(node.weight, 0.05)) * 0.75,
              );
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          mesh.setMatrixAt(index, dummy.matrix);
          mesh.setColorAt(index, new THREE.Color(kindColors[node.kind]));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      };
      scene.add(mesh);

      const edgeSegments: Array<{
        source: import("three").Vector3;
        target: import("three").Vector3;
        sourceKind: MemoryGraphNodeKind;
        targetKind: MemoryGraphNodeKind;
      }> = [];
      const edgeColors: number[] = [];
      for (const edge of payload.edges) {
        const source = positions.get(edge.sourceNodeId);
        const target = positions.get(edge.targetNodeId);
        const sourceNode = nodeById.get(edge.sourceNodeId);
        const targetNode = nodeById.get(edge.targetNodeId);
        if (!source || !target || !sourceNode || !targetNode) continue;
        edgeSegments.push({
          source,
          target,
          sourceKind: sourceNode.kind,
          targetKind: targetNode.kind,
        });
        const intensity = Math.min(0.68, 0.14 + edge.weight * 0.32);
        edgeColors.push(0.28, intensity + 0.22, intensity, 0.28, intensity + 0.22, intensity);
      }
      const edgePoints = new Float32Array(edgeSegments.length * 6);
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePoints, 3));
      edgeGeometry.setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3));
      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.24,
        blending: THREE.AdditiveBlending,
      });
      const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      scene.add(lines);

      const setEdgeSegments = (hidden: ReadonlySet<MemoryGraphNodeKind>) => {
        edgeSegments.forEach((segment, index) => {
          const offset = index * 6;
          if (hidden.has(segment.sourceKind) || hidden.has(segment.targetKind)) {
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

      const setHiddenKinds = (hidden: ReadonlySet<MemoryGraphNodeKind>) => {
        setNodeInstances(hidden);
        setEdgeSegments(hidden);
      };
      setHiddenKinds(hiddenKindsRef.current);

      const stars = starField(THREE);
      scene.add(stars.points);
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerStart: { x: number; y: number } | undefined;
      const onPointerDown = (event: PointerEvent) => {
        pointerStart = { x: event.clientX, y: event.clientY };
      };
      const onPointerUp = (event: PointerEvent) => {
        if (!pointerStart || Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y,
        ) > 5) return;
        const rect = renderer?.domElement.getBoundingClientRect();
        if (!rect) return;
        pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(mesh, false)[0];
        if (hit?.instanceId === undefined) return;
        const node = nodes[hit.instanceId];
        if (node) void selectNode(node.id);
      };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointerup", onPointerUp);

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

      const reset = () => {
        camera.position.set(0, 4, 29);
        controls.target.set(0, 0, 0);
        controls.update();
      };
      let rendering = false;
      const draw = () => {
        if (disposed || !renderer || !rendering) return;
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
      sceneControllerRef.current = { setHiddenKinds, setActive, reset };
      setActive(activeRef.current);

      disposeScene = () => {
        cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();
        renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer?.domElement.removeEventListener("pointerup", onPointerUp);
        controls.dispose();
        geometry.dispose();
        material.dispose();
        edgeGeometry.dispose();
        edgeMaterial.dispose();
        stars.geometry.dispose();
        stars.material.dispose();
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

    async function selectNode(id: string) {
      setSelectedId(id);
      setDetail(undefined);
      setDetailLoading(true);
      try {
        const response = await fetch(
          `/api/memory/graph?view=universe_node&id=${encodeURIComponent(id)}`,
          { cache: "no-store" },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Concept details could not be loaded.");
        setDetail(body.node as UniverseNodeDetail);
      } catch (detailError) {
        setError(message(detailError));
      } finally {
        setDetailLoading(false);
      }
    }
  }, [payload]);

  useEffect(() => {
    hiddenKindsRef.current = hiddenKinds;
    sceneControllerRef.current?.setHiddenKinds(hiddenKinds);
  }, [hiddenKinds]);

  useEffect(() => {
    activeRef.current = active;
    sceneControllerRef.current?.setActive(active);
  }, [active]);

  const shownNodeCount = useMemo(() => payload?.nodes.filter(
    (node) => !hiddenKinds.has(node.kind),
  ).length || 0, [payload, hiddenKinds]);

  function toggleKind(kind: MemoryGraphNodeKind) {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function resetView() {
    sceneControllerRef.current?.reset();
  }

  return (
    <section className={styles.shell} aria-labelledby="memory-universe-title">
      <header className={styles.header}>
        <div>
          <p><Sparkles size={14} /> Relationship universe</p>
          <h2 id="memory-universe-title">See how your knowledge connects.</h2>
          <span>Drag to orbit · scroll to zoom · select a point to reveal its meaning</span>
        </div>
        <button type="button" onClick={resetView}>
          <Focus size={16} /> Reset view
        </button>
      </header>

      <div className={styles.stage}>
        <div ref={mountRef} className={styles.canvas} />
        {!payload && !error ? (
          <div className={styles.loading}>
            <LoaderCircle size={22} className={styles.spin} />
            Mapping relationships…
          </div>
        ) : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {payload ? (
          <div className={styles.counter}>
            <Rotate3D size={15} />
            <strong>{shownNodeCount.toLocaleString()}</strong> points
            <span>{payload.stats.edges.toLocaleString()} links</span>
          </div>
        ) : null}
        <div className={styles.legend} aria-label="Graph filters">
          {(Object.entries(kindLabels) as Array<[MemoryGraphNodeKind, string]>)
            .filter(([kind]) => Boolean(payload?.stats.kinds[kind]))
            .map(([kind, label]) => (
              <button
                type="button"
                key={kind}
                className={hiddenKinds.has(kind) ? styles.hiddenKind : undefined}
                onClick={() => toggleKind(kind)}
                aria-pressed={!hiddenKinds.has(kind)}
              >
                <i style={{ background: kindColors[kind] }} />
                {label}
                <small>{payload?.stats.kinds[kind]?.toLocaleString()}</small>
              </button>
            ))}
        </div>

        {selectedId ? (
          <aside className={styles.inspector} aria-live="polite">
            <button
              type="button"
              className={styles.close}
              onClick={() => { setSelectedId(undefined); setDetail(undefined); }}
              aria-label="Close concept details"
            ><X size={16} /></button>
            {detailLoading ? (
              <div className={styles.detailLoading}>
                <LoaderCircle size={20} className={styles.spin} /> Inspecting point…
              </div>
            ) : detail ? (
              <>
                <p><i style={{ background: kindColors[detail.kind] }} /> {kindLabels[detail.kind]}</p>
                <h3>{detail.label}</h3>
                <span>{detail.summary || "This point groups related evidence and recall activity."}</span>
                <dl>
                  <div><dt>Evidence sources</dt><dd>{detail.sourceCount}</dd></div>
                  <div><dt>Connection weight</dt><dd>{Math.round(detail.weight * 100)}%</dd></div>
                  <div><dt>Last indexed</dt><dd>{formatDate(detail.updatedAt)}</dd></div>
                </dl>
                {detail.tags.length ? (
                  <div className={styles.tags}>{detail.tags.map((tag) => <em key={tag}>{tag}</em>)}</div>
                ) : null}
              </>
            ) : null}
          </aside>
        ) : null}
        <div className={styles.cornerMark}><Maximize2 size={14} /> 3D index</div>
      </div>
    </section>
  );
}

function layoutNodes(
  nodes: readonly UniverseNode[],
  THREE: typeof import("three"),
) {
  const positions = new Map<string, import("three").Vector3>();
  const kinds = Object.keys(kindLabels) as MemoryGraphNodeKind[];
  const grouped = new Map(kinds.map((kind) => [kind, [] as UniverseNode[]]));
  nodes.forEach((node) => grouped.get(node.kind)?.push(node));
  kinds.forEach((kind, kindIndex) => {
    const group = grouped.get(kind) || [];
    const angle = kindIndex / kinds.length * Math.PI * 2;
    const center = new THREE.Vector3(
      Math.cos(angle) * 8.4,
      Math.sin(angle * 1.7) * 3.4,
      Math.sin(angle) * 8.4,
    );
    group.forEach((node, index) => {
      const random = seeded(node.id);
      const phi = Math.acos(1 - 2 * ((index + 0.5) / Math.max(group.length, 1)));
      const theta = Math.PI * (1 + Math.sqrt(5)) * index + random * 1.8;
      const radius = 1.4 + Math.cbrt(index + 1) * 0.7 + random * 1.5;
      positions.set(node.id, new THREE.Vector3(
        center.x + Math.sin(phi) * Math.cos(theta) * radius,
        center.y + Math.cos(phi) * radius * 0.65,
        center.z + Math.sin(phi) * Math.sin(theta) * radius,
      ));
    });
  });
  return positions;
}

function starField(THREE: typeof import("three")) {
  const positions: number[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const radius = 35 + seeded(`star-${index}`) * 35;
    const theta = seeded(`theta-${index}`) * Math.PI * 2;
    const phi = Math.acos(1 - 2 * seeded(`phi-${index}`));
    positions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xa7e7d6,
    size: 0.055,
    transparent: true,
    opacity: 0.48,
  });
  return { points: new THREE.Points(geometry, material), geometry, material };
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

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
