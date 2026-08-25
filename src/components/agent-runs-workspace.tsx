"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  FileText,
  GitBranch,
  Loader2,
  Network,
  Play,
  RefreshCw,
  Search,
  Hammer,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";

type JsonRecord = Record<string, unknown>;
type ThreadSummary = { id: string; title: string; updatedAt: string; mode: AgentMode };
type ThreadTurn = { id: string; role: "user" | "assistant"; content: string; createdAt: string };
type AgentMode = "orchestrate" | "research" | "execute" | "learn";
type AgentId = "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne";
type GroundingReport = {
  status: "verified" | "not_required" | "missing" | "invalid";
  citedIds: string[];
  invalidIds: string[];
  sources: Array<{ citationId: string; kind: string; title: string; confidence: number }>;
};
type RunFeedback = {
  verdict: "useful" | "needs_work";
  correction?: string;
  updatedAt: string;
};
type TabKey = "goal" | "context" | "plan" | "execute" | "evidence";

type StreamEvent =
  | { type: "run"; runId?: string; threadId?: string }
  | { type: "status"; label?: string; detail?: string }
  | { type: "memory"; title?: string; count?: number }
  | { type: "model"; model: string; tier: "fast" | "reasoning"; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; latencyMs: number; fallbackUsed: boolean; estimatedCostUsd?: number }
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
  | { type: "delegated"; threadId?: string; workflowId?: string; acknowledgement?: string; reason?: string }
  | { type: "error"; message?: string };

const tabs: Array<{ key: TabKey; label: string; icon: typeof TerminalSquare }> = [
  { key: "goal", label: "Task", icon: TerminalSquare },
  { key: "context", label: "Context", icon: Brain },
  { key: "plan", label: "Plan", icon: GitBranch },
  { key: "execute", label: "Progress", icon: Play },
  { key: "evidence", label: "Result", icon: FileText },
];

const starterGoals = [
  {
    label: "Research a decision",
    description: "Compare sources and recommend a next step.",
    mode: "research" as AgentMode,
    goal: "Research current human-in-the-loop agent UX patterns, compare credible sources, and recommend the three changes that would most improve this workspace. Do not modify external systems.",
  },
  {
    label: "Check release readiness",
    description: "Summarize evidence, blockers, and safe actions.",
    mode: "orchestrate" as AgentMode,
    goal: "Prepare a production release readiness report using evaluations, SLOs, incidents, and security evidence. Identify blockers and three safe next actions without changing external systems.",
  },
  {
    label: "Investigate a failure",
    description: "Find likely causes and propose remediation.",
    mode: "research" as AgentMode,
    goal: "Inspect recent workflow failures, identify the most likely root cause, and produce a bounded remediation plan with verification steps. Do not apply changes.",
  },
  {
    label: "Summarize workspace knowledge",
    description: "Show what is known and what is missing.",
    mode: "learn" as AgentMode,
    goal: "Search workspace memory and knowledge for this project, summarize what is known, identify missing context, and suggest what should be added next.",
  },
];

export function AgentRunsWorkspace({
  initialAgentId,
  initialThreadId,
  initialGoal,
}: {
  initialAgentId?: AgentId;
  initialThreadId?: string;
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
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("goal");
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const [contextPack, setContextPack] = useState<JsonRecord>();
  const [workflowPlan, setWorkflowPlan] = useState<JsonRecord>();
  const [workflowRun, setWorkflowRun] = useState<JsonRecord>();
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [agentResponse, setAgentResponse] = useState("");
  const [grounding, setGrounding] = useState<GroundingReport>();
  const [activeAgentRunId, setActiveAgentRunId] = useState("");
  const [runFeedback, setRunFeedback] = useState<RunFeedback>();
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [evidence, setEvidence] = useState<JsonRecord>({});
  const [evidenceState, setEvidenceState] = useState<"loading" | "ready" | "error">("loading");
  const [workflowSyncError, setWorkflowSyncError] = useState<string>();
  const [runAnnouncement, setRunAnnouncement] = useState("Run workspace ready.");
  const [waitingApproval, setWaitingApproval] = useState<Extract<StreamEvent, { type: "waiting_approval" }>>();
  const [threadId, setThreadId] = useState(initialThreadId || "");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const evidenceControllerRef = useRef<AbortController | null>(null);
  const evidenceVersionRef = useRef(0);
  const pendingDeltasRef = useRef<string[]>([]);
  const deltaFlushTimerRef = useRef<number | null>(null);
  const initialThreadLoadedRef = useRef(false);

  const planNodes = arrayPath(workflowPlan, "plan.plan.nodes");
  const contextResults = arrayPath(contextPack, "pack.results");
  const approvalItems = arrayPath(evidence, "approvals.items");
  const runRows = arrayPath(evidence, "runs.runs");
  const agentRunCompleted = streamEvents.some((event) => event.type === "done");
  const reviewedPlanId = stringPath(workflowPlan, "plan.id", "");
  const reviewedPlanStatus = stringPath(workflowPlan, "plan.status", "");
  const reviewedPlanReady = Boolean(
    reviewedPlanId && reviewedPlanStatus === "planned",
  );
  const readPermission = permissionMessage(session, sessionStatus, "read");
  const runPermission = permissionMessage(session, sessionStatus, "run.agent");
  const workflowPermission = permissionMessage(session, sessionStatus, "manage.workflow");
  const activeWorkflowId = stringPath(workflowRun, "run.id", "");
  const activeWorkflowStatus = stringPath(workflowRun, "run.status", "");
  const workflowInProgress = Boolean(
    activeWorkflowId &&
      !["completed", "failed", "canceled"].includes(activeWorkflowStatus),
  );

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
      evidenceControllerRef.current?.abort();
      if (deltaFlushTimerRef.current !== null) {
        window.clearTimeout(deltaFlushTimerRef.current);
      }
    };
    // Session changes are the only automatic evidence refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, role]);

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
            `/api/workflows/${encodeURIComponent(activeWorkflowId)}?view=status`,
            { signal: controller.signal },
          ),
        );
        if (disposed) {
          return;
        }
        setWorkflowSyncError(undefined);
        const nextStatus = stringPath(next, "run.status", "");
        setWorkflowRun((current) => ({
          ...asRecord(current),
          run: {
            ...asRecord(readPath(current, "run")),
            ...asRecord(next.run),
          },
        }));
        if (nextStatus && nextStatus !== activeWorkflowStatus) {
          void refreshEvidence();
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
      await readJson(`/api/runs/${encodeURIComponent(activeAgentRunId)}`, {
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
      setRunAnnouncement(
        verdict === "useful"
          ? "Useful outcome recorded."
          : "Correction recorded for future agent work.",
      );
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

  function changeGoal(nextGoal: string) {
    if (nextGoal === goal) {
      return;
    }
    setGoal(nextGoal);
    setContextPack(undefined);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setAgentResponse("");
    setGrounding(undefined);
    setActiveAgentRunId("");
    setRunFeedback(undefined);
    setStreamEvents([]);
    setWaitingApproval(undefined);
  }

  function changeMode(nextMode: AgentMode) {
    if (nextMode === mode) {
      return;
    }
    setMode(nextMode);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setAgentResponse("");
    setActiveAgentRunId("");
    setRunFeedback(undefined);
    setStreamEvents([]);
    setWaitingApproval(undefined);
  }

  function changeApprovalRequired(nextValue: boolean) {
    if (nextValue === approvalRequired) {
      return;
    }
    setApprovalRequired(nextValue);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setAgentResponse("");
    setActiveAgentRunId("");
    setRunFeedback(undefined);
    setStreamEvents([]);
    setWaitingApproval(undefined);
  }

  async function buildContext() {
    if (readPermission) {
      setError(readPermission);
      return;
    }
    setLoading("context");
    setError(undefined);
    setRunAnnouncement("Building context.");
    try {
      const result = await readJson("/api/retrieval/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: goal, limit: 8, persistTrace: true }),
      });
      setContextPack(asRecord(result));
      setActiveTab("context");
      setRunAnnouncement("Context is ready for review.");
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : "Context retrieval failed.");
      setRunAnnouncement("Context retrieval failed.");
    } finally {
      setLoading(undefined);
    }
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
    setLoading("plan");
    setError(undefined);
    setRunAnnouncement("Generating a workflow plan.");
    try {
      const result = await readJson("/api/workflows/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, mode, requireApproval: approvalRequired }),
      });
      const nextPlan = asRecord(result);
      const nextPlanStatus = stringPath(nextPlan, "plan.status", "");
      setWorkflowPlan(nextPlan);
      setWorkflowRun(undefined);
      setWorkflowSyncError(undefined);
      setActiveTab("plan");
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
      setActiveTab("plan");
      return;
    }
    if (activeWorkflowId) {
      setError("This reviewed plan has already started. Generate a new plan to run again.");
      return;
    }
    setLoading("workflow");
    setError(undefined);
    setRunAnnouncement("Starting the durable workflow.");
    try {
      const result = await readJson("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal,
          mode,
          planId: reviewedPlanId || undefined,
          requireApproval: approvalRequired,
          metadata: { source: "agent-runs-workspace" },
        }),
      });
      setWorkflowRun(asRecord(result));
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

  async function runAgent() {
    if (runPermission) {
      setError(runPermission);
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading("agent");
    setError(undefined);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    const submittedGoal = goal.trim();
    if (!submittedGoal) {
      setError("Write a message before asking Asael.");
      return;
    }
    setAgentResponse("");
    setActiveAgentRunId("");
    setRunFeedback(undefined);
    setStreamEvents([{ type: "status", label: "Starting", detail: "Opening the durable conversation." }]);
    setWaitingApproval(undefined);
    pendingDeltasRef.current = [];
    if (deltaFlushTimerRef.current !== null) {
      window.clearTimeout(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = null;
    }
    setActiveTab("execute");
    setRunAnnouncement("Agent run started.");
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
          message: submittedGoal,
          strategy: "auto",
          agentId: preferredAgentId,
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
          flushPendingDeltas();
          setAgentResponse(event.response || "");
          setGrounding(event.grounding);
          if (event.response) {
            setTurns((current) => [
              ...current,
              { id: `assistant-${Date.now()}`, role: "assistant", content: event.response || "", createdAt: new Date().toISOString() },
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
          setWaitingApproval(event);
          setRunAnnouncement("Agent run paused for approval.");
        }
        if (event.type === "error") {
          terminalEvent = "error";
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

  async function refreshThreads() {
    try {
      const result = asRecord(await readJson("/api/threads?limit=20"));
      setThreads(arrayPath(result, "threads") as unknown as ThreadSummary[]);
    } catch {
      // Threads are convenience navigation; agent execution reports its own errors.
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
      setActiveTab("goal");
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Conversation could not be loaded.");
    }
  }

  function newThread() {
    setThreadId("");
    setTurns([]);
    setGoal("");
    setAgentResponse("");
    setStreamEvents([]);
    setActiveTab("goal");
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
      className="mx-auto max-w-[90rem] px-4 py-7 sm:px-7 lg:px-10"
      aria-busy={Boolean(loading)}
      data-testid="work-workspace"
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {runAnnouncement}
      </p>
      <section className="border-b border-line/80 pb-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-ink shadow-sm">
                <TerminalSquare size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Ask Asael</p>
                <h1 className="mt-1 text-3xl font-semibold tracking-tight">What are we working on?</h1>
              </div>
            </div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-muted">
              Ask a question, explore an idea, or hand off a task. You stay in control of every consequential action.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill label={runPosture.label} tone={runPosture.tone} />
            <button
              type="button"
              onClick={() => void refreshEvidence()}
              disabled={evidenceState === "loading"}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
            >
              {evidenceState === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              Refresh
            </button>
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

      <section className="mx-auto mt-6 max-w-6xl">
        <div className="mb-4 grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="min-w-0 border-b border-line pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4" aria-label="Recent conversations">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Conversations</h2>
              <button type="button" onClick={newThread} className="rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10">New</button>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto lg:block lg:space-y-1 lg:overflow-visible">
              {threads.slice(0, 8).map((thread) => (
                <button key={thread.id} type="button" onClick={() => void loadThread(thread.id)} className={clsx("min-w-44 rounded-xl px-3 py-2 text-left transition lg:block lg:w-full lg:min-w-0", thread.id === threadId ? "bg-foreground text-background" : "hover:bg-surface-raised")}>
                  <span className="block truncate text-sm font-medium">{thread.title}</span>
                  <span className={clsx("mt-1 block text-xs", thread.id === threadId ? "text-background/65" : "text-muted")}>{formatRelativeThreadTime(thread.updatedAt)}</span>
                </button>
              ))}
              {!threads.length ? <p className="text-xs leading-5 text-muted">Your conversations will appear here.</p> : null}
            </div>
          </aside>
          <div className="min-w-0 space-y-4" aria-live="polite">
            {turns.map((turn) => (
              <article key={turn.id} className={clsx("max-w-3xl", turn.role === "user" ? "ml-auto rounded-2xl bg-foreground px-4 py-3 text-background" : "border-l-2 border-primary pl-4")}>
                <p className="whitespace-pre-wrap text-sm leading-6">{turn.content}</p>
              </article>
            ))}
            {agentResponse && turns.at(-1)?.content !== agentResponse ? <article className="max-w-3xl border-l-2 border-primary pl-4"><p className="whitespace-pre-wrap text-sm leading-6">{agentResponse}</p></article> : null}
            {!turns.length && !agentResponse ? <div className="py-6"><p className="text-lg font-semibold tracking-tight">Start a conversation</p><p className="mt-1 text-sm text-muted">Asael remembers the thread, so you can refine, question, and continue.</p></div> : null}
          </div>
        </div>
        <div className="soft-shadow min-w-0 overflow-hidden rounded-2xl border border-line/80 bg-surface">
          <nav className="flex max-w-full gap-1 overflow-x-auto border-b border-line/80 px-3 py-2 sm:gap-2" aria-label="Agent run stages" role="tablist">
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
                    "inline-flex min-h-10 shrink-0 items-center gap-1 rounded-xl px-2 text-sm font-semibold transition sm:gap-2 sm:px-3",
                    activeTab === tab.key ? "bg-foreground text-background shadow-sm" : "text-muted hover:bg-surface-raised hover:text-foreground",
                  )}
                >
                  <Icon size={15} className="hidden sm:block" aria-hidden="true" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div
            id="run-stage-panel"
            role="tabpanel"
            aria-labelledby={`run-tab-${activeTab}`}
            tabIndex={0}
            className="p-4 outline-none"
          >
            {activeTab === "goal" ? (
              <GoalStage
                goal={goal}
                mode={mode}
                approvalRequired={approvalRequired}
                preferredAgentId={preferredAgentId}
                loading={loading}
                readDisabledReason={readPermission}
                runDisabledReason={runPermission}
                workflowDisabledReason={workflowPermission}
                workflowReady={reviewedPlanReady}
                workflowStarted={Boolean(activeWorkflowId)}
                workflowInProgress={workflowInProgress}
                onGoalChange={changeGoal}
                onModeChange={changeMode}
                onApprovalChange={changeApprovalRequired}
                onClearPreferredAgent={() => setPreferredAgentId(undefined)}
                onContext={() => void buildContext()}
                onPlan={() => void buildPlan()}
                onAgent={() => void runAgent()}
                onWorkflow={() => void startWorkflow()}
              />
            ) : null}

            {activeTab === "context" ? (
              <StagePanel title="Context preview" description="Retrieved evidence that will shape planning and execution.">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void buildContext()}
                    disabled={Boolean(loading) || Boolean(readPermission)}
                    title={readPermission}
                    className="action-button"
                  >
                    {loading === "context" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Brain size={14} aria-hidden="true" />}
                    Refresh context
                  </button>
                  <StatusPill label={`${contextResults.length} evidence items`} tone={contextResults.length ? "success" : "neutral"} />
                </div>
                <ResultRows
                  rows={contextResults.map((item) => ({
                    title: stringValue(item.title, "Context item"),
                    status: stringValue(item.kind, "evidence"),
                    meta: stringValue(item.content, "No excerpt"),
                    score: stringValue(item.confidence || item.score, ""),
                  }))}
                  empty="No context pack yet. Preview context from the Task stage."
                />
              </StagePanel>
            ) : null}

            {activeTab === "plan" ? (
              <StagePanel title="Workflow plan" description="Policy-aware nodes, risk, approvals, and verification criteria.">
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
                  empty="No plan generated yet. Use Preview plan from the Task stage."
                />
              </StagePanel>
            ) : null}

            {activeTab === "execute" ? (
              <StagePanel title="Execution" description="Run the agent stream, start durable workflow work, and process queued nodes.">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void runAgent()}
                    disabled={
                      Boolean(loading) ||
                      Boolean(runPermission) ||
                      workflowInProgress
                    }
                    title={
                      runPermission ||
                      (workflowInProgress
                        ? "Wait for the active workflow to finish or cancel it first."
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
                <CouncilExecutionMap events={streamEvents} />
                <div className="grid gap-4 lg:grid-cols-[0.86fr_1.14fr]">
                  <div className="rounded-md border border-line bg-background p-3">
                    <p className="text-sm font-semibold">Run stream</p>
                    <div className="mt-3 max-h-96 space-y-2 overflow-auto">
                      {streamEvents.length ? (
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
                  </div>
                  <div className="rounded-md border border-line bg-background p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold">Agent response</p>
                      {grounding ? (
                        <StatusPill
                          label={groundingLabel(grounding.status)}
                          tone={grounding.status === "verified" ? "success" : grounding.status === "not_required" ? "neutral" : "warning"}
                        />
                      ) : null}
                    </div>
                    <div className="mt-3 min-h-64 max-h-96 overflow-auto rounded-md border border-line bg-surface p-3 text-sm leading-6 text-muted">
                      {agentResponse || "Run the agent to stream an answer here."}
                    </div>
                    {grounding?.sources.some((source) => grounding.citedIds.includes(source.citationId)) ? (
                      <div className="mt-3 space-y-2" aria-label="Answer sources">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Sources used</p>
                        {grounding.sources.filter((source) => grounding.citedIds.includes(source.citationId)).map((source) => (
                          <div key={source.citationId} className="rounded-md border border-line bg-surface px-3 py-2 text-xs">
                            <p className="font-medium text-foreground">{source.title}</p>
                            <p className="mt-0.5 font-mono text-muted">[{source.citationId}] · {source.kind} · {Math.round(source.confidence * 100)}%</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {agentResponse && activeAgentRunId && agentRunCompleted ? (
                      <RunFeedbackPanel
                        feedback={runFeedback}
                        saving={feedbackSaving}
                        onSave={saveRunFeedback}
                      />
                    ) : null}
                  </div>
                </div>
              </StagePanel>
            ) : null}

            {activeTab === "evidence" ? (
              <StagePanel title="Results and evidence" description="Inline result history and approval blockers. Open focused admin views only when deeper release or runtime evidence is needed.">
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
                <div className="grid gap-4 lg:grid-cols-2">
                  <EvidenceCard title="Agent answers" rows={runRows.map((item) => evidenceRow(item, "prompt", "status"))} empty="No run records loaded." />
                  <EvidenceCard title="Blocked before result" rows={approvalItems.map((item) => evidenceRow(item, "title", "kind"))} empty="No approvals pending." />
                  <EvidenceCard title="Workflow outcomes" rows={arrayPath(evidence, "workflows.runs").map((item) => evidenceRow(item, "goal", "status"))} empty="No workflows loaded." />
                </div>
              </StagePanel>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function CouncilExecutionMap({ events }: { events: StreamEvent[] }) {
  const memberEvents = events.filter((event): event is Extract<StreamEvent, { type: "council_member" }> => event.type === "council_member");
  const latestByAgent = new Map<AgentId, Extract<StreamEvent, { type: "council_member" }>>();
  for (const event of memberEvents) latestByAgent.set(event.agentId, event);
  const members = [...latestByAgent.values()];
  const verdict = [...events].reverse().find((event): event is Extract<StreamEvent, { type: "council_verdict" }> => event.type === "council_verdict");
  if (!members.length && !verdict) return null;
  return (
    <section className="council-execution" aria-label="Live agent council">
      <header>
        <div><Network size={15} aria-hidden="true" /><span>Agent council</span></div>
        <small>{verdict ? "Review complete" : "Independent passes running"}</small>
      </header>
      <div className="council-stage">
        <svg viewBox="0 0 720 220" preserveAspectRatio="none" aria-hidden="true">
          <path d="M360 108 C285 108 265 42 165 42 M360 108 C285 108 265 178 165 178 M360 108 C435 108 455 42 555 42 M360 108 C435 108 455 178 555 178" />
        </svg>
        <div className="council-hub"><span><Sparkles size={17} aria-hidden="true" /></span><strong>Atlas</strong><small>Synthesis</small></div>
        <div className="council-members">
          {members.map((member) => {
            const Icon = member.agentId === "scout" ? Search : member.agentId === "forge" ? Hammer : member.agentId === "sentinel" ? ShieldCheck : member.agentId === "mnemosyne" ? Brain : Sparkles;
            return <article key={member.agentId} className={clsx(`is-${member.status}`, `agent-${member.agentId}`)}><span><Icon size={15} aria-hidden="true" /></span><div><strong>{member.agentName}</strong><small>{member.status === "thinking" ? "Thinking" : member.status === "failed" ? "Needs retry" : member.confidence === undefined ? "Complete" : `${Math.round(member.confidence * 100)}% confidence`}</small></div>{member.summary ? <p>{member.summary}</p> : null}</article>;
          })}
        </div>
      </div>
      {verdict ? <footer className={clsx(`is-${verdict.status}`)}><ShieldCheck size={14} aria-hidden="true" /><div><strong>{verdict.status === "passed" ? "Sentinel accepted the answer" : verdict.status === "revised" ? "Atlas revised after critique" : "Critic pass needs retry"}</strong><p>{verdict.assessment}</p></div><span>{Math.round(verdict.score * 100)}%</span></footer> : null}
    </section>
  );
}

function GoalStage({
  goal,
  mode,
  approvalRequired,
  preferredAgentId,
  loading,
  readDisabledReason,
  runDisabledReason,
  workflowDisabledReason,
  workflowReady,
  workflowStarted,
  workflowInProgress,
  onGoalChange,
  onModeChange,
  onApprovalChange,
  onClearPreferredAgent,
  onContext,
  onPlan,
  onAgent,
  onWorkflow,
}: {
  goal: string;
  mode: AgentMode;
  approvalRequired: boolean;
  preferredAgentId?: AgentId;
  loading?: string;
  readDisabledReason?: string;
  runDisabledReason?: string;
  workflowDisabledReason?: string;
  workflowReady: boolean;
  workflowStarted: boolean;
  workflowInProgress: boolean;
  onGoalChange: (value: string) => void;
  onModeChange: (value: AgentMode) => void;
  onApprovalChange: (value: boolean) => void;
  onClearPreferredAgent: () => void;
  onContext: () => void;
  onPlan: () => void;
  onAgent: () => void;
  onWorkflow: () => void;
}) {
  const goalMissing = !goal.trim();
  const draftLocked = Boolean(loading) || workflowInProgress;
  return (
    <StagePanel
      title="Describe the outcome"
      description="Choose a safe sample or write the result you need. Planning and advanced controls stay optional."
    >
      {preferredAgentId ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2.5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Primary agent</p>
            <p className="mt-1 text-sm font-semibold">{agentDisplayName(preferredAgentId)} is leading this task</p>
          </div>
          <button type="button" onClick={onClearPreferredAgent} className="rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10">
            Use automatic routing
          </button>
        </div>
      ) : null}
      <div aria-labelledby="sample-use-cases">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <p id="sample-use-cases" className="text-sm font-semibold">
            Sample use cases
          </p>
          <p className="text-xs text-muted">Read-only starters you can edit</p>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {starterGoals.map((starter) => (
            <button
              key={starter.label}
              type="button"
              onClick={() => {
                onGoalChange(starter.goal);
                onModeChange(starter.mode);
              }}
              disabled={draftLocked}
              aria-pressed={goal === starter.goal}
              className={clsx(
                "rounded-md border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                goal === starter.goal
                  ? "border-primary bg-primary/10"
                  : "border-line bg-background hover:bg-surface-raised",
              )}
            >
              <span className="block text-sm font-semibold">{starter.label}</span>
              <span className="mt-1 block text-xs leading-5 text-muted">
                {starter.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      <label className="mt-6 block text-sm font-semibold">
        Task outcome
        <textarea
          value={goal}
          onChange={(event) => onGoalChange(event.currentTarget.value)}
          rows={6}
          required
          disabled={draftLocked}
          aria-describedby="run-goal-help"
          placeholder="Describe what should be produced, important constraints, and how you will know it is complete."
          className="mt-2 w-full rounded-md border border-line bg-background px-3 py-3 text-sm leading-6 outline-none transition focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span id="run-goal-help" className="mt-2 block text-xs font-normal leading-5 text-muted">
          {workflowInProgress
            ? "This draft is locked while its workflow is active."
            : "Describe the outcome, constraints, and evidence you expect. Do not include secrets."}
        </span>
      </label>

      <details className="mt-4 rounded-md border border-line bg-background p-3">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
          <span>Run settings</span>
          <span className="font-mono text-xs font-normal text-muted">
            {mode} · approvals {approvalRequired ? "on" : "off"}
          </span>
        </summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold">
            How the agent should work
            <select
              value={mode}
              disabled={draftLocked}
              onChange={(event) =>
                onModeChange(event.currentTarget.value as AgentMode)
              }
              className="mt-2 min-h-11 w-full rounded-md border border-line bg-surface px-3 text-sm font-normal"
            >
              <option value="orchestrate">General task</option>
              <option value="research">Research and compare</option>
              <option value="execute">Use approved tools</option>
              <option value="learn">Use and update knowledge</option>
            </select>
          </label>
          <label className="flex min-h-16 items-center justify-between gap-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">
            <span>
              <span className="block font-semibold">Require approval</span>
              <span className="mt-1 block text-xs leading-5 text-muted">
                Pause durable workflows before gated actions.
              </span>
            </span>
            <input
              type="checkbox"
              checked={approvalRequired}
              disabled={draftLocked}
              onChange={(event) =>
                onApprovalChange(event.currentTarget.checked)
              }
              className="size-4 shrink-0 accent-[var(--primary)]"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onContext}
          disabled={
            Boolean(loading) || goalMissing || Boolean(readDisabledReason)
          }
          title={goalMissing ? "Enter a task first." : readDisabledReason}
          className="action-button mt-4"
        >
          {loading === "context" ? (
            <Loader2
              size={14}
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Brain size={14} aria-hidden="true" />
          )}
          Preview context
        </button>
      </details>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button
          type="button"
          onClick={onAgent}
          disabled={
            Boolean(loading) ||
            goalMissing ||
            Boolean(runDisabledReason) ||
            workflowInProgress
          }
          title={
            goalMissing
              ? "Enter a task first."
              : runDisabledReason ||
                (workflowInProgress
                  ? "Wait for the active workflow to finish or cancel it first."
                  : undefined)
          }
          className="primary-button"
        >
          {loading === "agent" ? (
            <Loader2
              size={14}
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          Run task
        </button>
        <button
          type="button"
          onClick={onPlan}
          disabled={
            Boolean(loading) ||
            goalMissing ||
            Boolean(workflowDisabledReason) ||
            workflowInProgress
          }
          title={
            goalMissing
              ? "Enter a goal first."
              : workflowDisabledReason ||
                (workflowInProgress
                  ? "Wait for the active workflow to finish or cancel it first."
                  : undefined)
          }
          className="action-button"
        >
          {loading === "plan" ? (
            <Loader2
              size={14}
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <GitBranch size={14} aria-hidden="true" />
          )}
          Preview plan
        </button>
        {workflowReady || workflowStarted ? (
          <button
            type="button"
            onClick={onWorkflow}
            disabled={
              Boolean(loading) ||
              goalMissing ||
              Boolean(workflowDisabledReason) ||
              !workflowReady ||
              workflowStarted
            }
            title={
              workflowDisabledReason ||
              (workflowStarted
                ? "Generate a new plan before starting another workflow."
                : undefined)
            }
            className="action-button"
          >
            {loading === "workflow" ? (
              <Loader2
                size={14}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Workflow size={14} aria-hidden="true" />
            )}
            {workflowStarted ? "Workflow started" : "Start reviewed plan"}
          </button>
        ) : null}
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">
        Run task for a direct answer. Preview a plan when the work should be
        durable, reviewable, and resumable.
      </p>
    </StagePanel>
  );
}

function StagePanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
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
    <section className="mt-3 border-t border-line pt-3" aria-labelledby="run-feedback-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p id="run-feedback-title" className="text-sm font-semibold">Train this agent</p>
          <p className="mt-1 text-xs text-muted">Your signal shapes future routing and responses.</p>
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
        <div className="mt-3 rounded-md border border-line bg-surface p-3">
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
  if (event.type === "model") {
    const cost = event.estimatedCostUsd === undefined ? "cost rate not configured" : `$${event.estimatedCostUsd.toFixed(6)}`;
    return `${event.model} used ${event.totalTokens.toLocaleString()} tokens in ${(event.latencyMs / 1_000).toFixed(1)}s (${cost})${event.fallbackUsed ? "; fallback used" : ""}.`;
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
  if (event.type === "error") {
    return event.message || "Agent run failed.";
  }
  return "Event received.";
}

function groundingLabel(status: GroundingReport["status"]) {
  if (status === "verified") return "Citations verified";
  if (status === "not_required") return "No retrieved sources";
  if (status === "invalid") return "Invalid citation";
  return "Citation needed";
}

function agentDisplayName(agentId: AgentId) {
  return {
    atlas: "Atlas",
    scout: "Scout",
    forge: "Forge",
    sentinel: "Sentinel",
    mnemosyne: "Mnemosyne",
  }[agentId];
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
