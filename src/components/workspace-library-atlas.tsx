"use client";

import { clsx } from "clsx";
import {
  CircleAlert,
  Database,
  ExternalLink,
  FileText,
  Focus,
  GitBranch,
  LoaderCircle,
  Rotate3D,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  libraryAtlasConnectedNodeIds,
  projectWorkspaceLibraryAtlas,
  type LibraryAtlasEdge,
  type LibraryAtlasNode,
} from "@/lib/library/atlas-projection";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import styles from "@/components/workspace-library-atlas.module.css";

export type WorkspaceLibraryAtlasProps = Readonly<{
  items: readonly WorkspaceLibraryItem[];
  total: number;
  totalIsLowerBound: boolean;
  nextOffset: number | null;
  selectedId?: string;
  onSelect?: (itemId?: string) => void;
  className?: string;
}>;

type CameraSnapshot = Readonly<{
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}>;

type AtlasSceneController = Readonly<{
  setActive: (active: boolean) => void;
  setSelection: (itemId?: string) => void;
  setDrift: (enabled: boolean) => void;
  fit: () => void;
  zoomBy: (factor: number) => void;
}>;

type SceneState = "loading" | "ready" | "unavailable";

export function WorkspaceLibraryAtlas({
  items,
  total,
  totalIsLowerBound,
  nextOffset,
  selectedId,
  onSelect,
  className,
}: WorkspaceLibraryAtlasProps) {
  const shellRef = useRef<HTMLElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneControllerRef = useRef<AtlasSceneController | null>(null);
  const cameraSnapshotRef = useRef<CameraSnapshot | undefined>(undefined);
  const selectRef = useRef<(itemId?: string) => void>(() => undefined);
  const selectedItemIdRef = useRef<string | undefined>(undefined);
  const driftRef = useRef(false);
  const renderActiveRef = useRef(false);
  const [internalSelectedId, setInternalSelectedId] = useState<string>();
  const [drift, setDrift] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [inViewport, setInViewport] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [sceneState, setSceneState] = useState<SceneState>("loading");
  const [sceneError, setSceneError] = useState<string>();
  const effectiveSelectedId = selectedId ?? internalSelectedId;
  const selectedItem = items.find((item) => item.id === effectiveSelectedId);
  const projection = useMemo(() => projectWorkspaceLibraryAtlas(items, {
    total,
    totalIsLowerBound,
    nextOffset,
  }), [items, nextOffset, total, totalIsLowerBound]);
  const connectedNodeIds = useMemo(() => new Set(
    libraryAtlasConnectedNodeIds(projection, selectedItem?.id),
  ), [projection, selectedItem?.id]);

  useEffect(() => {
    selectRef.current = (itemId) => {
      setInternalSelectedId(itemId);
      onSelect?.(itemId);
    };
  }, [onSelect]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReducedMotion(media.matches);
      if (media.matches) setDrift(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof IntersectionObserver === "undefined") {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInViewport(Boolean(entry?.isIntersecting)),
      { rootMargin: "240px 0px" },
    );
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const renderActive = inViewport && pageVisible;
  useEffect(() => {
    renderActiveRef.current = renderActive;
    sceneControllerRef.current?.setActive(renderActive);
  }, [renderActive]);

  useEffect(() => {
    selectedItemIdRef.current = selectedItem?.id;
    sceneControllerRef.current?.setSelection(selectedItem?.id);
  }, [selectedItem?.id]);

  useEffect(() => {
    driftRef.current = drift && !reducedMotion;
    sceneControllerRef.current?.setDrift(drift && !reducedMotion);
  }, [drift, reducedMotion]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    if (!projection.nodes.length) {
      mount.replaceChildren();
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | undefined;
    let disposeScene: (() => void) | undefined;
    void Promise.all([
      import("three"),
      import("three/examples/jsm/controls/OrbitControls.js"),
    ]).then(([THREE, { OrbitControls }]) => {
      if (disposed) return;

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x06151c, 0.009);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.08, 260);
      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setClearColor(0x06151c, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.tabIndex = -1;
      mount.replaceChildren(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.enablePan = true;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.screenSpacePanning = true;
      controls.rotateSpeed = 0.62;
      controls.panSpeed = 0.78;
      controls.zoomSpeed = 0.9;
      controls.minDistance = 2.8;
      controls.maxDistance = 150;
      controls.autoRotate = false;
      controls.autoRotateSpeed = 0.22;

      const positions = layoutAtlas(
        projection.nodes,
        projection.edges,
        THREE,
      );
      const itemNodeIds = new Map(
        projection.nodes.flatMap((node) =>
          node.itemId ? [[node.itemId, node.id] as const] : []
        ),
      );
      const graphBounds = new THREE.Box3();
      for (const position of positions.values()) graphBounds.expandByPoint(position);
      const graphSphere = graphBounds.isEmpty()
        ? new THREE.Sphere(new THREE.Vector3(), 12)
        : graphBounds.getBoundingSphere(new THREE.Sphere());
      const homeTarget = graphSphere.center.clone();
      const homePosition = new THREE.Vector3();
      const homeDirection = new THREE.Vector3(0.1, 0.36, 1).normalize();

      const nodeGeometry = new THREE.IcosahedronGeometry(0.24, 1);
      const nodeMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        toneMapped: false,
      });
      const nodeMesh = new THREE.InstancedMesh(
        nodeGeometry,
        nodeMaterial,
        projection.nodes.length,
      );
      nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const dummy = new THREE.Object3D();
      let selectedNodeId = itemNodeIds.get(selectedItemIdRef.current || "");
      let highlightedNodeId = selectedNodeId;

      const renderNodes = () => {
        projection.nodes.forEach((node, index) => {
          dummy.position.copy(positions.get(node.id) || homeTarget);
          const selected = node.id === highlightedNodeId;
          const baseScale = nodeScale(node);
          dummy.scale.setScalar(baseScale * (selected ? 1.48 : 1));
          dummy.updateMatrix();
          nodeMesh.setMatrixAt(index, dummy.matrix);
          const color = new THREE.Color(colorForNode(node));
          if (selected) color.offsetHSL(0, 0.04, 0.2);
          nodeMesh.setColorAt(index, color);
        });
        nodeMesh.instanceMatrix.needsUpdate = true;
        if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
      };
      renderNodes();
      scene.add(nodeMesh);

      const edgeSegments = projection.edges.flatMap((edge) => {
        const source = positions.get(edge.sourceNodeId);
        const target = positions.get(edge.targetNodeId);
        return source && target ? [{ edge, source, target }] : [];
      });
      const edgePoints = new Float32Array(edgeSegments.length * 6);
      edgeSegments.forEach(({ source, target }, index) => {
        edgePoints.set([
          source.x, source.y, source.z,
          target.x, target.y, target.z,
        ], index * 6);
      });
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(edgePoints, 3),
      );
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: 0x67baa6,
        opacity: 0.2,
        transparent: true,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      edgeMaterial.fog = false;
      const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      scene.add(edgeLines);

      let highlightGeometry = new THREE.BufferGeometry();
      const highlightMaterial = new THREE.LineBasicMaterial({
        color: 0xc9fff0,
        opacity: 0.84,
        transparent: true,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      highlightMaterial.fog = false;
      const highlightLines = new THREE.LineSegments(
        highlightGeometry,
        highlightMaterial,
      );
      scene.add(highlightLines);

      const ringGeometry = new THREE.TorusGeometry(0.46, 0.028, 8, 48);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xb9ffe9,
        opacity: 0.9,
        transparent: true,
        toneMapped: false,
      });
      const selectionRing = new THREE.Mesh(ringGeometry, ringMaterial);
      selectionRing.visible = false;
      scene.add(selectionRing);

      const observatory = createObservatory(THREE);
      scene.add(observatory.group);

      const setHighlight = (nodeId?: string) => {
        highlightedNodeId = nodeId;
        selectionRing.visible = Boolean(selectedNodeId);
        const selectedPosition = selectedNodeId
          ? positions.get(selectedNodeId)
          : undefined;
        if (selectedPosition) selectionRing.position.copy(selectedPosition);

        const points: import("three").Vector3[] = [];
        if (nodeId) {
          for (const segment of edgeSegments) {
            if (
              segment.edge.sourceNodeId === nodeId ||
              segment.edge.targetNodeId === nodeId
            ) points.push(segment.source, segment.target);
          }
        }
        const nextGeometry = new THREE.BufferGeometry().setFromPoints(points);
        highlightGeometry.dispose();
        highlightGeometry = nextGeometry;
        highlightLines.geometry = nextGeometry;
        edgeMaterial.opacity = nodeId ? 0.055 : 0.2;
        renderNodes();
      };
      setHighlight(selectedNodeId);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerStart: { x: number; y: number } | undefined;
      let hoveredNodeId: string | undefined;
      const findNode = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = (event.clientX - rect.left) / Math.max(rect.width, 1) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / Math.max(rect.height, 1) * 2 - 1);
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(nodeMesh, false)[0];
        return hit?.instanceId === undefined
          ? undefined
          : projection.nodes[hit.instanceId];
      };
      const onPointerDown = (event: PointerEvent) => {
        pointerStart = { x: event.clientX, y: event.clientY };
      };
      const onPointerMove = (event: PointerEvent) => {
        const node = findNode(event);
        renderer.domElement.style.cursor = node?.itemId ? "pointer" : "grab";
        if (node?.id === hoveredNodeId) return;
        hoveredNodeId = node?.id;
        setHighlight(node?.id || selectedNodeId);
      };
      const onPointerLeave = () => {
        hoveredNodeId = undefined;
        setHighlight(selectedNodeId);
      };
      const onPointerUp = (event: PointerEvent) => {
        if (!pointerStart || Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y,
        ) > 5) return;
        const node = findNode(event);
        if (node?.itemId) selectRef.current?.(node.itemId);
      };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerup", onPointerUp);

      const updateHomePosition = () => {
        const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
        const horizontalHalfFov = Math.atan(
          Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.1),
        );
        const limitingHalfFov = Math.max(
          THREE.MathUtils.degToRad(13),
          Math.min(verticalHalfFov, horizontalHalfFov),
        );
        const distance = Math.max(
          18,
          graphSphere.radius / Math.sin(limitingHalfFov) * 1.12,
        );
        homePosition.copy(homeTarget).add(
          homeDirection.clone().multiplyScalar(distance),
        );
        controls.maxDistance = Math.max(150, distance * 2.8);
      };
      updateHomePosition();

      const restoreCamera = () => {
        const snapshot = cameraSnapshotRef.current;
        if (snapshot && snapshot.position.every(Number.isFinite) && snapshot.target.every(Number.isFinite)) {
          camera.position.fromArray([...snapshot.position]);
          controls.target.fromArray([...snapshot.target]);
        } else {
          camera.position.copy(homePosition);
          controls.target.copy(homeTarget);
        }
        controls.update();
      };
      restoreCamera();

      const saveCamera = () => {
        cameraSnapshotRef.current = {
          position: camera.position.toArray() as [number, number, number],
          target: controls.target.toArray() as [number, number, number],
        };
      };
      controls.addEventListener("change", saveCamera);

      let driftEnabled = false;
      let rendering = false;
      const draw = () => {
        if (disposed || !rendering) return;
        controls.autoRotate = driftEnabled;
        if (selectionRing.visible) selectionRing.lookAt(camera.position);
        controls.update();
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(draw);
      };
      const setActive = (active: boolean) => {
        if (active && !rendering) {
          rendering = true;
          draw();
        } else if (!active && rendering) {
          rendering = false;
          controls.autoRotate = false;
          cancelAnimationFrame(animationFrame);
        }
      };
      const fit = () => {
        updateHomePosition();
        camera.position.copy(homePosition);
        controls.target.copy(homeTarget);
        controls.update();
        saveCamera();
      };
      const zoomBy = (factor: number) => {
        const offset = camera.position.clone().sub(controls.target);
        if (offset.lengthSq() < 0.01) offset.copy(homeDirection);
        const distance = THREE.MathUtils.clamp(
          offset.length() * factor,
          controls.minDistance,
          controls.maxDistance,
        );
        camera.position.copy(controls.target).add(
          offset.normalize().multiplyScalar(distance),
        );
        controls.update();
        saveCamera();
      };

      const resize = () => {
        const width = Math.max(mount.clientWidth, 1);
        const height = Math.max(mount.clientHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();

      const onContextLost = (event: Event) => {
        event.preventDefault();
        setActive(false);
        setSceneState("unavailable");
        setSceneError("The spatial view paused because WebGL became unavailable. The asset index remains fully usable.");
      };
      renderer.domElement.addEventListener("webglcontextlost", onContextLost);

      sceneControllerRef.current = {
        setActive,
        setSelection: (itemId) => {
          selectedNodeId = itemNodeIds.get(itemId || "");
          setHighlight(selectedNodeId);
        },
        setDrift: (enabled) => {
          driftEnabled = enabled;
          controls.autoRotate = enabled;
        },
        fit,
        zoomBy,
      };
      sceneControllerRef.current.setSelection(selectedItemIdRef.current);
      sceneControllerRef.current.setDrift(driftRef.current);
      setActive(renderActiveRef.current);
      setSceneState("ready");

      disposeScene = () => {
        saveCamera();
        setActive(false);
        resizeObserver?.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
        controls.removeEventListener("change", saveCamera);
        controls.dispose();
        nodeGeometry.dispose();
        nodeMaterial.dispose();
        edgeGeometry.dispose();
        edgeMaterial.dispose();
        highlightGeometry.dispose();
        highlightMaterial.dispose();
        ringGeometry.dispose();
        ringMaterial.dispose();
        observatory.dispose();
        renderer.dispose();
        renderer.domElement.remove();
        sceneControllerRef.current = null;
      };
    }).catch(() => {
      if (disposed) return;
      setSceneState("unavailable");
      setSceneError("This device could not start the spatial view. The asset index remains fully usable.");
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      disposeScene?.();
    };
  }, [projection]);

  function chooseItem(itemId?: string) {
    selectRef.current(itemId);
  }

  const assetCount = projection.nodes.filter((node) => node.kind === "asset").length;
  const sourceCount = projection.nodes.filter((node) => node.kind === "source").length;
  const workLinkCount = projection.nodes.filter((node) =>
    ["workspace", "project", "mission", "work_item", "knowledge_document"].includes(node.kind)
  ).length;

  return (
    <section
      ref={shellRef}
      className={clsx(styles.shell, className)}
      aria-labelledby="workspace-library-atlas-title"
      data-testid="workspace-library-atlas"
    >
      <header className={styles.header}>
        <div>
          <p><GitBranch size={15} aria-hidden="true" /> Library Atlas</p>
          <h3 id="workspace-library-atlas-title">Files in context</h3>
          <span>Orbit the current results and inspect the source, version, and work links behind each asset.</span>
        </div>
        <dl className={styles.summary} aria-label="Atlas summary">
          <div><dt>Mapped</dt><dd>{assetCount.toLocaleString()}</dd></div>
          <div><dt>Sources</dt><dd>{sourceCount.toLocaleString()}</dd></div>
          <div><dt>Work links</dt><dd>{workLinkCount.toLocaleString()}</dd></div>
        </dl>
      </header>

      <div className={styles.workspace}>
        <div
          className={styles.stage}
          aria-describedby="workspace-library-atlas-description"
        >
          <div ref={mountRef} className={styles.canvas} />
          <p id="workspace-library-atlas-description" className="sr-only">
            A supplementary three-dimensional map. Use the adjacent asset index for complete keyboard access.
          </p>

          {sceneState === "loading" && items.length ? (
            <div className={styles.sceneMessage} role="status">
              <LoaderCircle size={21} className={styles.spin} aria-hidden="true" />
              Mapping provenance…
            </div>
          ) : null}
          {sceneState === "unavailable" ? (
            <div className={styles.sceneMessage} role="status">
              <CircleAlert size={21} aria-hidden="true" />
              <span>{sceneError}</span>
            </div>
          ) : null}
          {!items.length ? (
            <div className={styles.sceneMessage} role="status">
              <FileText size={22} aria-hidden="true" />
              <span>Nothing is mapped in the current view.</span>
            </div>
          ) : null}

          <div className={styles.counter} aria-hidden="true">
            <Rotate3D size={15} />
            {projection.resultScope.mappedItems.toLocaleString()} of {projection.resultScope.total.toLocaleString()}{projection.resultScope.totalIsLowerBound ? "+" : ""} mapped
          </div>

          <div className={styles.controls} aria-label="Atlas camera controls">
            <button
              type="button"
              onClick={() => sceneControllerRef.current?.zoomBy(0.72)}
              aria-label="Zoom in"
              title="Zoom in"
            ><ZoomIn size={17} aria-hidden="true" /></button>
            <button
              type="button"
              onClick={() => sceneControllerRef.current?.zoomBy(1.38)}
              aria-label="Zoom out"
              title="Zoom out"
            ><ZoomOut size={17} aria-hidden="true" /></button>
            <button
              type="button"
              onClick={() => sceneControllerRef.current?.fit()}
            ><Focus size={16} aria-hidden="true" /> Fit</button>
            <button
              type="button"
              aria-pressed={drift}
              disabled={reducedMotion}
              title={reducedMotion ? "Drift is disabled by your reduced-motion setting" : "Toggle gentle camera drift"}
              onClick={() => setDrift((current) => !current)}
            ><Rotate3D size={16} aria-hidden="true" /> Drift</button>
          </div>

          <div className={styles.legend} aria-hidden="true">
            <span><i data-tone="asset" /> Assets</span>
            <span><i data-tone="source" /> Sources</span>
            <span><i data-tone="context" /> Context</span>
          </div>
        </div>

        <aside className={styles.rail} aria-label="Atlas asset index">
          {selectedItem ? (
            <section className={styles.inspector} aria-live="polite">
              <button
                type="button"
                className={styles.close}
                onClick={() => chooseItem(undefined)}
                aria-label="Clear selected asset"
              ><X size={17} aria-hidden="true" /></button>
              <p>{kindLabel(selectedItem.kind)} · {statusLabel(selectedItem.status)}</p>
              <h4>{selectedItem.title}</h4>
              {selectedItem.summary ? <span>{selectedItem.summary}</span> : null}
              <dl>
                <div><dt>Source</dt><dd>{selectedItem.sourceLabel}</dd></div>
                <div><dt>Version</dt><dd>{selectedItem.currentVersion.versionNumber} of {selectedItem.versionCount}</dd></div>
                <div><dt>Size</dt><dd>{formatBytes(selectedItem.currentVersion.byteCount)}</dd></div>
                <div><dt>Scope</dt><dd>{scopeLabel(selectedItem.scope.visibility)}</dd></div>
                <div><dt>Connections</dt><dd>{Math.max(connectedNodeIds.size - 1, 0)}</dd></div>
              </dl>
              <div className={styles.citation}>
                <span>Citation</span>
                <code title={selectedItem.citationRefs[0]}>{selectedItem.citationRefs[0]}</code>
              </div>
              {selectedItem.openHref ? (
                <a href={selectedItem.openHref} className={styles.openLink}>
                  Open asset <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : null}
            </section>
          ) : (
            <section className={styles.inspectorEmpty}>
              <Database size={20} aria-hidden="true" />
              <strong>Select an asset</strong>
              <span>The map and index share one selection. Every line is backed by an explicit source, tag, or work link.</span>
            </section>
          )}

          <div className={styles.indexHeading}>
            <div><strong>Asset index</strong><span>Keyboard-accessible map</span></div>
            <small>{items.length.toLocaleString()}</small>
          </div>
          <ol className={styles.assetList}>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === selectedItem?.id ? styles.selectedAsset : undefined}
                  onClick={() => chooseItem(item.id)}
                  aria-pressed={item.id === selectedItem?.id}
                >
                  <i data-status={item.status} aria-hidden="true" />
                  <span><strong>{item.title}</strong><small>{item.sourceLabel} · {kindLabel(item.kind)}</small></span>
                  <em>{item.currentVersion.versionNumber > 1 ? `v${item.currentVersion.versionNumber}` : statusLabel(item.status)}</em>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <footer className={styles.disclosure}>
        <span>Drag to orbit · Shift-drag to pan · Scroll to zoom</span>
        <span>Lines show provenance and explicit work links—not inferred similarity.</span>
        {projection.resultScope.truncated || nextOffset !== null ? (
          <strong>Current mapped result set</strong>
        ) : null}
      </footer>
    </section>
  );
}

function layoutAtlas(
  nodes: readonly LibraryAtlasNode[],
  edges: readonly LibraryAtlasEdge[],
  THREE: typeof import("three"),
) {
  const positions = new Map<string, import("three").Vector3>();
  const hubs = nodes.filter((node) => node.kind !== "asset").sort(compareNodes);
  const assets = nodes.filter((node) => node.kind === "asset").sort(compareNodes);
  const hubGroups: LibraryAtlasNode["kind"][][] = [
    ["kind"],
    ["source"],
    ["workspace", "project", "mission", "work_item", "knowledge_document"],
    ["tag"],
  ];

  hubGroups.forEach((group, groupIndex) => {
    const groupNodes = hubs.filter((node) => group.includes(node.kind));
    groupNodes.forEach((node, index) => {
      const vector = seededSphere(`${node.id}:hub`, THREE);
      const radius = [4.2, 8.2, 14.5, 19][groupIndex] +
        (index / Math.max(groupNodes.length, 1)) * 1.4;
      positions.set(node.id, vector.multiplyScalar(radius));
    });
  });

  const neighborIds = new Map<string, string[]>();
  for (const edge of edges) {
    const current = neighborIds.get(edge.sourceNodeId) || [];
    current.push(edge.targetNodeId);
    neighborIds.set(edge.sourceNodeId, current);
  }
  assets.forEach((node, index) => {
    const anchorPositions = (neighborIds.get(node.id) || [])
      .map((id) => positions.get(id))
      .filter((value): value is import("three").Vector3 => Boolean(value))
      .slice(0, 3);
    const anchor = anchorPositions.length
      ? anchorPositions.reduce(
          (sum, position) => sum.add(position),
          new THREE.Vector3(),
        ).divideScalar(anchorPositions.length)
      : seededSphere(`${node.id}:anchor`, THREE).multiplyScalar(10);
    const jitter = seededSphere(`${node.id}:asset`, THREE).multiplyScalar(
      2.1 + seeded(`${node.id}:spread`) * 4.2,
    );
    const lane = (index % 7 - 3) * 0.12;
    positions.set(node.id, anchor.add(jitter).add(new THREE.Vector3(0, lane, 0)));
  });
  return positions;
}

function createObservatory(THREE: typeof import("three")) {
  const group = new THREE.Group();
  const resources: Array<{ dispose: () => void }> = [];
  for (let index = 0; index < 3; index += 1) {
    const radius = 6.8 + index * 6.2;
    const curve = new THREE.EllipseCurve(0, 0, radius, radius * (0.82 + index * 0.04));
    const geometry = new THREE.BufferGeometry().setFromPoints(
      curve.getPoints(120).map((point) => new THREE.Vector3(point.x, 0, point.y)),
    );
    const material = new THREE.LineBasicMaterial({
      color: index === 0 ? 0x65b7a2 : 0x3b7180,
      opacity: index === 0 ? 0.2 : 0.12,
      transparent: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const ring = new THREE.LineLoop(geometry, material);
    ring.rotation.z = (index % 2 ? -1 : 1) * (0.06 + index * 0.025);
    group.add(ring);
    resources.push(geometry, material);
  }

  const stars: number[] = [];
  for (let index = 0; index < 520; index += 1) {
    const point = seededSphere(`library-star:${index}`, THREE).multiplyScalar(
      24 + seeded(`library-star-radius:${index}`) * 32,
    );
    stars.push(point.x, point.y, point.z);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(stars, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: 0x8fd7c5,
    size: 0.075,
    opacity: 0.5,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  group.add(new THREE.Points(starGeometry, starMaterial));
  resources.push(starGeometry, starMaterial);

  return {
    group,
    dispose: () => resources.forEach((resource) => resource.dispose()),
  };
}

function seededSphere(
  key: string,
  THREE: typeof import("three"),
) {
  const theta = seeded(`${key}:theta`) * Math.PI * 2;
  const y = seeded(`${key}:y`) * 2 - 1;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  return new THREE.Vector3(
    Math.cos(theta) * radius,
    y * 0.72,
    Math.sin(theta) * radius,
  ).normalize();
}

function seeded(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function compareNodes(left: LibraryAtlasNode, right: LibraryAtlasNode) {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function nodeScale(node: LibraryAtlasNode) {
  if (node.kind === "asset") return node.status === "processing" ? 1.2 : 1;
  if (node.kind === "kind") return 2.8 + Math.min(node.count, 20) * 0.035;
  if (node.kind === "source") return 2.25 + Math.min(node.count, 20) * 0.03;
  if (node.kind === "tag") return 1.45 + Math.min(node.count, 12) * 0.025;
  return 1.85 + Math.min(node.count, 16) * 0.025;
}

function colorForNode(node: LibraryAtlasNode) {
  if (node.status === "failed") return "#ff9fae";
  if (node.status === "processing") return "#fff0a8";
  if (node.kind === "source") return "#99c7ff";
  if (node.kind === "tag") return "#ffd18a";
  if (node.kind !== "asset" && node.kind !== "kind") return "#d4b4ff";
  if (node.kind === "kind") return "#effcf8";
  if (node.assetKind === "image") return "#ffd18a";
  if (["audio", "recording", "transcript"].includes(node.assetKind || "")) return "#ffb1bb";
  if (node.assetKind === "video") return "#d4b4ff";
  if (["meeting", "email", "message"].includes(node.assetKind || "")) return "#99c7ff";
  return "#90ead0";
}

function kindLabel(value: WorkspaceLibraryItem["kind"]) {
  if (value === "generated_artifact") return "Generated";
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function statusLabel(value: WorkspaceLibraryItem["status"]) {
  if (value === "ready") return "Ready";
  if (value === "processing") return "Processing";
  if (value === "unsupported") return "Unsupported";
  return "Needs attention";
}

function scopeLabel(value: WorkspaceLibraryItem["scope"]["visibility"]) {
  if (value === "workspace_shared") return "Workspace";
  if (value === "project_shared") return "Project";
  if (value === "mission_shared") return "Mission";
  return "Private";
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
