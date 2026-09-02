"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  GitBranch,
  History,
  Loader2,
  Map as MapIcon,
  MessageSquareText,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Volume2,
  Workflow,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import { ConversationCanvas } from "@/components/conversation-canvas";
import { CouncilExecutionMap } from "@/components/agents/council-execution-map";
import { VoiceMode } from "@/components/voice/voice-mode";
import workspaceStyles from "@/components/agent-runs-workspace.module.css";

type JsonRecord = Record<string, unknown>;
type ThreadSummary = { id: string; title: string; updatedAt: string; mode: AgentMode };
type ThreadTurn = { id: string; role: "user" | "assistant"; content: string; createdAt: string; runId?: string };
type AgentMode = "orchestrate" | "research" | "execute" | "learn";
type AgentId = string;
type GroundingReport = {
  status: "verified" | "not_required" | "missing" | "invalid";
  citedIds: string[];
  invalidIds: string[];
  sources: Array<{
    citationId: string;
    kind: string;
    title: string;
    confidence?: number;
    url?: string;
    snippet?: string;
    accessedAt?: string;
  }>;
};
type RunFeedback = {
  verdict: "useful" | "needs_work";
  correction?: string;
  updatedAt: string;
};
type ConversationMemory = {
  id: string;
  type: string;
  title: string;
  content: string;
  source: string;
  updatedAt: string;
  claimStatus?: string;
};
type TabKey = "memory" | "context" | "plan" | "execute" | "evidence";

type StreamEvent =
  | { type: "run"; runId?: string; threadId?: string; missionId?: string }
  | { type: "status"; label?: string; detail?: string }
  | {
      type: "harness";
      version: 1 | 2;
      mode: AgentMode;
      provider: "openai" | "google" | "anthropic" | "aws_bedrock" | "fallback";
      model: string;
      tier: "fast" | "reasoning";
      memoryScope: "session" | "project" | "all";
      contextDecision: "disabled_session" | "excluded_by_user" | "selected_by_user" | "retrieved" | "skipped";
      contextMode: string;
      contextCount: number;
      contextTraceId?: string;
      contextEvidenceIds: string[];
      contextRationale: string[];
      liveWeb: boolean;
      toolCount: number;
      toolIds: string[];
      approvalToolCount: number;
      skillIds: string[];
      toolboxSha256: string;
      instructionsSha256: string;
      maxToolSteps: number;
      maxToolCallsPerTurn: number;
      maxToolResultChars: number;
      maxOutputTokens: number;
      approvalPolicy: "always" | "risk_based" | "read_only";
      autonomy: "assist" | "governed" | "execute";
      learningState?: "cold_start" | "observing" | "reinforced" | "supported";
      learningSampleSize?: number;
      learningGuidanceCount?: number;
    }
  | { type: "memory"; title?: string; count?: number }
  | { type: "model"; model: string; provider?: "openai" | "google" | "anthropic" | "aws_bedrock" | "local"; tier: "fast" | "reasoning"; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; latencyMs: number; fallbackUsed: boolean; estimatedCostUsd?: number; costKnown?: boolean; iteration?: number; iterationCount?: number }
  | { type: "council_member"; agentId: AgentId; agentName: string; role: string; status: "thinking" | "completed" | "failed"; summary?: string; confidence?: number; durationMs?: number }
  | { type: "council_verdict"; status: "passed" | "revised" | "failed"; score: number; assessment: string; requiredChanges: string[] }
  | { type: "delta"; text?: string }
  | {
      type: "tool";
      toolId?: string;
      toolName?: string;
      status?: string;
      riskLevel?: number;
      dryRun?: boolean;
      summary?: string;
    }
  | { type: "waiting_approval"; executionId?: string; toolId?: string; message?: string }
  | { type: "done"; response?: string; grounding?: GroundingReport }
  | { type: "delegated"; threadId?: string; workflowId?: string; missionId?: string; acknowledgement?: string; reason?: string }
  | { type: "canceled"; message?: string }
  | { type: "error"; message?: string };

const tabs: Array<{ key: TabKey; label: string; icon: typeof TerminalSquare }> = [
  { key: "memory", label: "Memory", icon: Database },
  { key: "context", label: "Context", icon: Brain },
  { key: "plan", label: "Plan", icon: GitBranch },
  { key: "execute", label: "Activity", icon: Play },
  { key: "evidence", label: "Result", icon: FileText },
];

export function AgentRunsWorkspace({
  initialAgentId,
  initialThreadId,
  initialMissionId,
  initialGoal,
}: {
  initialAgentId?: AgentId;
  initialThreadId?: string;
  initialMissionId?: string;
  initialGoal?: string;
}) {
  const {
    session,
    status: sessionStatus,
    role,
  } = useWorkspaceSession();
  const [goal, setGoal] = useState(initialGoal || "");
  const [mode, setMode] = useState<AgentMode>("orchestrate");
  const [preferredAgentId, setPreferredAgentId] = useState<AgentId | undefined>(initialAgentId);
  const [preferredAgentName, setPreferredAgentName] = useState<string | undefined>(initialAgentId ? agentDisplayName(initialAgentId) : undefined);
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("context");
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const [contextPack, setContextPack] = useState<JsonRecord>();
  const [contextQuery, setContextQuery] = useState("");
  const [selectedContextIds, setSelectedContextIds] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string>();
  const [workflowPlan, setWorkflowPlan] = useState<JsonRecord>();
  const [workflowRun, setWorkflowRun] = useState<JsonRecord>();
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [agentResponse, setAgentResponse] = useState("");
  const [grounding, setGrounding] = useState<GroundingReport>();
  const [activeAgentRunId, setActiveAgentRunId] = useState("");
  const [runFeedback, setRunFeedback] = useState<RunFeedback>();
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);
  const [evidence, setEvidence] = useState<JsonRecord>({});
  const [evidenceState, setEvidenceState] = useState<"loading" | "ready" | "error">("loading");
  const [workflowSyncError, setWorkflowSyncError] = useState<string>();
  const [runAnnouncement, setRunAnnouncement] = useState("Run workspace ready.");
  const [waitingApproval, setWaitingApproval] = useState<Extract<StreamEvent, { type: "waiting_approval" }>>();
  const [threadId, setThreadId] = useState(initialThreadId || "");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [conversationView, setConversationView] = useState<"chat" | "map">("chat");
  const [conversationsCollapsed, setConversationsCollapsed] = useState(false);
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  const [conversationMemories, setConversationMemories] = useState<ConversationMemory[]>([]);
  const [memoryState, setMemoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [memoryError, setMemoryError] = useState<string>();
  const [forgettingMemoryId, setForgettingMemoryId] = useState("");
  const [confirmForgetMemoryId, setConfirmForgetMemoryId] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const contextControllerRef = useRef<AbortController | null>(null);
  const contextVersionRef = useRef(0);
  const contextSelectionReviewedRef = useRef(false);
  const evidenceControllerRef = useRef<AbortController | null>(null);
  const evidenceVersionRef = useRef(0);
  const pendingDeltasRef = useRef<string[]>([]);
  const deltaFlushTimerRef = useRef<number | null>(null);
  const initialThreadLoadedRef = useRef(false);
  const responseAudioRef = useRef<HTMLAudioElement | null>(null);
  const responseAudioUrlRef = useRef<string | undefined>(undefined);
  const agentRequestIdRef = useRef<string>("");
  const directRunStatusRef = useRef("");
  const currentRunIdRef = useRef("");
  const detailsDialogRef = useRef<HTMLElement | null>(null);
  const detailsReturnFocusRef = useRef<HTMLElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptPinnedRef = useRef(true);
  const conversationsButtonRef = useRef<HTMLButtonElement | null>(null);
  const conversationsSheetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!initialAgentId || agentDisplayName(initialAgentId) !== "Custom agent") return;
    const controller = new AbortController();
    void readJson(`/api/agents/${encodeURIComponent(initialAgentId)}`, { signal: controller.signal })
      .then((payload) => setPreferredAgentName(stringPath(asRecord(payload), "agent.name", "Custom agent")))
      .catch(() => undefined);
    return () => controller.abort();
  }, [initialAgentId]);

  const planNodes = arrayPath(workflowPlan, "plan.plan.nodes");
  const contextResults = arrayPath(contextPack, "pack.results");
  const contextResultIds = contextResults
    .map(contextEvidenceId)
    .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index);
  const normalizedGoal = goal.trim();
  const contextPreparedForGoal = Boolean(
    normalizedGoal && contextQuery === normalizedGoal && !contextLoading,
  );
  const approvalItems = arrayPath(evidence, "approvals.items");
  const runRows = arrayPath(evidence, "runs.runs");
  const agentRunCompleted = streamEvents.some((event) => event.type === "done");
  const agentRunTerminal = streamEvents.some((event) => ["done", "error", "canceled"].includes(event.type));
  const reviewedPlanId = stringPath(workflowPlan, "plan.id", "");
  const reviewedPlanStatus = stringPath(workflowPlan, "plan.status", "");
  const reviewedPlanReady = Boolean(
    reviewedPlanId && reviewedPlanStatus === "planned",
  );
  const readPermission = permissionMessage(session, sessionStatus, "read");
  const runPermission = permissionMessage(session, sessionStatus, "run.agent");
  const voicePermission = permissionMessage(session, sessionStatus, "write.memory");
  const workflowPermission = permissionMessage(session, sessionStatus, "manage.workflow");
  const activeWorkflowId = stringPath(workflowRun, "run.id", "");
  const activeWorkflowStatus = stringPath(workflowRun, "run.status", "");
  const workflowInProgress = Boolean(
    activeWorkflowId &&
      !["completed", "failed", "canceled"].includes(activeWorkflowStatus),
  );
  const directRunInProgress = Boolean(
    loading === "agent" || waitingApproval || (activeAgentRunId && !agentRunTerminal),
  );
  const conversationLocked = workflowInProgress || directRunInProgress;
  const workflowReport = stringPath(workflowRun, "run.result.report", "");
  const currentAssistantResponse = workflowReport || agentResponse;
  const currentResponseIsLastTurn = Boolean(
    currentAssistantResponse &&
      turns.at(-1)?.role === "assistant" &&
      turns.at(-1)?.content === currentAssistantResponse,
  );
  const visibleTurns = currentResponseIsLastTurn ? turns.slice(0, -1) : turns;
  const activityVisible = Boolean(
    loading === "agent" || streamEvents.length > 0 || workflowRun,
  );
  const activityTerminal = workflowRun
    ? ["completed", "failed", "canceled"].includes(activeWorkflowStatus)
    : agentRunTerminal && loading !== "agent";
  const activityCount = workflowRun
    ? arrayPath(workflowRun, "steps").length + arrayPath(workflowRun, "events").length
    : streamEvents.filter((event) => event.type !== "delta").length;

  const runPosture = useMemo(() => {
    if (workflowRun) {
      if (activeWorkflowStatus === "completed") {
        return { label: "Workflow completed", tone: "success" as const };
      }
      if (activeWorkflowStatus === "failed") {
        return { label: "Workflow failed", tone: "danger" as const };
      }
      if (activeWorkflowStatus === "canceled") {
        return { label: "Workflow canceled", tone: "neutral" as const };
      }
      if (activeWorkflowStatus === "waiting_approval") {
        return { label: "Approval required", tone: "warning" as const };
      }
      if (activeWorkflowStatus === "paused") {
        return { label: "Workflow paused", tone: "warning" as const };
      }
      if (activeWorkflowStatus === "queued") {
        return { label: "Workflow queued", tone: "warning" as const };
      }
      if (activeWorkflowStatus === "running") {
        return { label: "Workflow running", tone: "neutral" as const };
      }
      return { label: "Workflow status unknown", tone: "neutral" as const };
    }
    if (waitingApproval) {
      return { label: "Approval required", tone: "warning" as const };
    }
    if (streamEvents.some((event) => event.type === "error")) {
      return { label: "Failed", tone: "danger" as const };
    }
    if (streamEvents.some((event) => event.type === "canceled")) {
      return { label: "Canceled", tone: "neutral" as const };
    }
    if (loading === "agent") {
      return { label: "Agent running", tone: "neutral" as const };
    }
    if (agentResponse) {
      return { label: "Evidence captured", tone: "success" as const };
    }
    if (workflowPlan) {
      if (reviewedPlanStatus === "failed") {
        return { label: "Plan needs changes", tone: "danger" as const };
      }
      return {
        label: reviewedPlanReady ? "Plan ready" : "Plan incomplete",
        tone: "warning" as const,
      };
    }
    if (contextPack) {
      return { label: "Context ready", tone: "warning" as const };
    }
    return { label: "Draft", tone: "neutral" as const };
  }, [
    activeWorkflowStatus,
    agentResponse,
    contextPack,
    loading,
    streamEvents,
    waitingApproval,
    reviewedPlanReady,
    reviewedPlanStatus,
    workflowPlan,
    workflowRun,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = window.localStorage.getItem("asael-conversations-collapsed");
      setConversationsCollapsed(stored === "true");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (sessionStatus !== "ready" || readPermission || !threadId) {
      const frame = window.requestAnimationFrame(() => {
        setConversationMemories([]);
        setMemoryState(threadId ? "idle" : "ready");
      });
      return () => window.cancelAnimationFrame(frame);
    }
    void refreshConversationMemories(threadId);
    // The selected conversation owns its memory view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, sessionStatus, readPermission]);

  useEffect(() => {
    if (!mobileConversationsOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => conversationsSheetRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileConversationsOpen(false);
        conversationsButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = conversationsSheetRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileConversationsOpen]);

  useEffect(() => {
    if (sessionStatus === "ready") {
      void refreshEvidence();
      void refreshThreads();
      if (initialThreadId && !initialThreadLoadedRef.current) {
        initialThreadLoadedRef.current = true;
        void loadThread(initialThreadId);
      }
    }
    return () => {
      abortControllerRef.current?.abort();
      contextControllerRef.current?.abort();
      evidenceControllerRef.current?.abort();
      if (deltaFlushTimerRef.current !== null) {
        window.clearTimeout(deltaFlushTimerRef.current);
      }
      responseAudioRef.current?.pause();
      if (responseAudioUrlRef.current) URL.revokeObjectURL(responseAudioUrlRef.current);
    };
    // Session changes are the only automatic evidence refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, role]);

  useEffect(() => {
    if (!detailsOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      detailsDialogRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailsOpen(false);
      if (event.key !== "Tab") return;
      const focusable = detailsDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      detailsReturnFocusRef.current?.focus();
    };
  }, [detailsOpen]);

  useEffect(() => {
    if (!transcriptPinnedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [agentResponse, currentAssistantResponse, loading, streamEvents.length, turns.length]);

  useEffect(() => {
    if (
      !activeWorkflowId ||
      ["completed", "failed", "canceled"].includes(activeWorkflowStatus)
    ) {
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const schedule = () => {
      if (!disposed) {
        timer = window.setTimeout(() => void poll(), 3_000);
      }
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      controller = new AbortController();
      try {
        const next = asRecord(
          await readJson(
            `/api/workflows/${encodeURIComponent(activeWorkflowId)}`,
            { signal: controller.signal },
          ),
        );
        if (disposed) {
          return;
        }
        setWorkflowSyncError(undefined);
        const nextStatus = stringPath(next, "run.status", "");
        setWorkflowRun(next);
        if (nextStatus && nextStatus !== activeWorkflowStatus) {
          void refreshEvidence();
          if (["completed", "failed", "canceled"].includes(nextStatus) && threadId) {
            void refreshThreadTurns(threadId);
          }
          if (nextStatus === "completed") {
            const report = stringPath(next, "run.result.report", "");
            if (report) {
              setAgentResponse(report);
              setTurns((current) => current.at(-1)?.content === report
                ? current
                : [...current, {
                    id: `workflow-${activeWorkflowId}-${Date.now()}`,
                    role: "assistant",
                    content: report,
                    createdAt: new Date().toISOString(),
                    runId: `workflow:${activeWorkflowId}`,
                  }]);
            }
          }
          setRunAnnouncement(`Workflow is now ${nextStatus.replace(/_/g, " ")}.`);
        }
      } catch (pollError) {
        if (!disposed && !controller.signal.aborted) {
          setWorkflowSyncError(
            `Live workflow updates are temporarily unavailable. Retrying automatically. ${refreshMessage(pollError)}`,
          );
        }
      } finally {
        schedule();
      }
    };
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
    // Run identity and status control the polling lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkflowId, activeWorkflowStatus]);

  useEffect(() => {
    if (!activeAgentRunId || loading === "agent" || agentRunTerminal) return;
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const schedule = () => {
      if (!disposed) timer = window.setTimeout(() => void poll(), 3_000);
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      controller = new AbortController();
      try {
        const payload = asRecord(await readJson(`/api/runs/${encodeURIComponent(activeAgentRunId)}`, { signal: controller.signal }));
        if (disposed) return;
        const run = asRecord(payload.run);
        const status = stringValue(run.status);
        const statusChanged = Boolean(status && status !== directRunStatusRef.current);
        if (status) directRunStatusRef.current = status;
        if (status === "waiting_approval") {
          const approval = asRecord(run.waitingApproval);
          setWaitingApproval({
            type: "waiting_approval",
            executionId: stringValue(approval.executionId),
            toolId: stringValue(approval.toolId),
            message: `${stringValue(approval.toolName, "A gated action")} needs approval before the task can continue.`,
          });
          if (statusChanged) setRunAnnouncement("Agent run is waiting for approval.");
        } else if (status === "running" || status === "resuming" || status === "queued") {
          setWaitingApproval(undefined);
          if (statusChanged) {
            setRunAnnouncement(status === "resuming" ? "Approved. The task is resuming." : `Agent run is ${status}.`);
          }
        } else if (status === "completed") {
          const response = stringValue(run.response);
          const nextGrounding = asRecord(run.grounding) as unknown as GroundingReport;
          setWaitingApproval(undefined);
          setAgentResponse(response);
          if (run.grounding) setGrounding(nextGrounding);
          setStreamEvents((current) => current.some((event) => event.type === "done")
            ? current
            : [...current, { type: "done", response, grounding: run.grounding ? nextGrounding : undefined }]);
          if (response) {
            setTurns((current) => current.at(-1)?.content === response
              ? current
              : [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: response, createdAt: new Date().toISOString(), runId: activeAgentRunId }]);
          }
          setRunAnnouncement("Agent run completed. Review the result and evidence.");
          void refreshEvidence();
          void refreshThreads();
        } else if (status === "failed") {
          const message = stringValue(run.error, "Agent run failed.");
          setWaitingApproval(undefined);
          setError(message);
          setStreamEvents((current) => [...current, { type: "error", message }]);
          setRunAnnouncement("Agent run failed.");
        } else if (status === "canceled") {
          setWaitingApproval(undefined);
          setStreamEvents((current) => [...current, { type: "canceled", message: "The task was canceled." }]);
          setRunAnnouncement("Agent run canceled.");
        }
      } catch {
        // Keep the visible last-known state and retry while the run remains active.
      } finally {
        schedule();
      }
    };
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // The run id and terminal state own this polling lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentRunId, agentRunTerminal, loading]);

  useEffect(() => {
    if (
      sessionStatus !== "ready" ||
      readPermission ||
      !normalizedGoal ||
      normalizedGoal.length < 8 ||
      workflowInProgress ||
      loading === "agent" ||
      contextLoading ||
      contextQuery === normalizedGoal
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void buildContext({ query: normalizedGoal, reveal: false });
    }, 900);
    return () => window.clearTimeout(timer);
    // Context is intentionally rebuilt only when the active task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contextLoading,
    contextQuery,
    loading,
    normalizedGoal,
    readPermission,
    sessionStatus,
    workflowInProgress,
  ]);

  function flushPendingDeltas() {
    if (!pendingDeltasRef.current.length) {
      deltaFlushTimerRef.current = null;
      return;
    }
    const batch = pendingDeltasRef.current.join("");
    pendingDeltasRef.current = [];
    deltaFlushTimerRef.current = null;
    setAgentResponse((current) => current + batch);
  }

  function queueDelta(text: string) {
    pendingDeltasRef.current.push(text);
    if (deltaFlushTimerRef.current === null) {
      deltaFlushTimerRef.current = window.setTimeout(flushPendingDeltas, 120);
    }
  }

  async function stopAgent() {
    const controller = abortControllerRef.current;
    if (!controller) {
      return;
    }
    const runId = activeAgentRunId;
    setRunAnnouncement("Stopping the agent run.");
    controller.abort();
    if (!runId) {
      return;
    }
    try {
      await readJson(`/api/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
      });
      void refreshEvidence();
      setRunAnnouncement("Agent run canceled.");
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "The run stream stopped, but durable cancellation could not be confirmed.",
      );
      setRunAnnouncement(
        "The stream stopped. Check Activity to confirm the run status.",
      );
    }
  }

  async function saveRunFeedback(
    verdict: RunFeedback["verdict"],
    correction?: string,
  ) {
    if (!activeAgentRunId) return;
    setFeedbackSaving(true);
    setError(undefined);
    try {
      const feedbackResult = await readJson(`/api/runs/${encodeURIComponent(activeAgentRunId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verdict,
          correction: correction?.trim() || undefined,
        }),
      });
      setRunFeedback({
        verdict,
        correction: correction?.trim() || undefined,
        updatedAt: new Date().toISOString(),
      });
      const learning = feedbackResult.learning as { affectedMemories?: number; demotedCapabilities?: string[] } | undefined;
      setRunAnnouncement(verdict === "useful"
        ? `Useful outcome recorded. ${learning?.affectedMemories || 0} learned memories were reinforced.`
        : `Correction recorded. ${learning?.affectedMemories || 0} learned memories were quarantined and ${learning?.demotedCapabilities?.length || 0} capability trust profiles were demoted.`);
      void refreshEvidence();
    } catch (feedbackError) {
      setError(
        feedbackError instanceof Error
          ? feedbackError.message
          : "Feedback could not be saved.",
      );
      setRunAnnouncement("Feedback could not be saved.");
    } finally {
      setFeedbackSaving(false);
    }
  }

  function openTaskDetails(tab: TabKey) {
    detailsReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveTab(tab);
    setDetailsOpen(true);
    if (tab === "memory" && threadId) {
      void refreshConversationMemories(threadId);
    }
  }

  function closeTaskDetails() {
    setDetailsOpen(false);
  }

  function changeGoal(nextGoal: string) {
    if (nextGoal === goal) {
      return;
    }
    contextControllerRef.current?.abort();
    contextVersionRef.current += 1;
    setGoal(nextGoal);
    setError(undefined);
    setContextPack(undefined);
    setContextQuery("");
    setSelectedContextIds([]);
    contextSelectionReviewedRef.current = false;
    setContextLoading(false);
    setContextError(undefined);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function changeMode(nextMode: AgentMode) {
    if (nextMode === mode) {
      return;
    }
    setMode(nextMode);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function changeApprovalRequired(nextValue: boolean) {
    if (nextValue === approvalRequired) {
      return;
    }
    setApprovalRequired(nextValue);
    setWorkflowPlan(undefined);
  }

  async function buildContext({
    query = goal.trim(),
    reveal = true,
  }: {
    query?: string;
    reveal?: boolean;
  } = {}) {
    if (readPermission) {
      setContextError(readPermission);
      if (reveal) openTaskDetails("context");
      return undefined;
    }
    const taskQuery = query.trim();
    if (reveal) contextSelectionReviewedRef.current = true;
    if (!taskQuery) {
      setContextError("Write the task first so Asael can find relevant context.");
      if (reveal) openTaskDetails("context");
      return undefined;
    }
    const version = ++contextVersionRef.current;
    contextControllerRef.current?.abort();
    const controller = new AbortController();
    contextControllerRef.current = controller;
    setContextLoading(true);
    setContextError(undefined);
    if (reveal) openTaskDetails("context");
    setRunAnnouncement("Finding context for this task.");
    try {
      const result = await readJson("/api/retrieval/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: taskQuery, limit: 8, persistTrace: false }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || version !== contextVersionRef.current) {
        return undefined;
      }
      const nextPack = asRecord(result);
      const evidenceIds = arrayPath(nextPack, "pack.results")
        .filter(contextMatchesTask)
        .map(contextEvidenceId)
        .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index);
      setContextPack(nextPack);
      setContextQuery(taskQuery);
      setSelectedContextIds(evidenceIds);
      setWorkflowPlan(undefined);
      setRunAnnouncement(
        evidenceIds.length
          ? `Context is ready. ${evidenceIds.length} matching items are selected.`
          : "No saved context matched this task. Asael will start without saved context.",
      );
      return { query: taskQuery, evidenceIds };
    } catch (buildError) {
      if (controller.signal.aborted || version !== contextVersionRef.current) {
        return undefined;
      }
      const message = buildError instanceof Error ? buildError.message : "Context retrieval failed.";
      setContextPack(undefined);
      setContextQuery(taskQuery);
      setSelectedContextIds([]);
      setContextError(message);
      setRunAnnouncement("Context could not be loaded. This task will use no saved context.");
      return { query: taskQuery, evidenceIds: [] };
    } finally {
      if (version === contextVersionRef.current) {
        setContextLoading(false);
        if (contextControllerRef.current === controller) {
          contextControllerRef.current = null;
        }
      }
    }
  }

  function updateContextSelection(nextIds: string[]) {
    if (workflowInProgress || loading === "agent") return;
    contextSelectionReviewedRef.current = true;
    const allowed = new Set(contextResultIds);
    setSelectedContextIds(
      nextIds.filter((id, index, values) => allowed.has(id) && values.indexOf(id) === index),
    );
    setWorkflowPlan(undefined);
    setRunAnnouncement("Context selection updated. Only checked items will be used.");
  }

  function contextSelectionForTask(query: string) {
    if (contextQuery !== query || contextLoading) return undefined;
    return { query, evidenceIds: selectedContextIds };
  }

  async function buildPlan() {
    if (workflowPermission) {
      setError(workflowPermission);
      return;
    }
    if (workflowInProgress) {
      setError("Wait for the active workflow to finish or cancel it before replacing its plan.");
      return;
    }
    const taskQuery = goal.trim();
    if (contextLoading) {
      openTaskDetails("context");
      setRunAnnouncement("Wait for task context to finish loading, then preview the plan.");
      return;
    }
    const contextSelection = contextSelectionForTask(taskQuery);
    if (!contextSelection) {
      const prepared = await buildContext({ query: taskQuery, reveal: true });
      if (prepared) {
        setRunAnnouncement("Context preparation finished. Review the selection, then preview the plan again.");
      }
      return;
    }
    setLoading("plan");
    setError(undefined);
    setRunAnnouncement("Generating a workflow plan.");
    try {
      const result = await readJson("/api/workflows/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: taskQuery,
          mode,
          requireApproval: approvalRequired,
          contextSelection,
        }),
      });
      const nextPlan = asRecord(result);
      const nextPlanStatus = stringPath(nextPlan, "plan.status", "");
      setWorkflowPlan(nextPlan);
      setWorkflowRun(undefined);
      setWorkflowSyncError(undefined);
      openTaskDetails("plan");
      setRunAnnouncement(
        nextPlanStatus === "planned"
          ? "Workflow plan is ready for review."
          : "The workflow plan needs changes before it can run.",
      );
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : "Workflow plan failed.");
      setRunAnnouncement("Workflow planning failed.");
    } finally {
      setLoading(undefined);
    }
  }

  async function startWorkflow() {
    if (workflowPermission) {
      setError(workflowPermission);
      return;
    }
    if (!reviewedPlanReady) {
      setError(
        reviewedPlanStatus === "failed"
          ? stringPath(
              workflowPlan,
              "plan.error",
              "This plan could not be executed safely. Generate a new plan.",
            )
          : "Generate and review a workflow plan before starting it.",
      );
      openTaskDetails("plan");
      return;
    }
    if (activeWorkflowId) {
      setError("This reviewed plan has already started. Generate a new plan to run again.");
      return;
    }
    const taskQuery = goal.trim();
    const contextSelection = contextSelectionForTask(taskQuery);
    if (!contextSelection) {
      setError("The task changed after this plan was prepared. Review fresh context and generate the plan again.");
      openTaskDetails("context");
      return;
    }
    setLoading("workflow");
    setError(undefined);
    setAgentResponse("");
    setGrounding(undefined);
    setStreamEvents([{ type: "status", label: "Starting workflow", detail: "Preparing durable work." }]);
    setTurns((current) => current.at(-1)?.role === "user" && current.at(-1)?.content === taskQuery
      ? current
      : [...current, {
          id: `pending-workflow-user-${Date.now()}`,
          role: "user",
          content: taskQuery,
          createdAt: new Date().toISOString(),
        }]);
    setRunAnnouncement("Starting the durable workflow.");
    try {
      let workflowThreadId = threadId;
      if (!workflowThreadId) {
        const threadResult = asRecord(await readJson("/api/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: taskQuery.slice(0, 200), mode }),
        }));
        workflowThreadId = stringPath(threadResult, "thread.id", "");
        if (!workflowThreadId) {
          throw new Error("The conversation could not be created.");
        }
        setThreadId(workflowThreadId);
        void refreshThreads();
      }
      const result = await readJson("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: taskQuery,
          mode,
          planId: reviewedPlanId || undefined,
          requireApproval: approvalRequired,
          metadata: {
            source: "agent-runs-workspace",
            threadId: workflowThreadId,
            contextSelection,
          },
        }),
      });
      setWorkflowRun(asRecord(result));
      setGoal("");
      setActiveTab("execute");
      void refreshEvidence();
      setRunAnnouncement("Workflow started. Activity and results are available from the workspace navigation.");
    } catch (workflowError) {
      setError(workflowError instanceof Error ? workflowError.message : "Workflow start failed.");
      setRunAnnouncement("Workflow start failed.");
    } finally {
      setLoading(undefined);
    }
  }

  async function runAgent(options?: {
    submittedGoal?: string;
    prepareContextAutomatically?: boolean;
  }) {
    if (runPermission) {
      setError(runPermission);
      return;
    }
    const submittedGoal = (options?.submittedGoal ?? goal).trim();
    if (!submittedGoal) {
      setError("Write a message before asking Asael.");
      return;
    }
    if (contextLoading && !options?.prepareContextAutomatically) {
      openTaskDetails("context");
      setRunAnnouncement("Wait for task context to finish loading, then run the task.");
      return;
    }
    const contextSelection = contextSelectionReviewedRef.current
      ? contextSelectionForTask(submittedGoal)
      : undefined;
    if (!contextSelection && !options?.prepareContextAutomatically) {
      const prepared = await buildContext({
        query: submittedGoal,
        reveal: true,
      });
      if (!prepared) return;
      setRunAnnouncement("Context preparation finished. Review the selection, then run the task again.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading("agent");
    setError(undefined);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setAgentResponse("");
    setGrounding(undefined);
    setActiveAgentRunId("");
    currentRunIdRef.current = "";
    setRunFeedback(undefined);
    setStreamEvents([{ type: "status", label: "Starting", detail: "Opening the durable conversation." }]);
    directRunStatusRef.current = "";
    setWaitingApproval(undefined);
    pendingDeltasRef.current = [];
    if (deltaFlushTimerRef.current !== null) {
      window.clearTimeout(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = null;
    }
    setActiveTab("execute");
    setRunAnnouncement("Agent run started.");
    const requestId = agentRequestIdRef.current || crypto.randomUUID();
    agentRequestIdRef.current = requestId;
    setTurns((current) => [
      ...current,
      { id: `pending-user-${Date.now()}`, role: "user", content: submittedGoal, createdAt: new Date().toISOString() },
    ]);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          threadId: threadId || undefined,
          missionId: initialMissionId || undefined,
          message: submittedGoal,
          requestId,
          strategy: "auto",
          agentId: preferredAgentId,
          contextSelection,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(stringValue(asRecord(body).message || asRecord(body).error, `/api/agent returned ${response.status}`));
      }

      let terminalEvent: "done" | "delegated" | "waiting_approval" | "error" | undefined;
      await readSse(response.body, (event) => {
        if (event.type === "run" && event.runId) {
          currentRunIdRef.current = event.runId;
          setActiveAgentRunId(event.runId);
          if (event.threadId) {
            setThreadId(event.threadId);
          }
          return;
        }
        if (event.type === "delta" && event.text) {
          queueDelta(event.text);
          return;
        }
        setStreamEvents((current) => [...current.slice(-199), event]);
        if (event.type === "delegated") {
          terminalEvent = "delegated";
          agentRequestIdRef.current = "";
          const acknowledgement = event.acknowledgement || "This task is continuing as a durable workflow.";
          if (event.threadId) setThreadId(event.threadId);
          if (event.workflowId) setWorkflowRun({ run: { id: event.workflowId } });
          setAgentResponse(acknowledgement);
          setTurns((current) => [
            ...current,
            { id: `assistant-${Date.now()}`, role: "assistant", content: acknowledgement, createdAt: new Date().toISOString() },
          ]);
          setGoal("");
          void refreshThreads();
          setRunAnnouncement("Task moved to a durable background workflow.");
        }
        if (event.type === "done") {
          terminalEvent = "done";
          agentRequestIdRef.current = "";
          flushPendingDeltas();
          setAgentResponse(event.response || "");
          setGrounding(event.grounding);
          if (event.response) {
            setTurns((current) => [
              ...current,
              { id: `assistant-${Date.now()}`, role: "assistant", content: event.response || "", createdAt: new Date().toISOString(), runId: currentRunIdRef.current || undefined },
            ]);
          }
          setGoal("");
          void refreshThreads();
          setRunAnnouncement("Agent run completed. Review the result and evidence.");
        }
        if (event.type === "status") {
          setRunAnnouncement(streamEventLabel(event));
        }
        if (event.type === "waiting_approval") {
          terminalEvent = "waiting_approval";
          agentRequestIdRef.current = "";
          setWaitingApproval(event);
          setRunAnnouncement("Agent run paused for approval.");
        }
        if (event.type === "error") {
          terminalEvent = "error";
          agentRequestIdRef.current = "";
          setError(event.message || "Agent run failed.");
          setRunAnnouncement("Agent run failed.");
        }
      });
      if (!terminalEvent) {
        throw new Error(
          "The agent stream ended before a final status was received. Check Activity before retrying.",
        );
      }
      flushPendingDeltas();
      void refreshEvidence();
    } catch (agentError) {
      if (controller.signal.aborted) {
        setStreamEvents((current) => [
          ...current.slice(-199),
          { type: "status", label: "Canceled", detail: "The operator stopped this run." },
        ]);
        setRunAnnouncement("Agent run stopped.");
      } else {
        setError(agentError instanceof Error ? agentError.message : "Agent run failed.");
        setRunAnnouncement("Agent run failed.");
      }
    } finally {
      flushPendingDeltas();
      abortControllerRef.current = null;
      setLoading(undefined);
    }
  }

  async function listenToResponse(text = currentAssistantResponse) {
    if (!text.trim() || speechLoading) return;
    if (responseAudioRef.current && !responseAudioRef.current.paused) {
      responseAudioRef.current.pause();
      return;
    }
    setSpeechLoading(true);
    try {
      const response = await fetch("/api/media/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(stringValue(asRecord(body).error, "Speech playback failed.")); }
      const blob = await response.blob();
      if (responseAudioUrlRef.current) URL.revokeObjectURL(responseAudioUrlRef.current);
      const url = URL.createObjectURL(blob);
      responseAudioUrlRef.current = url;
      const audio = new Audio(url);
      responseAudioRef.current = audio;
      await audio.play();
    } catch (speechError) {
      setError(speechError instanceof Error ? speechError.message : "Speech playback failed.");
    } finally { setSpeechLoading(false); }
  }

  async function refreshThreads() {
    try {
      const result = asRecord(await readJson("/api/threads?limit=100"));
      setThreads(arrayPath(result, "threads") as unknown as ThreadSummary[]);
    } catch {
      // Threads are convenience navigation; agent execution reports its own errors.
    }
  }

  function toggleConversationsColumn() {
    setConversationsCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("asael-conversations-collapsed", String(next));
      return next;
    });
  }

  async function refreshConversationMemories(id = threadId) {
    if (!id) {
      setConversationMemories([]);
      setMemoryState("ready");
      return;
    }
    setMemoryState("loading");
    setMemoryError(undefined);
    try {
      const result = asRecord(await readJson(`/api/memory?threadId=${encodeURIComponent(id)}&limit=100`));
      if (id !== threadId) return;
      setConversationMemories(arrayPath(result, "memories") as unknown as ConversationMemory[]);
      setMemoryState("ready");
    } catch (memoryLoadError) {
      if (id !== threadId) return;
      setMemoryError(memoryLoadError instanceof Error ? memoryLoadError.message : "Conversation memory could not be loaded.");
      setMemoryState("error");
    }
  }

  async function forgetConversationMemory(memoryId: string) {
    setForgettingMemoryId(memoryId);
    setMemoryError(undefined);
    try {
      await readJson(`/api/memory/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      setConversationMemories((current) => current.filter((memory) => memory.id !== memoryId));
      setConfirmForgetMemoryId("");
      setRunAnnouncement("Memory forgotten. It will no longer influence future conversations.");
    } catch (memoryDeleteError) {
      setMemoryError(memoryDeleteError instanceof Error ? memoryDeleteError.message : "Memory could not be forgotten.");
    } finally {
      setForgettingMemoryId("");
    }
  }

  async function refreshThreadTurns(id: string) {
    try {
      const result = asRecord(await readJson(`/api/threads/${encodeURIComponent(id)}`));
      if (id !== threadId) return;
      setTurns(arrayPath(result, "turns") as unknown as ThreadTurn[]);
    } catch {
      // Keep the current transcript visible and let the next poll or reopen retry.
    }
  }

  async function loadThread(id: string) {
    try {
      const result = asRecord(await readJson(`/api/threads/${encodeURIComponent(id)}`));
      const thread = asRecord(result.thread);
      setThreadId(stringValue(thread.id));
      setMode((stringValue(thread.mode, "orchestrate") as AgentMode));
      setTurns(arrayPath(result, "turns") as unknown as ThreadTurn[]);
      setAgentResponse("");
      contextControllerRef.current?.abort();
      contextVersionRef.current += 1;
      setContextPack(undefined);
      setContextQuery("");
      setSelectedContextIds([]);
      contextSelectionReviewedRef.current = false;
      setContextLoading(false);
      setContextError(undefined);
      setWorkflowPlan(undefined);
      setWorkflowRun(undefined);
      setWorkflowSyncError(undefined);
      setActiveAgentRunId("");
      currentRunIdRef.current = "";
      directRunStatusRef.current = "";
      setStreamEvents([]);
      setWaitingApproval(undefined);
      setGrounding(undefined);
      setActiveTab("execute");
      setDetailsOpen(false);
      setMobileConversationsOpen(false);
      setConversationView("chat");
      agentRequestIdRef.current = "";
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Conversation could not be loaded.");
    }
  }

  function newThread() {
    contextControllerRef.current?.abort();
    contextVersionRef.current += 1;
    setThreadId("");
    setTurns([]);
    setGoal("");
    setContextPack(undefined);
    setContextQuery("");
    setSelectedContextIds([]);
    contextSelectionReviewedRef.current = false;
    setContextLoading(false);
    setContextError(undefined);
    setAgentResponse("");
    setStreamEvents([]);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setActiveAgentRunId("");
    currentRunIdRef.current = "";
    directRunStatusRef.current = "";
    setWaitingApproval(undefined);
    setGrounding(undefined);
    setActiveTab("context");
    setDetailsOpen(false);
    setMobileConversationsOpen(false);
    setConversationView("chat");
    setConversationMemories([]);
    setMemoryState("ready");
    setError(undefined);
  }

  async function tickQueue() {
    if (workflowPermission) {
      setError(workflowPermission);
      return;
    }
    setLoading("tick");
    setError(undefined);
    setRunAnnouncement("Processing queued workflow work.");
    try {
      await readJson("/api/workflows/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 5, slo: true, alerts: false }),
      });
      void refreshEvidence();
      setActiveTab("evidence");
      setRunAnnouncement("Queue processing finished. Evidence was refreshed.");
    } catch (tickError) {
      setError(tickError instanceof Error ? tickError.message : "Queue tick failed.");
      setRunAnnouncement("Queue processing failed.");
    } finally {
      setLoading(undefined);
    }
  }

  async function refreshEvidence() {
    if (sessionStatus !== "ready" || !session) {
      return;
    }
    const version = ++evidenceVersionRef.current;
    evidenceControllerRef.current?.abort();
    const controller = new AbortController();
    evidenceControllerRef.current = controller;
    setEvidenceState("loading");
    try {
      if (Boolean(session.authEnabled) && !Boolean(session.authenticated)) {
        const protectedPayload = {
          error: "Sign in to load protected production evidence.",
          items: [],
          runs: [],
        };
        setEvidence({
          runs: protectedPayload,
          approvals: protectedPayload,
          workflows: protectedPayload,
        });
        setEvidenceState("ready");
        return;
      }
      const payload = asRecord(
        await readJson("/api/workspace-summary?limit=8&approvalLimit=8", {
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted || version !== evidenceVersionRef.current) {
        return;
      }
      const summary = asRecord(payload.summary);
      setEvidence({
        runs: workspaceSourcePayload(summary, "runs", "runs"),
        approvals: workspaceSourcePayload(summary, "approvals", "items"),
        workflows: workspaceSourcePayload(summary, "workflows", "runs"),
      });
      setEvidenceState("ready");
    } catch (refreshError) {
      if (controller.signal.aborted || version !== evidenceVersionRef.current) {
        return;
      }
      setEvidenceState("error");
      setEvidence({
        error: refreshMessage(refreshError),
      });
    } finally {
      if (evidenceControllerRef.current === controller) {
        evidenceControllerRef.current = null;
      }
    }
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.key);
    window.requestAnimationFrame(() => {
      document.getElementById(`run-tab-${nextTab.key}`)?.focus();
    });
  }

  return (
    <div
      className={clsx("mx-auto max-w-[96rem] px-4 py-6 sm:px-7 lg:px-10", workspaceStyles.workspace)}
      aria-busy={Boolean(loading)}
      data-testid="work-workspace"
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {runAnnouncement}
      </p>
      <div className={workspaceStyles.ambientField} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <section className={clsx("border-b border-line/80 pb-6", workspaceStyles.topbar)}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className={clsx("min-w-0", workspaceStyles.pageIdentity)}>
            <span className={workspaceStyles.pageOrb} aria-hidden="true"><Sparkles size={18} /></span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Asael</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
                One conversation for questions, follow-ups, plans, and finished work.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill label={runPosture.label} tone={runPosture.tone} />
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-md border border-danger/35 bg-danger/10 p-3 text-sm text-danger" role="alert">
            {error}
          </div>
        ) : null}
        {workflowSyncError ? (
          <div className="mt-4 rounded-md border border-warning/45 bg-warning/10 p-3 text-sm text-muted" role="status">
            {workflowSyncError}
          </div>
        ) : null}

        {runPermission || workflowPermission ? (
          <div className="mt-4 flex flex-col gap-3 rounded-md border border-warning/45 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="font-semibold">Run controls are limited</p>
                <p className="mt-1 leading-5 text-muted">
                  {runPermission || workflowPermission} Current role: {role}.
                </p>
              </div>
            </div>
            {session?.authEnabled && !session.authenticated ? (
              <Link href="/login" className="action-link shrink-0">Sign in</Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className={clsx(
        "mt-6 grid gap-5 transition-[grid-template-columns]",
        workspaceStyles.conversationLayout,
        conversationsCollapsed ? "lg:grid-cols-1" : "lg:grid-cols-[14rem_minmax(0,1fr)]",
      )}>
        {!conversationsCollapsed ? (
        <aside className={clsx("hidden min-w-0 lg:sticky lg:top-24 lg:block lg:self-start lg:border-r lg:pr-4", workspaceStyles.threadRail)} aria-label="Recent conversations">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Conversations</h2>
            <div className="flex items-center gap-1">
              <button type="button" onClick={newThread} className="grid size-9 place-items-center rounded-full text-primary transition hover:bg-primary/10" aria-label="New conversation" title="New conversation">
                <Plus size={15} aria-hidden="true" />
              </button>
              <button type="button" onClick={toggleConversationsColumn} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground" aria-label="Collapse conversations" title="Collapse conversations">
                <PanelLeftClose size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className={clsx("mt-3 max-h-[calc(100vh-11rem)] space-y-1 overflow-y-auto pr-1", workspaceStyles.threadList)}>
            {threads.map((thread) => (
              <button key={thread.id} type="button" onClick={() => void loadThread(thread.id)} className={clsx("block w-full rounded-xl px-3 py-2.5 text-left transition", workspaceStyles.threadItem, thread.id === threadId ? clsx("bg-foreground text-background", workspaceStyles.threadItemActive) : "text-muted hover:bg-surface-raised hover:text-foreground")}>
                <span className="block truncate text-sm font-semibold">{thread.title}</span>
                <span className={clsx("mt-1 block text-xs", thread.id === threadId ? "text-background/65" : "text-muted")}>{formatRelativeThreadTime(thread.updatedAt)}</span>
              </button>
            ))}
            {!threads.length ? <p className="max-w-48 py-2 text-xs leading-5 text-muted">Start a task and your conversations will appear here.</p> : null}
          </div>
        </aside>
        ) : null}

        <div className="min-w-0">
          <section className={clsx("min-w-0 overflow-hidden rounded-2xl border border-line/80 bg-surface shadow-[0_24px_70px_-52px_rgba(0,0,0,0.45)]", workspaceStyles.chatShell)}>
            <header className={clsx("flex items-center justify-between gap-3 border-b border-line/80 px-3 py-2.5 sm:px-5", workspaceStyles.chatHeader)}>
              <div className="flex min-w-0 items-center gap-3">
                <button
                  ref={conversationsButtonRef}
                  type="button"
                  onClick={() => setMobileConversationsOpen(true)}
                  className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground lg:hidden"
                  aria-label="Open conversations"
                  aria-haspopup="dialog"
                >
                  <History size={16} aria-hidden="true" />
                </button>
                {conversationsCollapsed ? (
                  <button
                    type="button"
                    onClick={toggleConversationsColumn}
                    className="hidden size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground lg:grid"
                    aria-label="Show conversations"
                    title="Show conversations"
                  >
                    <PanelLeftOpen size={16} aria-hidden="true" />
                  </button>
                ) : null}
                <span className={clsx("grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary", workspaceStyles.intelligenceOrb)}>
                  {conversationView === "map" ? <MapIcon size={16} aria-hidden="true" /> : <MessageSquareText size={16} aria-hidden="true" />}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">
                    {conversationView === "map" ? "Conversation map" : threads.find((thread) => thread.id === threadId)?.title || "New conversation"}
                  </h2>
                  <p className="hidden truncate text-xs text-muted sm:block">{conversationView === "map" ? "See how your conversations connect." : "Ask, refine, and continue in the same thread."}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <div className="flex items-center rounded-full bg-surface-raised p-1" role="group" aria-label="Conversation view">
                  <button type="button" onClick={() => setConversationView("chat")} className={clsx("inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold transition", conversationView === "chat" ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground")} aria-pressed={conversationView === "chat"}>
                    <MessagesSquare size={13} aria-hidden="true" /><span className="hidden sm:inline">Chat</span>
                  </button>
                  <button type="button" onClick={() => setConversationView("map")} className={clsx("inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold transition", conversationView === "map" ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground")} aria-pressed={conversationView === "map"}>
                    <MapIcon size={13} aria-hidden="true" /><span className="hidden sm:inline">Map</span>
                  </button>
                </div>
                {threadId ? (
                  <button type="button" onClick={() => openTaskDetails("memory")} className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground" aria-haspopup="dialog" title="Conversation memory">
                    <Database size={14} aria-hidden="true" />
                    <span className="hidden sm:inline">Memory</span>
                    {conversationMemories.length ? <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{conversationMemories.length}</span> : null}
                  </button>
                ) : null}
                <button type="button" onClick={newThread} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground" aria-label="New conversation" title="New conversation">
                  <Plus size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => openTaskDetails(activityVisible ? "execute" : "context")}
                  className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground"
                  aria-haspopup="dialog"
                  aria-label="Open conversation details"
                  title="Conversation details"
                >
                  <Brain size={15} aria-hidden="true" />
                </button>
              </div>
            </header>

            {conversationView === "map" ? (
              <ConversationCanvas
                threads={threads}
                activeThreadId={threadId}
                onNew={newThread}
                onSelect={(id) => void loadThread(id)}
              />
            ) : (
            <>
            <div
              ref={transcriptRef}
              onScroll={(event) => {
                const target = event.currentTarget;
                transcriptPinnedRef.current =
                  target.scrollHeight - target.scrollTop - target.clientHeight < 96;
              }}
              className={clsx("min-h-[25rem] max-h-[calc(100vh-17rem)] overflow-y-auto px-4 py-6 sm:px-7 sm:py-8", workspaceStyles.transcript)}
            >
              <div className={clsx("mx-auto max-w-3xl space-y-7", workspaceStyles.transcriptInner)}>
              {visibleTurns.map((turn) => (
                <article key={turn.id} className={clsx("flex", workspaceStyles.turn, turn.role === "user" ? clsx("justify-end", workspaceStyles.userTurn) : clsx("justify-start", workspaceStyles.assistantTurn))}>
                  {turn.role === "user" ? (
                    <div className={clsx("max-w-[88%] rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-background sm:max-w-[78%]", workspaceStyles.userBubble)}>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-background/60">You</p>
                      <p className="whitespace-pre-wrap text-sm leading-6">{turn.content}</p>
                    </div>
                  ) : (
                    <div className={clsx("min-w-0 max-w-full sm:pl-1", workspaceStyles.assistantMessage)}>
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Asael</p>
                      <ConversationMessageContent content={turn.content} />
                    </div>
                  )}
                </article>
              ))}

              {activityVisible ? (
                <InlineTaskProgress
                  terminal={activityTerminal}
                  tone={runPosture.tone}
                  summary={taskProgressSummary({ workflowRun, streamEvents, loading })}
                  count={activityCount}
                  onOpen={() => openTaskDetails("execute")}
                />
              ) : null}

              {waitingApproval || activeWorkflowStatus === "waiting_approval" ? (
                <div className="ml-0 flex max-w-2xl items-start justify-between gap-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 sm:ml-8">
                  <div className="flex min-w-0 items-start gap-3">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-semibold">Approval needed</p>
                      <p className="mt-1 text-xs leading-5 text-muted">
                        {waitingApproval ? streamEventLabel(waitingApproval) : "Review the pending workflow action before work can continue."}
                      </p>
                    </div>
                  </div>
                  <Link href="/app/approvals" className="action-link shrink-0">Review</Link>
                </div>
              ) : null}

              {currentAssistantResponse ? (
                <article className={clsx("flex justify-start", workspaceStyles.turn, workspaceStyles.assistantTurn)}>
                  <div className={clsx("min-w-0 max-w-full sm:pl-1", workspaceStyles.assistantMessage)}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Asael</p>
                      {loading === "agent" ? (
                        <span className="inline-flex items-center gap-2 text-xs text-muted">
                          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                          Writing
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2">
                      <ConversationMessageContent content={currentAssistantResponse} grounding={grounding} />
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
                      <button
                        type="button"
                        onClick={() => void listenToResponse(currentAssistantResponse)}
                        disabled={speechLoading}
                        className="inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
                        aria-label="Listen to Asael's response"
                      >
                        {speechLoading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
                        Listen
                      </button>
                      {grounding ? (
                        <span className="inline-flex min-h-9 items-center rounded-full bg-surface-raised px-3 text-xs font-medium text-muted">
                          {groundingLabel(grounding.status)}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => openTaskDetails("evidence")}
                        className="inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
                        aria-haspopup="dialog"
                      >
                        Evidence <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </div>
                    {grounding && citedGroundingSources(grounding).length ? (
                      <details className="mt-3 rounded-xl border border-line/80 bg-background px-3">
                        <summary className="flex min-h-10 cursor-pointer items-center justify-between text-xs font-semibold">
                          Sources used
                          <span className="text-muted">{citedGroundingSources(grounding).length}</span>
                        </summary>
                        <div className="space-y-2 border-t border-line/70 py-3">
                          {citedGroundingSources(grounding).map((source, sourceIndex) => {
                            const sourceUrl = safeExternalUrl(source.url);
                            return (
                              <div key={source.citationId} className="rounded-lg bg-surface px-3 py-2 text-xs">
                                {sourceUrl ? (
                                  <a
                                    href={sourceUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="font-medium text-foreground underline decoration-line underline-offset-4 transition hover:text-primary"
                                  >
                                    {source.title}
                                  </a>
                                ) : (
                                  <p className="font-medium text-foreground">{source.title}</p>
                                )}
                                {source.snippet ? <p className="mt-1 line-clamp-2 leading-5 text-muted">{source.snippet}</p> : null}
                                <p className="mt-1 font-mono text-muted">
                                  Source {sourceIndex + 1} · [{source.citationId}] · {source.kind}
                                  {source.confidence === undefined ? "" : ` · ${Math.round(source.confidence * 100)}%`}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    ) : null}
                    {grounding?.status === "missing" ? (
                      <p className="mt-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-5 text-muted" role="status">
                        Evidence was available, but this response did not cite it. Open Evidence to review the captured sources.
                      </p>
                    ) : null}
                    {grounding?.invalidIds.length ? (
                      <p className="mt-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs leading-5 text-muted" role="status">
                        Unverified source marker{grounding.invalidIds.length === 1 ? "" : "s"}: {grounding.invalidIds.map((id) => `[${id}]`).join(", ")}
                      </p>
                    ) : null}
                    {agentResponse && activeAgentRunId && agentRunCompleted ? (
                      <RunFeedbackPanel feedback={runFeedback} saving={feedbackSaving} onSave={saveRunFeedback} />
                    ) : null}
                  </div>
                </article>
              ) : null}
              {!turns.length && !currentAssistantResponse ? (
                <div className={clsx("grid min-h-64 place-items-center text-center", workspaceStyles.emptyConversation)}>
                  <div>
                    <span className={clsx("mx-auto grid size-11 place-items-center rounded-full bg-primary/10 text-primary", workspaceStyles.emptyOrb)}><Sparkles size={18} aria-hidden="true" /></span>
                    <h2 className="mt-4 text-xl font-semibold tracking-tight">What should we work through?</h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">Start with a question or outcome. Follow up naturally, and Asael keeps this conversation together.</p>
                  </div>
                </div>
              ) : null}
              </div>
            </div>

            <GoalStage
              goal={goal}
              mode={mode}
              approvalRequired={approvalRequired}
              preferredAgentId={preferredAgentId}
              preferredAgentName={preferredAgentName}
              loading={loading}
              contextLoading={contextLoading}
              contextReady={contextPreparedForGoal}
              contextSelectedCount={selectedContextIds.length}
              contextTotalCount={contextResultIds.length}
              contextError={contextError}
              readDisabledReason={readPermission}
              runDisabledReason={runPermission}
              voiceDisabledReason={runPermission || voicePermission}
              workflowDisabledReason={workflowPermission}
              workflowReady={reviewedPlanReady}
              workflowStarted={Boolean(activeWorkflowId)}
              workflowInProgress={conversationLocked}
              hasConversation={turns.length > 0 || Boolean(currentAssistantResponse)}
              onGoalChange={changeGoal}
              onModeChange={changeMode}
              onApprovalChange={changeApprovalRequired}
              onClearPreferredAgent={() => { setPreferredAgentId(undefined); setPreferredAgentName(undefined); }}
              onContext={() => void buildContext()}
              onReviewContext={() => {
                contextSelectionReviewedRef.current = true;
                openTaskDetails("context");
              }}
              onPlan={() => void buildPlan()}
              onAgent={() => void runAgent({ prepareContextAutomatically: true })}
              onVoiceTranscript={(transcript) => {
                const existingDraft = goal.trim();
                const voiceGoal = existingDraft ? `${existingDraft}\n\n${transcript}` : transcript;
                changeGoal(voiceGoal);
                void runAgent({ submittedGoal: voiceGoal, prepareContextAutomatically: true });
              }}
              onStop={stopAgent}
              onWorkflow={() => void startWorkflow()}
            />
            </>
            )}
          </section>

          {detailsOpen ? (
          <div
            className="fixed inset-0 z-[90] flex items-end justify-center bg-foreground/35 p-0 backdrop-blur-sm sm:items-center sm:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeTaskDetails();
            }}
          >
          <section
            ref={detailsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-details-title"
            tabIndex={-1}
            className="command-details max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl border border-line/80 bg-surface shadow-2xl outline-none sm:rounded-2xl"
          >
            <div className="border-b border-line/80 px-4 pt-4 sm:px-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="task-details-title" className="text-base font-semibold">Task details</h2>
                  <p className="mt-1 text-xs leading-5 text-muted">Context, plan, observable activity, and evidence for this conversation.</p>
                </div>
                <button
                  type="button"
                  onClick={closeTaskDetails}
                  className="grid size-10 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground"
                  aria-label="Close task details"
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
              <nav className="mt-3 flex max-w-full gap-1 overflow-x-auto" aria-label="Task details" role="tablist">
            {tabs.map((tab, index) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  id={`run-tab-${tab.key}`}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  aria-controls="run-stage-panel"
                  tabIndex={activeTab === tab.key ? 0 : -1}
                  className={clsx(
                    "inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 px-2 text-xs font-semibold transition",
                    activeTab === tab.key ? "border-primary text-foreground" : "border-transparent text-muted hover:text-foreground",
                  )}
                >
                  <Icon size={14} aria-hidden="true" />
                  {tab.label}
                </button>
              );
            })}
              </nav>
            </div>

          <div
            id="run-stage-panel"
            role="tabpanel"
            aria-labelledby={`run-tab-${activeTab}`}
            tabIndex={0}
            className="outline-none"
          >
            {activeTab === "memory" ? (
              <StagePanel title="Conversation memory" description="What Asael learned from this conversation. Forgetting a memory removes it from future conversations everywhere, while the chat transcript stays intact.">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshConversationMemories()}
                    disabled={!threadId || memoryState === "loading" || Boolean(readPermission)}
                    title={readPermission}
                    className="action-button"
                  >
                    <RefreshCw size={14} className={memoryState === "loading" ? "animate-spin" : ""} aria-hidden="true" />
                    Refresh memory
                  </button>
                  <StatusPill
                    label={threadId ? `${conversationMemories.length} remembered` : "No conversation yet"}
                    tone={conversationMemories.length ? "success" : "neutral"}
                  />
                </div>
                {memoryError ? (
                  <div className="mb-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm leading-6 text-muted" role="status">{memoryError}</div>
                ) : null}
                {!threadId ? (
                  <div className="rounded-xl border border-dashed border-line bg-background p-5 text-sm leading-6 text-muted">Start a conversation and its memories will appear here after Asael responds.</div>
                ) : memoryState === "loading" && !conversationMemories.length ? (
                  <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading conversation memory…</div>
                ) : conversationMemories.length ? (
                  <div className="space-y-2">
                    {conversationMemories.map((memory) => {
                      const confirming = confirmForgetMemoryId === memory.id;
                      const forgetting = forgettingMemoryId === memory.id;
                      return (
                        <article key={memory.id} className="rounded-xl border border-line/80 bg-background p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">{memory.type}</span>
                                <span className="text-[11px] text-muted">{formatRelativeThreadTime(memory.updatedAt)}</span>
                              </div>
                              <h3 className="mt-2 text-sm font-semibold">{memory.title}</h3>
                              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-muted">{memory.content}</p>
                            </div>
                            {!confirming ? (
                              <button type="button" onClick={() => setConfirmForgetMemoryId(memory.id)} className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-danger/10 hover:text-danger" aria-label={`Forget ${memory.title}`} title="Forget this memory everywhere">
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            ) : null}
                          </div>
                          {confirming ? (
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-3">
                              <p className="text-xs leading-5 text-muted">Forget this everywhere? The conversation itself will not be deleted.</p>
                              <div className="flex gap-2">
                                <button type="button" onClick={() => setConfirmForgetMemoryId("")} className="min-h-9 rounded-full px-3 text-xs font-semibold text-muted hover:bg-surface-raised">Keep</button>
                                <button type="button" onClick={() => void forgetConversationMemory(memory.id)} disabled={forgetting} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-danger px-3 text-xs font-semibold text-white disabled:opacity-50">
                                  {forgetting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                                  Forget
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-line bg-background p-5 text-sm leading-6 text-muted">Nothing has been saved from this conversation yet. New replies are remembered automatically; refresh in a moment if Asael is still processing them.</div>
                )}
              </StagePanel>
            ) : null}

            {activeTab === "context" ? (
              <StagePanel title="Context" description="Choose the saved information Asael may use. Low-match items start excluded, and every unchecked item is excluded server-side.">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void buildContext()}
                    disabled={Boolean(loading) || contextLoading || workflowInProgress || Boolean(readPermission)}
                    title={readPermission}
                    className="action-button"
                  >
                    {contextLoading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Brain size={14} aria-hidden="true" />}
                    Refresh context
                  </button>
                  <StatusPill
                    label={`${selectedContextIds.length} of ${contextResultIds.length} selected`}
                    tone={selectedContextIds.length ? "success" : "neutral"}
                  />
                  {contextResultIds.length ? (
                    <>
                      <button
                        type="button"
                        onClick={() => updateContextSelection(contextResultIds)}
                        disabled={contextLoading || workflowInProgress || loading === "agent" || selectedContextIds.length === contextResultIds.length}
                        className="min-h-10 rounded-md px-2 text-xs font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-50"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => updateContextSelection([])}
                        disabled={contextLoading || workflowInProgress || loading === "agent" || selectedContextIds.length === 0}
                        className="min-h-10 rounded-md px-2 text-xs font-semibold text-muted transition hover:bg-surface-raised disabled:opacity-50"
                      >
                        Clear
                      </button>
                    </>
                  ) : null}
                </div>
                {contextQuery ? (
                  <p className="mb-3 line-clamp-3 rounded-md bg-background px-3 py-2 text-xs leading-5 text-muted">
                    Built fresh for: <span className="font-medium text-foreground">{contextQuery}</span>
                  </p>
                ) : null}
                {contextError ? (
                  <div className="mb-3 rounded-md border border-warning/45 bg-warning/10 p-3 text-xs leading-5 text-muted" role="status">
                    Saved context could not be loaded. This task will run without it unless you refresh. {contextError}
                  </div>
                ) : null}
                <ContextSelectionList
                  rows={contextResults}
                  selectedIds={selectedContextIds}
                  loading={contextLoading}
                  disabled={workflowInProgress || loading === "agent"}
                  onChange={updateContextSelection}
                />
              </StagePanel>
            ) : null}

            {activeTab === "plan" ? (
              <StagePanel title="Plan" description="Steps, risk, approvals, and how the result will be checked.">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void buildPlan()}
                    disabled={
                      Boolean(loading) ||
                      Boolean(workflowPermission) ||
                      workflowInProgress
                    }
                    title={
                      workflowPermission ||
                      (workflowInProgress
                        ? "Wait for the active workflow to finish or cancel it first."
                        : undefined)
                    }
                    className="action-button"
                  >
                    {loading === "plan" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
                    Generate plan
                  </button>
                  <button
                    type="button"
                    onClick={() => void startWorkflow()}
                    disabled={
                      Boolean(loading) ||
                      Boolean(workflowPermission) ||
                      !reviewedPlanReady ||
                      Boolean(activeWorkflowId)
                    }
                    title={
                      workflowPermission ||
                      (activeWorkflowId
                        ? "This plan has already started."
                        : !reviewedPlanReady
                          ? reviewedPlanStatus === "failed"
                            ? "This plan failed safety validation. Generate a new plan."
                            : "Generate a plan first."
                          : undefined)
                    }
                    className="primary-button"
                  >
                    {loading === "workflow" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Workflow size={14} aria-hidden="true" />}
                    {activeWorkflowId ? "Workflow started" : "Start reviewed plan"}
                  </button>
                  <StatusPill label={`risk ${stringPath(workflowPlan, "plan.highestRiskLevel", "0")}`} tone={numberValue(readPath(workflowPlan, "plan.highestRiskLevel"), 0) >= 2 ? "warning" : "neutral"} />
                </div>
                {reviewedPlanStatus === "failed" ? (
                  <div
                    className="mb-4 rounded-md border border-danger/35 bg-danger/10 p-3 text-sm leading-6 text-danger"
                    role="alert"
                  >
                    {stringPath(
                      workflowPlan,
                      "plan.error",
                      "This plan did not pass safety validation. Generate a new plan before execution.",
                    )}
                  </div>
                ) : null}
                {numberValue(
                  readPath(workflowPlan, "plan.highestRiskLevel"),
                  0,
                ) >= 3 ? (
                  <div
                    className="mb-4 rounded-md border border-warning/45 bg-warning/10 p-3 text-sm leading-6 text-muted"
                    role="note"
                  >
                    Risk-3 actions stay in preview mode. Executing an
                    irreversible action must be initiated in Tools, then receive
                    two distinct admin approvals in Approvals.
                  </div>
                ) : null}
                <ResultRows
                  rows={planNodes.map((item) => ({
                    title: stringValue(item.label, "Plan node"),
                    status: `${stringValue(item.kind, "node")} / risk ${stringValue(item.riskLevel, "0")}`,
                    meta: stringValue(item.description, "No description"),
                    score: Boolean(item.approvalRequired) ? "approval" : stringValue(item.policy, "auto"),
                  }))}
                  empty="No plan yet. Use Preview plan below the task."
                />
              </StagePanel>
            ) : null}

            {activeTab === "execute" ? (
              <StagePanel title="Activity" description="Observable work, approvals, and technical detail. The answer stays in the conversation.">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void runAgent({ prepareContextAutomatically: true })}
                    disabled={
                      Boolean(loading) ||
                      Boolean(runPermission) ||
                      conversationLocked
                    }
                    title={
                      runPermission ||
                      (conversationLocked
                        ? "Wait for the active work to finish or cancel it first."
                        : undefined)
                    }
                    className="primary-button"
                  >
                    {loading === "agent" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    Run task
                  </button>
                  {loading === "agent" ? (
                    <button type="button" onClick={stopAgent} className="action-button border-danger/50 text-danger" data-testid="stop-agent-run">
                      <Square size={13} aria-hidden="true" />
                      Stop run
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void tickQueue()}
                    disabled={Boolean(loading) || Boolean(workflowPermission)}
                    title={workflowPermission}
                    className="action-button"
                  >
                    {loading === "tick" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                    Tick queue
                  </button>
                  {workflowRun ? <StatusPill label={stringPath(workflowRun, "run.status", "workflow created")} tone={toneForStatus(readPath(workflowRun, "run.status"))} /> : null}
                  {workflowRun ? (
                    <Link href="/app/workflows" className="action-link">
                      Manage workflow
                    </Link>
                  ) : null}
                </div>
                {waitingApproval ? (
                  <div className="mb-4 flex flex-col gap-3 rounded-md border border-warning/45 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between" role="status">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                      <div>
                        <p className="text-sm font-semibold">Run paused for approval</p>
                        <p className="mt-1 text-xs leading-5 text-muted">{streamEventLabel(waitingApproval)}</p>
                      </div>
                    </div>
                    <Link href="/app/approvals" className="primary-button shrink-0">Open Approvals</Link>
                  </div>
                ) : null}
                {!waitingApproval &&
                activeWorkflowStatus === "waiting_approval" ? (
                  <div
                    className="mb-4 flex flex-col gap-3 rounded-md border border-warning/45 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between"
                    role="status"
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle
                        size={17}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm font-semibold">
                          Workflow paused for approval
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted">
                          Review the pending action before this workflow can
                          continue.
                        </p>
                      </div>
                    </div>
                    <Link
                      href="/app/approvals"
                      className="primary-button shrink-0"
                    >
                      Review approval
                    </Link>
                  </div>
                ) : null}
                <TaskProgressTimeline
                  events={streamEvents}
                  workflowRun={workflowRun}
                  running={loading === "agent"}
                />
                <CouncilExecutionMap events={streamEvents} />
                <details className="rounded-md border border-line bg-background">
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 text-sm font-semibold">
                    <span>Technical activity</span>
                    <span className="text-xs font-normal text-muted">{streamEvents.filter((event) => event.type !== "delta").length} events</span>
                  </summary>
                  <div className="max-h-96 space-y-2 overflow-auto border-t border-line p-3">
                    {streamEvents.some((event) => event.type !== "delta") ? (
                      streamEvents.filter((event) => event.type !== "delta").map((event, index) => (
                        <div key={`${event.type}-${index}`} className="rounded-md border border-line bg-surface p-2 text-xs leading-5">
                          <span className="font-mono text-primary">{event.type}</span>
                          <p className="mt-1 text-muted">{streamEventLabel(event)}</p>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-line p-4 text-sm text-muted">No stream events yet.</div>
                    )}
                  </div>
                </details>
              </StagePanel>
            ) : null}

            {activeTab === "evidence" ? (
              <StagePanel title="Results and evidence" description="Recent answers, blocked actions, and workflow outcomes.">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshEvidence()}
                    disabled={evidenceState === "loading" || Boolean(readPermission)}
                    title={readPermission}
                    className="action-button"
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    Refresh evidence
                  </button>
                  <Link
                    href={
                      activeAgentRunId
                        ? `/app/results?run=${encodeURIComponent(`agent:${activeAgentRunId}`)}`
                        : "/app/results"
                    }
                    className="primary-button"
                  >
                    Open Results
                  </Link>
                  <Link href="/app/approvals" className="action-link">Open approvals</Link>
                  <Link href="/app/evaluations" className="action-link">Release evidence</Link>
                  <Link href="/app/observability" className="action-link">Monitoring</Link>
                </div>
                <div className="grid gap-4">
                  <EvidenceCard title="Agent answers" rows={runRows.map((item) => evidenceRow(item, "prompt", "status"))} empty="No run records loaded." />
                  <EvidenceCard title="Blocked before result" rows={approvalItems.map((item) => evidenceRow(item, "title", "kind"))} empty="No approvals pending." />
                  <EvidenceCard title="Workflow outcomes" rows={arrayPath(evidence, "workflows.runs").map((item) => evidenceRow(item, "goal", "status"))} empty="No workflows loaded." />
                </div>
              </StagePanel>
            ) : null}
          </div>
          </section>
          </div>
          ) : null}
        </div>
      </section>

      {mobileConversationsOpen ? (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-foreground/35 backdrop-blur-sm"
            onClick={() => {
              setMobileConversationsOpen(false);
              conversationsButtonRef.current?.focus();
            }}
            aria-label="Close conversations"
            tabIndex={-1}
          />
          <section
            ref={conversationsSheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-conversations-title"
            tabIndex={-1}
            className={clsx("absolute inset-y-0 left-0 flex w-[min(88vw,22rem)] flex-col border-r border-line bg-surface shadow-2xl outline-none", workspaceStyles.mobileConversationSheet)}
          >
            <header className="flex min-h-16 items-center justify-between gap-3 border-b border-line px-4">
              <div>
                <h2 id="mobile-conversations-title" className="text-sm font-semibold">Conversations</h2>
                <p className="mt-0.5 text-xs text-muted">Return to any thread.</p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={newThread} className="grid size-10 place-items-center rounded-full text-primary hover:bg-primary/10" aria-label="New conversation"><Plus size={16} aria-hidden="true" /></button>
                <button type="button" onClick={() => { setMobileConversationsOpen(false); conversationsButtonRef.current?.focus(); }} className="grid size-10 place-items-center rounded-full text-muted hover:bg-surface-raised hover:text-foreground" aria-label="Close conversations"><X size={17} aria-hidden="true" /></button>
              </div>
            </header>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
              {threads.map((thread) => (
                <button key={thread.id} type="button" onClick={() => void loadThread(thread.id)} className={clsx("block w-full rounded-xl px-3 py-3 text-left transition", thread.id === threadId ? "bg-foreground text-background" : "text-muted hover:bg-surface-raised hover:text-foreground")}>
                  <span className="block truncate text-sm font-semibold">{thread.title}</span>
                  <span className={clsx("mt-1 block text-xs", thread.id === threadId ? "text-background/65" : "text-muted")}>{formatRelativeThreadTime(thread.updatedAt)}</span>
                </button>
              ))}
              {!threads.length ? <p className="p-3 text-sm leading-6 text-muted">Start a conversation and it will appear here.</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function InlineTaskProgress({
  terminal,
  tone,
  summary,
  count,
  onOpen,
}: {
  terminal: boolean;
  tone: Tone;
  summary: string;
  count: number;
  onOpen: () => void;
}) {
  const title = terminal
    ? tone === "danger"
      ? "Work stopped"
      : tone === "warning"
        ? "Waiting for input"
        : `Worked through ${count || 1} ${count === 1 ? "update" : "updates"}`
    : "Asael is working";
  return (
    <article className={clsx("flex justify-start", workspaceStyles.progressTurn)}>
      <button
        type="button"
        onClick={onOpen}
        className={clsx("group ml-0 flex max-w-2xl items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-surface-raised sm:ml-8", workspaceStyles.progressFlow)}
        aria-haspopup="dialog"
      >
        <span className={clsx(
          "grid size-8 shrink-0 place-items-center rounded-full",
          workspaceStyles.progressNode,
          terminal
            ? tone === "danger"
              ? "bg-danger/10 text-danger"
              : tone === "warning"
                ? "bg-warning/10 text-warning"
                : "bg-success/10 text-success"
            : "bg-primary/10 text-primary",
        )}>
          {terminal ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <Clock3 size={15} className="animate-pulse" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">{summary}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
          View activity <ChevronRight size={13} className="transition group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </button>
    </article>
  );
}

function ConversationMessageContent({
  content,
  grounding,
}: {
  content: string;
  grounding?: GroundingReport;
}) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  const citations = new Map(
    grounding
      ? citedGroundingSources(grounding).map((source, sourceIndex) => [
          source.citationId,
          { source, index: sourceIndex + 1 },
        ] as const)
      : [],
  );
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div key={`code-${index}`} className="my-4 overflow-hidden rounded-xl border border-line bg-foreground text-background">
          {language ? <div className="border-b border-background/15 px-4 py-2 font-mono text-[10px] uppercase tracking-wide text-background/60">{language}</div> : null}
          <pre className="overflow-x-auto p-4 text-xs leading-6"><code>{code.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      const className = level === 1
        ? "mt-7 text-xl font-semibold tracking-tight first:mt-0"
        : level === 2
          ? "mt-6 text-lg font-semibold tracking-tight first:mt-0"
          : "mt-5 text-sm font-semibold uppercase tracking-[0.1em] text-muted first:mt-0";
      blocks.push(level === 1
        ? <h2 key={`heading-${index}`} className={className}><MessageInline text={heading[2]} citations={citations} /></h2>
        : level === 2
          ? <h3 key={`heading-${index}`} className={className}><MessageInline text={heading[2]} citations={citations} /></h3>
          : <h4 key={`heading-${index}`} className={className}><MessageInline text={heading[2]} citations={citations} /></h4>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`bullets-${index}`} className="my-4 space-y-2 pl-5 text-sm leading-7 text-foreground/90">
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`} className="list-disc pl-1"><MessageInline text={item} citations={citations} /></li>)}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`numbers-${index}`} className="my-4 space-y-2 pl-5 text-sm leading-7 text-foreground/90">
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`} className="list-decimal pl-1"><MessageInline text={item} citations={citations} /></li>)}
        </ol>,
      );
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`} className="my-4 border-l-2 border-primary pl-4 text-sm italic leading-7 text-muted">
          <MessageInline text={quote.join(" ")} citations={citations} />
        </blockquote>,
      );
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} className="my-6 border-line" />);
      index += 1;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !messageBlockStarts(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`} className="my-3 text-sm leading-7 text-foreground/90 first:mt-0 last:mb-0">
        <MessageInline text={paragraph.join(" ")} citations={citations} />
      </p>,
    );
  }

  return <div className="min-w-0 max-w-[72ch]">{blocks}</div>;
}

function MessageInline({
  text,
  citations,
}: {
  text: string;
  citations?: Map<string, { source: GroundingReport["sources"][number]; index: number }>;
}) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\[(?:memory|knowledge|graph|web):[^\]\s]+\])/g);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.startsWith("**") && token.endsWith("**")) {
          return <strong key={`${token}-${index}`} className="font-semibold text-foreground"><MessageInline text={token.slice(2, -2)} citations={citations} /></strong>;
        }
        if (token.startsWith("`") && token.endsWith("`")) {
          return <code key={`${token}-${index}`} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[0.88em] text-foreground">{token.slice(1, -1)}</code>;
        }
        const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
        if (link) {
          return <a key={`${token}-${index}`} href={link[2]} target="_blank" rel="noreferrer noopener" className="font-medium text-primary underline decoration-primary/35 underline-offset-4 hover:decoration-primary">{link[1]}</a>;
        }
        const citationId = /^\[((?:memory|knowledge|graph|web):[^\]\s]+)\]$/.exec(token)?.[1];
        const citation = citationId ? citations?.get(citationId) : undefined;
        if (citation) {
          const sourceUrl = safeExternalUrl(citation.source.url);
          const marker = (
            <span
              className="inline-flex min-w-5 items-center justify-center rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 align-super font-mono text-[0.7em] font-semibold leading-none text-primary"
              title={`${citation.source.title} · ${citation.source.kind}`}
            >
              {citation.index}
            </span>
          );
          return sourceUrl ? (
            <a
              key={`${token}-${index}`}
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Source ${citation.index}: ${citation.source.title}`}
              className="mx-0.5 inline-flex no-underline transition hover:-translate-y-px"
            >
              {marker}
            </a>
          ) : (
            <span key={`${token}-${index}`} aria-label={`Source ${citation.index}: ${citation.source.title}`} className="mx-0.5 inline-flex">
              {marker}
            </span>
          );
        }
        return token;
      })}
    </>
  );
}

function messageBlockStarts(lines: string[], index: number) {
  const line = lines[index].trim();
  return (
    line.startsWith("```") ||
    /^(#{1,3})\s+/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    line.startsWith(">") ||
    /^---+$/.test(line)
  );
}

function ContextSelectionList({
  rows,
  selectedIds,
  loading,
  disabled,
  onChange,
}: {
  rows: JsonRecord[];
  selectedIds: string[];
  loading: boolean;
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  if (loading && !rows.length) {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-background text-sm text-muted">
        <Loader2 size={15} className="animate-spin" aria-hidden="true" />
        Finding context for this task…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm leading-6 text-muted">
        No saved memory or knowledge matched this task. The task will start with no saved context.
      </div>
    );
  }
  const selected = new Set(selectedIds);
  return (
    <fieldset className="divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
      <legend className="sr-only">Choose context for this task</legend>
      {rows.slice(0, 12).map((item, index) => {
        const id = contextEvidenceId(item);
        const checked = selected.has(id);
        const confidence = numberValue(item.supportScore ?? item.confidence ?? item.score, Number.NaN);
        return (
          <label
            key={id || `${stringValue(item.title)}-${index}`}
            className={clsx(
              "flex cursor-pointer items-start gap-3 p-3 transition",
              checked ? "bg-primary/5" : "bg-surface/60 opacity-70 hover:opacity-100",
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={loading || disabled || !id}
              onChange={(event) => {
                onChange(
                  event.currentTarget.checked
                    ? [...selectedIds, id]
                    : selectedIds.filter((selectedId) => selectedId !== id),
                );
              }}
              className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold">{stringValue(item.title, "Context item")}</span>
                <span className={clsx(
                  "rounded-md px-2 py-1 font-mono text-[11px]",
                  checked ? "bg-primary/10 text-primary" : "bg-surface-raised text-muted",
                )}>
                  {checked ? "Included" : "Excluded"}
                </span>
              </span>
              <span className="mt-1 line-clamp-3 block text-xs leading-5 text-muted">
                {stringValue(item.content, "No excerpt available.")}
              </span>
              <span className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted">
                <span className="rounded-md bg-surface-raised px-2 py-1">{stringValue(item.kind, "evidence")}</span>
                {Number.isFinite(confidence) ? (
                  <span className="rounded-md bg-surface-raised px-2 py-1">{Math.round(confidence * 100)}% match</span>
                ) : null}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function TaskProgressTimeline({
  events,
  workflowRun,
  running,
}: {
  events: StreamEvent[];
  workflowRun?: JsonRecord;
  running: boolean;
}) {
  const workflowSteps = arrayPath(workflowRun, "steps");
  const workflowEvents = arrayPath(workflowRun, "events");
  const workflow = asRecord(readPath(workflowRun, "run"));
  if (workflowRun) {
    const completed = workflowSteps.filter((step) => ["completed", "skipped"].includes(stringValue(step.status))).length;
    const planStep = workflowSteps.find((step) => stringValue(step.stepKey) === "plan");
    const planNodes = arrayPath(planStep, "output.plan.nodes");
    const planNodeEvents = new Map<string, JsonRecord>();
    for (const event of workflowEvents) {
      const nodeId = stringPath(event, "payload.nodeId", "");
      if (nodeId && stringValue(event.type).startsWith("workflow.plan_node.")) {
        planNodeEvents.set(nodeId, event);
      }
    }
    return (
      <section className="mb-4 overflow-hidden rounded-md border border-line bg-background" aria-label="Workflow progress">
        <header className="flex items-start justify-between gap-3 border-b border-line px-3 py-3">
          <div>
            <p className="text-sm font-semibold">Workflow progress</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {workflowSteps.length
                ? `${completed} of ${workflowSteps.length} stages complete`
                : "Loading the workflow stages…"}
            </p>
          </div>
          <StatusPill
            label={stringValue(workflow.status, "starting").replaceAll("_", " ")}
            tone={toneForStatus(workflow.status)}
          />
        </header>
        <ol className="divide-y divide-line">
          {workflowSteps.length ? workflowSteps.map((step, index) => {
            const status = stringValue(step.status, "pending");
            const isCurrent = stringValue(workflow.currentStep) === stringValue(step.stepKey);
            const error = stringValue(step.error);
            const reason = stringPath(step, "output.reason", "");
            return (
              <li key={stringValue(step.id, `${stringValue(step.stepKey)}-${index}`)} className={clsx("flex gap-3 px-3 py-3", isCurrent && "bg-primary/5")}>
                <span className={clsx(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                  status === "completed" || status === "skipped"
                    ? "bg-success/15 text-success"
                    : status === "failed"
                      ? "bg-danger/15 text-danger"
                      : isCurrent || status === "running"
                        ? "bg-primary/15 text-primary"
                        : "bg-surface-raised text-muted",
                )}>
                  {status === "completed" || status === "skipped" ? "✓" : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{stringValue(step.label, humanizeWorkflowStep(stringValue(step.stepKey)))}</span>
                    <span className="font-mono text-[11px] text-muted">{status.replaceAll("_", " ")}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted">
                    {error || reason || (isCurrent ? "Asael is working on this stage now." : workflowStepDescription(stringValue(step.stepKey)))}
                  </span>
                </span>
              </li>
            );
          }) : (
            <li className="p-4 text-sm text-muted">The workflow was created. Detailed stages will appear after the first update.</li>
          )}
        </ol>
        {planNodes.length ? (
          <div className="border-t border-line px-3 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Execution plan</p>
            <div className="mt-2 space-y-2">
              {planNodes.map((node, index) => {
                const nodeId = stringValue(node.id);
                const latest = planNodeEvents.get(nodeId);
                const status = latest
                  ? stringValue(latest.type).split(".").at(-1) || "pending"
                  : "pending";
                return (
                  <div key={nodeId || `plan-node-${index}`} className="flex items-start justify-between gap-3 rounded-md bg-surface px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">{stringValue(node.label, `Plan step ${index + 1}`)}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{stringValue(node.description, "Waiting to begin.")}</p>
                    </div>
                    <span className={clsx(
                      "shrink-0 rounded-md px-2 py-1 font-mono text-[11px]",
                      status === "completed"
                        ? "bg-success/10 text-success"
                        : status === "failed" || status === "interrupted"
                          ? "bg-danger/10 text-danger"
                          : status === "started"
                            ? "bg-primary/10 text-primary"
                            : "bg-surface-raised text-muted",
                    )}>
                      {status === "started" ? "running" : status}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {workflowEvents.length ? (
          <div className="border-t border-line px-3 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Latest updates</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted">
              {workflowEvents.slice(-3).reverse().map((event, index) => (
                <li key={stringValue(event.id, `${stringValue(event.type)}-${index}`)}>
                  {workflowEventLabel(stringValue(event.type))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }

  const updates = events.filter((event) => event.type !== "delta");
  return (
    <section className="mb-4 overflow-hidden rounded-md border border-line bg-background" aria-label="Task progress">
      <header className="flex items-start justify-between gap-3 border-b border-line px-3 py-3">
        <div>
          <p className="text-sm font-semibold">Live task progress</p>
          <p className="mt-1 text-xs leading-5 text-muted">Plain-language updates as Asael works.</p>
        </div>
        {running ? <StatusPill label="working" tone="neutral" /> : null}
      </header>
      {updates.length ? (
        <ol className="divide-y divide-line">
          {updates.slice(-8).map((event, index) => (
            <li key={`${event.type}-${index}`} className="flex gap-3 px-3 py-3">
              <span className={clsx("mt-1 size-2.5 shrink-0 rounded-full", activityDotTone(event))} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{activityTitle(event)}</span>
                <span className="mt-1 block text-xs leading-5 text-muted">{streamEventLabel(event)}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="p-4 text-sm text-muted">Progress updates will appear here as soon as the task starts.</p>
      )}
    </section>
  );
}

function GoalStage({
  goal,
  mode,
  approvalRequired,
  preferredAgentId,
  preferredAgentName,
  loading,
  contextLoading,
  contextReady,
  contextSelectedCount,
  contextTotalCount,
  contextError,
  readDisabledReason,
  runDisabledReason,
  voiceDisabledReason,
  workflowDisabledReason,
  workflowReady,
  workflowStarted,
  workflowInProgress,
  hasConversation,
  onGoalChange,
  onModeChange,
  onApprovalChange,
  onClearPreferredAgent,
  onContext,
  onReviewContext,
  onPlan,
  onAgent,
  onVoiceTranscript,
  onStop,
  onWorkflow,
}: {
  goal: string;
  mode: AgentMode;
  approvalRequired: boolean;
  preferredAgentId?: AgentId;
  preferredAgentName?: string;
  loading?: string;
  contextLoading: boolean;
  contextReady: boolean;
  contextSelectedCount: number;
  contextTotalCount: number;
  contextError?: string;
  readDisabledReason?: string;
  runDisabledReason?: string;
  voiceDisabledReason?: string;
  workflowDisabledReason?: string;
  workflowReady: boolean;
  workflowStarted: boolean;
  workflowInProgress: boolean;
  hasConversation: boolean;
  onGoalChange: (value: string) => void;
  onModeChange: (value: AgentMode) => void;
  onApprovalChange: (value: boolean) => void;
  onClearPreferredAgent: () => void;
  onContext: () => void;
  onReviewContext: () => void;
  onPlan: () => void;
  onAgent: () => void;
  onVoiceTranscript: (transcript: string) => void;
  onStop: () => void;
  onWorkflow: () => void;
}) {
  const goalMissing = !goal.trim();
  const draftLocked = Boolean(loading) || workflowInProgress;
  const contextLabel = contextLoading
    ? "Finding context"
    : contextError
      ? "No saved context"
      : contextReady
        ? `Context ${contextSelectedCount}/${contextTotalCount}`
        : "Context";
  return (
    <section className={clsx("border-t border-line/70 bg-background/95 px-3 py-2 backdrop-blur sm:px-5", workspaceStyles.composerDock)} aria-labelledby="command-composer-title">
      <div className={clsx("mx-auto max-w-3xl", workspaceStyles.composerWidth)}>
        <h2 id="command-composer-title" className="sr-only">Message Asael</h2>
        <div className={clsx("rounded-[1.35rem] border border-line bg-surface shadow-[0_10px_32px_-28px_rgba(0,0,0,0.5)] focus-within:border-primary/60", workspaceStyles.composer)}>
          <span className={workspaceStyles.composerAura} aria-hidden="true"><Sparkles size={15} /></span>
          {preferredAgentId ? (
            <div className="flex items-center justify-between gap-3 border-b border-line/70 px-3 py-1.5">
              <span className="text-xs text-muted">
                Working with <strong className="font-semibold text-foreground">{preferredAgentName || agentDisplayName(preferredAgentId)}</strong>
              </span>
              <button type="button" onClick={onClearPreferredAgent} className="min-h-8 rounded-full px-2 text-xs font-semibold text-primary hover:bg-primary/10">
                Route automatically
              </button>
            </div>
          ) : null}

          <label className="block">
            <span className="sr-only">Message Asael</span>
            <textarea
              value={goal}
              onChange={(event) => onGoalChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (!draftLocked && !goalMissing && !runDisabledReason) onAgent();
                }
              }}
              rows={2}
              required
              disabled={draftLocked}
              placeholder={hasConversation ? "Ask a follow-up…" : "Message Asael…"}
              className="max-h-40 min-h-14 w-full resize-none bg-transparent px-4 pb-2 pt-3 text-sm leading-6 outline-none placeholder:text-muted/75 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              <label className="sr-only" htmlFor="command-mode">Approach</label>
              <select
                id="command-mode"
                value={mode}
                disabled={draftLocked}
                onChange={(event) => onModeChange(event.currentTarget.value as AgentMode)}
                className="min-h-8 shrink-0 rounded-full border-0 bg-surface-raised px-2.5 text-[11px] font-semibold text-muted outline-none hover:text-foreground"
              >
                <option value="orchestrate">General</option>
                <option value="research">Research</option>
                <option value="execute">Tools</option>
                <option value="learn">Knowledge</option>
              </select>
              <button
                type="button"
                onClick={() => onApprovalChange(!approvalRequired)}
                disabled={draftLocked}
                className={clsx(
                  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold transition",
                  approvalRequired ? "bg-primary/10 text-primary" : "bg-surface-raised text-muted hover:text-foreground",
                )}
                aria-pressed={approvalRequired}
                title={`Approvals ${approvalRequired ? "on" : "off"}`}
              >
                <ShieldCheck size={12} aria-hidden="true" />
                <span className="hidden md:inline">Approvals {approvalRequired ? "on" : "off"}</span>
              </button>
              <button
                type="button"
                onClick={contextReady || contextError ? onReviewContext : onContext}
                disabled={contextLoading || goalMissing || Boolean(readDisabledReason)}
                title={goalMissing ? "Write a message first." : readDisabledReason}
                className={clsx(
                  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold transition",
                  contextReady ? "bg-success/10 text-success" : contextError ? "bg-warning/10 text-warning" : "bg-surface-raised text-muted hover:text-foreground",
                )}
              >
                {contextLoading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />}
                <span className="hidden md:inline">{contextLabel}</span>
                {contextReady ? <span className="md:hidden">{contextSelectedCount}/{contextTotalCount}</span> : null}
              </button>
              <button
                type="button"
                onClick={onPlan}
                disabled={Boolean(loading) || goalMissing || Boolean(workflowDisabledReason) || workflowInProgress}
                title={goalMissing ? "Write a message first." : workflowDisabledReason}
                className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-2.5 text-[11px] font-semibold text-muted transition hover:text-foreground disabled:opacity-50"
              >
                {loading === "plan" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <GitBranch size={13} aria-hidden="true" />}
                <span className="hidden sm:inline">Plan</span>
              </button>
              {workflowReady || (workflowStarted && workflowInProgress) ? (
                <button
                  type="button"
                  onClick={onWorkflow}
                  disabled={Boolean(loading) || goalMissing || Boolean(workflowDisabledReason) || !workflowReady || workflowStarted}
                  className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-[11px] font-semibold text-primary disabled:opacity-50"
                >
                  <Workflow size={13} aria-hidden="true" />
                  {workflowStarted ? "Workflow active" : "Start plan"}
                </button>
              ) : null}
            </div>

            {loading === "agent" ? (
              <button type="button" onClick={onStop} className="grid size-9 shrink-0 place-items-center rounded-full bg-danger text-white" aria-label="Stop response">
                <Square size={13} aria-hidden="true" />
              </button>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
                <VoiceMode
                  disabled={draftLocked || contextLoading || Boolean(voiceDisabledReason)}
                  disabledReason={voiceDisabledReason}
                  onTranscript={onVoiceTranscript}
                />
                <button
                  type="button"
                  onClick={onAgent}
                  disabled={draftLocked || goalMissing || Boolean(runDisabledReason)}
                  title={goalMissing ? "Write a message first." : runDisabledReason}
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label={hasConversation ? "Send follow-up" : "Send message"}
                >
                  <ArrowUp size={17} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </div>
        {workflowInProgress ? <p className="mt-1.5 px-2 text-center text-[10px] leading-4 text-muted">This conversation is locked while active work finishes or waits for approval.</p> : null}
      </div>
    </section>
  );
}

function StagePanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="p-4 sm:p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ResultRows({ rows, empty }: { rows: Array<{ title: string; status: string; meta: string; score?: string }>; empty: string }) {
  if (!rows.length) {
    return <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm text-muted">{empty}</div>;
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
      {rows.slice(0, 12).map((row, index) => (
        <div key={`${row.title}-${index}`} className="grid gap-3 p-3 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{row.title}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{row.meta}</p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <span className="rounded-md bg-surface px-2 py-1 font-mono text-xs text-muted">{row.status}</span>
            {row.score ? <span className="rounded-md bg-primary/10 px-2 py-1 font-mono text-xs text-primary">{row.score}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function RunFeedbackPanel({
  feedback,
  saving,
  onSave,
}: {
  feedback?: RunFeedback;
  saving: boolean;
  onSave: (verdict: RunFeedback["verdict"], correction?: string) => Promise<void>;
}) {
  const [correctionOpen, setCorrectionOpen] = useState(
    feedback?.verdict === "needs_work",
  );
  const [correction, setCorrection] = useState(feedback?.correction || "");

  return (
    <section className="mt-4 rounded-xl border border-line/80 bg-background px-3 py-3" aria-labelledby="run-feedback-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p id="run-feedback-title" className="text-sm font-semibold">Help Asael improve</p>
          <p className="mt-1 text-xs text-muted">Was this response useful?</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={feedback?.verdict === "useful"}
            disabled={saving}
            onClick={() => {
              setCorrectionOpen(false);
              void onSave("useful");
            }}
            className={clsx(
              "inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-xs font-semibold transition disabled:opacity-60",
              feedback?.verdict === "useful"
                ? "border-success/40 bg-success/10 text-success"
                : "border-line hover:bg-surface-raised",
            )}
          >
            <ThumbsUp size={14} aria-hidden="true" /> Useful
          </button>
          <button
            type="button"
            aria-pressed={feedback?.verdict === "needs_work" || correctionOpen}
            disabled={saving}
            onClick={() => setCorrectionOpen(true)}
            className={clsx(
              "inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-xs font-semibold transition disabled:opacity-60",
              feedback?.verdict === "needs_work" || correctionOpen
                ? "border-warning/45 bg-warning/10 text-warning"
                : "border-line hover:bg-surface-raised",
            )}
          >
            <ThumbsDown size={14} aria-hidden="true" /> Needs work
          </button>
        </div>
      </div>
      {correctionOpen ? (
        <div className="mt-3 rounded-lg border border-line bg-surface p-3">
          <label className="block text-xs font-semibold" htmlFor="run-feedback-correction">
            What should change next time?
          </label>
          <textarea
            id="run-feedback-correction"
            value={correction}
            maxLength={2_000}
            rows={3}
            disabled={saving}
            onChange={(event) => setCorrection(event.currentTarget.value)}
            placeholder="Be more concise, verify a source, preserve a constraint..."
            className="mt-2 w-full rounded-md border border-line bg-background px-3 py-2 text-sm leading-5 outline-none focus:border-primary"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">Saved corrections guide this specialist on future tasks.</p>
            <button
              type="button"
              disabled={saving}
              onClick={() => void onSave("needs_work", correction)}
              className="primary-button shrink-0"
            >
              {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              Save feedback
            </button>
          </div>
        </div>
      ) : null}
      {feedback ? (
        <p className="mt-2 text-xs text-muted" role="status">
          {feedback.verdict === "useful" ? "Useful outcome saved." : "Correction saved."} You can change this anytime.
        </p>
      ) : null}
    </section>
  );
}

function EvidenceCard({ title, rows, empty }: { title: string; rows: Array<{ title: string; status: string; meta: string }>; empty: string }) {
  return (
    <div className="rounded-md border border-line bg-background p-3">
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-3 space-y-2">
        {rows.length ? (
          rows.slice(0, 5).map((row, index) => (
            <div key={`${row.title}-${index}`} className="rounded-md border border-line bg-surface p-2">
              <p className="truncate text-xs font-semibold">{row.title}</p>
              <p className="mt-1 truncate text-xs text-muted">{row.meta}</p>
              <span className={clsx("mt-2 inline-flex rounded-md px-2 py-1 font-mono text-xs", pillTone(toneForStatus(row.status)))}>{row.status}</span>
            </div>
          ))
        ) : (
          <div className="rounded-md border border-dashed border-line p-3 text-xs text-muted">{empty}</div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={clsx("inline-flex h-10 items-center rounded-md px-3 font-mono text-sm", pillTone(tone))}>{label}</span>;
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.replaceAll("\r\n", "\n").split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      emitSseEvent(event, onEvent);
    }
  }

  buffer += decoder.decode();
  for (const event of buffer.replaceAll("\r\n", "\n").split("\n\n")) {
    emitSseEvent(event, onEvent);
  }
}

function emitSseEvent(
  block: string,
  onEvent: (event: StreamEvent) => void,
) {
  const payload = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (payload) {
    onEvent(JSON.parse(payload) as StreamEvent);
  }
}

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(body);
    throw new Error(stringValue(record.message || record.error, `${path} returned ${response.status}`));
  }
  return body;
}

function refreshMessage(error: unknown) {
  return error instanceof Error ? error.message : "Resource unavailable.";
}

function workspaceSourcePayload(
  summary: JsonRecord,
  sourceKey: "runs" | "workflows" | "approvals",
  dataKey: "runs" | "items",
) {
  const source = asRecord(readPath(summary, `sources.${sourceKey}`));
  if (source.status === "ready") {
    return {
      [dataKey]: Array.isArray(source.data) ? source.data : [],
    };
  }
  return {
    error: stringValue(source.error, "Resource unavailable."),
    [dataKey]: [],
  };
}

function evidenceRow(item: JsonRecord, titleKey: string, statusKey: string) {
  return {
    title: stringValue(item[titleKey], "Evidence item"),
    status: stringValue(item[statusKey], "unknown"),
    meta: stringValue(item.updatedAt || item.createdAt || item.id, "ledger"),
  };
}

function streamEventLabel(event: StreamEvent) {
  if (event.type === "status") {
    return event.detail ? `${event.label || "Status"}: ${event.detail}` : event.label || "Status update.";
  }
  if (event.type === "memory") {
    return event.count ? `${event.title || "Memory"} (${event.count})` : event.title || "Memory event.";
  }
  if (event.type === "harness") {
    const context = {
      disabled_session: "durable context off for this session",
      excluded_by_user: "saved context excluded by you",
      selected_by_user: `${event.contextCount} selected context item${event.contextCount === 1 ? "" : "s"} resolved`,
      retrieved: `${event.contextCount} relevant context item${event.contextCount === 1 ? "" : "s"} retrieved`,
      skipped: "memory retrieval skipped as unnecessary",
    }[event.contextDecision];
    const tools = `${event.toolCount} governed tool${event.toolCount === 1 ? "" : "s"} available`;
    const learning = event.learningSampleSize
      ? `informed by ${event.learningSampleSize} prior outcome${event.learningSampleSize === 1 ? "" : "s"}`
      : "learning baseline started";
    const reason = event.contextRationale[0];
    const provider = event.provider === "google"
      ? "Gemini"
      : event.provider === "openai"
        ? "OpenAI"
        : event.provider === "anthropic"
          ? "Anthropic"
          : "Local fallback";
    return `${provider} · ${event.tier} route · ${context} · ${tools} · ${learning}.${reason ? ` ${reason}` : ""}`;
  }
  if (event.type === "model") {
    const cost = event.estimatedCostUsd === undefined ? "cost rate not configured" : `$${event.estimatedCostUsd.toFixed(6)}`;
    const loop = event.iterationCount
      ? ` across ${event.iterationCount} loop pass${event.iterationCount === 1 ? "" : "es"}`
      : event.iteration
        ? ` on loop pass ${event.iteration}`
        : "";
    return `${event.provider === "google" ? "Google · " : event.provider === "anthropic" ? "Anthropic · " : "OpenAI · "}${event.model} used ${event.totalTokens.toLocaleString()} tokens${loop} in ${(event.latencyMs / 1_000).toFixed(1)}s (${cost})${event.fallbackUsed ? "; fallback used" : ""}.`;
  }
  if (event.type === "council_member") {
    if (event.status === "thinking") return `${event.agentName} is working independently as ${event.role}.`;
    if (event.status === "failed") return `${event.agentName} could not complete its council pass${event.summary ? `: ${event.summary}` : "."}`;
    return `${event.agentName} completed its ${event.role.toLowerCase()} pass${event.confidence === undefined ? "." : ` at ${Math.round(event.confidence * 100)}% confidence.`}`;
  }
  if (event.type === "council_verdict") {
    return event.status === "passed"
      ? `Sentinel accepted the result at ${Math.round(event.score * 100)}%.`
      : event.status === "revised"
        ? `Sentinel requested changes; Atlas revised the answer (${Math.round(event.score * 100)}% initial score).`
        : event.assessment;
  }
  if (event.type === "tool") {
    const name = event.toolName || event.toolId || "Tool";
    if (event.status === "running") {
      return `${name} is running (risk ${event.riskLevel ?? "?"}).`;
    }
    if (event.status === "executed") {
      return `${name} executed.`;
    }
    if (event.status === "dry_run") {
      return `${name} was previewed only, with no side effects. Approve it from Approvals to run for real.`;
    }
    if (event.status === "approval_required") {
      return `${name} is waiting for human approval.`;
    }
    if (event.status === "blocked") {
      return `${name} was blocked by policy${event.summary ? `: ${event.summary}` : "."}`;
    }
    return `${name} failed${event.summary ? `: ${event.summary}` : "."}`;
  }
  if (event.type === "waiting_approval") {
    return (
      event.message ||
      `Run paused for approval of ${event.toolId || "a gated tool"}. Approving it in the Approvals workspace resumes this run automatically.`
    );
  }
  if (event.type === "done") {
    return "Agent run completed.";
  }
  if (event.type === "delegated") {
    return event.reason || "Task delegated to a durable workflow.";
  }
  if (event.type === "canceled") {
    return event.message || "Task canceled.";
  }
  if (event.type === "error") {
    return event.message || "Agent run failed.";
  }
  return "Event received.";
}

function taskProgressSummary({
  workflowRun,
  streamEvents,
  loading,
}: {
  workflowRun?: JsonRecord;
  streamEvents: StreamEvent[];
  loading?: string;
}) {
  if (workflowRun) {
    const steps = arrayPath(workflowRun, "steps");
    const completed = steps.filter((step) => ["completed", "skipped"].includes(stringValue(step.status))).length;
    const current = steps.find((step) => stringValue(step.stepKey) === stringPath(workflowRun, "run.currentStep", ""));
    if (current) return `${stringValue(current.label, "Workflow stage")} · ${completed} of ${steps.length} stages complete`;
    const status = stringPath(workflowRun, "run.status", "starting").replaceAll("_", " ");
    return steps.length ? `${completed} of ${steps.length} stages complete · ${status}` : `Workflow ${status}`;
  }
  const latest = [...streamEvents].reverse().find((event) => event.type !== "delta");
  if (latest) return streamEventLabel(latest);
  return loading === "agent" ? "Starting the task…" : "Task activity is available.";
}

function activityTitle(event: StreamEvent) {
  if (event.type === "status") return event.label || "Task update";
  if (event.type === "harness") return "Harness configured";
  if (event.type === "memory") return "Context prepared";
  if (event.type === "model") return "Answer generated";
  if (event.type === "council_member") return `${event.agentName} · ${event.status}`;
  if (event.type === "council_verdict") return "Quality review";
  if (event.type === "tool") return event.toolName || event.toolId || "Tool activity";
  if (event.type === "waiting_approval") return "Waiting for approval";
  if (event.type === "delegated") return "Moved to workflow";
  if (event.type === "done") return "Task complete";
  if (event.type === "canceled") return "Task canceled";
  if (event.type === "error") return "Task failed";
  return "Task started";
}

function activityDotTone(event: StreamEvent) {
  if (event.type === "error" || event.type === "canceled") return "bg-danger";
  if (event.type === "waiting_approval") return "bg-warning";
  if (event.type === "done" || event.type === "council_verdict") return "bg-success";
  if (event.type === "tool" && ["failed", "blocked"].includes(event.status || "")) return "bg-danger";
  return "bg-primary";
}

function humanizeWorkflowStep(stepKey: string) {
  return stepKey
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Workflow stage";
}

function workflowStepDescription(stepKey: string) {
  const descriptions: Record<string, string> = {
    preflight: "Checking permissions, safety, and the execution environment.",
    retrieve_context: "Loading only the context selected for this task.",
    plan: "Turning the request into clear, executable steps.",
    approval_gate: "Waiting for required human review before gated actions.",
    execute: "Carrying out the approved plan.",
    verify: "Checking the result against the requested outcome.",
    persist_report: "Saving the result and evidence for later review.",
  };
  return descriptions[stepKey] || "Waiting for this stage to begin.";
}

function workflowEventLabel(type: string) {
  const labels: Record<string, string> = {
    "step.started": "A workflow stage started.",
    "step.completed": "A workflow stage completed.",
    "step.failed": "A workflow stage failed.",
    "step.retry_scheduled": "A failed stage is scheduled to retry.",
    "workflow.waiting_approval": "The workflow is waiting for approval.",
    "workflow.plan_node.started": "A plan step started.",
    "workflow.plan_node.completed": "A plan step completed.",
    "workflow.plan_node.failed": "A plan step failed.",
    "workflow.plan_node.skipped": "A plan step was skipped.",
    "workflow.plan_node.interrupted": "A plan step was interrupted.",
  };
  return labels[type] || type.replaceAll(".", " · ").replaceAll("_", " ");
}

function groundingLabel(status: GroundingReport["status"]) {
  if (status === "verified") return "Sources cited";
  if (status === "not_required") return "No citations required";
  if (status === "invalid") return "Invalid source";
  return "Citation needed";
}

function citedGroundingSources(grounding: GroundingReport) {
  const citedIds = new Set(grounding.citedIds);
  return grounding.sources.filter((source, index, sources) =>
    citedIds.has(source.citationId) &&
    sources.findIndex((candidate) => candidate.citationId === source.citationId) === index);
}

function safeExternalUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function agentDisplayName(agentId: AgentId) {
  return {
    atlas: "Atlas",
    scout: "Scout",
    forge: "Forge",
    sentinel: "Sentinel",
    mnemosyne: "Mnemosyne",
  }[agentId] || "Custom agent";
}

function contextEvidenceId(item: JsonRecord) {
  const kind = stringValue(item.kind);
  const id = stringValue(item.id);
  return ["memory", "knowledge", "graph"].includes(kind) && id
    ? `${kind}:${id}`
    : "";
}

function contextMatchesTask(item: JsonRecord) {
  const support = numberValue(item.supportScore, 0);
  const confidence = numberValue(item.confidence, 0);
  return support >= 0.2 && confidence >= 0.35;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => asRecord(current)[segment], source);
}

function arrayPath(source: unknown, path: string): JsonRecord[] {
  const value = readPath(source, path);
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringPath(source: unknown, path: string, fallback = "0") {
  return stringValue(readPath(source, path), fallback);
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatRelativeThreadTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Tone = "neutral" | "success" | "warning" | "danger";

function toneForStatus(value: unknown): Tone {
  const text = stringValue(value).toLowerCase();
  if (["healthy", "passed", "success", "completed", "executed", "active", "allow", "approved", "ready", "info"].includes(text)) {
    return "success";
  }
  if (["warn", "warning", "waiting_approval", "queued", "paused", "pending", "degraded", "dry_run"].includes(text)) {
    return "warning";
  }
  if (["error", "failed", "blocked", "deny", "unhealthy", "rejected", "open"].includes(text)) {
    return "danger";
  }
  return "neutral";
}

function pillTone(tone: Tone) {
  if (tone === "success") {
    return "bg-success/10 text-success";
  }
  if (tone === "warning") {
    return "bg-warning/10 text-warning";
  }
  if (tone === "danger") {
    return "bg-danger/10 text-danger";
  }
  return "bg-surface text-muted";
}
