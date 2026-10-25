"use client";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Film,
  FolderOpen,
  History,
  ImageIcon,
  Keyboard,
  LayoutGrid,
  List,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
  Workflow,
  X,
} from "lucide-react";
import {
  canPerform,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import { workspaceOwnerScope } from "@/components/app-shell/workspace-owner-scope";
import {
  type StudioAsset,
  type StudioFlow,
  type StudioGraph,
  type StudioIssue,
  type StudioNodeType,
  type StudioQuote,
  type StudioRun,
  type StudioRunEvent,
  type StudioScope,
  type StudioViewport,
  STUDIO_MAX_NODES,
  STUDIO_TERMINAL_RUN_STATES,
  emptyStudioGraph,
  studioGraphSchema,
  studioViewportSchema,
  studioCanonicalJson,
} from "@/lib/studio/contracts";
import { type StudioCapability } from "@/lib/studio/capabilities";
import {
  createStudioNode,
  createStudioTemplate,
  STUDIO_TEMPLATES,
  type StudioTemplateId,
} from "@/lib/studio/templates";
import { hasFreshStudioResult, validateGraph } from "@/lib/studio/graph";
import {
  StudioClient,
  StudioResponseError,
  StudioScopeChanged,
  readFlow,
  readRun,
  errorMessage,
  uncertainFailure,
} from "./client";
import {
  duplicateGraphNodes,
  durationLabel,
  graphHistoryReducer,
  initialGraphHistory,
  isTypingTarget,
  mergeRunEvents,
  newestNodeRun,
  enrichStudioAsset,
  nodeDescriptions,
  nodeLabels,
  removeGraphElements,
  saveFingerprint,
  scopeLabel,
  statusLabel,
  readPendingSubmission,
  type PendingStudioSubmission,
} from "./state";
import { SavedRunResults, StudioInspector } from "./inspector";
import styles from "./studio.module.css";

const Canvas = dynamic(() => import("./canvas"), {
  ssr: false,
  loading: () => (
    <div
      className={styles.skeleton}
      role="status"
      aria-label="Loading canvas"
    />
  ),
});
const defaultViewport: StudioViewport = { x: 0, y: 0, zoom: 1 };
type DraftReceipt = {
  baseRevision: number;
  name: string;
  graph: StudioGraph;
  viewport: StudioViewport;
};
type PendingFlowCreate = {
  key: string;
  body: {
    name: string;
    description: string;
    graph: StudioGraph;
    viewport: StudioViewport;
    projectId?: string;
  };
};
function recoverPendingCreate(owner: string): PendingFlowCreate | undefined {
  if (typeof sessionStorage === "undefined") return;
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`asael:studio-create:${owner}`) || "null",
    ) as PendingFlowCreate | null;
    if (
      saved &&
      typeof saved.key === "string" &&
      saved.key &&
      typeof saved.body?.name === "string" &&
      typeof saved.body?.description === "string" &&
      studioGraphSchema.safeParse(saved.body.graph).success &&
      studioViewportSchema.safeParse(saved.body.viewport).success &&
      (!saved.body.projectId || typeof saved.body.projectId === "string")
    )
      return saved;
  } catch {
    /* Only validated local drafts can be retried. */
  }
}

type Props = {
  initialFlowId?: string;
  initialProjectId?: string;
  deployment: string;
};

export function StudioWorkspace(props: Props) {
  const { session, status, role } = useWorkspaceSession();
  const owner = workspaceOwnerScope(session, role, props.deployment);
  if (status !== "ready" || !owner)
    return (
      <section className={styles.empty}>
        <h1>Visual Studio</h1>
        <p>
          {status === "loading"
            ? "Checking your workspace…"
            : "Your workspace session is unavailable. Sign in or refresh to continue."}
        </p>
      </section>
    );
  return (
    <OwnedStudio
      key={owner}
      {...props}
      owner={owner}
      writable={
        canPerform(role, "manage.workflow") && canPerform(role, "execute.tool")
      }
    />
  );
}
function OwnedStudio({
  initialFlowId,
  initialProjectId,
  owner,
  writable,
}: Props & { owner: string; writable: boolean }) {
  const [client] = useState(() => new StudioClient(undefined, 30_000, owner));
  const [pendingCreate, setPendingCreate] = useState(() =>
    recoverPendingCreate(owner),
  );
  const [flows, setFlows] = useState<StudioFlow[]>([]);
  const [capabilities, setCapabilities] = useState<StudioCapability[]>([]);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<StudioFlow>();
  const flowRef = useRef<StudioFlow | undefined>(undefined);
  const [name, setName] = useState("");
  const [history, dispatch] = useReducer(graphHistoryReducer, undefined, () =>
    initialGraphHistory(),
  );
  const graph = history.graph;
  const [viewport, setViewport] = useState<StudioViewport>(defaultViewport);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]),
    [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [notice, setNotice] = useState<{
    tone: "error" | "warning" | "info";
    text: string;
    kind?: "model-change";
  }>();
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  const [saveState, setSaveState] = useState<
    "saved" | "saving" | "error" | "conflict"
  >("saved");
  const [saveError, setSaveError] = useState("");
  const saving = useRef(false),
    loadGeneration = useRef(0);
  const [library, setLibrary] = useState(true),
    [inspector, setInspector] = useState(true),
    [listView, setListView] = useState(false),
    [narrow, setNarrow] = useState(false),
    [shortcuts, setShortcuts] = useState(false);
  const [search, setSearch] = useState("");
  const [issues, setIssues] = useState<StudioIssue[]>([]);
  const [quote, setQuote] = useState<StudioQuote>();
  const [expiredQuoteId, setExpiredQuoteId] = useState("");
  const [maxCost, setMaxCost] = useState(""),
    [maxGenerations, setMaxGenerations] = useState(4),
    [allowUnknown, setAllowUnknown] = useState(false);
  const [pendingSubmission, setPendingSubmission] =
    useState<PendingStudioSubmission>();
  const [runs, setRuns] = useState<StudioRun[]>([]),
    [activeRun, setActiveRun] = useState<StudioRun>();
  const [events, setEvents] = useState<StudioRunEvent[]>([]),
    [showHistory, setShowHistory] = useState(false),
    [pollError, setPollError] = useState("");
  const eventCursor = useRef(0);
  const [pollRevision, setPollRevision] = useState(0);
  const activeRunId = activeRun?.id;
  const latest = useRef({ name, graph, viewport });
  useLayoutEffect(() => {
    latest.current = { name, graph, viewport };
  }, [name, graph, viewport]);
  useEffect(() => {
    if (!quote) return;
    const timer = window.setTimeout(
      () => setExpiredQuoteId(quote.id),
      Math.max(0, Date.parse(quote.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [quote]);
  const dirty = Boolean(
    flow &&
      (saveFingerprint(name, graph) !==
        saveFingerprint(flow.name, flow.graph) ||
        studioCanonicalJson(viewport) !== studioCanonicalJson(flow.viewport)),
  );
  const draftKey = flow ? `asael:studio-draft:${owner}:${flow.id}` : "";

  const loadFlow = useCallback(
    async (id: string) => {
      const generation = ++loadGeneration.current;
      setLoading(true);
      setNotice(undefined);
      try {
        const response = await client.json<{ flow: StudioFlow }>(
          `/api/studio/flows/${encodeURIComponent(id)}`,
        );
        const next = readFlow(response.flow);
        if (generation !== loadGeneration.current) return;
        flowRef.current = next;
        setFlow(next);
        setName(next.name);
        dispatch({ type: "reset", graph: next.graph });
        setViewport(next.viewport);
        setSaveState("saved");
        setSaveError("");
        setQuote(undefined);
        setSelectedNodes([]);
        setSelectedEdges([]);
        setIssues([]);
        setPendingSubmission(undefined);
        setRuns([]);
        setActiveRun(undefined);
        setEvents([]);
        eventCursor.current = 0;
        const key = `asael:studio-draft:${owner}:${next.id}`;
        try {
          const stored = sessionStorage.getItem(key);
          if (stored) {
            const draft = JSON.parse(stored) as DraftReceipt;
            if (
              studioGraphSchema.safeParse(draft.graph).success &&
              studioViewportSchema.safeParse(draft.viewport).success &&
              Number.isInteger(draft.baseRevision) &&
              typeof draft.name === "string"
            ) {
              setName(draft.name);
              dispatch({ type: "reset", graph: draft.graph });
              setViewport(draft.viewport);
              if (draft.baseRevision !== next.revision) {
                setSaveState("conflict");
                setSaveError(
                  "Your recovered draft and the saved flow have different revisions. Save your draft as a copy, or load the saved revision.",
                );
              } else
                setNotice({
                  tone: "info",
                  text: "Recovered this tab’s unsaved draft. Autosave will continue.",
                });
            }
          }
        } catch {
          /* A malformed local draft cannot replace the saved graph. */
        }
        try {
          const stored = sessionStorage.getItem(
            `asael:studio-submission:${owner}:${next.id}`,
          );
          if (stored)
            setPendingSubmission(
              readPendingSubmission(JSON.parse(stored), next.id),
            );
        } catch {
          /* Invalid local receipt data never becomes a new submission. */
        }
        const url = new URL(window.location.href);
        url.searchParams.set("flow", next.id);
        window.history.replaceState(null, "", url);
        try {
          sessionStorage.setItem(`asael:studio-last-flow:${owner}`, next.id);
        } catch {
          /* The URL still preserves this flow on refresh. */
        }
        const prior = await client.json<{ runs: StudioRun[] }>(
          `/api/studio/flows/${encodeURIComponent(id)}/runs`,
        );
        if (generation !== loadGeneration.current) return;
        const checked = (prior.runs || []).map((r) => readRun(r, id));
        setRuns(checked);
        setActiveRun(
          checked.find((r) => !STUDIO_TERMINAL_RUN_STATES.includes(r.status)) ||
            checked[0],
        );
      } catch (error) {
        if (
          !(error instanceof StudioScopeChanged) &&
          generation === loadGeneration.current
        )
          setNotice({ tone: "error", text: errorMessage(error) });
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [client, owner],
  );
  useEffect(() => {
    client.activate();
    let alive = true;
    void Promise.allSettled([
      client.json<{ flows: StudioFlow[] }>("/api/studio/flows"),
      client.json<{ capabilities: StudioCapability[] }>(
        "/api/studio/capabilities",
      ),
      client.json<{ assets: StudioAsset[] }>("/api/studio/assets"),
    ])
      .then((results) => {
        if (!alive) return;
        const [f, c, a] = results;
        if (f.status === "fulfilled") setFlows(f.value.flows.map(readFlow));
        if (c.status === "fulfilled") setCapabilities(c.value.capabilities);
        if (a.status === "fulfilled") setAssets(a.value.assets);
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected")
          setNotice({ tone: "error", text: errorMessage(failed.reason) });
        setLoading(false);
        let restoreId = initialFlowId;
        if (!restoreId && !initialProjectId)
          try {
            const saved = sessionStorage.getItem(
              `asael:studio-last-flow:${owner}`,
            );
            if (saved && /^[a-zA-Z0-9:_-]{1,160}$/.test(saved))
              restoreId = saved;
          } catch {}
        if (restoreId) void loadFlow(restoreId);
      })
      .catch((error) => {
        if (alive) {
          setLoading(false);
          setNotice({ tone: "error", text: errorMessage(error) });
        }
      });
    return () => {
      alive = false;
      loadGeneration.current += 1;
      client.dispose();
    };
  }, [client, initialFlowId, initialProjectId, loadFlow, owner]);
  useEffect(() => {
    const media = window.matchMedia("(max-width:900px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const saveNow = useCallback(async () => {
    const base = flowRef.current;
    if (!base || !writable || saving.current || saveState === "conflict")
      return false;
    const submitted = { ...latest.current };
    const key = crypto.randomUUID();
    saving.current = true;
    setSaveState("saving");
    try {
      const response = await client.json<{ flow: StudioFlow }>(
        `/api/studio/flows/${encodeURIComponent(base.id)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({ revision: base.revision, ...submitted }),
        },
      );
      const saved = readFlow(response.flow);
      if (flowRef.current?.id !== base.id) return false;
      flowRef.current = saved;
      setFlow(saved);
      setFlows((current) => [
        saved,
        ...current.filter((f) => f.id !== saved.id),
      ]);
      setSaveState("saved");
      setSaveError("");
      return true;
    } catch (error) {
      if (error instanceof StudioScopeChanged) return false;
      setSaveState(
        error instanceof StudioResponseError && error.status === 409
          ? "conflict"
          : "error",
      );
      setSaveError(
        error instanceof StudioResponseError && error.status === 409
          ? "This flow changed in another tab. Your draft is retained. Save it as a copy or load the saved revision."
          : errorMessage(error),
      );
      return false;
    } finally {
      saving.current = false;
    }
  }, [client, writable, saveState]);
  useEffect(() => {
    if (!flow || !dirty) return;
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ baseRevision: flow.revision, ...latest.current }),
      );
    } catch {
      /* Server autosave remains available if tab storage is full. */
    }
    if (!writable || saveState === "conflict" || saveState === "error") return;
    const timer = window.setTimeout(() => void saveNow(), 800);
    return () => window.clearTimeout(timer);
  }, [
    flow,
    dirty,
    draftKey,
    name,
    graph,
    viewport,
    writable,
    saveState,
    saveNow,
  ]);
  useEffect(() => {
    if (flow && !dirty && saveState === "saved")
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
  }, [flow, dirty, draftKey, saveState]);

  const changeGraph = useCallback((next: StudioGraph, record = true) => {
    dispatch({ type: "replace", graph: next, record });
    setQuote(undefined);
    setIssues([]);
  }, []);
  const moveGraphHistory = useCallback((type: "undo" | "redo") => {
    dispatch({ type });
    setQuote(undefined);
    setNotice((current) =>
      current?.kind === "model-change" ? undefined : current,
    );
  }, []);
  const select = useCallback((nodes: string[], edges: string[]) => {
    setSelectedNodes((current) =>
      current.join() === nodes.join() ? current : nodes,
    );
    setSelectedEdges((current) =>
      current.join() === edges.join() ? current : edges,
    );
  }, []);
  const currentNode = graph.nodes.find((n) => n.id === selectedNodes[0]);
  const allRuns = useMemo(
    () =>
      activeRun
        ? [activeRun, ...runs.filter((r) => r.id !== activeRun.id)]
        : runs,
    [activeRun, runs],
  );
  const nodeRuns = useMemo(
    () =>
      Object.fromEntries(
        graph.nodes.flatMap((n) => {
          const latest = allRuns
            .flatMap((r) => r.nodes)
            .find((r) => r.nodeId === n.id);
          return latest ? [[n.id, latest] as const] : [];
        }),
      ),
    [graph.nodes, allRuns],
  );
  const previousResults = useMemo(
    () =>
      Object.fromEntries(
        graph.nodes.flatMap((n) => {
          const previous = newestNodeRun(allRuns, n.id);
          return previous
            ? [
                [
                  n.id,
                  {
                    configurationHash: previous.node.configurationHash,
                    outputAssets: previous.node.outputAssets,
                    inputAssets: previous.node.inputAssets,
                    runId: previous.run.id,
                  },
                ],
              ]
            : [];
        }),
      ),
    [graph.nodes, allRuns],
  );
  const staleIds = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter(
            (n) =>
              previousResults[n.id] &&
              !hasFreshStudioResult(graph, n.id, previousResults),
          )
          .map((n) => n.id),
      ),
    [graph, previousResults],
  );
  const selectedOutputs = useMemo(
    () =>
      currentNode
        ? [
            ...new Map(
              allRuns
                .flatMap((r) =>
                  r.nodes
                    .filter((n) => n.nodeId === currentNode.id)
                    .flatMap((n) => n.outputAssets),
                )
                .map((a) => [a.id, a]),
            ).values(),
          ]
        : [],
    [allRuns, currentNode],
  );

  const removeSelection = useCallback(() => {
    if (!writable) return;
    changeGraph(removeGraphElements(graph, selectedNodes, selectedEdges));
    select([], []);
  }, [writable, changeGraph, graph, selectedNodes, selectedEdges, select]);
  const duplicateSelection = useCallback(() => {
    if (!writable) return;
    try {
      changeGraph(
        duplicateGraphNodes(graph, selectedNodes, () => crypto.randomUUID()),
      );
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    }
  }, [writable, graph, selectedNodes, changeGraph]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || !flow || !writable) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        moveGraphHistory(event.shiftKey ? "redo" : "undo");
      } else if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelection();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelection();
      } else if (event.key === "Escape") {
        select([], []);
        setQuote(undefined);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    flow,
    writable,
    duplicateSelection,
    removeSelection,
    select,
    moveGraphHistory,
  ]);

  useEffect(() => {
    if (!activeRunId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = activeRunId;
    const poll = async () => {
      if (!alive) return;
      if (document.hidden) {
        timer = setTimeout(poll, 3000);
        return;
      }
      try {
        const response = await client.json<{
          run: StudioRun;
          events: StudioRunEvent[];
        }>(
          `/api/studio/runs/${encodeURIComponent(id)}?afterSeq=${eventCursor.current}`,
        );
        if (!alive) return;
        const next = readRun(response.run, flowRef.current?.id);
        setActiveRun(next);
        setRuns((old) => [next, ...old.filter((r) => r.id !== next.id)]);
        setEvents((old) => mergeRunEvents(old, response.events || []));
        setAssets((old) => [
          ...new Map(
            [...old, ...next.nodes.flatMap((n) => n.outputAssets)].map((a) => [
              a.id,
              a,
            ]),
          ).values(),
        ]);
        eventCursor.current = Math.max(
          eventCursor.current,
          ...(response.events || []).map((e) => e.seq),
        );
        setPollError("");
        if (!STUDIO_TERMINAL_RUN_STATES.includes(next.status))
          timer = setTimeout(poll, 2500);
      } catch (error) {
        if (alive && !(error instanceof StudioScopeChanged)) {
          setPollError(errorMessage(error));
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, activeRunId, pollRevision]);

  async function createFlow(template?: StudioTemplateId, copy = false) {
    if (!writable || busy) return;
    setBusy(true);
    setNotice(undefined);
    const submission = pendingCreate || {
      key: crypto.randomUUID(),
      body: {
        name: copy
          ? `${name} copy`.slice(0, 160)
          : template
            ? STUDIO_TEMPLATES.find((t) => t.id === template)?.name ||
              "Untitled flow"
            : "Untitled flow",
        description: copy ? flow?.description || "" : "",
        graph: copy
          ? graph
          : template
            ? createStudioTemplate(template, capabilities)
            : emptyStudioGraph(),
        viewport: copy ? viewport : defaultViewport,
        projectId: copy ? flow?.projectId || undefined : initialProjectId,
      },
    };
    const receiptKey = `asael:studio-create:${owner}`;
    setPendingCreate(submission);
    try {
      sessionStorage.setItem(receiptKey, JSON.stringify(submission));
    } catch {
      /* In-memory receipt remains available. */
    }
    try {
      const response = await client.post<{ flow: StudioFlow }>(
        "/api/studio/flows",
        submission.body,
        submission.key,
      );
      const next = readFlow(response.flow);
      setPendingCreate(undefined);
      try {
        sessionStorage.removeItem(receiptKey);
      } catch {}
      setFlows((current) => [next, ...current]);
      await loadFlow(next.id);
    } catch (error) {
      if (!uncertainFailure(error)) {
        setPendingCreate(undefined);
        try {
          sessionStorage.removeItem(receiptKey);
        } catch {}
      }
      if (!(error instanceof StudioScopeChanged))
        setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  function addNode(type: StudioNodeType, asset?: StudioAsset) {
    if (!writable) return;
    if (graph.nodes.length >= STUDIO_MAX_NODES) {
      setNotice({
        tone: "warning",
        text: `This flow has reached its ${STUDIO_MAX_NODES}-node limit.`,
      });
      return;
    }
    const n = createStudioNode(
      type,
      crypto.randomUUID(),
      80 + (graph.nodes.length % 4) * 290,
      70 + Math.floor(graph.nodes.length / 4) * 210,
      capabilities,
    );
    if (asset) {
      n.title = asset.filename.slice(0, 160);
      n.config = {
        ...n.config,
        assetId: asset.id,
        assetMediaType: asset.mediaType,
        assetVersion: asset.contentSha256,
      };
    }
    changeGraph({ ...graph, nodes: [...graph.nodes, n] });
    select([n.id], []);
    setInspector(true);
  }
  async function uploadReference(file: File) {
    if (!currentNode || !writable) return;
    const nodeId = currentNode.id;
    setUploading(true);
    try {
      if (file.size > 3 * 1024 * 1024)
        throw new Error("References must be 3 MiB or smaller.");
      const body = new FormData();
      body.set("file", file);
      const response = await client.json<{ asset: StudioAsset }>(
        "/api/studio/assets",
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body,
        },
      );
      const asset = response.asset;
      if (!asset?.id || !asset.contentSha256)
        throw new Error(
          "The upload receipt is incomplete. Refresh saved assets before retrying.",
        );
      setAssets((old) => [asset, ...old.filter((a) => a.id !== asset.id)]);
      const draft = latest.current.graph;
      changeGraph({
        ...draft,
        nodes: draft.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                config: {
                  ...n.config,
                  assetId: asset.id,
                  assetMediaType: asset.mediaType,
                  assetVersion: asset.contentSha256,
                },
              }
            : n,
        ),
      });
    } catch (error) {
      if (!(error instanceof StudioScopeChanged))
        setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setUploading(false);
    }
  }
  async function requestQuote(scope: StudioScope) {
    if (!flow || busy || pendingSubmission) return;
    if (saving.current) {
      setNotice({
        tone: "info",
        text: "The latest edit is saving. Validate the flow once its saved status appears.",
      });
      return;
    }
    setBusy(true);
    setQuote(undefined);
    setNotice(undefined);
    try {
      if (dirty && !(await saveNow())) return;
      const current = flowRef.current!;
      const local = validateGraph(latest.current.graph, capabilities, {
        scope,
      });
      setIssues(local);
      if (local.some((i) => i.severity === "error")) {
        setNotice({
          tone: "warning",
          text: "Resolve the highlighted inputs before running.",
        });
        return;
      }
      const response = await client.post<{ quote: StudioQuote }>(
        `/api/studio/flows/${encodeURIComponent(current.id)}/quote`,
        { revision: current.revision, scope },
      );
      if (
        flowRef.current?.revision !== current.revision ||
        saveFingerprint(latest.current.name, latest.current.graph) !==
          saveFingerprint(current.name, current.graph)
      ) {
        setNotice({
          tone: "info",
          text: "The draft changed while estimating. Validate the new draft before running.",
        });
        return;
      }
      const next = response.quote;
      if (
        !next ||
        next.flowId !== current.id ||
        next.flowRevision !== current.revision
      )
        throw new Error("The estimate did not match this saved flow.");
      setQuote(next);
      setIssues(next.issues);
      setMaxGenerations(Math.min(8, Math.max(1, next.generationCount)));
      setMaxCost(
        next.estimate.maximumUsd !== undefined
          ? String(next.estimate.maximumUsd)
          : next.estimate.estimatedUsd !== null
            ? String(next.estimate.estimatedUsd)
            : "",
      );
      setAllowUnknown(false);
    } catch (error) {
      if (error instanceof StudioResponseError) {
        const body = error.body as { issues?: StudioIssue[] };
        if (body.issues) setIssues(body.issues);
      }
      if (!(error instanceof StudioScopeChanged))
        setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  async function submitRun(retry?: PendingStudioSubmission) {
    if (!flow || busy || (!quote && !retry)) return;
    const submission = retry || {
      path: `/api/studio/flows/${encodeURIComponent(flow.id)}/runs`,
      key: crypto.randomUUID(),
      body: {
        quoteId: quote!.id,
        scope: quote!.scope,
        maxCostUsd: maxCost.trim() ? Number(maxCost) : null,
        allowUnknownCost: allowUnknown,
        maxGenerations,
      },
    };
    setBusy(true);
    setPendingSubmission(submission);
    setNotice(undefined);
    const receiptKey = `asael:studio-submission:${owner}:${flow.id}`;
    try {
      sessionStorage.setItem(receiptKey, JSON.stringify(submission));
    } catch {
      setNotice({
        tone: "warning",
        text: "Tab storage is unavailable. Keep this page open until the run receipt is confirmed.",
      });
    }
    try {
      const response = await client.post<{ run: StudioRun }>(
        submission.path,
        submission.body,
        submission.key,
      );
      const run = readRun(response.run, flow.id);
      setActiveRun(run);
      setRuns((old) => [run, ...old.filter((r) => r.id !== run.id)]);
      setEvents([]);
      eventCursor.current = 0;
      setQuote(undefined);
      setPendingSubmission(undefined);
      try {
        sessionStorage.removeItem(receiptKey);
      } catch {}
      setShowHistory(true);
    } catch (error) {
      if (error instanceof StudioScopeChanged) return;
      if (!uncertainFailure(error)) {
        setPendingSubmission(undefined);
        try {
          sessionStorage.removeItem(receiptKey);
        } catch {}
      }
      setNotice({
        tone: "error",
        text: uncertainFailure(error)
          ? "The run response was interrupted. Retry this exact submission to recover its receipt; it keeps the same submission identity."
          : errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function runAction(action: "cancel" | "retry-persistence") {
    if (!activeRun || busy) return;
    setBusy(true);
    try {
      const response = await client.post<{ run: StudioRun }>(
        `/api/studio/runs/${encodeURIComponent(activeRun.id)}`,
        { action },
      );
      setActiveRun(readRun(response.run, flow?.id));
      setPollRevision((current) => current + 1);
      setNotice({
        tone: "info",
        text:
          action === "cancel"
            ? "Cancellation requested. Work already accepted by a provider may still finish and incur its charge."
            : "Storage retry requested for the existing provider result. No new generation was requested.",
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  async function returnToSavedFlows() {
    const generation = ++loadGeneration.current;
    flowRef.current = undefined;
    setFlow(undefined);
    setQuote(undefined);
    setNotice(undefined);
    setLoading(true);
    window.history.replaceState(null, "", "/app/studio");
    try {
      sessionStorage.removeItem(`asael:studio-last-flow:${owner}`);
    } catch {}
    try {
      const response = await client.json<{ flows: StudioFlow[] }>(
        "/api/studio/flows",
      );
      if (generation === loadGeneration.current)
        setFlows(response.flows.map(readFlow));
    } catch (error) {
      if (
        !(error instanceof StudioScopeChanged) &&
        generation === loadGeneration.current
      )
        setNotice({
          tone: "error",
          text: `The saved-flow list could not refresh. ${errorMessage(error)}`,
        });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }
  async function flowAction(action: "duplicate" | "archive") {
    if (!flow || busy) return;
    setBusy(true);
    try {
      const response = await client.post<{ flow: StudioFlow }>(
        `/api/studio/flows/${encodeURIComponent(flow.id)}/actions`,
        { action, revision: flow.revision },
      );
      if (action === "duplicate") {
        const copied = readFlow(response.flow);
        setFlows((old) => [copied, ...old]);
        await loadFlow(copied.id);
      } else {
        setFlows((old) => old.filter((f) => f.id !== flow.id));
        await returnToSavedFlows();
      }
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  const isDemo = graph.nodes.some(
    (n) => capabilities.find((c) => c.id === n.config.capabilityId)?.demo,
  );
  const readOnly = !writable || Boolean(flow?.archived);
  const readyQuote =
    quote &&
    !dirty &&
    quote.flowRevision === flow?.revision &&
    quote.id !== expiredQuoteId &&
    !quote.issues.some((i) => i.severity === "error");
  return (
    <section
      className={styles.studio}
      aria-label="Visual Studio"
      data-testid="creative-studio"
    >
      <header className={styles.toolbar}>
        <div className={styles.titleGroup}>
          {flow ? (
            <button
              type="button"
              className={styles.iconButton}
              disabled={dirty || busy}
              aria-label="Back to saved flows"
              onClick={() => void returnToSavedFlows()}
            >
              <ArrowLeft size={18} />
            </button>
          ) : (
            <Workflow size={24} aria-hidden="true" />
          )}
          <div>
            <h1>Visual Studio</h1>
            <p>
              {flow
                ? `${saveState === "conflict" ? "Save conflict" : saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : dirty ? "Unsaved changes" : "Saved"} · ${flow.projectId ? "Project flow" : "Workspace flow"}`
                : "Create images and videos in reusable flows"}
            </p>
          </div>
          {isDemo && flow ? (
            <span className={styles.demo}>Contains demo fixtures</span>
          ) : null}
        </div>
        <div className={styles.actions}>
          {flow ? (
            <>
              <button
                className={styles.iconButton}
                aria-label="Undo graph edit"
                disabled={!history.past.length || readOnly}
                onClick={() => moveGraphHistory("undo")}
              >
                <Undo2 size={16} />
              </button>
              <button
                className={styles.iconButton}
                aria-label="Redo graph edit"
                disabled={!history.future.length || readOnly}
                onClick={() => moveGraphHistory("redo")}
              >
                <Redo2 size={16} />
              </button>
              <button
                className={styles.button}
                disabled={busy}
                onClick={() => setShowHistory(!showHistory)}
              >
                <History size={16} aria-hidden="true" />
                Run history
              </button>
              <button
                className={styles.button}
                disabled={
                  readOnly ||
                  busy ||
                  Boolean(pendingSubmission) ||
                  saveState === "conflict"
                }
                onClick={() =>
                  void requestQuote({ mode: "flow", regenerate: false })
                }
              >
                <Check size={16} aria-hidden="true" />
                Validate & estimate
              </button>
              <button
                className={styles.primary}
                disabled={
                  readOnly ||
                  busy ||
                  Boolean(pendingSubmission) ||
                  saveState === "conflict"
                }
                onClick={() =>
                  void requestQuote({ mode: "flow", regenerate: false })
                }
              >
                <Play size={16} aria-hidden="true" />
                Run flow
              </button>
            </>
          ) : (
            <button
              className={styles.primary}
              disabled={!writable || busy || loading || Boolean(pendingCreate)}
              onClick={() => void createFlow()}
            >
              <Plus size={16} aria-hidden="true" />
              New flow
            </button>
          )}
        </div>
      </header>
      {!writable ? (
        <div className={styles.notice}>
          Your current role can view flows and results. Editing and running
          require an operator role.
        </div>
      ) : null}
      {notice ? (
        <div
          className={styles.notice}
          data-tone={notice.tone}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <p>{notice.text}</p>
        </div>
      ) : null}
      {flow && (saveState === "conflict" || saveState === "error") ? (
        <section
          className={styles.notice}
          data-tone={saveState === "conflict" ? "warning" : "error"}
          aria-label="Unsaved flow recovery"
          role="alert"
        >
          <p>
            {saveError ||
              "Your latest edits have not been saved. Your draft is retained."}
          </p>
          {saveState === "conflict" ? (
            <div className={styles.actions}>
              <button
                className={styles.button}
                disabled={busy || !writable}
                onClick={() => void createFlow(undefined, true)}
              >
                Save draft as a copy
              </button>
              <button
                className={styles.button}
                disabled={busy}
                onClick={() => {
                  try {
                    sessionStorage.removeItem(draftKey);
                  } catch {}
                  if (flow) void loadFlow(flow.id);
                }}
              >
                Discard draft and load saved flow
              </button>
            </div>
          ) : (
            <button
              className={styles.button}
              disabled={busy || !writable}
              onClick={() => void saveNow()}
            >
              Retry save
            </button>
          )}
        </section>
      ) : null}
      {pendingSubmission ? (
        <div className={styles.notice} data-tone="warning">
          <p>
            {busy
              ? "Submitting this exact run…"
              : "Submission outcome is unconfirmed. Recover its receipt before starting another run."}
          </p>
          <button
            className={styles.button}
            disabled={busy}
            onClick={() => void submitRun(pendingSubmission)}
          >
            Recover run receipt
          </button>
        </div>
      ) : null}
      {pendingCreate ? (
        <div className={styles.notice} data-tone="warning">
          <p>
            {busy
              ? "Saving this exact new flow…"
              : "Flow creation is unconfirmed. Recover the original result before creating another flow."}
          </p>
          <button
            className={styles.button}
            disabled={busy || !writable}
            onClick={() => void createFlow()}
          >
            Recover flow creation
          </button>
        </div>
      ) : null}
      {loading && !flow ? (
        <div className={styles.empty}>
          <div
            className={styles.skeleton}
            role="status"
            aria-label="Loading saved flows"
          />
        </div>
      ) : !flow ? (
        <div className={styles.empty}>
          <h2>Your creative workflows</h2>
          <p>
            Connect a prompt and references to image and video models. Saved
            flows retain their results and run history.
          </p>
          <h3 className={styles.sectionHeading}>Start from a template</h3>
          {STUDIO_TEMPLATES.map((t) => (
            <button
              key={t.id}
              className={styles.libraryItem}
              disabled={
                !writable ||
                busy ||
                !capabilities.length ||
                Boolean(pendingCreate)
              }
              onClick={() => void createFlow(t.id)}
            >
              <Workflow size={20} aria-hidden="true" />
              <span>
                <strong>{t.name}</strong>
                <small>{t.description}</small>
              </span>
            </button>
          ))}
          <p className={styles.support}>
            Templates use available models. Demo operations are clearly labeled
            and create fixed fixture files without paid requests.
          </p>
          <h3 className={styles.sectionHeading}>Saved flows</h3>
          {flows.length ? (
            <div className={styles.flowList}>
              {flows
                .filter(
                  (f) =>
                    !f.archived &&
                    (!initialProjectId || f.projectId === initialProjectId),
                )
                .map((f) => (
                  <div className={styles.flowRow} key={f.id}>
                    <button disabled={busy} onClick={() => void loadFlow(f.id)}>
                      <strong>{f.name}</strong>
                      <small>
                        {f.graph.nodes.length} nodes · Updated{" "}
                        {new Date(f.updatedAt).toLocaleString()}
                      </small>
                    </button>
                    <button
                      className={styles.button}
                      onClick={() => void loadFlow(f.id)}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      Open flow
                    </button>
                  </div>
                ))}
            </div>
          ) : (
            <p className={styles.support}>
              Your first saved flow will appear here.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <label
              className={styles.field}
              style={{ margin: 0, flex: "1 1 12rem", maxWidth: "28rem" }}
            >
              Flow name
              <input
                className={styles.input}
                value={name}
                maxLength={160}
                disabled={readOnly}
                onChange={(e) => {
                  setName(e.target.value);
                  setQuote(undefined);
                }}
              />
            </label>
            <div className={styles.actions}>
              <button
                className={styles.iconButton}
                aria-label="Toggle node library"
                aria-pressed={library}
                onClick={() => setLibrary(!library)}
              >
                <PanelLeft size={16} />
              </button>
              <button
                className={styles.iconButton}
                aria-label="Toggle inspector"
                aria-pressed={inspector}
                onClick={() => setInspector(!inspector)}
              >
                <PanelRight size={16} />
              </button>
              <button
                className={styles.button}
                onClick={() => setListView(!listView)}
                disabled={narrow}
              >
                {listView || narrow ? (
                  <LayoutGrid size={16} />
                ) : (
                  <List size={16} />
                )}{" "}
                {listView || narrow ? "Canvas" : "Node list"}
              </button>
              <button
                className={styles.iconButton}
                aria-label="Keyboard shortcuts"
                aria-expanded={shortcuts}
                onClick={() => setShortcuts(!shortcuts)}
              >
                <Keyboard size={16} />
              </button>
              <button
                className={styles.iconButton}
                aria-label="Duplicate selected nodes"
                disabled={!selectedNodes.length || readOnly}
                onClick={duplicateSelection}
              >
                <Copy size={16} />
              </button>
              <button
                className={styles.iconButton}
                aria-label="Delete selected nodes or connections"
                disabled={
                  (!selectedNodes.length && !selectedEdges.length) || readOnly
                }
                onClick={removeSelection}
              >
                <Trash2 size={16} />
              </button>
              <button
                className={styles.iconButton}
                aria-label="Save flow now"
                disabled={
                  !dirty ||
                  saveState === "saving" ||
                  readOnly ||
                  saveState === "conflict"
                }
                onClick={() => void saveNow()}
              >
                <Save size={16} />
              </button>
            </div>
          </div>
          {shortcuts ? (
            <section className={styles.shortcuts}>
              <h2>Canvas shortcuts</h2>
              <div className={styles.shortcutList}>
                <span>⌘/Ctrl Z: Undo</span>
                <span>⌘/Ctrl Shift Z: Redo</span>
                <span>⌘/Ctrl D: Duplicate selection</span>
                <span>Delete: Remove selection</span>
                <span>Shift: Select multiple</span>
                <span>Esc: Clear selection</span>
              </div>
              <p className={styles.support}>
                Shortcuts pause while typing. Undo and redo change the graph
                only; they never repeat or cancel generation.
              </p>
            </section>
          ) : null}
          <div
            className={styles.workspace}
            data-library={library}
            data-inspector={inspector}
          >
            {library ? (
              <aside className={styles.library} aria-label="Node library">
                <div className={styles.panelHeading}>
                  <h2>Add a node</h2>
                  <span className={styles.support}>
                    {graph.nodes.length}/{STUDIO_MAX_NODES}
                  </span>
                </div>
                <label className={styles.field}>
                  Search nodes
                  <input
                    className={styles.input}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Prompt, image, video…"
                  />
                </label>
                {(Object.keys(nodeLabels) as StudioNodeType[])
                  .filter((type) =>
                    `${nodeLabels[type]} ${nodeDescriptions[type]}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((type) => (
                    <button
                      key={type}
                      className={styles.libraryItem}
                      disabled={readOnly}
                      onClick={() => addNode(type)}
                    >
                      <Plus size={16} aria-hidden="true" />
                      <span>
                        <strong>{nodeLabels[type]}</strong>
                        <small>{nodeDescriptions[type]}</small>
                      </span>
                    </button>
                  ))}
                <h3 className={styles.sectionHeading}>Reusable assets</h3>
                {assets.slice(0, 12).map((a) => (
                  <button
                    className={styles.libraryItem}
                    disabled={readOnly}
                    key={a.id}
                    onClick={() => addNode("asset", a)}
                  >
                    {a.mediaType.startsWith("image/") ? (
                      <ImageIcon size={16} />
                    ) : (
                      <Film size={16} />
                    )}
                    <span>
                      <strong>{a.filename}</strong>
                      <small>
                        {a.demo ? "Demo fixture · " : ""}
                        {a.mediaType}
                      </small>
                    </span>
                  </button>
                ))}
                {!assets.length ? (
                  <p className={styles.support}>
                    Add a Reference node to upload an image. Generated results
                    can be reused here.
                  </p>
                ) : null}
                <details className={styles.details}>
                  <summary>Starter flows</summary>
                  {STUDIO_TEMPLATES.map((t) => (
                    <button
                      className={styles.libraryItem}
                      key={t.id}
                      disabled={
                        readOnly || dirty || busy || Boolean(pendingCreate)
                      }
                      onClick={() => void createFlow(t.id)}
                    >
                      <span>
                        <strong>{t.name}</strong>
                        <small>Creates a separate editable flow</small>
                      </span>
                    </button>
                  ))}
                </details>
              </aside>
            ) : null}
            {listView || narrow ? (
              <div className={styles.nodeList} aria-label="Flow nodes">
                {graph.nodes.map((n) => (
                  <button
                    className={styles.nodeListItem}
                    key={n.id}
                    aria-pressed={selectedNodes.includes(n.id)}
                    onClick={() => {
                      select([n.id], []);
                      setInspector(true);
                    }}
                  >
                    <strong>{n.title}</strong>
                    <small>
                      {nodeLabels[n.type]}
                      {nodeRuns[n.id]
                        ? ` · ${statusLabel(nodeRuns[n.id].status)}`
                        : ""}
                      {staleIds.has(n.id) ? " · Draft changed" : ""}
                    </small>
                  </button>
                ))}
                {!graph.nodes.length ? (
                  <p>Add a prompt or a generator from the node library.</p>
                ) : null}
              </div>
            ) : (
              <Canvas
                key={flow.id}
                graph={graph}
                capabilities={capabilities}
                viewport={viewport}
                nodeRuns={nodeRuns}
                staleIds={staleIds}
                selectedNodes={selectedNodes}
                selectedEdges={selectedEdges}
                onSelection={select}
                onGraph={changeGraph}
                onCheckpoint={() => dispatch({ type: "checkpoint" })}
                onViewport={setViewport}
                onError={(text) => setNotice({ tone: "warning", text })}
                readOnly={readOnly}
              />
            )}
            {inspector ? (
              <aside className={styles.inspector} aria-label="Node inspector">
                <StudioInspector
                  key={currentNode?.id || "none"}
                  node={currentNode}
                  graph={graph}
                  capabilities={capabilities}
                  assets={assets}
                  run={currentNode ? nodeRuns[currentNode.id] : undefined}
                  historicalAssets={selectedOutputs}
                  upstreamResults={previousResults}
                  staleNodeIds={staleIds}
                  stale={Boolean(currentNode && staleIds.has(currentNode.id))}
                  selectableOutputIds={
                    currentNode
                      ? previousResults[currentNode.id]?.outputAssets.map(
                          (asset) => asset.id,
                        ) || []
                      : []
                  }
                  issues={issues}
                  disabled={readOnly}
                  busy={busy || uploading || Boolean(pendingSubmission)}
                  onNode={(node) =>
                    changeGraph({
                      ...graph,
                      nodes: graph.nodes.map((n) =>
                        n.id === node.id ? node : n,
                      ),
                    })
                  }
                  onGraph={changeGraph}
                  onUpload={uploadReference}
                  onReuse={(asset) => addNode("asset", asset)}
                  onRun={(scope) => void requestQuote(scope)}
                  onNotice={(text, kind) =>
                    setNotice({ tone: "info", text, kind })
                  }
                />
              </aside>
            ) : null}
          </div>
          {issues.length ? (
            <div className={styles.notice} data-tone="warning">
              <strong>Flow validation</strong>
              <ul className={styles.issues}>
                {issues.map((i, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => {
                        if (i.nodeId) select([i.nodeId], []);
                        setInspector(true);
                      }}
                    >
                      {i.nodeId
                        ? `${graph.nodes.find((n) => n.id === i.nodeId)?.title || "Node"}: `
                        : ""}
                      {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {quote ? (
            <section className={styles.quote} aria-label="Run estimate">
              <div className={styles.panelHeading}>
                <h2>
                  {scopeLabel(
                    quote.scope,
                    graph.nodes.find((n) => n.id === quote.scope.nodeId),
                  )}
                  : review estimate
                </h2>
                <button
                  className={styles.iconButton}
                  aria-label="Dismiss estimate"
                  onClick={() => setQuote(undefined)}
                >
                  <X size={16} />
                </button>
              </div>
              <div className={styles.quoteContent}>
                <div>
                  <strong>
                    {quote.estimate.status === "unknown"
                      ? "Cost unavailable"
                      : quote.estimate.status === "range"
                        ? `Estimated $${quote.estimate.estimatedUsd?.toFixed(3) ?? "unknown"} USD`
                        : `$${quote.estimate.estimatedUsd?.toFixed(3) ?? "unknown"} USD`}
                  </strong>
                  <p className={styles.support}>
                    {quote.generationCount} new output
                    {quote.generationCount === 1 ? "" : "s"} ·{" "}
                    {quote.reusedNodeIds.length} node
                    {quote.reusedNodeIds.length === 1 ? "" : "s"} reusing saved
                    results
                  </p>
                  <p className={styles.support}>{quote.estimate.explanation}</p>
                  {quote.estimate.maximumUsd !== undefined ? (
                    <p className={styles.support}>
                      Conservative upper bound: $
                      {quote.estimate.maximumUsd.toFixed(3)} USD
                    </p>
                  ) : null}
                  <p className={styles.support}>
                    Provider charges and application usage are separate.
                    Cancellation does not promise a refund.
                  </p>
                  <p className={styles.support}>
                    Estimate expires{" "}
                    {new Date(quote.expiresAt).toLocaleTimeString()}. Request a
                    new estimate if it expires.
                  </p>
                </div>
                <div>
                  <label className={styles.field}>
                    Maximum new outputs (up to 8)
                    <input
                      type="number"
                      className={styles.input}
                      min={1}
                      max={8}
                      value={maxGenerations}
                      onChange={(e) =>
                        setMaxGenerations(Number(e.target.value))
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Run cost cap (USD)
                    <input
                      type="number"
                      className={styles.input}
                      min={0}
                      step="any"
                      value={maxCost}
                      placeholder="No known cost cap"
                      onChange={(e) => setMaxCost(e.target.value)}
                    />
                  </label>
                  {quote.requiresUnknownCostConsent ? (
                    <label className={styles.checkbox}>
                      <input
                        type="checkbox"
                        checked={allowUnknown}
                        onChange={(e) => setAllowUnknown(e.target.checked)}
                      />
                      I understand this provider’s cost cannot be estimated.
                    </label>
                  ) : null}
                  <button
                    className={styles.primary}
                    disabled={
                      !readyQuote ||
                      busy ||
                      readOnly ||
                      !Number.isInteger(maxGenerations) ||
                      maxGenerations < Math.max(1, quote.generationCount) ||
                      maxGenerations > 8 ||
                      (quote.requiresUnknownCostConsent && !allowUnknown) ||
                      Boolean(
                        maxCost &&
                          (!Number.isFinite(Number(maxCost)) ||
                            Number(maxCost) < 0),
                      )
                    }
                    onClick={() => void submitRun()}
                  >
                    <Play size={16} aria-hidden="true" />
                    {isDemo ? "Start reviewed flow" : "Start generation"}
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {showHistory || activeRun ? (
            <section className={styles.activity} aria-label="Run activity">
              <div className={styles.panelHeading}>
                <h2>Run activity</h2>
                <div className={styles.actions}>
                  {activeRun &&
                  !STUDIO_TERMINAL_RUN_STATES.includes(activeRun.status) ? (
                    <button
                      className={styles.button}
                      disabled={
                        busy ||
                        readOnly ||
                        Boolean(activeRun.cancellationRequestedAt)
                      }
                      onClick={() => void runAction("cancel")}
                    >
                      {activeRun.cancellationRequestedAt
                        ? "Cancellation requested"
                        : "Cancel remaining work"}
                    </button>
                  ) : null}
                  {activeRun?.nodes.some(
                    (n) =>
                      n.status === "persisting" ||
                      n.errorCode === "studio_persistence_canceled",
                  ) ? (
                    <button
                      className={styles.button}
                      disabled={busy || readOnly}
                      onClick={() => void runAction("retry-persistence")}
                    >
                      Retry result storage
                    </button>
                  ) : null}
                  <select
                    className={styles.select}
                    style={{ maxWidth: "22rem" }}
                    aria-label="Choose a saved run"
                    value={activeRun?.id || ""}
                    onChange={(e) => {
                      const selected = runs.find(
                        (r) => r.id === e.target.value,
                      );
                      setEvents([]);
                      eventCursor.current = 0;
                      setActiveRun(selected);
                    }}
                  >
                    <option value="">Choose a run</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {new Date(r.createdAt).toLocaleString()} ·{" "}
                        {statusLabel(r.status)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {pollError ? (
                <p className={styles.error} role="alert">
                  {pollError} The last confirmed run is retained; reconnecting.
                </p>
              ) : null}
              {activeRun ? (
                <>
                  <p className={styles.support}>
                    {statusLabel(activeRun.status)} ·{" "}
                    {durationLabel(activeRun.createdAt, activeRun.completedAt)}{" "}
                    · Saved flow revision {activeRun.flowRevision}. Draft edits
                    affect future runs.
                  </p>
                  <div className={styles.runList}>
                    {activeRun.nodes.map((n) => (
                      <div className={styles.runRow} key={n.nodeId}>
                        <div>
                          <strong>
                            {activeRun.graph.nodes.find(
                              (node) => node.id === n.nodeId,
                            )?.title || "Removed node"}
                          </strong>
                          <p>
                            {n.reusedFrom ? "Reused successful output. " : ""}
                            {n.outputAssets.length} saved result
                            {n.outputAssets.length === 1 ? "" : "s"}
                            {n.error ? ` · ${n.error}` : ""}
                          </p>
                          <SavedRunResults
                            assets={n.outputAssets.map((asset) =>
                              enrichStudioAsset(asset, assets),
                            )}
                            disabled={readOnly}
                            onReuse={(asset) => addNode("asset", asset)}
                          />
                        </div>
                        <span data-status={n.status}>
                          {statusLabel(n.status)}
                        </span>
                        <button
                          className={styles.button}
                          disabled={
                            !graph.nodes.some((node) => node.id === n.nodeId)
                          }
                          onClick={() => {
                            select([n.nodeId], []);
                            setInspector(true);
                          }}
                        >
                          Inspect
                        </button>
                      </div>
                    ))}
                  </div>
                  {events.length ? (
                    <details className={styles.details}>
                      <summary>Execution events</summary>
                      <ol>
                        {events.map((e) => (
                          <li className={styles.support} key={e.seq}>
                            {new Date(e.createdAt).toLocaleTimeString()} ·{" "}
                            {e.message}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </>
              ) : (
                <p className={styles.support}>
                  Run history is stored with this flow. Close the browser and
                  return here to check progress.
                </p>
              )}
            </section>
          ) : null}
          <footer className={styles.toolbar}>
            <p className={styles.support}>
              Deleting a node keeps its saved assets and historical runs.
            </p>
            <div className={styles.actions}>
              <button
                className={styles.button}
                disabled={readOnly || busy || dirty}
                onClick={() => void flowAction("duplicate")}
              >
                Duplicate flow
              </button>
              <button
                className={styles.button}
                disabled={readOnly || busy || dirty}
                onClick={() => void flowAction("archive")}
              >
                Archive flow
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
