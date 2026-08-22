"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";

type JsonRecord = Record<string, unknown>;
type AgentMode = "orchestrate" | "research" | "execute" | "learn";
type TabKey = "goal" | "context" | "plan" | "execute" | "evidence";

type StreamEvent =
  | { type: "run"; runId?: string }
  | { type: "status"; label?: string; detail?: string }
  | { type: "memory"; title?: string; count?: number }
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
  | { type: "done"; response?: string }
  | { type: "error"; message?: string };

const tabs: Array<{ key: TabKey; label: string; icon: typeof TerminalSquare }> = [
  { key: "goal", label: "Goal", icon: TerminalSquare },
  { key: "context", label: "Context", icon: Brain },
  { key: "plan", label: "Plan", icon: GitBranch },
  { key: "execute", label: "Execute", icon: Play },
  { key: "evidence", label: "Results", icon: FileText },
];

const starterGoals = [
  "Search my memory and knowledge for anything about this project, then summarize what you found and what is missing.",
  "Research the latest workflow failures, build a remediation plan, and save durable lessons.",
  "Prepare a production release readiness report using evaluations, SLOs, incidents, and security evidence.",
  "Fetch https://api.github.com/zen with the http.request tool and tell me what came back.",
];

const runMapSteps = [
  {
    step: "1",
    key: "goal",
    label: "First",
    title: "Goal",
    body: "Say what you want done.",
    icon: TerminalSquare,
  },
  {
    step: "2",
    key: "context",
    label: "RAG",
    title: "Context",
    body: "See memory and live-web evidence.",
    icon: Brain,
  },
  {
    step: "3",
    key: "plan",
    label: "Before action",
    title: "Plan",
    body: "Check steps, risk, and gates.",
    icon: GitBranch,
  },
  {
    step: "4",
    key: "execute",
    label: "Action",
    title: "Execute",
    body: "Run the agent or workflow.",
    icon: Play,
  },
  {
    step: "5",
    key: "approvals",
    label: "If blocked",
    title: "Approve",
    body: "Decide risky gates only if needed.",
    icon: ShieldCheck,
    href: "/app/approvals",
  },
  {
    step: "6",
    key: "results",
    label: "Last",
    title: "Results",
    body: "Read output and evidence.",
    icon: FileText,
    href: "/app/results",
  },
] as const;

export function AgentRunsWorkspace() {
  const {
    session,
    status: sessionStatus,
    role,
  } = useWorkspaceSession();
  const [goal, setGoal] = useState(starterGoals[0]);
  const [mode, setMode] = useState<AgentMode>("orchestrate");
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("goal");
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const [contextPack, setContextPack] = useState<JsonRecord>();
  const [workflowPlan, setWorkflowPlan] = useState<JsonRecord>();
  const [workflowRun, setWorkflowRun] = useState<JsonRecord>();
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [agentResponse, setAgentResponse] = useState("");
  const [activeAgentRunId, setActiveAgentRunId] = useState("");
  const [evidence, setEvidence] = useState<JsonRecord>({});
  const [evidenceState, setEvidenceState] = useState<"loading" | "ready" | "error">("loading");
  const [workflowSyncError, setWorkflowSyncError] = useState<string>();
  const [runAnnouncement, setRunAnnouncement] = useState("Run workspace ready.");
  const [waitingApproval, setWaitingApproval] = useState<Extract<StreamEvent, { type: "waiting_approval" }>>();
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingDeltasRef = useRef<string[]>([]);
  const deltaFlushTimerRef = useRef<number | null>(null);

  const planNodes = arrayPath(workflowPlan, "plan.plan.nodes");
  const contextResults = arrayPath(contextPack, "pack.results");
  const approvalItems = arrayPath(evidence, "approvals.items");
  const runRows = arrayPath(evidence, "runs.runs");
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
    void refreshEvidence();
    return () => {
      abortControllerRef.current?.abort();
      if (deltaFlushTimerRef.current !== null) {
        window.clearTimeout(deltaFlushTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (
      !activeWorkflowId ||
      ["completed", "failed", "canceled"].includes(activeWorkflowStatus)
    ) {
      return;
    }
    let disposed = false;
    const poll = async () => {
      try {
        const next = asRecord(
          await readJson(`/api/workflows/${encodeURIComponent(activeWorkflowId)}`),
        );
        if (disposed) {
          return;
        }
        setWorkflowSyncError(undefined);
        const nextStatus = stringPath(next, "run.status", "");
        setWorkflowRun(next);
        if (nextStatus && nextStatus !== activeWorkflowStatus) {
          await refreshEvidence();
          setRunAnnouncement(`Workflow is now ${nextStatus.replace(/_/g, " ")}.`);
        }
      } catch (pollError) {
        if (!disposed) {
          setWorkflowSyncError(
            `Live workflow updates are temporarily unavailable. Retrying automatically. ${refreshMessage(pollError)}`,
          );
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    void poll();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
    // refreshEvidence is intentionally read at poll time; run identity/status
    // control the lifecycle of this interval.
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
      await refreshEvidence();
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
    setActiveAgentRunId("");
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
      await refreshEvidence();
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
    setAgentResponse("");
    setActiveAgentRunId("");
    setStreamEvents([]);
    setWaitingApproval(undefined);
    pendingDeltasRef.current = [];
    if (deltaFlushTimerRef.current !== null) {
      window.clearTimeout(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = null;
    }
    setActiveTab("execute");
    setRunAnnouncement("Agent run started.");

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, messages: [{ role: "user", content: goal }] }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(stringValue(asRecord(body).message || asRecord(body).error, `/api/agent returned ${response.status}`));
      }

      let terminalEvent: "done" | "waiting_approval" | "error" | undefined;
      await readSse(response.body, (event) => {
        if (event.type === "run" && event.runId) {
          setActiveAgentRunId(event.runId);
          return;
        }
        if (event.type === "delta" && event.text) {
          queueDelta(event.text);
          return;
        }
        setStreamEvents((current) => [...current.slice(-199), event]);
        if (event.type === "done") {
          terminalEvent = "done";
          flushPendingDeltas();
          setAgentResponse(event.response || "");
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
      await refreshEvidence();
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
      await refreshEvidence();
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
    setEvidenceState("loading");
    try {
      const session = asRecord(await readJson("/api/auth/session"));
      if (Boolean(session.authEnabled) && !Boolean(session.authenticated)) {
        const protectedPayload = {
          error: "Sign in to load protected production evidence.",
          items: [],
          runs: [],
          events: [],
        };
        setEvidence({
          session,
          runs: protectedPayload,
          approvals: protectedPayload,
          release: protectedPayload,
          events: protectedPayload,
          workflows: protectedPayload,
        });
        setEvidenceState("ready");
        return;
      }
      const role = sessionRole(session);
      const canManageWorkflow = hasRole(role, ["operator", "admin", "system"]);
      const canReadSecurity = hasRole(role, ["admin", "system"]);
      const unavailableForRole = { error: "Operator or admin role required for this evidence.", items: [], runs: [], events: [] };
      const securityUnavailable = { error: "Admin role required for release and observability evidence.", items: [], runs: [], events: [] };
      const [runs, approvals, release, events, workflows] = await Promise.all([
        readJson("/api/runs?limit=8").catch((refreshError) => ({ error: refreshMessage(refreshError) })),
        canManageWorkflow
          ? readJson("/api/approvals?limit=8").catch((refreshError) => ({ error: refreshMessage(refreshError), items: [] }))
          : Promise.resolve(unavailableForRole),
        canReadSecurity
          ? readJson("/api/release/evidence").catch((refreshError) => ({ error: refreshMessage(refreshError) }))
          : Promise.resolve(securityUnavailable),
        canReadSecurity
          ? readJson("/api/observability?limit=12").catch((refreshError) => ({ error: refreshMessage(refreshError), events: [] }))
          : Promise.resolve(securityUnavailable),
        readJson("/api/workflows?limit=8").catch((refreshError) => ({ error: refreshMessage(refreshError), runs: [] })),
      ]);
      setEvidence({
        runs,
        approvals,
        release,
        events,
        workflows,
      });
      setEvidenceState("ready");
    } catch (refreshError) {
      setEvidenceState("error");
      setEvidence({
        error: refreshMessage(refreshError),
      });
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
      className="px-4 py-6 sm:px-6 lg:px-8"
      aria-busy={Boolean(loading)}
      data-testid="work-workspace"
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {runAnnouncement}
      </p>
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                <TerminalSquare size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold text-primary">Work</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">Give the agent a bounded outcome.</h1>
              </div>
            </div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-muted">
              Write the goal, inspect context and the plan, then run it. Sensitive actions pause in Inbox. Completed output and evidence appear in Results.
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
              Refresh evidence
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

      <RunMap
        activeTab={activeTab}
        onStage={(key) => setActiveTab(key)}
        contextReady={Boolean(contextPack)}
        planReady={reviewedPlanReady}
        executionStarted={Boolean(workflowRun || streamEvents.length || agentResponse)}
        approvalCount={
          waitingApproval || activeWorkflowStatus === "waiting_approval" ? 1 : 0
        }
        resultReady={Boolean(
          agentResponse ||
            streamEvents.some((event) => event.type === "done") ||
            activeWorkflowStatus === "completed"
        )}
      />

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 rounded-lg border border-line bg-surface">
          <nav className="flex max-w-full gap-2 overflow-x-auto border-b border-line p-2" aria-label="Agent run stages" role="tablist">
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
                    "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold transition",
                    activeTab === tab.key ? "bg-primary text-primary-ink" : "text-muted hover:bg-surface-raised hover:text-foreground",
                  )}
                >
                  <Icon size={15} aria-hidden="true" />
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
                  empty="No context pack yet. Build context from the Goal stage."
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
                    two distinct admin approvals in the Inbox.
                  </div>
                ) : null}
                <ResultRows
                  rows={planNodes.map((item) => ({
                    title: stringValue(item.label, "Plan node"),
                    status: `${stringValue(item.kind, "node")} / risk ${stringValue(item.riskLevel, "0")}`,
                    meta: stringValue(item.description, "No description"),
                    score: Boolean(item.approvalRequired) ? "approval" : stringValue(item.policy, "auto"),
                  }))}
                  empty="No plan generated yet. Use Preview plan from the Goal stage."
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
                    Run agent
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
                    <Link href="/app/approvals" className="primary-button shrink-0">Open Inbox</Link>
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
                    <p className="text-sm font-semibold">Agent response</p>
                    <div className="mt-3 min-h-64 max-h-96 overflow-auto rounded-md border border-line bg-surface p-3 text-sm leading-6 text-muted">
                      {agentResponse || "Run the agent to stream an answer here."}
                    </div>
                  </div>
                </div>
              </StagePanel>
            ) : null}

            {activeTab === "evidence" ? (
              <StagePanel title="Results and evidence" description="Inline result history, approval blockers, release gate, and runtime events. Use the Results page as the final cross-run destination.">
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
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <EvidenceCard title="Agent answers" rows={runRows.map((item) => evidenceRow(item, "prompt", "status"))} empty="No run records loaded." />
                  <EvidenceCard title="Blocked before result" rows={approvalItems.map((item) => evidenceRow(item, "title", "kind"))} empty="No approvals pending." />
                  <EvidenceCard title="Workflow outcomes" rows={arrayPath(evidence, "workflows.runs").map((item) => evidenceRow(item, "goal", "status"))} empty="No workflows loaded." />
                  <EvidenceCard title="Runtime events" rows={arrayPath(evidence, "events.events").map((item) => evidenceRow(item, "message", "level"))} empty="No runtime events loaded." />
                </div>
              </StagePanel>
            ) : null}
          </div>
        </div>

        <aside className="min-w-0 space-y-4">
          <StagePanel title="Run brief" description="The current run setup stays visible while you move through stages.">
            <div className="space-y-3">
              <SummaryRow label="Mode" value={mode} />
              <SummaryRow label="Approval" value={approvalRequired ? "required" : "not required"} />
              <SummaryRow label="Context" value={`${contextResults.length} items`} />
              <SummaryRow label="Plan nodes" value={`${planNodes.length}`} />
              <SummaryRow
                label="Workspace queue"
                value={`${approvalItems.length} pending`}
              />
            </div>
          </StagePanel>

          <StagePanel title="Goal" description="Keep the active objective short enough to inspect.">
            <p className="text-sm leading-6 text-muted">{goal}</p>
          </StagePanel>

          <StagePanel title="Related workspaces" description="Subsystem controls live in their own pages.">
            <div className="grid gap-2">
              <WorkspaceLink href="/app/results" label="Results" icon={FileText} />
              <WorkspaceLink href="/app/memory" label="Knowledge" icon={Brain} />
              <WorkspaceLink href="/app/workflows" label="Workflows" icon={Workflow} />
              <WorkspaceLink href="/app/tools" label="Tools" icon={ShieldCheck} />
              <WorkspaceLink href="/app/observability" label="Monitoring" icon={Layers3} />
            </div>
          </StagePanel>
        </aside>
      </section>
    </div>
  );
}

function RunMap({
  activeTab,
  onStage,
  contextReady,
  planReady,
  executionStarted,
  approvalCount,
  resultReady,
}: {
  activeTab: TabKey;
  onStage: (key: TabKey) => void;
  contextReady: boolean;
  planReady: boolean;
  executionStarted: boolean;
  approvalCount: number;
  resultReady: boolean;
}) {
  return (
    <section className="mt-4 rounded-lg border border-primary/30 bg-surface p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Run map</p>
          <h2 className="mt-1 text-lg font-semibold">Move left to right. Results are the end.</h2>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-muted">
          Do not judge the work from the middle of the page. A run is complete only when the result is visible or the blocker is resolved.
        </p>
      </div>
      <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3 2xl:grid-cols-6">
        {runMapSteps.map((item) => {
          const state = runMapState(item.key, {
            activeTab,
            contextReady,
            planReady,
            executionStarted,
            approvalCount,
            resultReady,
          });
          return (
            <RunMapStep
              key={item.key}
              item={item}
              state={state}
              selected={item.key === activeTab || (item.key === "results" && activeTab === "evidence")}
              onStage={onStage}
            />
          );
        })}
      </div>
    </section>
  );
}

function RunMapStep({
  item,
  state,
  selected,
  onStage,
}: {
  item: (typeof runMapSteps)[number];
  state: { tone: Tone; label: string };
  selected: boolean;
  onStage: (key: TabKey) => void;
}) {
  const Icon = item.icon;
  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="grid size-9 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-ink">{item.step}</span>
        <span className={clsx("rounded-md px-2 py-1 font-mono text-[11px]", pillTone(state.tone))}>{state.label}</span>
      </div>
      <Icon size={17} className="mt-5 text-primary" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold">{item.title}</p>
      <p className="mt-2 text-xs leading-5 text-muted">{item.body}</p>
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{item.label}</p>
    </>
  );

  if ("href" in item && item.href) {
    return (
      <Link
        href={item.href}
        className={clsx(
          "group min-h-44 bg-background p-4 text-left transition hover:bg-surface-raised",
          selected && "ring-2 ring-inset ring-primary",
        )}
      >
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onStage(item.key as TabKey)}
      aria-pressed={selected}
      className={clsx(
        "group min-h-44 bg-background p-4 text-left transition hover:bg-surface-raised",
        selected && "ring-2 ring-inset ring-primary",
      )}
    >
      {body}
    </button>
  );
}

function runMapState(
  key: (typeof runMapSteps)[number]["key"],
  state: {
    activeTab: TabKey;
    contextReady: boolean;
    planReady: boolean;
    executionStarted: boolean;
    approvalCount: number;
    resultReady: boolean;
  },
): { tone: Tone; label: string } {
  if (key === "goal") {
    return state.activeTab === "goal" ? { tone: "warning", label: "active" } : { tone: "success", label: "ready" };
  }
  if (key === "context") {
    if (state.contextReady) {
      return { tone: "success", label: "built" };
    }
    return state.activeTab === "context" ? { tone: "warning", label: "active" } : { tone: "neutral", label: "next" };
  }
  if (key === "plan") {
    if (state.planReady) {
      return { tone: "success", label: "ready" };
    }
    return state.activeTab === "plan" ? { tone: "warning", label: "active" } : { tone: "neutral", label: "pending" };
  }
  if (key === "execute") {
    if (state.executionStarted) {
      return { tone: "success", label: "started" };
    }
    return state.activeTab === "execute" ? { tone: "warning", label: "active" } : { tone: "neutral", label: "pending" };
  }
  if (key === "approvals") {
    if (state.approvalCount > 0) {
      return { tone: "warning", label: "blocked" };
    }
    return state.executionStarted ? { tone: "success", label: "clear" } : { tone: "neutral", label: "if needed" };
  }
  if (state.resultReady) {
    return { tone: "success", label: "available" };
  }
  return state.activeTab === "evidence" ? { tone: "warning", label: "review" } : { tone: "neutral", label: "last" };
}

function GoalStage({
  goal,
  mode,
  approvalRequired,
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
  onContext,
  onPlan,
  onAgent,
  onWorkflow,
}: {
  goal: string;
  mode: AgentMode;
  approvalRequired: boolean;
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
  onContext: () => void;
  onPlan: () => void;
  onAgent: () => void;
  onWorkflow: () => void;
}) {
  const goalMissing = !goal.trim();
  const draftLocked = Boolean(loading) || workflowInProgress;
  return (
    <StagePanel title="Compose goal" description="Start with intent, mode, and approval posture. Then move left to right: context, plan, execute, results.">
      <label className="block text-sm font-semibold">
        Goal
        <textarea
          value={goal}
          onChange={(event) => onGoalChange(event.currentTarget.value)}
          rows={7}
          required
          disabled={draftLocked}
          aria-describedby="run-goal-help"
          className="mt-2 w-full rounded-md border border-line bg-background px-3 py-3 text-sm leading-6 outline-none transition focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span id="run-goal-help" className="mt-2 block text-xs font-normal leading-5 text-muted">
          {workflowInProgress
            ? "This draft is locked while its workflow is active."
            : "Describe the outcome, constraints, and evidence you expect. Do not include secrets."}
        </span>
      </label>
      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p className="text-sm font-semibold">Mode</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            {(["orchestrate", "research", "execute", "learn"] as AgentMode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onModeChange(item)}
                disabled={draftLocked}
                aria-pressed={mode === item}
                className={clsx(
                  "min-h-11 rounded-md border px-3 text-sm font-semibold capitalize transition disabled:cursor-not-allowed disabled:opacity-60",
                  mode === item ? "border-primary bg-primary text-primary-ink" : "border-line bg-background text-muted hover:bg-surface-raised hover:text-foreground",
                )}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line bg-background px-3 text-sm">
          <span>Approval gate</span>
          <input
            type="checkbox"
            checked={approvalRequired}
            disabled={draftLocked}
            onChange={(event) => onApprovalChange(event.currentTarget.checked)}
            className="size-4 accent-[var(--primary)]"
          />
        </label>
      </div>
      <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <button
          type="button"
          onClick={onContext}
          disabled={Boolean(loading) || goalMissing || Boolean(readDisabledReason)}
          title={goalMissing ? "Enter a goal first." : readDisabledReason}
          className="action-button"
        >
          {loading === "context" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Brain size={14} aria-hidden="true" />}
          Build context
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
          {loading === "plan" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
          Preview plan
        </button>
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
            goalMissing
              ? "Enter a goal first."
              : workflowDisabledReason ||
                (workflowStarted
                  ? "Generate a new plan before starting another workflow."
                  : !workflowReady
                    ? "Preview and review a plan first."
                    : undefined)
          }
          className="action-button"
        >
          {loading === "workflow" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Workflow size={14} aria-hidden="true" />}
          {workflowStarted
            ? "Workflow started"
            : workflowReady
              ? "Start reviewed plan"
              : "Review plan first"}
        </button>
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
              ? "Enter a goal first."
              : runDisabledReason ||
                (workflowInProgress
                  ? "Wait for the active workflow to finish or cancel it first."
                  : undefined)
          }
          className="primary-button"
        >
          {loading === "agent" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          Run agent
        </button>
      </div>
      <div className="mt-5 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
        {starterGoals.map((starter) => (
          <button
            key={starter}
            type="button"
            onClick={() => onGoalChange(starter)}
            disabled={draftLocked}
            aria-pressed={goal === starter}
            className={clsx(
              "min-h-11 bg-background p-4 text-left text-sm leading-6 transition hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
              goal === starter ? "text-foreground ring-2 ring-inset ring-primary" : "text-muted",
            )}
          >
            {starter}
          </button>
        ))}
      </div>
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-background px-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

function WorkspaceLink({ href, label, icon: Icon }: { href: string; label: string; icon: typeof TerminalSquare }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-md border border-line bg-background px-3 py-2 text-sm font-semibold transition hover:bg-surface-raised">
      <span className="inline-flex items-center gap-2">
        <Icon size={15} className="text-primary" aria-hidden="true" />
        {label}
      </span>
      <ArrowRight size={14} className="text-muted" aria-hidden="true" />
    </Link>
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

function sessionRole(session: JsonRecord) {
  return stringValue(readPath(session, "context.role") || readPath(session, "membership.role"), "viewer");
}

function hasRole(role: string, allowed: string[]) {
  return allowed.includes(role);
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
  if (event.type === "tool") {
    const name = event.toolName || event.toolId || "Tool";
    if (event.status === "running") {
      return `${name} is running (risk ${event.riskLevel ?? "?"}).`;
    }
    if (event.status === "executed") {
      return `${name} executed.`;
    }
    if (event.status === "dry_run") {
      return `${name} was previewed only, with no side effects. Approve it from Inbox to run for real.`;
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
  if (event.type === "error") {
    return event.message || "Agent run failed.";
  }
  return "Event received.";
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
