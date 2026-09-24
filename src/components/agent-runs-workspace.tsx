"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  Film,
  GitBranch,
  Globe2,
  History,
  ImageIcon,
  Loader2,
  Map as MapIcon,
  MessageSquareText,
  MessagesSquare,
  Pause,
  Pencil,
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
import { startVisibleRefresh } from "@/lib/client/visible-refresh";
import {
  PrivateMediaPreview,
  type PrivateMediaReadiness,
  privateCaptureAssetContentUrl,
} from "@/components/media/private-media-preview";
import { VoiceMode } from "@/components/voice/voice-mode";
import {
  CommandComposerField,
  type CommandSlashAction,
} from "@/components/command/command-composer-field";
import { CommandModelPicker } from "@/components/command/command-model-picker";
import { AsaelLottieMascot } from "@/components/mascot/asael-lottie-mascot";
import workspaceStyles from "@/components/agent-runs-workspace.module.css";
import { arsenalAgents } from "@/lib/agents/arsenal";
import type { ContextScopeId } from "@/lib/rag/context-scope";
import {
  StreamingPcmPlayer,
  streamVersionedSpeech,
} from "@/lib/voice/pcm-player";
import {
  parseVoiceApprovalEvidence,
  type VoiceApprovalEvidence,
  type VoiceCommandReply,
  type VoiceCommandReview,
} from "@/lib/voice/command-review";
import {
  canonicalClientAgentMode,
  projectClientThreadSummaries,
  projectClientThreadTurns,
  type ClientAgentMode,
} from "@/lib/command/client-projection";
import { startProgressiveThreadLoad } from "@/lib/command/progressive-thread-load";
import type {
  CommandContextCatalogItem,
  CommandContextReference,
} from "@/lib/command/composer-context-contract";
import type { CommandModelSelectionRequest } from "@/lib/models/command-selection";
import { modelAssignmentScopeForAgent } from "@/lib/orchestration/computer-use-routing";
import type { ModelAssignmentScope } from "@/lib/settings/types";
import {
  commandArtifactContentUrl,
  projectCommandFileArtifactState,
  projectCommandFileArtifacts,
  type CommandFileArtifact,
  type CommandFileArtifactState,
} from "@/lib/command/artifact-projection";
import {
  extractLegacyCommandMedia,
  mergeCommandMediaArtifacts,
  projectCommandMediaArtifacts,
  type CommandMediaArtifact,
} from "@/lib/command/media-projection";
import {
  commandWorkspaceArtifactUrl,
  projectCommandWorkspaceArtifactState,
  projectCommandWorkspaceArtifacts,
  type CommandWorkspaceArtifact,
  type CommandWorkspaceArtifactState,
} from "@/lib/command/workspace-artifact-projection";

const ConversationCanvas = dynamic(
  () => import("@/components/conversation-canvas").then((module) =>
    module.ConversationCanvas
  ),
  {
    loading: () => (
      <div className="grid min-h-[25rem] place-items-center text-sm text-muted">
        Loading conversation map…
      </div>
    ),
  },
);

const ConversationProgressPanel = dynamic(
  () => import("@/components/conversation-progress-panel").then((module) =>
    module.ConversationProgressPanel
  ),
  {
    loading: () => (
      <div className="grid min-h-32 place-items-center text-sm text-muted">
        Loading activity…
      </div>
    ),
  },
);

type JsonRecord = Record<string, unknown>;
type ThreadSummary = { id: string; title: string; updatedAt: string; mode: AgentMode };
type CommandProject = { id: string; title: string; status: string };
type ThreadTurn = { id: string; role: "user" | "assistant"; content: string; createdAt: string; runId?: string };
type AgentMode = ClientAgentMode;
type AgentId = string;
type AgentPresentation = {
  id: AgentId;
  name: string;
  role: string;
  voice: string;
  visualIdentity: string;
  accent: "emerald" | "blue" | "amber" | "violet" | "rose";
};
type ActiveContextScopeId = Extract<
  ContextScopeId,
  "none" | "current_turn" | "session" | "agent_private" | "mission" | "project" | "workspace" | "personal" | "explicit_selection"
>;
type PersonalContextConsentView = {
  state: "inactive" | "active";
  notice: { text: string; sha256: string };
};
type PromptQueueItem = {
  id: string;
  clientCorrelationId: string;
  prompt: string;
  promptSha256: string;
  mode: AgentMode;
  strategy: "direct" | "auto";
  target: {
    threadId: string | null;
    missionId: string | null;
    projectId: string | null;
    executionTarget: "asael" | "local_macos";
  };
  agent: {
    logicalAgentId: string;
    definitionVersion: number;
    definitionVersionId: string;
  };
  model: {
    providerId: "openai" | "google" | "anthropic" | "aws_bedrock";
    modelId: string;
    tier: "fast" | "reasoning";
    reasoningLevel?: string;
  };
  contextReferenceCount: number;
  state: "queued" | "paused" | "dispatching" | "completed" | "failed";
  position: number;
  lifecycleRevision: number;
  runId: string | null;
  resultThreadId: string | null;
  progressLabel: string | null;
  failureCode: string | null;
  updatedAt: string;
  queueGrantsAuthority: false;
};

const CONTEXT_SCOPE_OPTIONS: readonly Readonly<{
  id: ContextScopeId;
  label: string;
  description: string;
}>[] = [
  {
    id: "explicit_selection",
    label: "Reviewed saved context",
    description: "Use only the saved items you review and keep selected.",
  },
  {
    id: "agent_private",
    label: "This agent's memory",
    description: "Use only memory owned by you and the assigned agent.",
  },
  {
    id: "project",
    label: "Selected project",
    description: "Use durable knowledge shared within one selected project.",
  },
  {
    id: "workspace",
    label: "Selected workspace",
    description: "Use durable knowledge shared within the selected workspace.",
  },
  {
    id: "session",
    label: "Conversation only",
    description: "Use this conversation without saved memory or knowledge.",
  },
  {
    id: "current_turn",
    label: "Current message only",
    description: "Exclude earlier turns and all saved context.",
  },
  {
    id: "none",
    label: "No extra context",
    description: "Use only this task and governing instructions.",
  },
  {
    id: "personal",
    label: "Personal automatic",
    description:
      "Automatically select relevant owner-private memory under your active consent.",
  },
  {
    id: "mission",
    label: "Attached mission",
    description:
      "Use shared knowledge from the attached Mission's canonical Project membership.",
  },
];

function contextScopeOption(scopeId: ContextScopeId) {
  return CONTEXT_SCOPE_OPTIONS.find((option) => option.id === scopeId) ||
    CONTEXT_SCOPE_OPTIONS[0];
}
type ClaimSupportState =
  | "supported"
  | "inferred"
  | "disputed"
  | "stale"
  | "unsupported";
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
  claimEvidence?: {
    schemaVersion: 1;
    claimEvidenceMapId: string;
    evaluatedAt: string;
    coverage: {
      materialClaimCount: number;
      supportedMaterialClaimCount: number;
      coverageBps: number | null;
    };
    claims: Array<{
      claimId: string;
      startUtf16: number;
      endUtf16Exclusive: number;
      materiality: "material" | "non_material";
      supportState: ClaimSupportState;
      supportReason: string;
      evidenceUnitIds: string[];
    }>;
  };
};
type RunFeedback = {
  verdict: "useful" | "needs_work";
  correction?: string;
  updatedAt: string;
};
type ContextLockState = {
  selection: {
    query: string;
    evidenceIds: string[];
    lockToken: string;
  };
  receipt: {
    lockId: string;
    selectionSha256: string;
    issuedAt: string;
    expiresAt: string;
  };
};
type ContextUseReceipt = {
  receiptSha256: string;
  selectionSha256: string;
  candidateEvidenceIds: string[];
  userInclusionIds: string[];
  userExclusionIds: string[];
  actualEvidenceIds: string[];
  droppedEvidenceIds: string[];
  candidateCount: number;
  includedCount: number;
  excludedCount: number;
  actualCount: number;
  droppedCount: number;
  recordedAt: string;
};
type TrajectoryCheckpoint = {
  checkpointId: string;
  checkpointSha256: string;
  sequence: number;
  boundaryKind: "model" | "tool" | "approval" | "delegation" | "verifier";
  boundaryPhase: "before" | "waiting" | "after";
  boundaryAttempt: number;
  lifecycleState: "active" | "waiting" | "terminal";
  resumeDisposition: "resumable" | "awaiting_signal" | "not_resumable";
  recordedAt: string;
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
type TraceStageStatus = "observed" | "pending" | "missing" | "not_applicable";
type RunTraceStage = {
  id: "intent" | "plan" | "agent" | "model" | "tool" | "evidence" | "effect" | "verification" | "memory";
  label: string;
  ordinal: number;
  required: boolean;
  status: TraceStageStatus;
  eventCount: number;
  events: Array<{
    eventRef: string;
    parentEventRef?: string;
    causationRef?: string;
    streamKind: string;
    type: string;
    seq: number;
    at: string;
    summary: string;
  }>;
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
      contextDecision: "disabled_session" | "disabled_project_unavailable" | "excluded_by_user" | "selected_by_user" | "retrieved" | "skipped";
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
      budgetLimits: {
        modelTurns: number;
        tokens: number;
        costMicrousd: number;
        wallTimeMs: number;
        toolCalls: number;
        browserActions: number;
        agents: number;
        fanOut: number;
        retries: number;
        replans: number;
      };
      approvalPolicy: "always" | "risk_based" | "read_only";
      autonomy: "assist" | "governed" | "execute";
      learningState?: "cold_start" | "observing" | "reinforced" | "supported";
      learningSampleSize?: number;
      learningGuidanceCount?: number;
      adaptationState?: "baseline" | "evidence_ready" | "active";
      adaptationEvidenceCount?: number;
      adaptationConfidence?: number;
      adaptationActivationVersions?: number[];
    }
  | { type: "memory"; title?: string; count?: number }
  | { type: "model"; model: string; provider?: "openai" | "google" | "anthropic" | "aws_bedrock" | "local"; tier: "fast" | "reasoning"; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; latencyMs: number; fallbackUsed: boolean; estimatedCostUsd?: number; costKnown?: boolean; iteration?: number; iterationCount?: number; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; commandSelectionSha256?: string }
  | { type: "council_member"; agentId: AgentId; agentName: string; role: string; status: "thinking" | "completed" | "failed"; summary?: string; confidence?: number; durationMs?: number; taskId?: string; delegationId?: string; lifecycleState?: "proposed" | "accepted" | "working" | "waiting" | "challenged" | "completed_proposed" | "result_accepted" | "rejected" | "canceled" | "expired"; lifecycleRevision?: number }
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
      executionId?: string;
    }
  | { type: "waiting_approval"; executionId?: string; toolId?: string; message?: string }
  | { type: "budget_exhausted"; dimension?: string; limit?: number; attempted?: number; requiresAuthorization?: true; message?: string }
  | { type: "done"; response?: string; grounding?: GroundingReport }
  | { type: "delegated"; threadId?: string; workflowId?: string; missionId?: string; acknowledgement?: string; reason?: string }
  | { type: "clarification"; runId?: string; threadId?: string; message?: string; reasonCode?: "ambiguous_destructive_target" | "ambiguous_known_procedure" | "ambiguous_read_target" }
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
  initialRunId,
  initialThreadId,
  initialMissionId,
  initialProjectId,
  initialContextScope,
  initialGoal,
}: {
  initialAgentId?: AgentId;
  initialRunId?: string;
  initialThreadId?: string;
  initialMissionId?: string;
  initialProjectId?: string;
  initialContextScope?: Extract<ActiveContextScopeId, "mission" | "project" | "workspace">;
  initialGoal?: string;
}) {
  const {
    session,
    status: sessionStatus,
    role,
  } = useWorkspaceSession();
  const [goal, setGoal] = useState(initialGoal || "");
  const [mode, setMode] = useState<AgentMode>("orchestrate");
  const initialBuiltInAgent = initialAgentId
    ? builtInAgentPresentation(initialAgentId)
    : undefined;
  const [preferredAgent, setPreferredAgent] = useState<AgentPresentation | undefined>(
    initialBuiltInAgent,
  );
  const [commandReferences, setCommandReferences] = useState<CommandContextCatalogItem[]>(
    initialBuiltInAgent
      ? [{
          kind: "agent",
          id: initialBuiltInAgent.id,
          label: initialBuiltInAgent.name,
          description: initialBuiltInAgent.role,
          state: "ready",
          selectable: true,
        }]
      : [],
  );
  const [commandModelSelection, setCommandModelSelection] =
    useState<CommandModelSelectionRequest>();
  const preferredAgentId = preferredAgent?.id;
  const activeAssistantName = preferredAgent?.name || "Asael";
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("context");
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const [contextPack, setContextPack] = useState<JsonRecord>();
  const [contextScope, setContextScope] = useState<ActiveContextScopeId>(
    initialContextScope || "session",
  );
  const [projects, setProjects] = useState<CommandProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialProjectId || "",
  );
  const [contextQuery, setContextQuery] = useState("");
  const [selectedContextIds, setSelectedContextIds] = useState<string[]>([]);
  const [contextPreviewToken, setContextPreviewToken] = useState("");
  const [contextLock, setContextLock] = useState<ContextLockState>();
  const [contextLocking, setContextLocking] = useState(false);
  const [contextUseReceipt, setContextUseReceipt] = useState<ContextUseReceipt>();
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string>();
  const [personalContextConsent, setPersonalContextConsent] =
    useState<PersonalContextConsentView>();
  const [personalContextConsentState, setPersonalContextConsentState] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [personalContextConsentError, setPersonalContextConsentError] =
    useState<string>();
  const [personalContextConsentUpdating, setPersonalContextConsentUpdating] =
    useState(false);
  const [workflowPlan, setWorkflowPlan] = useState<JsonRecord>();
  const [workflowRun, setWorkflowRun] = useState<JsonRecord>();
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [agentResponse, setAgentResponse] = useState("");
  const [runMediaProjection, setRunMediaProjection] = useState<{
    runId: string;
    artifacts: CommandMediaArtifact[];
    files: CommandFileArtifact[];
    fileState: CommandFileArtifactState;
    workspaceArtifacts: CommandWorkspaceArtifact[];
    workspaceArtifactState: CommandWorkspaceArtifactState;
  }>({
    runId: "",
    artifacts: [],
    files: [],
    fileState: "none",
    workspaceArtifacts: [],
    workspaceArtifactState: "none",
  });
  const [grounding, setGrounding] = useState<GroundingReport>();
  const [activeAgentRunId, setActiveAgentRunId] = useState("");
  const [runFeedback, setRunFeedback] = useState<RunFeedback>();
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);
  const [evidence, setEvidence] = useState<JsonRecord>({});
  const [evidenceState, setEvidenceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [workflowSyncError, setWorkflowSyncError] = useState<string>();
  const [runAnnouncement, setRunAnnouncement] = useState("Run workspace ready.");
  const [waitingApproval, setWaitingApproval] = useState<Extract<StreamEvent, { type: "waiting_approval" }>>();
  const [clarificationRunId, setClarificationRunId] = useState("");
  const [threadId, setThreadId] = useState(initialThreadId || "");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [promptQueue, setPromptQueue] = useState<PromptQueueItem[]>([]);
  const [promptQueueBusyId, setPromptQueueBusyId] = useState("");
  const [promptQueueError, setPromptQueueError] = useState<string>();
  const [conversationView, setConversationView] = useState<"chat" | "map">("chat");
  const [conversationCanvas, setConversationCanvas] = useState<unknown>();
  const [conversationCanvasState, setConversationCanvasState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [conversationCanvasError, setConversationCanvasError] = useState<string>();
  const [conversationsCollapsed, setConversationsCollapsed] = useState(false);
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  const [conversationMemories, setConversationMemories] = useState<ConversationMemory[]>([]);
  const [memoryState, setMemoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [memoryError, setMemoryError] = useState<string>();
  const [forgettingMemoryId, setForgettingMemoryId] = useState("");
  const [confirmForgetMemoryId, setConfirmForgetMemoryId] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedActivityRunId, setSelectedActivityRunId] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const contextControllerRef = useRef<AbortController | null>(null);
  const contextVersionRef = useRef(0);
  const contextSelectionReviewedRef = useRef(false);
  const evidenceControllerRef = useRef<AbortController | null>(null);
  const evidenceVersionRef = useRef(0);
  const evidenceVisibleRef = useRef(false);
  const memoryControllerRef = useRef<AbortController | null>(null);
  const memoryVersionRef = useRef(0);
  const conversationCanvasControllerRef = useRef<AbortController | null>(null);
  const threadLoadControllerRef = useRef<AbortController | null>(null);
  const threadLoadVersionRef = useRef(0);
  const pendingDeltasRef = useRef<string[]>([]);
  const deltaFlushTimerRef = useRef<number | null>(null);
  const initialThreadLoadedRef = useRef(false);
  const initialRunLoadedRef = useRef(false);
  const responseSpeechControllerRef = useRef<AbortController | null>(null);
  const responseSpeechPlayerRef = useRef<StreamingPcmPlayer | null>(null);
  const agentRequestIdRef = useRef<string>("");
  const directRunStatusRef = useRef("");
  const currentRunIdRef = useRef("");
  const detailsDialogRef = useRef<HTMLElement | null>(null);
  const detailsReturnFocusRef = useRef<HTMLElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptPinnedRef = useRef(true);
  const conversationsButtonRef = useRef<HTMLButtonElement | null>(null);
  const conversationsSheetRef = useRef<HTMLElement | null>(null);
  const promptQueueDrainRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const threadsRefreshRef = useRef<Promise<void> | null>(null);
  const threadsRefreshQueuedRef = useRef(false);
  const runProjectionControllerRef = useRef<AbortController | null>(null);

  const refreshPromptQueue = useCallback(async (signal?: AbortSignal) => {
    const payload = await readJson("/api/command/prompt-queue", {
      cache: "no-store",
      signal,
    });
    const items = promptQueueItemsFromPayload(payload);
    setPromptQueue(items);
    setPromptQueueError(undefined);
    return items;
  }, []);

  useEffect(() => {
    if (sessionStatus !== "ready") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void refreshPromptQueue(controller.signal).catch((queueError: unknown) => {
        if (!controller.signal.aborted) {
          setPromptQueueError(refreshMessage(queueError));
        }
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refreshPromptQueue, sessionStatus]);

  useEffect(() => {
    if (
      sessionStatus !== "ready" ||
      !promptQueue.some((item) => item.state === "dispatching")
    ) return;
    return startVisibleRefresh({
      onRefresh: async () => {
        await refreshPromptQueue();
      },
      pollIntervalMs: 2_500,
    });
  }, [promptQueue, refreshPromptQueue, sessionStatus]);

  useEffect(() => {
    const controller = new AbortController();
    let stateTimer: number | undefined;
    if (!initialAgentId) {
      stateTimer = window.setTimeout(() => {
        setPreferredAgent(undefined);
      }, 0);
      return () => window.clearTimeout(stateTimer);
    }
    const builtIn = builtInAgentPresentation(initialAgentId);
    if (builtIn) {
      stateTimer = window.setTimeout(() => {
        setPreferredAgent(builtIn);
      }, 0);
      return () => window.clearTimeout(stateTimer);
    }
    stateTimer = window.setTimeout(() => {
      setPreferredAgent(undefined);
    }, 0);
    void readJson(`/api/agents/${encodeURIComponent(initialAgentId)}`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const agent = asRecord(asRecord(payload).agent);
        if (agent.selectable !== true || stringValue(agent.id) !== initialAgentId) return;
        setPreferredAgent(agentPresentationFromApi(agent));
      })
      .catch(() => undefined);
    return () => {
      window.clearTimeout(stateTimer);
      controller.abort();
    };
  }, [initialAgentId]);

  useEffect(() => {
    const projectsNeeded = Boolean(
      initialProjectId ||
      contextScope === "project" ||
      contextScope === "workspace"
    );
    if (
      sessionStatus !== "ready" ||
      !projectsNeeded ||
      projectsLoadedRef.current
    ) return;
    const controller = new AbortController();
    void readJson("/api/projects", { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const rows = arrayPath(asRecord(payload), "projects")
          .map((value) => asRecord(value))
          .map((value) => ({
            id: stringValue(value.id),
            title: stringValue(value.title),
            status: stringValue(value.status),
          }))
          .filter((value) => value.id && value.title && value.status !== "archived");
        projectsLoadedRef.current = true;
        setProjects(rows);
        setSelectedProjectId((current) =>
          current && rows.some((project) => project.id === current)
            ? current
            : initialProjectId && rows.some((project) => project.id === initialProjectId)
              ? initialProjectId
              : contextScope === "project"
                ? rows[0]?.id || ""
                : ""
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [contextScope, initialProjectId, sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== "ready") return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setPersonalContextConsentState("loading");
        setPersonalContextConsentError(undefined);
      }
    });
    void readJson("/api/memory/personal-context-consent", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setPersonalContextConsent(personalContextConsentView(payload));
        setPersonalContextConsentState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPersonalContextConsentState("error");
        setPersonalContextConsentError(refreshMessage(error));
      });
    return () => controller.abort();
  }, [sessionStatus]);

  const planNodes = arrayPath(workflowPlan, "plan.plan.nodes");
  const contextResults = arrayPath(contextPack, "pack.results");
  const contextResultIds = contextResults
    .map(contextEvidenceId)
    .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index);
  const normalizedGoal = goal.trim();
  const contextPreparedForGoal = Boolean(
    normalizedGoal && (
      contextScope !== "explicit_selection" ||
      (contextQuery === normalizedGoal && !contextLoading)
    ),
  );
  const contextLockedForGoal = Boolean(
    contextScope !== "explicit_selection" ||
    (
      contextLock?.selection.query === normalizedGoal &&
      sameOrderedStringValues(
        contextLock.selection.evidenceIds,
        selectedContextIds,
      )
    ),
  );
  const approvalItems = arrayPath(evidence, "approvals.items");
  const runRows = arrayPath(evidence, "runs.runs");
  const agentRunCompleted = streamEvents.some((event) => event.type === "done");
  const agentRunTerminal = streamEvents.some((event) => ["done", "error", "canceled"].includes(event.type));
  const reviewedPlanId = stringPath(workflowPlan, "plan.id", "");
  const reviewedPlanStatus = stringPath(workflowPlan, "plan.status", "");
  const reviewedPlanContextCount = numberValue(
    readPath(workflowPlan, "plan.commandContextBoundary.referenceCount"),
    0,
  );
  const reviewedPlanModelScope = stringPath(
    workflowPlan,
    "plan.commandModelBoundary.assignmentScope",
    "",
  );
  const reviewedPlanReady = Boolean(
    reviewedPlanId && reviewedPlanStatus === "planned",
  );
  const readPermission = permissionMessage(session, sessionStatus, "read");
  const runPermission = permissionMessage(session, sessionStatus, "run.agent");
  const voicePermission = permissionMessage(session, sessionStatus, "write.memory");
  const personalContextActive = personalContextConsent?.state === "active";
  const workflowPermission = permissionMessage(session, sessionStatus, "manage.workflow");
  const workflowActionPermission = workflowPermission;
  const activeWorkflowId = stringPath(workflowRun, "run.id", "");
  const activeWorkflowStatus = stringPath(workflowRun, "run.status", "");
  const workflowInProgress = Boolean(
    activeWorkflowId &&
      !["completed", "failed", "canceled"].includes(activeWorkflowStatus),
  );
  const directRunInProgress = Boolean(
    loading === "agent" ||
      waitingApproval ||
      (activeAgentRunId && !agentRunTerminal && !clarificationRunId),
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
    if (clarificationRunId) {
      return { label: "Clarification needed", tone: "warning" as const };
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
    clarificationRunId,
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
      void refreshThreads();
      if (initialThreadId && !initialThreadLoadedRef.current) {
        initialThreadLoadedRef.current = true;
        void loadThread(initialThreadId);
      } else if (initialRunId && !initialRunLoadedRef.current) {
        initialRunLoadedRef.current = true;
        void loadRunActivity(initialRunId);
      }
    }
    return () => {
      abortControllerRef.current?.abort();
      contextControllerRef.current?.abort();
      evidenceControllerRef.current?.abort();
      memoryControllerRef.current?.abort();
      conversationCanvasControllerRef.current?.abort();
      threadLoadControllerRef.current?.abort();
      runProjectionControllerRef.current?.abort();
      if (deltaFlushTimerRef.current !== null) {
        window.clearTimeout(deltaFlushTimerRef.current);
      }
      responseSpeechControllerRef.current?.abort();
      responseSpeechPlayerRef.current?.stop();
    };
    // Session changes are the only automatic evidence refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, role]);

  useEffect(() => {
    const visible = Boolean(
      detailsOpen &&
      activeTab === "evidence" &&
      sessionStatus === "ready" &&
      !readPermission
    );
    evidenceVisibleRef.current = visible;
    if (!visible) return;
    void refreshEvidence();
    return () => {
      evidenceVisibleRef.current = false;
      evidenceControllerRef.current?.abort();
    };
    // Evidence is an optional details projection and loads only while visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, detailsOpen, readPermission, sessionStatus]);

  useEffect(() => {
    if (conversationView !== "map" || sessionStatus !== "ready" || readPermission) return;
    void refreshConversationCanvas(threadId);
    return () => conversationCanvasControllerRef.current?.abort();
    // The selected Conversation and view own this bounded read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationView, threadId, sessionStatus, readPermission]);

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
    let controller: AbortController | undefined;
    const stopRefresh = startVisibleRefresh({
      refreshOnStart: !activeWorkflowStatus,
      pollIntervalMs: 3_000,
      onRefresh: async () => {
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
        }
      },
    });
    return () => {
      disposed = true;
      controller?.abort();
      stopRefresh();
    };
    // Run identity and status control the polling lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkflowId, activeWorkflowStatus]);

  useEffect(() => {
    if (!activeAgentRunId || loading === "agent" || agentRunTerminal) return;
    let disposed = false;
    let controller: AbortController | undefined;
    const stopRefresh = startVisibleRefresh({
      refreshOnStart: false,
      pollIntervalMs: 3_000,
      onRefresh: async () => {
        controller = new AbortController();
        try {
          const payload = asRecord(await readJson(`/api/runs/${encodeURIComponent(activeAgentRunId)}`, { signal: controller.signal }));
          if (disposed) return;
          setRunMediaProjection({
            runId: activeAgentRunId,
            artifacts: projectCommandMediaArtifacts(payload),
            files: projectCommandFileArtifacts(payload),
            fileState: projectCommandFileArtifactState(payload),
            workspaceArtifacts: projectCommandWorkspaceArtifacts(payload),
            workspaceArtifactState: projectCommandWorkspaceArtifactState(payload),
          });
          setContextUseReceipt(contextUseReceiptFromPayload(payload));
          const run = asRecord(payload.run);
          const status = stringValue(run.status);
          const statusChanged = Boolean(status && status !== directRunStatusRef.current);
          if (status) directRunStatusRef.current = status;
          if (status === "waiting_clarification") {
            const clarification = stringValue(
              run.response,
              "Reply to the clarification request to continue this run.",
            );
            setWaitingApproval(undefined);
            setClarificationRunId(activeAgentRunId);
            setAgentResponse(clarification);
            setStreamEvents((current) => current.some((event) =>
              event.type === "clarification" && event.runId === activeAgentRunId
            ) ? current : [...current, {
              type: "clarification",
              runId: activeAgentRunId,
              threadId: stringValue(run.threadId) || threadId || undefined,
              message: clarification,
              reasonCode: "ambiguous_read_target",
            }]);
            if (statusChanged) setRunAnnouncement("Agent run is waiting for clarification.");
          } else if (status === "waiting_approval") {
            const approval = asRecord(run.waitingApproval);
            setClarificationRunId("");
            setWaitingApproval({
              type: "waiting_approval",
              executionId: stringValue(approval.executionId),
              toolId: stringValue(approval.toolId),
              message: `${stringValue(approval.toolName, "A gated action")} needs approval before the task can continue.`,
            });
            if (statusChanged) setRunAnnouncement("Agent run is waiting for approval.");
          } else if (status === "running" || status === "resuming" || status === "queued") {
            setWaitingApproval(undefined);
            setClarificationRunId("");
            if (statusChanged) {
              setRunAnnouncement(status === "resuming" ? "Approved. The task is resuming." : `Agent run is ${status}.`);
            }
          } else if (status === "completed") {
            const response = stringValue(run.response);
            const nextGrounding = renderSafeGroundingReport(run.grounding);
            setWaitingApproval(undefined);
            setClarificationRunId("");
            setAgentResponse(response);
            setGrounding(nextGrounding);
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
            setClarificationRunId("");
            setError(message);
            setStreamEvents((current) => [...current, { type: "error", message }]);
            setRunAnnouncement("Agent run failed.");
          } else if (status === "canceled") {
            setWaitingApproval(undefined);
            setClarificationRunId("");
            setStreamEvents((current) => [...current, { type: "canceled", message: "The task was canceled." }]);
            setRunAnnouncement("Agent run canceled.");
          }
        } catch {
          // Keep the visible last-known state and retry while the run remains active.
        }
      },
    });
    return () => {
      disposed = true;
      controller?.abort();
      stopRefresh();
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
      contextScope !== "explicit_selection" ||
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
    contextScope,
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
    const runId = activeAgentRunId;
    if (!controller && !runId) return;
    setRunAnnouncement("Stopping the agent run.");
    controller?.abort();
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
      const feedbackEffects = feedbackResult.feedbackEffects as { affectedMemories?: number; demotedCapabilities?: string[] } | undefined;
      setRunAnnouncement(verdict === "useful"
        ? `Useful outcome recorded. ${feedbackEffects?.affectedMemories || 0} retained memories were reinforced.`
        : `Correction recorded. ${feedbackEffects?.affectedMemories || 0} retained memories were quarantined and ${feedbackEffects?.demotedCapabilities?.length || 0} capability safety profiles were narrowed.`);
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

  async function forkRunFromCheckpoint(
    checkpointId: string,
    correction: string,
    sourceRunIdOverride?: string,
  ) {
    const sourceRunId = sourceRunIdOverride || activeAgentRunId;
    if (!sourceRunId || !correction.trim()) return;
    setLoading("agent");
    setError(undefined);
    setRunAnnouncement("Creating a corrected trace from the selected checkpoint.");
    try {
      const requestId = crypto.randomUUID();
      const payload = asRecord(await readJson(
        `/api/runs/${encodeURIComponent(sourceRunId)}/fork`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": requestId,
          },
          body: JSON.stringify({
            checkpointId,
            correction: correction.trim(),
            requestId,
          }),
        },
      ));
      const run = asRecord(payload.run);
      const runId = stringValue(run.id);
      if (!runId) throw new Error("The corrected trace did not return a run id.");
      const status = stringValue(run.status);
      const response = stringValue(run.response);
      const nextGrounding = run.grounding
        ? renderSafeGroundingReport(run.grounding)
        : undefined;
      currentRunIdRef.current = runId;
      directRunStatusRef.current = status;
      setActiveAgentRunId(runId);
      setSelectedActivityRunId(runId);
      setAgentResponse(response);
      setRunMediaProjection({
        runId,
        artifacts: projectCommandMediaArtifacts(payload),
        files: projectCommandFileArtifacts(payload),
        fileState: projectCommandFileArtifactState(payload),
        workspaceArtifacts: projectCommandWorkspaceArtifacts(payload),
        workspaceArtifactState: projectCommandWorkspaceArtifactState(payload),
      });
      setGrounding(nextGrounding);
      setRunFeedback(undefined);
      setTurns((current) => {
        const next = [
          ...current,
          {
            id: `fork-user-${Date.now()}`,
            role: "user" as const,
            content: correction.trim(),
            createdAt: new Date().toISOString(),
            runId,
          },
        ];
        return response
          ? [...next, {
              id: `fork-assistant-${Date.now()}`,
              role: "assistant" as const,
              content: response,
              createdAt: new Date().toISOString(),
              runId,
            }]
          : next;
      });
      if (status === "completed") {
        setWaitingApproval(undefined);
        setStreamEvents([
          { type: "run", runId },
          { type: "done", response, grounding: nextGrounding },
        ]);
        setRunAnnouncement("Corrected trace completed. The original run remains unchanged.");
      } else if (status === "failed") {
        const message = stringValue(run.error, "The corrected trace failed.");
        setWaitingApproval(undefined);
        setStreamEvents([{ type: "run", runId }, { type: "error", message }]);
        setError(message);
        setRunAnnouncement("The corrected trace failed; the original run remains available.");
      } else if (status === "canceled") {
        setWaitingApproval(undefined);
        setStreamEvents([
          { type: "run", runId },
          { type: "canceled", message: "The corrected trace was canceled." },
        ]);
        setRunAnnouncement("The corrected trace was canceled.");
      } else if (status === "waiting_approval") {
        const approval = asRecord(run.waitingApproval);
        const waiting = {
          type: "waiting_approval" as const,
          executionId: stringValue(approval.executionId),
          toolId: stringValue(approval.toolId),
          message: `${stringValue(approval.toolName, "A gated action")} needs a new approval for this corrected trace.`,
        };
        setWaitingApproval(waiting);
        setStreamEvents([{ type: "run", runId }, waiting]);
        setRunAnnouncement("The corrected trace is waiting for a new approval.");
      } else {
        setWaitingApproval(undefined);
        setStreamEvents([
          { type: "run", runId },
          { type: "status", label: "Corrected trace", detail: `Run is ${status || "queued"}.` },
        ]);
        setRunAnnouncement("The corrected trace is continuing in the background.");
      }
      void refreshEvidence();
      void refreshThreads();
    } catch (forkError) {
      setError(
        forkError instanceof Error
          ? forkError.message
          : "The corrected trace could not be created.",
      );
      setRunAnnouncement("The corrected trace could not be created; the original run was not changed.");
    } finally {
      setLoading(undefined);
    }
  }

  function clearSelectedActivity() {
    setSelectedActivityRunId("");
  }

  function selectTaskDetailsTab(tab: TabKey, activityRunId?: string) {
    setActiveTab(tab);
    if (tab === "memory" && threadId) {
      void refreshConversationMemories(threadId);
    }
    if (tab === "execute") {
      const runId = activityRunId || activeAgentRunId || currentRunIdRef.current || selectedActivityRunId;
      setSelectedActivityRunId(runId);
    }
  }

  function openTaskDetails(tab: TabKey, activityRunId?: string) {
    detailsReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectTaskDetailsTab(tab, activityRunId);
    setDetailsOpen(true);
  }

  function closeTaskDetails() {
    setDetailsOpen(false);
  }

  function clearContextLockState() {
    setContextPreviewToken("");
    setContextLock(undefined);
    setContextLocking(false);
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
    clearContextLockState();
    contextSelectionReviewedRef.current = contextScope !== "explicit_selection";
    setContextLoading(false);
    setContextError(undefined);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function changeContextScope(nextScope: ActiveContextScopeId) {
    if (nextScope === contextScope || workflowInProgress || loading === "agent") {
      return;
    }
    if (nextScope === "personal" && !personalContextActive) {
      setError(
        "Turn on Personal automatic context before selecting this scope.",
      );
      openTaskDetails("context");
      return;
    }
    if (nextScope === "mission" && !initialMissionId) {
      setError("Open Command from a Mission before using Mission context.");
      return;
    }
    contextControllerRef.current?.abort();
    contextVersionRef.current += 1;
    setContextScope(nextScope);
    if (nextScope === "project" && !selectedProjectId) {
      setSelectedProjectId(projects[0]?.id || "");
    }
    setContextPack(undefined);
    setContextQuery("");
    setSelectedContextIds([]);
    clearContextLockState();
    setContextLoading(false);
    setContextError(undefined);
    setWorkflowPlan(undefined);
    contextSelectionReviewedRef.current = nextScope !== "explicit_selection";
    agentRequestIdRef.current = "";
    setRunAnnouncement(contextScopeOption(nextScope).description);
  }

  async function updatePersonalContextConsent(
    operation: "activate" | "revoke",
  ) {
    if (voicePermission) {
      setPersonalContextConsentError(voicePermission);
      return;
    }
    const noticeSha256 = personalContextConsent?.notice.sha256;
    if (operation === "activate" && !noticeSha256) {
      setPersonalContextConsentError(
        "The consent notice is not ready. Refresh this page and try again.",
      );
      return;
    }
    setPersonalContextConsentUpdating(true);
    setPersonalContextConsentError(undefined);
    try {
      const payload = await readJson("/api/memory/personal-context-consent", {
        method: operation === "activate" ? "POST" : "DELETE",
        headers: operation === "activate"
          ? { "content-type": "application/json" }
          : undefined,
        body: operation === "activate"
          ? JSON.stringify({ noticeSha256 })
          : undefined,
      });
      const nextConsent = personalContextConsentView(payload);
      setPersonalContextConsent(nextConsent);
      setPersonalContextConsentState("ready");
      if (operation === "revoke" && contextScope === "personal") {
        changeContextScope("session");
      }
      setRunAnnouncement(
        operation === "activate"
          ? "Personal automatic context is available for tasks where you select it."
          : "Personal automatic context is off and no longer available to new runs.",
      );
    } catch (error) {
      setPersonalContextConsentError(refreshMessage(error));
    } finally {
      setPersonalContextConsentUpdating(false);
    }
  }

  function changeProject(nextProjectId: string) {
    if (threadId || conversationLocked) return;
    setSelectedProjectId(nextProjectId);
    setContextPack(undefined);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
    setRunAnnouncement("Project context changed. The next run will verify its exact membership scope.");
  }

  function changeMode(nextMode: AgentMode) {
    if (nextMode === mode) {
      return;
    }
    setMode(nextMode);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function changeCommandModelSelection(
    selection: CommandModelSelectionRequest | undefined,
  ) {
    setCommandModelSelection(selection);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function selectCommandReference(item: CommandContextCatalogItem) {
    if (!item.selectable) {
      setError(`${item.label} is not ready to use yet.`);
      return;
    }
    if (item.kind === "project" && (threadId || conversationLocked)) {
      setError("Start a new conversation before changing its Project context.");
      return;
    }
    setCommandReferences((current) => {
      const withoutSingleton = item.kind === "agent" || item.kind === "project"
        ? current.filter((candidate) => candidate.kind !== item.kind)
        : current;
      if (withoutSingleton.some((candidate) =>
        candidate.kind === item.kind && candidate.id === item.id
      )) return withoutSingleton;
      return [...withoutSingleton, item];
    });
    if (item.kind === "agent") {
      setCommandModelSelection(undefined);
      setPreferredAgent(builtInAgentPresentation(item.id) || {
        id: item.id,
        name: item.label,
        role: item.description || "Specialist",
        voice: "Clear, direct, and calm.",
        visualIdentity: "A focused Asael specialist.",
        accent: "emerald",
      });
    }
    if (item.kind === "project") {
      changeContextScope("project");
      changeProject(item.id);
    }
    setError(undefined);
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
    setRunAnnouncement(`${item.label} is attached to the next message as ${commandReferenceKindLabel(item.kind)} context.`);
  }

  function removeCommandReference(item: CommandContextCatalogItem) {
    if (item.kind === "project" && (threadId || conversationLocked)) {
      setError("This conversation is already bound to its Project. Start a new conversation to change it.");
      return;
    }
    setCommandReferences((current) => current.filter((candidate) =>
      candidate.kind !== item.kind || candidate.id !== item.id
    ));
    if (item.kind === "agent" && preferredAgentId === item.id) {
      setCommandModelSelection(undefined);
      setPreferredAgent(undefined);
    }
    if (item.kind === "project" && selectedProjectId === item.id) {
      changeContextScope("session");
      changeProject("");
    }
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function clearPreferredAgentSelection() {
    setCommandModelSelection(undefined);
    setPreferredAgent(undefined);
    setCommandReferences((current) => current.filter((item) => item.kind !== "agent"));
    setWorkflowPlan(undefined);
    agentRequestIdRef.current = "";
  }

  function clearEphemeralCommandReferences() {
    setCommandReferences((current) => current.filter((item) =>
      item.kind === "agent" || item.kind === "project"
    ));
  }

  function handleCommandSlashAction(action: CommandSlashAction) {
    if (action === "plan") {
      void buildPlan();
      return;
    }
    changeMode(action === "act"
      ? "execute"
      : action === "learn"
        ? "learn"
        : "research");
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
    if (contextScope !== "explicit_selection") {
      contextSelectionReviewedRef.current = true;
      setRunAnnouncement(contextScopeOption(contextScope).description);
      if (reveal) openTaskDetails("context");
      return { query, evidenceIds: [] };
    }
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
    setContextPreviewToken("");
    setContextLock(undefined);
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
      setContextPreviewToken(stringPath(nextPack, "preview.token", ""));
      setContextLock(undefined);
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
      clearContextLockState();
      setContextError(message);
      setRunAnnouncement("Context could not be loaded. Refresh or choose a no-saved-context scope.");
      return undefined;
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
    setContextLock(undefined);
    setWorkflowPlan(undefined);
    setRunAnnouncement("Context selection updated. Lock it before starting the task.");
  }

  function contextSelectionForTask(query: string) {
    if (
      contextQuery !== query ||
      contextLoading ||
      !contextLock ||
      contextLock.selection.query !== query ||
      !sameOrderedStringValues(
        contextLock.selection.evidenceIds,
        selectedContextIds,
      )
    ) return undefined;
    return contextLock.selection;
  }

  async function lockContextForTask() {
    const taskQuery = goal.trim();
    if (
      contextScope !== "explicit_selection" ||
      !taskQuery ||
      contextQuery !== taskQuery ||
      !contextPreviewToken ||
      contextLoading ||
      contextLocking
    ) return;
    setContextLocking(true);
    setContextError(undefined);
    setRunAnnouncement("Locking the reviewed context selection.");
    try {
      const payload = asRecord(await readJson("/api/retrieval/selection-lock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: taskQuery,
          evidenceIds: selectedContextIds,
          previewToken: contextPreviewToken,
        }),
      }));
      const selection = asRecord(payload.selection);
      const receipt = asRecord(payload.receipt);
      const nextLock: ContextLockState = {
        selection: {
          query: stringValue(selection.query),
          evidenceIds: Array.isArray(selection.evidenceIds)
            ? selection.evidenceIds.filter((id): id is string => typeof id === "string")
            : [],
          lockToken: stringValue(selection.lockToken),
        },
        receipt: {
          lockId: stringValue(receipt.lockId),
          selectionSha256: stringValue(receipt.selectionSha256),
          issuedAt: stringValue(receipt.issuedAt),
          expiresAt: stringValue(receipt.expiresAt),
        },
      };
      if (
        !nextLock.selection.lockToken ||
        !nextLock.receipt.selectionSha256 ||
        nextLock.selection.query !== taskQuery ||
        !sameOrderedStringValues(nextLock.selection.evidenceIds, selectedContextIds)
      ) {
        throw new Error("The context lock response was incomplete.");
      }
      setContextLock(nextLock);
      setWorkflowPlan(undefined);
      setRunAnnouncement(
        `Context locked. ${nextLock.selection.evidenceIds.length} saved item${nextLock.selection.evidenceIds.length === 1 ? "" : "s"} will be eligible for this run.`,
      );
    } catch (lockError) {
      setContextLock(undefined);
      setContextError(
        lockError instanceof Error
          ? lockError.message
          : "Context could not be locked.",
      );
      setRunAnnouncement("Context lock failed. Refresh and review the selection again.");
    } finally {
      setContextLocking(false);
    }
  }

  async function buildPlan() {
    if (workflowActionPermission) {
      setError(workflowActionPermission);
      return;
    }
    if (workflowInProgress) {
      setError("Wait for the active workflow to finish or cancel it before replacing its plan.");
      return;
    }
    const taskQuery = goal.trim();
    if (contextScope === "project" && !selectedProjectId) {
      setError("Choose a project before using project context.");
      openTaskDetails("context");
      return;
    }
    if (contextScope === "mission" && !initialMissionId) {
      setError("Open Command from a Mission before using Mission context.");
      openTaskDetails("context");
      return;
    }
    if (contextScope === "agent_private" && !preferredAgentId) {
      setError("Choose an Agent before using Agent-private context.");
      openTaskDetails("context");
      return;
    }
    if (contextLoading) {
      openTaskDetails("context");
      setRunAnnouncement("Wait for task context to finish loading, then preview the plan.");
      return;
    }
    const contextSelection = contextScope === "explicit_selection"
      ? contextSelectionForTask(taskQuery)
      : undefined;
    if (contextScope === "explicit_selection" && !contextSelection) {
      if (contextPreparedForGoal) {
        contextSelectionReviewedRef.current = true;
        openTaskDetails("context");
        setRunAnnouncement("Review and lock the context selection before previewing the plan.");
      } else {
        const prepared = await buildContext({ query: taskQuery, reveal: true });
        if (prepared) {
          setRunAnnouncement("Context preparation finished. Review and lock the selection, then preview the plan again.");
        }
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
          contextScope,
          contextSelection,
          agentId: contextScope === "agent_private"
            ? preferredAgentId
            : undefined,
          projectId: contextScope === "project"
            ? selectedProjectId
            : undefined,
          missionId: contextScope === "mission"
            ? initialMissionId
            : undefined,
          primaryAgentId: preferredAgentId || undefined,
          contextReferences: commandReferences.map(
            commandContextReferenceRequest,
          ),
          modelSelection: commandModelSelection,
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
    if (workflowActionPermission) {
      setError(workflowActionPermission);
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
    const contextSelection = contextScope === "explicit_selection"
      ? contextSelectionForTask(taskQuery)
      : undefined;
    if (contextScope === "explicit_selection" && !contextSelection) {
      setError("The task changed after this plan was prepared. Review fresh context and generate the plan again.");
      openTaskDetails("context");
      return;
    }
    setLoading("workflow");
    setError(undefined);
    setAgentResponse("");
    setRunMediaProjection({
      runId: "",
      artifacts: [],
      files: [],
      fileState: "none",
      workspaceArtifacts: [],
      workspaceArtifactState: "none",
    });
    setGrounding(undefined);
    setContextUseReceipt(undefined);
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
          primaryAgentId: preferredAgentId || undefined,
          contextReferences: commandReferences.map(
            commandContextReferenceRequest,
          ),
          modelSelection: commandModelSelection,
          metadata: {
            source: "agent-runs-workspace",
            threadId: workflowThreadId,
            contextScope,
            contextSelection,
            agentId: contextScope === "agent_private"
              ? preferredAgentId
              : undefined,
            projectId: contextScope === "project"
              ? selectedProjectId
              : undefined,
            missionId: contextScope === "mission"
              ? initialMissionId
              : undefined,
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

  async function enqueuePrompt() {
    const prompt = goal.trim();
    if (!prompt) {
      setPromptQueueError("Write a message before adding it to the queue.");
      return;
    }
    if (runPermission) {
      setPromptQueueError(runPermission);
      return;
    }
    const correlationId = crypto.randomUUID();
    setPromptQueueBusyId(correlationId);
    setPromptQueueError(undefined);
    try {
      const payload = asRecord(await readJson("/api/command/prompt-queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientCorrelationId: correlationId,
          prompt,
          mode,
          strategy: "direct",
          agentId: preferredAgentId || "atlas",
          contextReferences: commandReferences.map(
            commandContextReferenceRequest,
          ),
          modelSelection: commandModelSelection,
          target: {
            threadId: threadId || null,
            missionId: initialMissionId || null,
            projectId: selectedProjectId || null,
            executionTarget: "asael",
          },
        }),
      }));
      const item = promptQueueItemFromValue(payload.item);
      if (!item) throw new Error("The server returned an invalid queue item.");
      setPromptQueue((current) => mergePromptQueueItems(current, [item]));
      setGoal("");
      setCommandModelSelection(undefined);
      clearEphemeralCommandReferences();
      setRunAnnouncement("Prompt added to the persistent queue.");
    } catch (queueError) {
      setPromptQueueError(refreshMessage(queueError));
      await refreshPromptQueue().catch(() => undefined);
    } finally {
      setPromptQueueBusyId("");
    }
  }

  async function updateQueuedPrompt(
    item: PromptQueueItem,
    change: { prompt?: string; state?: "queued" | "paused" },
  ) {
    setPromptQueueBusyId(item.id);
    setPromptQueueError(undefined);
    setPromptQueue((current) => current.map((candidate) =>
      candidate.id === item.id
        ? {
            ...candidate,
            ...change,
            lifecycleRevision: candidate.lifecycleRevision + 1,
            progressLabel: change.state === "paused"
              ? "Paused by you"
              : change.state === "queued"
                ? "Ready to run"
                : candidate.progressLabel,
          }
        : candidate
    ));
    try {
      const payload = asRecord(await readJson(
        `/api/command/prompt-queue/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: item.lifecycleRevision,
            ...change,
          }),
        },
      ));
      const updated = promptQueueItemFromValue(payload.item);
      if (!updated) throw new Error("The server returned an invalid queue item.");
      setPromptQueue((current) => mergePromptQueueItems(current, [updated]));
    } catch (queueError) {
      setPromptQueueError(refreshMessage(queueError));
      await refreshPromptQueue().catch(() => undefined);
    } finally {
      setPromptQueueBusyId("");
    }
  }

  async function removeQueuedPrompt(item: PromptQueueItem) {
    setPromptQueueBusyId(item.id);
    setPromptQueueError(undefined);
    setPromptQueue((current) => current.filter((candidate) => candidate.id !== item.id));
    try {
      await readJson(`/api/command/prompt-queue/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: item.lifecycleRevision }),
      });
    } catch (queueError) {
      setPromptQueueError(refreshMessage(queueError));
      await refreshPromptQueue().catch(() => undefined);
    } finally {
      setPromptQueueBusyId("");
    }
  }

  async function moveQueuedPrompt(item: PromptQueueItem, direction: -1 | 1) {
    const active = promptQueue.filter((candidate) =>
      candidate.state === "queued" || candidate.state === "paused"
    );
    const index = active.findIndex((candidate) => candidate.id === item.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= active.length) return;
    const reordered = [...active];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    const terminal = promptQueue.filter((candidate) =>
      candidate.state !== "queued" && candidate.state !== "paused"
    );
    setPromptQueueBusyId(item.id);
    setPromptQueueError(undefined);
    setPromptQueue([...reordered, ...terminal]);
    try {
      const payload = asRecord(await readJson("/api/command/prompt-queue/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: reordered.map((candidate) => ({
            id: candidate.id,
            expectedRevision: candidate.lifecycleRevision,
          })),
        }),
      }));
      const updated = arrayPath(payload, "items")
        .map(promptQueueItemFromValue)
        .filter((candidate): candidate is PromptQueueItem => Boolean(candidate));
      setPromptQueue((current) => mergePromptQueueItems(current, updated));
    } catch (queueError) {
      setPromptQueueError(refreshMessage(queueError));
      await refreshPromptQueue().catch(() => undefined);
    } finally {
      setPromptQueueBusyId("");
    }
  }

  async function drainPromptQueue() {
    if (promptQueueDrainRef.current) return;
    promptQueueDrainRef.current = true;
    try {
      const items = await refreshPromptQueue();
      const next = items.find((item) => item.state === "queued");
      if (next) {
        await runAgent({ queueItem: next, queueForce: false });
      }
    } catch (queueError) {
      setPromptQueueError(refreshMessage(queueError));
    } finally {
      promptQueueDrainRef.current = false;
    }
  }

  async function runAgent(options?: {
    submittedGoal?: string;
    submittedThreadId?: string;
    prepareContextAutomatically?: boolean;
    voiceReview?: VoiceCommandReview;
    queueItem?: PromptQueueItem;
    queueForce?: boolean;
  }): Promise<VoiceCommandReply | undefined> {
    if (runPermission) {
      setError(runPermission);
      return;
    }
    const queueItem = options?.queueItem;
    const submittedGoal = (queueItem?.prompt ?? options?.submittedGoal ?? goal).trim();
    const submittedCommandReferences = queueItem
      ? []
      : commandReferences.map(commandContextReferenceRequest);
    if (!submittedGoal) {
      setError("Write a message before asking Asael.");
      return;
    }
    if (!queueItem && contextScope === "project" && !selectedProjectId) {
      setError("Choose a project before using project context.");
      openTaskDetails("context");
      return;
    }
    if (!queueItem && contextScope === "mission" && !initialMissionId) {
      setError("Open Command from a Mission before using Mission context.");
      openTaskDetails("context");
      return;
    }
    if (
      !queueItem &&
      contextScope === "explicit_selection" &&
      contextLoading &&
      !options?.prepareContextAutomatically
    ) {
      openTaskDetails("context");
      setRunAnnouncement("Wait for task context to finish loading, then run the task.");
      return;
    }
    const contextSelection = !queueItem && contextScope === "explicit_selection" &&
        contextSelectionReviewedRef.current
      ? contextSelectionForTask(submittedGoal)
      : undefined;
    if (
      !queueItem &&
      contextScope === "explicit_selection" &&
      !contextSelection
    ) {
      if (!contextPreparedForGoal) {
        const prepared = await buildContext({
          query: submittedGoal,
          reveal: true,
        });
        if (!prepared) return;
      }
      contextSelectionReviewedRef.current = true;
      openTaskDetails("context");
      setRunAnnouncement("Review and lock the context selection before running this task.");
      return;
    }
    const resumeRunId = queueItem ? undefined : clarificationRunId || undefined;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading("agent");
    setError(undefined);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setAgentResponse("");
    setRunMediaProjection({
      runId: "",
      artifacts: [],
      files: [],
      fileState: "none",
      workspaceArtifacts: [],
      workspaceArtifactState: "none",
    });
    setGrounding(undefined);
    if (!resumeRunId) setContextUseReceipt(undefined);
    setActiveAgentRunId(resumeRunId || "");
    currentRunIdRef.current = resumeRunId || "";
    clearSelectedActivity();
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
    const submittedAgentId = queueItem?.agent.logicalAgentId || preferredAgentId;
    let completedResponse = "";
    let streamedResponse = "";
    let completedRunId = resumeRunId || "";
    let pendingVoiceApproval: VoiceApprovalEvidence | undefined;
    let waitingApprovalEvent: Extract<StreamEvent, { type: "waiting_approval" }> | undefined;
    agentRequestIdRef.current = requestId;
    setTurns((current) => [
      ...current,
      { id: `pending-user-${Date.now()}`, role: "user", content: submittedGoal, createdAt: new Date().toISOString() },
    ]);

    let terminalEvent: "done" | "delegated" | "clarification" | "waiting_approval" | "error" | undefined;
    try {
      const response = await fetch(queueItem
        ? `/api/command/prompt-queue/${encodeURIComponent(queueItem.id)}/dispatch`
        : "/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(queueItem
          ? {
              expectedRevision: queueItem.lifecycleRevision,
              force: options?.queueForce ?? true,
            }
          : {
              mode,
              threadId: options?.submittedThreadId || threadId || undefined,
              resumeRunId,
              missionId: initialMissionId || undefined,
              projectId: selectedProjectId || undefined,
              message: submittedGoal,
              requestId,
              strategy: resumeRunId ? "auto" : "direct",
              agentId: submittedAgentId,
              contextScope: resumeRunId ? undefined : contextScope,
              contextSelection: resumeRunId ? undefined : contextSelection,
              contextReferences: resumeRunId ? undefined : submittedCommandReferences,
              modelSelection: resumeRunId ? undefined : commandModelSelection,
              voiceInput: resumeRunId ? undefined : options?.voiceReview,
            }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(stringValue(asRecord(body).message || asRecord(body).error, `/api/agent returned ${response.status}`));
      }

      await readSse(response.body, (event) => {
        if (event.type === "run" && event.runId) {
          currentRunIdRef.current = event.runId;
          completedRunId = event.runId;
          setActiveAgentRunId(event.runId);
          setSelectedActivityRunId(event.runId);
          if (event.threadId) {
            setThreadId(event.threadId);
          }
          return;
        }
        if (event.type === "delta" && event.text) {
          streamedResponse += event.text;
          queueDelta(event.text);
          return;
        }
        setStreamEvents((current) => [...current.slice(-199), event]);
        if (event.type === "delegated") {
          terminalEvent = "delegated";
          agentRequestIdRef.current = "";
          setClarificationRunId("");
          const acknowledgement = event.acknowledgement || "This task is continuing as a durable workflow.";
          completedResponse = acknowledgement;
          if (event.threadId) setThreadId(event.threadId);
          if (event.workflowId) setWorkflowRun({ run: { id: event.workflowId } });
          setAgentResponse(acknowledgement);
          setTurns((current) => [
            ...current,
            { id: `assistant-${Date.now()}`, role: "assistant", content: acknowledgement, createdAt: new Date().toISOString() },
          ]);
          setGoal("");
          clearEphemeralCommandReferences();
          void refreshThreads();
          setRunAnnouncement("Task moved to a durable background workflow.");
        }
        if (event.type === "clarification") {
          terminalEvent = "clarification";
          agentRequestIdRef.current = "";
          setClarificationRunId(event.runId || currentRunIdRef.current || "");
          const clarification = event.message || "Name or identify the exact item you want changed before I continue.";
          completedResponse = clarification;
          if (event.threadId) setThreadId(event.threadId);
          setAgentResponse(clarification);
          setTurns((current) => [
            ...current,
            { id: `assistant-${Date.now()}`, role: "assistant", content: clarification, createdAt: new Date().toISOString() },
          ]);
          setGoal("");
          void refreshThreads();
          setRunAnnouncement("The agent needs an exact target before it can continue.");
        }
        if (event.type === "done") {
          terminalEvent = "done";
          agentRequestIdRef.current = "";
          setClarificationRunId("");
          flushPendingDeltas();
          completedResponse = event.response || streamedResponse;
          setAgentResponse(completedResponse);
          setGrounding(renderSafeGroundingReport(event.grounding));
          if (completedResponse) {
            setTurns((current) => [
              ...current,
              { id: `assistant-${Date.now()}`, role: "assistant", content: completedResponse, createdAt: new Date().toISOString(), runId: currentRunIdRef.current || undefined },
            ]);
          }
          setGoal("");
          clearEphemeralCommandReferences();
          void refreshThreads();
          setRunAnnouncement("Agent run completed. Review the result and evidence.");
        }
        if (event.type === "status") {
          setRunAnnouncement(streamEventLabel(event));
        }
        if (event.type === "waiting_approval") {
          terminalEvent = "waiting_approval";
          agentRequestIdRef.current = "";
          setClarificationRunId("");
          setWaitingApproval(event);
          waitingApprovalEvent = event;
          clearEphemeralCommandReferences();
          setRunAnnouncement("Agent run paused for approval.");
        }
        if (event.type === "error") {
          terminalEvent = "error";
          agentRequestIdRef.current = "";
          setClarificationRunId("");
          setError(event.message || "Agent run failed.");
          setRunAnnouncement("Agent run failed.");
        }
      });
      if (!terminalEvent) {
        throw new Error(
          "The agent stream ended before a final status was received. Check Activity before retrying.",
        );
      }
      if (terminalEvent === "waiting_approval" && waitingApprovalEvent?.executionId) {
        const detail = asRecord(await readJson(
          `/api/approvals/${encodeURIComponent(waitingApprovalEvent.executionId)}`,
        ));
        pendingVoiceApproval = parseVoiceApprovalEvidence(detail.approval);
        completedResponse = waitingApprovalEvent.message ||
          `Review the exact ${pendingVoiceApproval.title} action before it runs.`;
      }
      flushPendingDeltas();
      void refreshEvidence();
      if (terminalEvent === "done" && currentRunIdRef.current) {
        void refreshRunProjection(currentRunIdRef.current);
      }
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
      if (queueItem) {
        await refreshPromptQueue().catch(() => undefined);
      }
      if (terminalEvent === "done" || terminalEvent === "delegated") {
        window.setTimeout(() => void drainPromptQueue(), 0);
      }
    }
    return completedResponse.trim() || pendingVoiceApproval
      ? {
          text: completedResponse || "Review the exact action before it runs.",
          runId: completedRunId || undefined,
          agentId: submittedAgentId,
          approval: pendingVoiceApproval,
        }
      : undefined;
  }

  async function listenToResponse(text = currentAssistantResponse) {
    if (responseSpeechControllerRef.current) {
      responseSpeechControllerRef.current.abort();
      responseSpeechControllerRef.current = null;
      responseSpeechPlayerRef.current?.stop();
      responseSpeechPlayerRef.current = null;
      setSpeechLoading(false);
      return;
    }
    if (!text.trim()) return;
    const controller = new AbortController();
    const player = new StreamingPcmPlayer();
    responseSpeechControllerRef.current = controller;
    responseSpeechPlayerRef.current = player;
    setSpeechLoading(true);
    try {
      await streamVersionedSpeech({
        text,
        threadId: threadId || undefined,
        runId: currentRunIdRef.current || undefined,
        agentId: preferredAgentId,
      }, {
        player,
        signal: controller.signal,
      });
    } catch (speechError) {
      if (controller.signal.aborted) return;
      setError(speechError instanceof Error ? speechError.message : "Speech playback failed.");
    } finally {
      if (responseSpeechControllerRef.current === controller) {
        responseSpeechControllerRef.current = null;
        setSpeechLoading(false);
      }
      if (responseSpeechPlayerRef.current === player) {
        responseSpeechPlayerRef.current = null;
      }
    }
  }

  async function refreshThreads() {
    if (threadsRefreshRef.current) {
      threadsRefreshQueuedRef.current = true;
      return threadsRefreshRef.current;
    }
    const request = (async () => {
      do {
        threadsRefreshQueuedRef.current = false;
        try {
          const result = asRecord(await readJson("/api/threads?limit=100"));
          setThreads(projectClientThreadSummaries(
            readPath(result, "threads"),
            ["orchestrate", "research", "execute", "learn"] as const,
            "orchestrate",
          ));
        } catch {
          // Threads are convenience navigation; agent execution reports its own errors.
        }
      } while (threadsRefreshQueuedRef.current);
    })();
    threadsRefreshRef.current = request;
    try {
      await request;
    } finally {
      if (threadsRefreshRef.current === request) {
        threadsRefreshRef.current = null;
        if (threadsRefreshQueuedRef.current) {
          threadsRefreshQueuedRef.current = false;
          void refreshThreads();
        }
      }
    }
  }

  async function refreshConversationCanvas(id = threadId) {
    conversationCanvasControllerRef.current?.abort();
    const controller = new AbortController();
    conversationCanvasControllerRef.current = controller;
    setConversationCanvas(undefined);
    setConversationCanvasState("loading");
    setConversationCanvasError(undefined);
    try {
      const query = id ? `?threadId=${encodeURIComponent(id)}` : "";
      const result = asRecord(await readJson(`/api/conversations/canvas${query}`, {
        signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      setConversationCanvas(result.projection);
      setConversationCanvasState("ready");
    } catch (canvasError) {
      if (controller.signal.aborted) return;
      setConversationCanvasError(
        canvasError instanceof Error
          ? canvasError.message
          : "The Conversation map could not be loaded.",
      );
      setConversationCanvasState("error");
    } finally {
      if (conversationCanvasControllerRef.current === controller) {
        conversationCanvasControllerRef.current = null;
      }
    }
  }

  async function refreshRunProjection(runId: string) {
    runProjectionControllerRef.current?.abort();
    const controller = new AbortController();
    runProjectionControllerRef.current = controller;
    try {
      const payload = asRecord(await readJson(
        `/api/runs/${encodeURIComponent(runId)}`,
        { signal: controller.signal },
      ));
      if (
        controller.signal.aborted ||
        (runId !== currentRunIdRef.current && runId !== activeAgentRunId)
      ) return;
      setRunMediaProjection({
        runId,
        artifacts: projectCommandMediaArtifacts(payload),
        files: projectCommandFileArtifacts(payload),
        fileState: projectCommandFileArtifactState(payload),
        workspaceArtifacts: projectCommandWorkspaceArtifacts(payload),
        workspaceArtifactState: projectCommandWorkspaceArtifactState(payload),
      });
      setContextUseReceipt(contextUseReceiptFromPayload(payload));
    } catch {
      // Text remains usable; the active-run poll or next reopen retries the
      // durable artifact and context projection together.
    } finally {
      if (runProjectionControllerRef.current === controller) {
        runProjectionControllerRef.current = null;
      }
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
    const version = ++memoryVersionRef.current;
    memoryControllerRef.current?.abort();
    const controller = new AbortController();
    memoryControllerRef.current = controller;
    if (!id) {
      setConversationMemories([]);
      setMemoryState("ready");
      memoryControllerRef.current = null;
      return;
    }
    setMemoryState("loading");
    setMemoryError(undefined);
    try {
      const result = asRecord(await readJson(
        `/api/memory?threadId=${encodeURIComponent(id)}&limit=100`,
        { signal: controller.signal },
      ));
      if (controller.signal.aborted || version !== memoryVersionRef.current) return;
      setConversationMemories(arrayPath(result, "memories") as unknown as ConversationMemory[]);
      setMemoryState("ready");
    } catch (memoryLoadError) {
      if (controller.signal.aborted || version !== memoryVersionRef.current) return;
      setMemoryError(memoryLoadError instanceof Error ? memoryLoadError.message : "Conversation memory could not be loaded.");
      setMemoryState("error");
    } finally {
      if (memoryControllerRef.current === controller) {
        memoryControllerRef.current = null;
      }
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
      setTurns(projectClientThreadTurns(readPath(result, "turns")));
    } catch {
      // Keep the current transcript visible and let the next poll or reopen retry.
    }
  }

  async function loadThread(
    id: string,
    options: {
      restoreLatestRun?: boolean;
      preserveActivity?: boolean;
    } = {},
  ) {
    const version = ++threadLoadVersionRef.current;
    threadLoadControllerRef.current?.abort();
    const controller = new AbortController();
    threadLoadControllerRef.current = controller;
    try {
      await startProgressiveThreadLoad({
        readThread: async (signal) => asRecord(await readJson(
          `/api/threads/${encodeURIComponent(id)}`,
          { signal },
        )),
        latestRunId: (result) => options.restoreLatestRun === false
          ? undefined
          : [...projectClientThreadTurns(readPath(result, "turns"))]
              .reverse()
              .find((turn) => Boolean(turn.runId))
              ?.runId,
        readRun: async (runId, signal) => asRecord(await readJson(
          `/api/runs/${encodeURIComponent(runId)}`,
          { signal },
        )),
        isCurrent: () => threadLoadVersionRef.current === version,
        onThreadReady: (result, latestRunId) => {
          const thread = asRecord(result.thread);
          const loadedTurns = projectClientThreadTurns(readPath(result, "turns"));
          setThreadId(stringValue(thread.id));
          const loadedProjectId = stringValue(thread.projectId);
          if (loadedProjectId) setSelectedProjectId(loadedProjectId);
          setMode(canonicalClientAgentMode(thread.mode));
          setTurns(loadedTurns);
          memoryControllerRef.current?.abort();
          memoryVersionRef.current += 1;
          setConversationMemories([]);
          setMemoryState("idle");
          setMemoryError(undefined);
          contextControllerRef.current?.abort();
          contextVersionRef.current += 1;
          setContextPack(undefined);
          setContextQuery("");
          setSelectedContextIds([]);
          clearContextLockState();
          contextSelectionReviewedRef.current = contextScope !== "explicit_selection";
          setContextLoading(false);
          setContextError(undefined);
          setWorkflowPlan(undefined);
          setWorkflowRun(undefined);
          setWorkflowSyncError(undefined);
          if (!options.preserveActivity) {
            setAgentResponse("");
            setRunMediaProjection({
              runId: latestRunId || "",
              artifacts: [],
              files: [],
              fileState: "none",
              workspaceArtifacts: [],
              workspaceArtifactState: "none",
            });
            setActiveAgentRunId("");
            setClarificationRunId("");
            currentRunIdRef.current = "";
            clearSelectedActivity();
            directRunStatusRef.current = "";
            setStreamEvents([]);
            setWaitingApproval(undefined);
            setGrounding(undefined);
            setContextUseReceipt(undefined);
            setActiveTab("execute");
            setDetailsOpen(false);
          }
          setMobileConversationsOpen(false);
          setConversationView("chat");
          agentRequestIdRef.current = "";
        },
        onRunReady: (runPayload, latestRunId) => {
          setRunMediaProjection({
            runId: latestRunId,
            artifacts: projectCommandMediaArtifacts(runPayload),
            files: projectCommandFileArtifacts(runPayload),
            fileState: projectCommandFileArtifactState(runPayload),
            workspaceArtifacts: projectCommandWorkspaceArtifacts(runPayload),
            workspaceArtifactState: projectCommandWorkspaceArtifactState(runPayload),
          });
          setContextUseReceipt(contextUseReceiptFromPayload(runPayload));
          const run = asRecord(runPayload.run);
          if (stringValue(run.status) !== "waiting_clarification") return;
          const message = stringValue(
            run.response,
            "Reply to the clarification request to continue this run.",
          );
          setAgentResponse(message);
          setActiveAgentRunId(latestRunId);
          setClarificationRunId(latestRunId);
          currentRunIdRef.current = latestRunId;
          directRunStatusRef.current = "waiting_clarification";
          setStreamEvents([
            { type: "run", runId: latestRunId, threadId: id },
            {
              type: "clarification",
              runId: latestRunId,
              threadId: id,
              message,
              reasonCode: "ambiguous_read_target",
            },
          ]);
        },
        signal: controller.signal,
      });
    } catch (threadError) {
      if (controller.signal.aborted || threadLoadVersionRef.current !== version) return;
      setError(threadError instanceof Error ? threadError.message : "Conversation could not be loaded.");
    }
  }

  async function loadRunActivity(id: string) {
    setError(undefined);
    try {
      const payload = asRecord(await readJson(`/api/runs/${encodeURIComponent(id)}`));
      const run = asRecord(payload.run);
      if (stringValue(run.id) !== id) throw new Error("Run not found.");
      const ownedThreadId = stringValue(run.threadId);
      if (ownedThreadId) {
        void loadThread(ownedThreadId, {
          restoreLatestRun: false,
          preserveActivity: true,
        });
      }
      const status = stringValue(run.status);
      const response = stringValue(run.response);
      const nextGrounding = run.grounding
        ? renderSafeGroundingReport(run.grounding)
        : undefined;
      const identity = asRecord(payload.agentIdentity);
      const card = asRecord(identity.card);
      if (stringValue(identity.state) === "ready" && stringValue(card.logicalAgentId)) {
        setPreferredAgent(agentPresentationFromApi({
          id: stringValue(card.logicalAgentId),
          name: stringValue(card.name, "Agent"),
          role: stringValue(card.role, "Agent"),
          persona: card.persona,
          accent: card.accent,
        }));
      }
      setWorkflowPlan(undefined);
      setWorkflowRun(undefined);
      setWorkflowSyncError(undefined);
      currentRunIdRef.current = id;
      directRunStatusRef.current = status;
      setSelectedActivityRunId(id);
      setActiveAgentRunId(["completed", "failed", "canceled"].includes(status) ? "" : id);
      setAgentResponse(response);
      setRunMediaProjection({
        runId: id,
        artifacts: projectCommandMediaArtifacts(payload),
        files: projectCommandFileArtifacts(payload),
        fileState: projectCommandFileArtifactState(payload),
        workspaceArtifacts: projectCommandWorkspaceArtifacts(payload),
        workspaceArtifactState: projectCommandWorkspaceArtifactState(payload),
      });
      setGrounding(nextGrounding);
      setContextUseReceipt(contextUseReceiptFromPayload(payload));
      setWaitingApproval(status === "waiting_approval" ? {
        type: "waiting_approval",
        executionId: stringPath(run, "waitingApproval.executionId", ""),
        toolId: stringPath(run, "waitingApproval.toolId", ""),
        message: `${stringPath(run, "waitingApproval.toolName", "A gated action")} needs approval before the task can continue.`,
      } : undefined);
      setClarificationRunId(status === "waiting_clarification" ? id : "");
      setStreamEvents([
        { type: "run", runId: id, threadId: ownedThreadId || undefined },
        ...(status === "completed"
          ? [{ type: "done" as const, response, grounding: nextGrounding }]
          : status === "failed"
            ? [{ type: "error" as const, message: stringValue(run.error, "The task stopped before completion.") }]
            : status === "canceled"
              ? [{ type: "canceled" as const, message: "The task was canceled." }]
              : [{ type: "status" as const, label: "Durable run", detail: `Run is ${status.replaceAll("_", " ")}.` }]),
      ]);
      setActiveTab("execute");
      setDetailsOpen(true);
      setRunAnnouncement("Opened the durable activity and recovery record for this run.");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Run activity could not be loaded.");
      setRunAnnouncement("Run activity could not be loaded.");
    }
  }

  function newThread() {
    threadLoadVersionRef.current += 1;
    threadLoadControllerRef.current?.abort();
    memoryControllerRef.current?.abort();
    memoryVersionRef.current += 1;
    contextControllerRef.current?.abort();
    contextVersionRef.current += 1;
    setThreadId("");
    setMode("orchestrate");
    setTurns([]);
    setGoal("");
    setContextPack(undefined);
    setContextQuery("");
    setSelectedContextIds([]);
    clearContextLockState();
    contextSelectionReviewedRef.current = contextScope !== "explicit_selection";
    setContextLoading(false);
    setContextError(undefined);
    setAgentResponse("");
    setRunMediaProjection({
      runId: "",
      artifacts: [],
      files: [],
      fileState: "none",
      workspaceArtifacts: [],
      workspaceArtifactState: "none",
    });
    setStreamEvents([]);
    setWorkflowPlan(undefined);
    setWorkflowRun(undefined);
    setWorkflowSyncError(undefined);
    setActiveAgentRunId("");
    setClarificationRunId("");
    currentRunIdRef.current = "";
    clearSelectedActivity();
    directRunStatusRef.current = "";
    setWaitingApproval(undefined);
    setGrounding(undefined);
    setContextUseReceipt(undefined);
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
    if (
      sessionStatus !== "ready" ||
      !session ||
      !evidenceVisibleRef.current
    ) {
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
    selectTaskDetailsTab(nextTab.key);
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
                    {conversationView === "map" ? "Canonical Conversation map" : threads.find((thread) => thread.id === threadId)?.title || "New conversation"}
                  </h2>
                  <p className="hidden truncate text-xs text-muted sm:block">{conversationView === "map" ? "Real runs, forks, delegations, Projects, and shared artifacts." : "Ask, refine, and continue in the same thread."}</p>
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
                projection={conversationCanvas}
                state={conversationCanvasState}
                error={conversationCanvasError}
                activeThreadId={threadId}
                onNew={newThread}
                onRefresh={() => void refreshConversationCanvas(threadId)}
                onSelectRun={(id) => openTaskDetails("execute", id)}
                onSelectThread={(id) => {
                  setConversationView("chat");
                  void loadThread(id);
                }}
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
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                        {activeAssistantName}
                        {preferredAgent?.role ? <span className="ml-2 text-muted">· {preferredAgent.role}</span> : null}
                      </p>
                      <ConversationMessageContent
                        content={turn.content}
                        mediaArtifacts={turn.runId && turn.runId === runMediaProjection.runId
                          ? runMediaProjection.artifacts
                          : undefined}
                        fileArtifacts={turn.runId && turn.runId === runMediaProjection.runId
                          ? runMediaProjection.files
                          : undefined}
                        fileArtifactState={turn.runId && turn.runId === runMediaProjection.runId
                          ? runMediaProjection.fileState
                          : undefined}
                        workspaceArtifacts={turn.runId && turn.runId === runMediaProjection.runId
                          ? runMediaProjection.workspaceArtifacts
                          : undefined}
                        workspaceArtifactState={turn.runId && turn.runId === runMediaProjection.runId
                          ? runMediaProjection.workspaceArtifactState
                          : undefined}
                      />
                      {turn.runId ? (
                        <button
                          type="button"
                          onClick={() => openTaskDetails("execute", turn.runId)}
                          className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
                          aria-haspopup="dialog"
                        >
                          <Globe2 size={13} aria-hidden="true" />
                          View activity
                        </button>
                      ) : null}
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
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                        {activeAssistantName}
                        {preferredAgent?.role ? <span className="ml-2 text-muted">· {preferredAgent.role}</span> : null}
                      </p>
                      {loading === "agent" ? (
                        <span className="inline-flex items-center gap-2 text-xs text-muted">
                          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                          Writing
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2">
                      <ConversationMessageContent
                        content={currentAssistantResponse}
                        grounding={grounding}
                        mediaArtifacts={runMediaProjection.artifacts}
                        fileArtifacts={runMediaProjection.files}
                        fileArtifactState={runMediaProjection.fileState}
                        workspaceArtifacts={runMediaProjection.workspaceArtifacts}
                        workspaceArtifactState={runMediaProjection.workspaceArtifactState}
                      />
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
                      <button
                        type="button"
                        onClick={() => void listenToResponse(currentAssistantResponse)}
                        className="inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
                        aria-label={speechLoading
                          ? `Stop ${activeAssistantName}'s response`
                          : `Listen to ${activeAssistantName}'s response`}
                      >
                        {speechLoading ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
                        {speechLoading ? "Stop listening" : "Listen"}
                      </button>
                      {grounding ? (
                        <span className="inline-flex min-h-9 items-center rounded-full bg-surface-raised px-3 text-xs font-medium text-muted">
                          {groundingLabel(grounding)}
                        </span>
                      ) : null}
                      {activeAgentRunId ? (
                        <button
                          type="button"
                          onClick={() => openTaskDetails("execute", activeAgentRunId)}
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
                          aria-haspopup="dialog"
                        >
                          <Globe2 size={13} aria-hidden="true" /> Activity
                        </button>
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
                    {grounding?.claimEvidence ? (
                      <ClaimEvidencePanel
                        content={currentAssistantResponse}
                        claimEvidence={grounding.claimEvidence}
                      />
                    ) : null}
                    {grounding?.status === "missing" ? (
                      <p className="mt-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-5 text-muted" role="status">
                        {grounding.claimEvidence
                          ? "Some material claims are not supported by authorized evidence. Open Claim evidence to see which statements need verification."
                          : "Evidence was available, but this response did not cite it. Open Evidence to review the captured sources."}
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
                  <div className="w-full max-w-2xl px-4">
                    <AsaelLottieMascot
                      state="idle"
                      size="hero"
                      className={clsx("mx-auto", workspaceStyles.emptyMascot)}
                      decorative
                    />
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">What should we work through?</h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">Start with a question or outcome. Follow up naturally, and Asael keeps this conversation together.</p>
                    <div className="mt-5 grid gap-2 text-left sm:grid-cols-3" aria-label="Document creation examples">
                      {[
                        "Create an editable PowerPoint presentation",
                        "Draft a collaborative Google Doc",
                        "Build a Google Sheet rollout tracker",
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => changeGoal(prompt)}
                          className="flex min-h-14 items-center gap-2 rounded-xl border border-line/80 bg-surface px-3 py-2.5 text-xs font-semibold leading-5 text-foreground transition hover:border-primary/40 hover:bg-primary/5"
                        >
                          <FileText size={15} className="shrink-0 text-primary" aria-hidden="true" />
                          <span>{prompt}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
              </div>
            </div>

            <PromptQueuePanel
              items={promptQueue}
              busyId={promptQueueBusyId}
              error={promptQueueError}
              dispatchLocked={Boolean(loading) || workflowInProgress}
              onEdit={(item, prompt) => void updateQueuedPrompt(item, { prompt })}
              onPause={(item) => void updateQueuedPrompt(item, { state: "paused" })}
              onResume={(item) => void updateQueuedPrompt(item, { state: "queued" })}
              onMove={(item, direction) => void moveQueuedPrompt(item, direction)}
              onRun={(item) => void runAgent({ queueItem: item, queueForce: true })}
              onDelete={(item) => void removeQueuedPrompt(item)}
              onRefresh={() => void refreshPromptQueue()}
            />
            <GoalStage
              goal={goal}
              mode={mode}
              approvalRequired={approvalRequired}
              preferredAgent={preferredAgent}
              commandReferences={commandReferences}
              commandModelScope={modelAssignmentScopeForAgent(preferredAgentId)}
              commandModelSelection={commandModelSelection}
              loading={loading}
              contextLoading={contextLoading}
              contextScope={contextScope}
              personalContextAvailable={personalContextActive}
              missionContextAvailable={Boolean(initialMissionId)}
              projectId={selectedProjectId}
              projects={projects}
              projectSelectionLocked={Boolean(threadId || conversationLocked)}
              contextReady={contextPreparedForGoal}
              contextLocked={contextLockedForGoal}
              contextSelectedCount={selectedContextIds.length}
              contextTotalCount={contextResultIds.length}
              contextError={contextError}
              readDisabledReason={readPermission}
              runDisabledReason={runPermission}
              voiceDisabledReason={runPermission || voicePermission}
              workflowDisabledReason={workflowActionPermission}
              workflowReady={reviewedPlanReady}
              workflowStarted={Boolean(activeWorkflowId)}
              workflowInProgress={conversationLocked}
              hasConversation={turns.length > 0 || Boolean(currentAssistantResponse)}
              voiceConversationId={threadId || undefined}
              onGoalChange={changeGoal}
              onModeChange={changeMode}
              onApprovalChange={changeApprovalRequired}
              onClearPreferredAgent={clearPreferredAgentSelection}
              onSelectCommandReference={selectCommandReference}
              onRemoveCommandReference={removeCommandReference}
              onCommandSlashAction={handleCommandSlashAction}
              onCommandModelSelection={changeCommandModelSelection}
              onContext={() => void buildContext()}
              onContextScopeChange={changeContextScope}
              onProjectChange={changeProject}
              onReviewContext={() => {
                contextSelectionReviewedRef.current = true;
                openTaskDetails("context");
              }}
              onPlan={() => void buildPlan()}
              onAgent={() => void runAgent({ prepareContextAutomatically: true })}
              onQueue={() => void enqueuePrompt()}
              onVoiceConversationBound={setThreadId}
              onVoiceTranscript={async (transcript, voiceConversationId, review) => {
                const voiceGoal = transcript;
                setThreadId(voiceConversationId);
                changeGoal(voiceGoal);
                return await runAgent({
                  submittedGoal: voiceGoal,
                  submittedThreadId: voiceConversationId,
                  prepareContextAutomatically: true,
                  voiceReview: review,
                });
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
            className={clsx(
              "command-details max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line/80 bg-surface shadow-2xl outline-none sm:rounded-2xl",
              activeTab === "execute" ? "max-w-6xl" : "max-w-4xl",
            )}
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
                  onClick={() => selectTaskDetailsTab(tab.key)}
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
              <StagePanel title="Conversation memory" description="Context retained from this conversation. Forgetting a memory removes it from future conversations everywhere, while the chat transcript stays intact.">
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
                <div className="mb-4 rounded-xl border border-line bg-background p-3">
                  <label htmlFor="context-scope" className="text-xs font-semibold text-foreground">
                    Context scope
                  </label>
                  <select
                    id="context-scope"
                    value={contextScope}
                    disabled={Boolean(loading) || workflowInProgress}
                    onChange={(event) => changeContextScope(
                      event.currentTarget.value as ActiveContextScopeId,
                    )}
                    className="mt-2 min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm font-medium text-foreground outline-none focus:border-primary"
                  >
                    {CONTEXT_SCOPE_OPTIONS.map((option) => (
                      <option
                        key={option.id}
                        value={option.id}
                        disabled={(option.id === "personal" && !personalContextActive) ||
                          (option.id === "mission" && !initialMissionId)}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    {contextScopeOption(contextScope).description}
                  </p>
                  <div className="mt-3 rounded-lg border border-line bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-xs text-foreground">
                        Personal automatic context
                      </strong>
                      <StatusPill
                        label={personalContextActive ? "On" : "Off"}
                        tone={personalContextActive ? "success" : "neutral"}
                      />
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted">
                      {personalContextConsent?.notice.text ||
                        (personalContextConsentState === "loading"
                          ? "Loading the consent notice…"
                          : "The consent notice is currently unavailable.")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void updatePersonalContextConsent(
                        personalContextActive ? "revoke" : "activate",
                      )}
                      disabled={
                        personalContextConsentUpdating ||
                        personalContextConsentState === "loading" ||
                        workflowInProgress ||
                        Boolean(loading) ||
                        Boolean(voicePermission) ||
                        !personalContextConsent?.notice.sha256
                      }
                      title={voicePermission}
                      className={personalContextActive
                        ? "mt-3 min-h-9 rounded-md border border-line px-3 text-xs font-semibold text-foreground hover:bg-surface-raised disabled:opacity-50"
                        : "primary-button mt-3"}
                    >
                      {personalContextConsentUpdating ? (
                        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                      ) : personalContextActive ? (
                        "Turn off"
                      ) : (
                        "Turn on"
                      )}
                    </button>
                    {personalContextConsentError ? (
                      <p className="mt-2 text-xs leading-5 text-danger" role="status">
                        {personalContextConsentError}
                      </p>
                    ) : null}
                  </div>
                  {contextScope === "project" ? (
                    <label className="mt-3 grid gap-1 text-xs font-semibold text-foreground" htmlFor="context-project">
                      Project
                      <select
                        id="context-project"
                        value={selectedProjectId}
                        disabled={Boolean(loading) || workflowInProgress || Boolean(threadId)}
                        onChange={(event) => changeProject(event.currentTarget.value)}
                        className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm font-medium text-foreground outline-none focus:border-primary"
                      >
                        <option value="">Choose a project</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>{project.title}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void buildContext()}
                    disabled={contextScope !== "explicit_selection" || Boolean(loading) || contextLoading || workflowInProgress || Boolean(readPermission)}
                    title={readPermission}
                    className="action-button"
                  >
                    {contextLoading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Brain size={14} aria-hidden="true" />}
                    Refresh context
                  </button>
                  {contextScope === "explicit_selection" ? (
                    <button
                      type="button"
                      onClick={() => void lockContextForTask()}
                      disabled={
                        Boolean(loading) ||
                        contextLoading ||
                        contextLocking ||
                        workflowInProgress ||
                        !contextPreviewToken ||
                        contextQuery !== normalizedGoal ||
                        contextLockedForGoal
                      }
                      className="primary-button"
                    >
                      {contextLocking ? (
                        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                      ) : contextLockedForGoal ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <ShieldCheck size={14} aria-hidden="true" />
                      )}
                      {contextLockedForGoal ? "Selection locked" : "Lock selection"}
                    </button>
                  ) : null}
                  <StatusPill
                    label={contextScope === "explicit_selection"
                      ? contextLockedForGoal
                        ? `${selectedContextIds.length} locked`
                        : `${selectedContextIds.length} of ${contextResultIds.length} selected`
                      : contextScopeOption(contextScope).label}
                    tone={contextScope === "explicit_selection" && contextLockedForGoal ? "success" : "neutral"}
                  />
                  {contextScope === "explicit_selection" && contextResultIds.length ? (
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
                {contextScope === "explicit_selection" && contextQuery ? (
                  <p className="mb-3 line-clamp-3 rounded-md bg-background px-3 py-2 text-xs leading-5 text-muted">
                    Built fresh for: <span className="font-medium text-foreground">{contextQuery}</span>
                  </p>
                ) : null}
                {contextScope === "explicit_selection" && contextLock ? (
                  <div className="mb-3 rounded-md border border-success/35 bg-success/10 px-3 py-2 text-xs leading-5 text-muted" role="status">
                    <span className="font-semibold text-foreground">Locked for this task.</span>{" "}
                    Receipt <span className="font-mono">{contextLock.receipt.selectionSha256.slice(0, 12)}</span> binds the checked and excluded items to the next run.
                  </div>
                ) : null}
                {contextScope === "explicit_selection" && contextError ? (
                  <div className="mb-3 rounded-md border border-warning/45 bg-warning/10 p-3 text-xs leading-5 text-muted" role="status">
                    Saved context could not be loaded. Refresh, or choose Conversation only, Current message only, or No extra context. {contextError}
                  </div>
                ) : null}
                {contextScope === "explicit_selection" ? (
                  <ContextSelectionList
                    rows={contextResults}
                    selectedIds={selectedContextIds}
                    loading={contextLoading}
                    disabled={workflowInProgress || loading === "agent"}
                    onChange={updateContextSelection}
                  />
                ) : contextScope === "personal" ? (
                  <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm leading-6 text-muted">
                    <strong className="text-foreground">Personal automatic context is on for this task.</strong>
                    <p className="mt-1">Consent is checked again when the run starts. Only relevant owner-private memory is eligible, and the scope does not authorize tools or memory changes.</p>
                  </div>
                ) : contextScope === "mission" ||
                    contextScope === "project" ||
                    contextScope === "workspace" ? (
                  <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm leading-6 text-muted">
                    <strong className="text-foreground">
                      {contextScope === "mission"
                        ? "Attached Mission's canonical Project"
                        : contextScope === "project"
                        ? projects.find((project) => project.id === selectedProjectId)?.title || "Choose a project"
                        : selectedProjectId
                          ? `Workspace containing ${projects.find((project) => project.id === selectedProjectId)?.title || "the selected project"}`
                          : "Your personal workspace"}
                    </strong>
                    <p className="mt-1">Membership is checked when the run starts. Only shared durable knowledge from this exact scope is eligible; personal and agent-private memory stays excluded.</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-line bg-background p-4 text-sm leading-6 text-muted">
                    Saved memory, knowledge, graph results, and automatic personal context are excluded for this run.
                  </div>
                )}
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
                      Boolean(workflowActionPermission) ||
                      workflowInProgress
                    }
                    title={
                      workflowActionPermission ||
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
                      Boolean(workflowActionPermission) ||
                      !reviewedPlanReady ||
                      Boolean(activeWorkflowId)
                    }
                    title={
                      workflowActionPermission ||
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
                  {reviewedPlanContextCount ? (
                    <StatusPill
                      label={`${reviewedPlanContextCount} context item${reviewedPlanContextCount === 1 ? "" : "s"} pinned`}
                      tone="success"
                    />
                  ) : null}
                  {reviewedPlanModelScope ? (
                    <StatusPill
                      label={`Model pinned · ${reviewedPlanModelScope.replaceAll("_", " ")}`}
                      tone="success"
                    />
                  ) : null}
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
                  {workflowRun ? (
                    <>
                      <StatusPill label={stringPath(workflowRun, "run.status", "workflow created")} tone={toneForStatus(readPath(workflowRun, "run.status"))} />
                      <WorkflowOutcomePill status={readPath(workflowRun, "run.canonicalStatus.status")} />
                    </>
                  ) : null}
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
                {activeWorkflowId ? (
                  <RunTraceJourney
                    runId={activeWorkflowId}
                    kind="workflow"
                    live={!["completed", "failed", "canceled"].includes(activeWorkflowStatus)}
                  />
                ) : null}
                {!activeWorkflowId && (selectedActivityRunId || activeAgentRunId) ? (
                  <ConversationProgressPanel
                    runId={selectedActivityRunId || activeAgentRunId}
                    live={loading === "agent" && (!selectedActivityRunId || selectedActivityRunId === activeAgentRunId)}
                    canCancel={Boolean(activeAgentRunId && (selectedActivityRunId || activeAgentRunId) === activeAgentRunId)}
                    onCancel={() => void stopAgent()}
                  />
                ) : null}
                {workflowRun ? (
                  <>
                    <TaskProgressTimeline
                      events={streamEvents}
                      workflowRun={workflowRun}
                      running={loading === "agent"}
                    />
                  </>
                ) : null}
                {!activeWorkflowId && (selectedActivityRunId || activeAgentRunId) ? (
                  <RunCheckpointForkPanel
                    key={selectedActivityRunId || activeAgentRunId}
                    runId={selectedActivityRunId || activeAgentRunId}
                    disabled={Boolean(
                      runPermission ||
                      loading === "agent" ||
                      (!agentRunTerminal && (selectedActivityRunId || activeAgentRunId) === activeAgentRunId)
                    )}
                    disabledReason={runPermission || (loading === "agent" ? "Wait for the current run to reach a durable boundary." : undefined)}
                    onFork={(checkpointId, correction) => forkRunFromCheckpoint(
                      checkpointId,
                      correction,
                      selectedActivityRunId || activeAgentRunId,
                    )}
                  />
                ) : null}
                {workflowRun ? (
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
                ) : null}
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
                  {contextUseReceipt ? (
                    <ContextUseReceiptCard receipt={contextUseReceipt} />
                  ) : null}
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
        <AsaelLottieMascot
          state={terminal ? (tone === "success" ? "success" : "attention") : "thinking"}
          size="small"
          className={workspaceStyles.progressNode}
          decorative
        />
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
  mediaArtifacts = [],
  fileArtifacts = [],
  fileArtifactState = "none",
  workspaceArtifacts = [],
  workspaceArtifactState = "none",
}: {
  content: string;
  grounding?: GroundingReport;
  mediaArtifacts?: readonly CommandMediaArtifact[];
  fileArtifacts?: readonly CommandFileArtifact[];
  fileArtifactState?: CommandFileArtifactState;
  workspaceArtifacts?: readonly CommandWorkspaceArtifact[];
  workspaceArtifactState?: CommandWorkspaceArtifactState;
}) {
  const safeContent = typeof content === "string" ? content : "";
  const recoveredMedia = extractLegacyCommandMedia(safeContent);
  const renderedMedia = mergeCommandMediaArtifacts(
    mediaArtifacts,
    recoveredMedia.artifacts,
  );
  const lines = recoveredMedia.content.replaceAll("\r\n", "\n").split("\n");
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

  return (
    <div className="min-w-0 max-w-3xl">
      {blocks.length ? <div className="max-w-[72ch]">{blocks}</div> : null}
      {renderedMedia.length ? (
        <div className={clsx("space-y-4", blocks.length ? "mt-5" : "mt-0")}>
          {renderedMedia.map((artifact) => (
            <CommandMediaArtifactCard key={artifact.assetId} artifact={artifact} />
          ))}
        </div>
      ) : null}
      {fileArtifacts.length ? (
        <div className={clsx(
          "space-y-4",
          blocks.length || renderedMedia.length ? "mt-5" : "mt-0",
        )}>
          {fileArtifacts.map((artifact) => (
            <CommandFileArtifactCard
              key={`${artifact.artifactId}:v${artifact.version}`}
              artifact={artifact}
            />
          ))}
        </div>
      ) : null}
      {fileArtifactState === "unavailable" ? (
        <div className={clsx(
          "flex max-w-2xl items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm",
          blocks.length || renderedMedia.length ? "mt-5" : "mt-0",
        )} role="status">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-semibold">The created file preview is temporarily unavailable</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              The task result remains available. Refresh this conversation or open Results to retry the private file projection.
            </p>
          </div>
        </div>
      ) : null}
      {workspaceArtifacts.length ? (
        <div className={clsx(
          "grid gap-3 sm:grid-cols-2",
          blocks.length || renderedMedia.length || fileArtifacts.length ? "mt-5" : "mt-0",
        )}>
          {workspaceArtifacts.map((artifact) => (
            <CommandWorkspaceArtifactCard
              key={`${artifact.kind}:${artifact.resourceId}`}
              artifact={artifact}
            />
          ))}
        </div>
      ) : null}
      {workspaceArtifactState === "pending" ? (
        <div className={clsx(
          "flex max-w-2xl items-start gap-3 rounded-xl border border-line bg-surface-raised/60 px-4 py-3 text-sm",
          blocks.length || renderedMedia.length || fileArtifacts.length || workspaceArtifacts.length
            ? "mt-5"
            : "mt-0",
        )} role="status" aria-live="polite">
          <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <div>
            <p className="font-semibold">Checking for a Google Workspace result</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Asael is still finalizing this task. Any verified Google file will appear here automatically.
            </p>
          </div>
        </div>
      ) : null}
      {workspaceArtifactState === "unavailable" ? (
        <div className={clsx(
          "flex max-w-2xl items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm",
          blocks.length || renderedMedia.length || fileArtifacts.length || workspaceArtifacts.length
            ? "mt-5"
            : "mt-0",
        )} role="status">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-semibold">The Google Workspace file link is temporarily unavailable</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              The task result remains intact. Refresh this conversation to retry its verified Google file projection.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CommandFileArtifactCard({ artifact }: { artifact: CommandFileArtifact }) {
  const downloadUrl = commandArtifactContentUrl(
    artifact.artifactId,
    artifact.version,
    { download: true },
  );
  const typeLabel = artifact.kind === "presentation"
    ? "PowerPoint presentation"
    : artifact.kind === "spreadsheet"
      ? "Excel workbook"
      : artifact.kind === "pdf"
        ? "PDF document"
        : "Word document";
  const detail = artifact.kind === "presentation" && artifact.slideCount
    ? `${artifact.slideCount} ${artifact.slideCount === 1 ? "slide" : "slides"}`
    : formatMediaBytes(artifact.byteCount);

  return (
    <section
      className="group overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      aria-label={`${typeLabel}: ${artifact.filename}`}
    >
      <div className="grid min-h-52 bg-[radial-gradient(circle_at_72%_18%,color-mix(in_srgb,var(--color-primary)_18%,transparent),transparent_38%),linear-gradient(135deg,var(--color-foreground),color-mix(in_srgb,var(--color-foreground)_88%,var(--color-primary)))] px-5 py-6 text-background sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center sm:gap-8 sm:px-7">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full border border-background/15 bg-background/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-background/75 backdrop-blur">
            <FileText size={13} aria-hidden="true" />
            Created by Asael
          </span>
          <h3 className="mt-5 max-w-xl text-balance text-2xl font-semibold tracking-tight text-background">
            {artifact.title}
          </h3>
          <p className="mt-3 text-sm leading-6 text-background/70">
            {typeLabel} · {detail} · Editable · Private
          </p>
        </div>
        <div className="relative mx-auto mt-7 h-28 w-48 sm:mt-0" aria-hidden="true">
          <span className="absolute inset-x-4 bottom-0 top-5 rotate-6 rounded-lg border border-background/20 bg-background/10 shadow-2xl" />
          <span className="absolute inset-x-2 bottom-2 top-3 -rotate-3 rounded-lg border border-background/25 bg-background/15 shadow-2xl" />
          <span className="absolute inset-0 grid rounded-lg border border-background/30 bg-background/95 p-3 text-foreground shadow-2xl transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-1">
            <span className="h-1.5 w-10 rounded-full bg-primary/75" />
            <span className="mt-2 h-2 w-4/5 rounded-full bg-foreground/80" />
            <span className="mt-1 h-1 w-3/5 rounded-full bg-foreground/20" />
            <span className="mt-auto grid grid-cols-3 gap-1.5">
              <span className="h-7 rounded bg-primary/20" />
              <span className="h-7 rounded bg-foreground/10" />
              <span className="h-7 rounded bg-primary/10" />
            </span>
          </span>
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 bg-background/70 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{artifact.filename}</p>
          <p className="mt-0.5 text-xs text-muted">
            Version {artifact.version} · {formatMediaBytes(artifact.byteCount)} · Ready
          </p>
        </div>
        <a href={downloadUrl} className="action-button">
          <Download size={14} aria-hidden="true" />
          Download
        </a>
      </footer>
    </section>
  );
}

function CommandWorkspaceArtifactCard({
  artifact,
}: {
  artifact: CommandWorkspaceArtifact;
}) {
  const openUrl = commandWorkspaceArtifactUrl(artifact.kind, artifact.resourceId);
  const typeLabel = artifact.kind === "document"
    ? "Google Doc"
    : artifact.kind === "spreadsheet"
      ? "Google Sheet"
      : "Google Slides";
  const description = artifact.kind === "document"
    ? "Collaborative document"
    : artifact.kind === "spreadsheet"
      ? "Collaborative spreadsheet"
      : "Collaborative presentation";

  return (
    <section
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
      aria-label={`${typeLabel}: ${artifact.title}`}
    >
      <div className="relative flex-1 overflow-hidden px-5 pb-5 pt-4">
        <span
          className="pointer-events-none absolute -right-8 -top-12 size-36 rounded-full bg-primary/10 blur-2xl transition-transform duration-300 group-hover:scale-125"
          aria-hidden="true"
        />
        <div className="relative flex items-start justify-between gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary shadow-sm">
            <FileText size={20} aria-hidden="true" />
          </span>
          <span className="rounded-full border border-line bg-background/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted backdrop-blur">
            Google Workspace
          </span>
        </div>
        <h3 className="relative mt-5 line-clamp-2 text-balance text-lg font-semibold tracking-tight">
          {artifact.title}
        </h3>
        <p className="relative mt-2 text-sm leading-6 text-muted">
          {typeLabel} · {description} · Saved to Drive
        </p>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 bg-background/65 px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <CheckCircle2 size={13} className="text-success" aria-hidden="true" />
          Verified and ready
        </span>
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="action-button"
          aria-label={`Open ${artifact.title} in ${typeLabel}`}
        >
          Open in Google
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </footer>
    </section>
  );
}

function CommandMediaArtifactCard({ artifact }: { artifact: CommandMediaArtifact }) {
  const [readiness, setReadiness] = useState<PrivateMediaReadiness>("preparing");
  const downloadUrl = readiness === "ready"
    ? privateCaptureAssetContentUrl(artifact.assetId, { download: true })
    : undefined;
  const Icon = artifact.kind === "image" ? ImageIcon : Film;
  const operationLabel = artifact.operation === "clip"
    ? "Clipped video"
    : artifact.operation === "edit"
      ? `Edited ${artifact.kind}`
      : `Generated ${artifact.kind}`;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm" aria-label={`${operationLabel}: ${artifact.filename}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line/80 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{artifact.filename}</p>
            <p className="mt-0.5 text-xs text-muted">
              {operationLabel}
              {artifact.byteCount > 0 ? ` · ${formatMediaBytes(artifact.byteCount)}` : ""}
              {` · ${readiness === "ready" ? "Ready" : readiness === "failed" ? "Preview unavailable" : "Preparing"}`}
              {" · Private"}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-line bg-background px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          {artifact.kind}
        </span>
      </header>
      <PrivateMediaPreview
        assetId={artifact.assetId}
        kind={artifact.kind}
        alt={`${operationLabel}: ${artifact.filename}`}
        className="min-h-64 rounded-none sm:min-h-80"
        mediaClassName="max-h-[34rem]"
        onReadinessChange={setReadiness}
      />
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 bg-background/70 px-4 py-3 sm:px-5">
        <p className="text-xs leading-5 text-muted">
          Stored in your private Capture library.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/capture#media-studio-title" className="action-button">
            <Sparkles size={14} aria-hidden="true" />
            Media Studio
          </Link>
          {downloadUrl ? (
            <a href={downloadUrl} className="action-button">
              <Download size={14} aria-hidden="true" />
              Download
            </a>
          ) : (
            <span className="action-button cursor-not-allowed opacity-50" aria-disabled="true">
              <Download size={14} aria-hidden="true" />
              Preparing
            </span>
          )}
        </div>
      </footer>
    </section>
  );
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

function ContextUseReceiptCard({ receipt }: { receipt: ContextUseReceipt }) {
  return (
    <section className="overflow-hidden rounded-md border border-line bg-background" aria-label="Context use receipt">
      <header className="flex flex-col gap-2 border-b border-line px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Context actually used</h3>
            <StatusPill label={`${receipt.actualCount} used`} tone="success" />
          </div>
          <p className="mt-1 text-xs leading-5 text-muted">
            The run-bound receipt records the reviewed inclusions, exclusions, and final compiled set.
          </p>
        </div>
        <span className="font-mono text-[10px] text-muted" title={receipt.receiptSha256}>
          receipt {receipt.receiptSha256.slice(0, 12)}
        </span>
      </header>
      <div className="grid gap-px bg-line sm:grid-cols-4">
        {[
          ["Previewed", receipt.candidateCount],
          ["Included", receipt.includedCount],
          ["Excluded", receipt.excludedCount],
          ["Actually used", receipt.actualCount],
        ].map(([label, count]) => (
          <div key={String(label)} className="bg-background px-3 py-3">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
            <span className="mt-1 block text-lg font-semibold">{count}</span>
          </div>
        ))}
      </div>
      <div className="space-y-3 px-3 py-3 text-xs">
        <ContextReceiptItems label="Used" ids={receipt.actualEvidenceIds} empty="No saved context was compiled into this run." />
        {receipt.droppedEvidenceIds.length ? (
          <ContextReceiptItems label="Selected but unavailable" ids={receipt.droppedEvidenceIds} />
        ) : null}
        {receipt.userExclusionIds.length ? (
          <details>
            <summary className="cursor-pointer font-semibold text-muted">
              Excluded by you ({receipt.userExclusionIds.length})
            </summary>
            <div className="mt-2">
              <ContextReceiptItems ids={receipt.userExclusionIds} />
            </div>
          </details>
        ) : null}
        <p className="font-mono text-[10px] text-muted" title={receipt.selectionSha256}>
          selection {receipt.selectionSha256.slice(0, 12)}
        </p>
      </div>
    </section>
  );
}

function ContextReceiptItems({
  label,
  ids,
  empty,
}: {
  label?: string;
  ids: string[];
  empty?: string;
}) {
  return (
    <div>
      {label ? <p className="mb-2 font-semibold text-foreground">{label}</p> : null}
      {ids.length ? (
        <div className="flex flex-wrap gap-2">
          {ids.map((id) => (
            <span key={id} className="rounded-md bg-surface-raised px-2 py-1 font-mono text-[10px] text-muted">
              {id}
            </span>
          ))}
        </div>
      ) : empty ? <p className="leading-5 text-muted">{empty}</p> : null}
    </div>
  );
}

function RunTraceJourney({
  runId,
  kind,
  live,
}: {
  runId: string;
  kind: "run" | "workflow";
  live: boolean;
}) {
  const [stages, setStages] = useState<RunTraceStage[]>([]);
  const [traceRef, setTraceRef] = useState("");
  const [outcome, setOutcome] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let firstLoad = true;
    const loadTrace = async (showLoading: boolean) => {
      if (showLoading) setState("loading");
      try {
        const payload = asRecord(await readJson(
          kind === "workflow"
            ? `/api/workflows/${encodeURIComponent(runId)}/trajectory`
            : `/api/runs/${encodeURIComponent(runId)}/trajectory`,
          { signal: controller.signal },
        ));
        if (controller.signal.aborted) return;
        const hierarchy = asRecord(payload.traceHierarchy);
        const parsedStages = Array.isArray(hierarchy.stages)
          ? hierarchy.stages.map(asRecord).flatMap(parseRunTraceStage)
          : [];
        setStages(parsedStages.sort((left, right) => left.ordinal - right.ordinal));
        setTraceRef(stringValue(hierarchy.traceId).slice(0, 12));
        setOutcome(stringValue(hierarchy.outcome));
        setError(undefined);
        setState("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Trace could not be loaded.");
        setState("error");
      }
    };
    const stopRefresh = live
      ? startVisibleRefresh({
          onRefresh: () => {
            const showLoading = firstLoad;
            firstLoad = false;
            return loadTrace(showLoading);
          },
          pollIntervalMs: 4_000,
          refreshOnStart: true,
        })
      : undefined;
    if (!live) void loadTrace(true);
    return () => {
      stopRefresh?.();
      controller.abort();
    };
  }, [kind, live, refreshVersion, runId]);

  const observed = stages.filter((stage) => stage.status === "observed").length;
  const gaps = stages.filter((stage) => stage.status === "missing").length;

  return (
    <section className="mb-4 overflow-hidden rounded-md border border-line bg-background" aria-label="Run trace journey">
      <header className="flex flex-col gap-3 border-b border-line px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">Trace journey</p>
            {outcome ? <StatusPill label={outcome} tone={toneForStatus(outcome)} /> : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted">
            Intent through verified outcome and memory, joined across owner-scoped event streams.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {traceRef ? <span className="font-mono text-[10px] text-muted">trace {traceRef}</span> : null}
          <button
            type="button"
            onClick={() => setRefreshVersion((version) => version + 1)}
            disabled={state === "loading"}
            className="inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={13} className={state === "loading" ? "animate-spin" : ""} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>
      {state === "loading" && !stages.length ? (
        <p className="flex items-center gap-2 px-3 py-4 text-sm text-muted" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading correlated trace…
        </p>
      ) : state === "error" ? (
        <p className="m-3 rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs leading-5 text-muted" role="status">
          {error || "Trace could not be loaded."}
        </p>
      ) : stages.length ? (
        <>
          <div className="grid grid-cols-3 gap-px bg-line lg:grid-cols-9">
            {stages.map((stage) => (
              <details key={stage.id} className="group min-w-0 bg-background open:col-span-3 lg:open:col-span-3">
                <summary className="flex min-h-24 cursor-pointer list-none flex-col justify-between gap-2 px-2.5 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center justify-between gap-2">
                    <span className={clsx(
                      "grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
                      traceStageClasses(stage.status),
                    )}>
                      {stage.status === "observed" ? <Check size={12} aria-hidden="true" /> : stage.ordinal + 1}
                    </span>
                    <ChevronRight size={12} className="text-muted transition group-open:rotate-90" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block truncate text-xs font-semibold">{stage.label}</span>
                    <span className="mt-1 block text-[10px] text-muted">{traceStageLabel(stage.status)}</span>
                  </span>
                </summary>
                <div className="border-t border-line px-3 py-3">
                  {stage.events.length ? (
                    <ol className="space-y-2">
                      {stage.events.map((event) => (
                        <li key={event.eventRef} className="rounded-md bg-surface px-2.5 py-2 text-[11px] leading-5">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-primary">{event.type}</span>
                            <time className="shrink-0 text-muted" dateTime={event.at}>{formatRelativeThreadTime(event.at)}</time>
                          </span>
                          <span className="mt-0.5 block text-muted">{event.summary}</span>
                          <span className="mt-0.5 block font-mono text-[10px] text-muted">
                            {event.streamKind} · event {event.eventRef.slice(0, 8)}
                            {event.parentEventRef || event.causationRef ? " · linked" : ""}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-xs leading-5 text-muted">
                      {stage.status === "not_applicable"
                        ? "This run did not use this stage."
                        : stage.status === "pending"
                          ? "This required stage has not been reached yet."
                          : "Required trace evidence is missing."}
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
          <p className="border-t border-line px-3 py-2 text-[11px] leading-5 text-muted">
            {observed} of 9 stages observed{gaps ? ` · ${gaps} required gap${gaps === 1 ? "" : "s"}` : ""}. Event references are hashed; prompts, outputs, credentials, and private reasoning are excluded.
          </p>
        </>
      ) : null}
    </section>
  );
}

function parseRunTraceStage(stage: JsonRecord): RunTraceStage[] {
  const id = stringValue(stage.id);
  const status = stringValue(stage.status);
  if (!isRunTraceStageId(id) || !isTraceStageStatus(status)) return [];
  const events = Array.isArray(stage.events)
    ? stage.events.map(asRecord).flatMap((event) => {
        const eventRef = stringValue(event.eventRef);
        const type = stringValue(event.type);
        const at = stringValue(event.at);
        if (!eventRef || !type || !at) return [];
        return [{
          eventRef,
          parentEventRef: stringValue(event.parentEventRef) || undefined,
          causationRef: stringValue(event.causationRef) || undefined,
          streamKind: stringValue(event.streamKind, "event"),
          type,
          seq: numberValue(event.seq, 0),
          at,
          summary: stringValue(event.summary, "Trace event recorded"),
        }];
      })
    : [];
  return [{
    id,
    label: stringValue(stage.label, id),
    ordinal: numberValue(stage.ordinal, 0),
    required: Boolean(stage.required),
    status,
    eventCount: numberValue(stage.eventCount, events.length),
    events,
  }];
}

function isRunTraceStageId(value: string): value is RunTraceStage["id"] {
  return ["intent", "plan", "agent", "model", "tool", "evidence", "effect", "verification", "memory"].includes(value);
}

function isTraceStageStatus(value: string): value is TraceStageStatus {
  return ["observed", "pending", "missing", "not_applicable"].includes(value);
}

function traceStageLabel(status: TraceStageStatus) {
  if (status === "observed") return "Observed";
  if (status === "pending") return "Pending";
  if (status === "missing") return "Missing";
  return "Not used";
}

function traceStageClasses(status: TraceStageStatus) {
  if (status === "observed") return "bg-success/15 text-success";
  if (status === "pending") return "bg-primary/15 text-primary";
  if (status === "missing") return "bg-danger/15 text-danger";
  return "bg-surface-raised text-muted";
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
    const workflowBudgetLimits = asRecord(readPath(workflow, "input.budgetLimits"));
    const workflowBudgetEvent = [...workflowEvents].reverse().find(
      (event) => stringValue(event.type) === "workflow.budget_reserved",
    );
    const workflowBudgetUsed = asRecord(readPath(workflowBudgetEvent, "payload.used"));
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
        <header className="flex flex-col gap-3 border-b border-line px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold">Workflow progress</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {workflowSteps.length
                ? `${completed} of ${workflowSteps.length} stages complete`
                : "Loading the workflow stages…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <StatusPill
              label={stringValue(workflow.status, "starting").replaceAll("_", " ")}
              tone={toneForStatus(workflow.status)}
            />
            <WorkflowOutcomePill status={readPath(workflow, "canonicalStatus.status")} />
          </div>
        </header>
        {Object.keys(workflowBudgetLimits).length ? (
          <p className="border-b border-line px-3 py-2 text-[11px] leading-5 text-muted">
            Budget used: {numberValue(workflowBudgetUsed.modelTurns, 0)} / {numberValue(workflowBudgetLimits.modelTurns, 0)} turns · {numberValue(workflowBudgetUsed.toolCalls, 0)} / {numberValue(workflowBudgetLimits.toolCalls, 0)} tools · {numberValue(workflowBudgetUsed.retries, 0)} / {numberValue(workflowBudgetLimits.retries, 0)} retries · {numberValue(workflowBudgetUsed.replans, 0)} / {numberValue(workflowBudgetLimits.replans, 0)} replans
          </p>
        ) : null}
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

function PromptQueuePanel({
  items,
  busyId,
  error,
  dispatchLocked,
  onEdit,
  onPause,
  onResume,
  onMove,
  onRun,
  onDelete,
  onRefresh,
}: {
  items: PromptQueueItem[];
  busyId: string;
  error?: string;
  dispatchLocked: boolean;
  onEdit: (item: PromptQueueItem, prompt: string) => void;
  onPause: (item: PromptQueueItem) => void;
  onResume: (item: PromptQueueItem) => void;
  onMove: (item: PromptQueueItem, direction: -1 | 1) => void;
  onRun: (item: PromptQueueItem) => void;
  onDelete: (item: PromptQueueItem) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [editValue, setEditValue] = useState("");
  if (!items.length && !error) return null;
  const movable = items.filter((item) =>
    item.state === "queued" || item.state === "paused"
  );
  return (
    <section className={workspaceStyles.queueDock} aria-labelledby="prompt-queue-title">
      <div className={workspaceStyles.queueCard}>
        <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="flex min-w-0 items-center gap-3 text-left"
            aria-expanded={expanded}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <Clock3 size={16} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span id="prompt-queue-title" className="block text-sm font-semibold">Prompt queue</span>
              <span className="block truncate text-xs text-muted">
                {items.filter((item) => item.state === "queued").length} ready · server-synced across your devices
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground"
            aria-label="Refresh prompt queue"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </header>
        {error ? (
          <p className="mx-4 mb-3 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger" role="status">
            {error}
          </p>
        ) : null}
        {expanded && items.length ? (
          <ol className="max-h-72 space-y-2 overflow-y-auto border-t border-line/70 px-3 py-3 sm:px-4">
            {items.map((item) => {
              const activeIndex = movable.findIndex((candidate) => candidate.id === item.id);
              const editable = item.state === "queued" || item.state === "paused" || item.state === "failed";
              const busy = busyId === item.id;
              const editing = editingId === item.id;
              return (
                <li key={item.id} className="rounded-xl border border-line/75 bg-background/70 px-3 py-2.5">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={clsx(
                      "mt-1 size-2 shrink-0 rounded-full",
                      item.state === "completed" ? "bg-success" :
                        item.state === "failed" ? "bg-danger" :
                          item.state === "dispatching" ? "animate-pulse bg-primary" :
                            item.state === "paused" ? "bg-warning" : "bg-primary",
                    )} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <div className="space-y-2">
                          <textarea
                            value={editValue}
                            onChange={(event) => setEditValue(event.currentTarget.value)}
                            rows={3}
                            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-5 outline-none focus:border-primary"
                            aria-label="Edit queued prompt"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={!editValue.trim() || busy}
                              onClick={() => {
                                onEdit(item, editValue.trim());
                                setEditingId("");
                              }}
                              className="min-h-8 rounded-full bg-primary px-3 text-xs font-semibold text-primary-ink disabled:opacity-40"
                            >
                              Save
                            </button>
                            <button type="button" onClick={() => setEditingId("")} className="min-h-8 rounded-full px-3 text-xs font-semibold text-muted hover:bg-surface-raised">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <p className="line-clamp-2 text-sm font-medium leading-5">{item.prompt}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                        <span className="font-semibold capitalize text-foreground">{item.state}</span>
                        <span>{item.agent.logicalAgentId} v{item.agent.definitionVersion}</span>
                        <span>
                          {item.model.providerId} · {item.model.modelId}
                          {item.model.reasoningLevel
                            ? ` · ${item.model.reasoningLevel} thinking`
                            : ""}
                        </span>
                        {item.contextReferenceCount ? (
                          <span>
                            {item.contextReferenceCount} context item
                            {item.contextReferenceCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {item.progressLabel ? <span>{item.progressLabel}</span> : null}
                      </div>
                    </div>
                    {busy ? <Loader2 size={14} className="mt-1 shrink-0 animate-spin text-primary" aria-label="Saving queue change" /> : null}
                  </div>
                  {!editing ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line/60 pt-2">
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(item.id);
                            setEditValue(item.prompt);
                          }}
                          disabled={busy}
                          className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
                          aria-label="Edit queued prompt"
                        ><Pencil size={13} aria-hidden="true" /></button>
                      ) : null}
                      {item.state === "queued" ? (
                        <button type="button" onClick={() => onPause(item)} disabled={busy} className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-raised hover:text-foreground disabled:opacity-40" aria-label="Pause queued prompt"><Pause size={13} aria-hidden="true" /></button>
                      ) : item.state === "paused" || item.state === "failed" ? (
                        <button type="button" onClick={() => onResume(item)} disabled={busy} className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-raised hover:text-foreground disabled:opacity-40" aria-label="Resume queued prompt"><Play size={13} aria-hidden="true" /></button>
                      ) : null}
                      {activeIndex >= 0 ? (
                        <>
                          <button type="button" onClick={() => onMove(item, -1)} disabled={busy || activeIndex === 0} className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-raised hover:text-foreground disabled:opacity-30" aria-label="Move prompt earlier"><ArrowUp size={13} aria-hidden="true" /></button>
                          <button type="button" onClick={() => onMove(item, 1)} disabled={busy || activeIndex === movable.length - 1} className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-raised hover:text-foreground disabled:opacity-30" aria-label="Move prompt later"><ArrowDown size={13} aria-hidden="true" /></button>
                        </>
                      ) : null}
                      {(item.state === "queued" || item.state === "paused") ? (
                        <button type="button" onClick={() => onRun(item)} disabled={busy || dispatchLocked} className="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-semibold text-background disabled:opacity-35"><Play size={12} aria-hidden="true" />Run now</button>
                      ) : null}
                      {item.state !== "dispatching" ? (
                        <button type="button" onClick={() => onDelete(item)} disabled={busy} className={clsx("grid size-8 place-items-center rounded-full text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40", item.state !== "queued" && item.state !== "paused" ? "ml-auto" : "")} aria-label="Remove queued prompt"><Trash2 size={13} aria-hidden="true" /></button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

function GoalStage({
  goal,
  mode,
  approvalRequired,
  preferredAgent,
  commandReferences,
  commandModelScope,
  commandModelSelection,
  loading,
  contextLoading,
  contextScope,
  personalContextAvailable,
  missionContextAvailable,
  projectId,
  projects,
  projectSelectionLocked,
  contextReady,
  contextLocked,
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
  voiceConversationId,
  onGoalChange,
  onModeChange,
  onApprovalChange,
  onClearPreferredAgent,
  onSelectCommandReference,
  onRemoveCommandReference,
  onCommandSlashAction,
  onCommandModelSelection,
  onContext,
  onContextScopeChange,
  onProjectChange,
  onReviewContext,
  onPlan,
  onAgent,
  onQueue,
  onVoiceConversationBound,
  onVoiceTranscript,
  onStop,
  onWorkflow,
}: {
  goal: string;
  mode: AgentMode;
  approvalRequired: boolean;
  preferredAgent?: AgentPresentation;
  commandReferences: readonly CommandContextCatalogItem[];
  commandModelScope: ModelAssignmentScope;
  commandModelSelection?: CommandModelSelectionRequest;
  loading?: string;
  contextLoading: boolean;
  contextScope: ActiveContextScopeId;
  personalContextAvailable: boolean;
  missionContextAvailable: boolean;
  projectId: string;
  projects: CommandProject[];
  projectSelectionLocked: boolean;
  contextReady: boolean;
  contextLocked: boolean;
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
  voiceConversationId?: string;
  onGoalChange: (value: string) => void;
  onModeChange: (value: AgentMode) => void;
  onApprovalChange: (value: boolean) => void;
  onClearPreferredAgent: () => void;
  onSelectCommandReference: (item: CommandContextCatalogItem) => void;
  onRemoveCommandReference: (item: CommandContextCatalogItem) => void;
  onCommandSlashAction: (action: CommandSlashAction) => void;
  onCommandModelSelection: (
    selection: CommandModelSelectionRequest | undefined,
  ) => void;
  onContext: () => void;
  onContextScopeChange: (scope: ActiveContextScopeId) => void;
  onProjectChange: (projectId: string) => void;
  onReviewContext: () => void;
  onPlan: () => void;
  onAgent: () => void;
  onQueue: () => void;
  onVoiceConversationBound: (conversationId: string) => void;
  onVoiceTranscript: (
    transcript: string,
    conversationId: string,
    review: VoiceCommandReview,
  ) => Promise<VoiceCommandReply | undefined>;
  onStop: () => void;
  onWorkflow: () => void;
}) {
  const goalMissing = !goal.trim();
  const activeRun = loading === "agent" || workflowInProgress;
  const draftLocked = Boolean(loading && loading !== "agent");
  const contextLabel = contextScope !== "explicit_selection"
    ? contextScopeOption(contextScope).label
    : contextLoading
      ? "Finding context"
      : contextError
        ? "No saved context"
        : contextReady
          ? contextLocked
            ? `Locked ${contextSelectedCount}/${contextTotalCount}`
            : `Review ${contextSelectedCount}/${contextTotalCount}`
          : "Context";
  return (
    <section className={clsx("border-t border-line/70 bg-background/95 px-3 py-2 backdrop-blur sm:px-5", workspaceStyles.composerDock)} aria-labelledby="command-composer-title">
      <div className={clsx("mx-auto max-w-3xl", workspaceStyles.composerWidth)}>
        <h2 id="command-composer-title" className="sr-only">Message Asael</h2>
        <div className={clsx("rounded-[1.35rem] border border-line bg-surface shadow-[0_10px_32px_-28px_rgba(0,0,0,0.5)] focus-within:border-primary/60", workspaceStyles.composer)}>
          <span className={workspaceStyles.composerAura} aria-hidden="true"><Sparkles size={15} /></span>
          {preferredAgent ? (
            <div className="flex items-center justify-between gap-3 border-b border-line/70 px-3 py-1.5">
              <span className="min-w-0 truncate text-xs text-muted" title={`${preferredAgent.visualIdentity} Voice: ${preferredAgent.voice}`}>
                Working with <strong className="font-semibold text-foreground">{preferredAgent.name}</strong>
                <span> · {preferredAgent.role}</span>
              </span>
              <button type="button" onClick={onClearPreferredAgent} className="min-h-8 rounded-full px-2 text-xs font-semibold text-primary hover:bg-primary/10">
                Route automatically
              </button>
            </div>
          ) : null}

          <CommandComposerField
            value={goal}
            disabled={draftLocked}
            placeholder={activeRun
              ? "Add the next prompt… · / Skills · @ context"
              : hasConversation
                ? "Ask a follow-up… · / Skills · @ context"
                : "Message Asael… · / Skills · @ context"}
            selected={commandReferences}
            onChange={onGoalChange}
            onSubmit={() => {
              if (!draftLocked && !goalMissing && !runDisabledReason) {
                if (activeRun) onQueue();
                else onAgent();
              }
            }}
            onSlashAction={onCommandSlashAction}
            onSelectReference={onSelectCommandReference}
            onRemoveReference={onRemoveCommandReference}
          />

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
                <option value="execute">Act</option>
                <option value="learn">Knowledge</option>
              </select>
              <CommandModelPicker
                scope={commandModelScope}
                value={commandModelSelection}
                disabled={draftLocked}
                onChange={onCommandModelSelection}
              />
              {contextScope === "project" ? (
                <>
                  <label className="sr-only" htmlFor="command-project-scope">Project context</label>
                  <select
                    id="command-project-scope"
                    value={projectId}
                    disabled={draftLocked || projectSelectionLocked}
                    onChange={(event) => onProjectChange(event.currentTarget.value)}
                    className="min-h-8 max-w-44 shrink-0 rounded-full border-0 bg-surface-raised px-2.5 text-[11px] font-semibold text-muted outline-none hover:text-foreground"
                  >
                    <option value="">Choose project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.title}</option>
                    ))}
                  </select>
                </>
              ) : null}
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
              <label className="sr-only" htmlFor="command-context-scope">Context scope</label>
              <select
                id="command-context-scope"
                value={contextScope}
                disabled={draftLocked}
                onChange={(event) => onContextScopeChange(
                  event.currentTarget.value as ActiveContextScopeId,
                )}
                className="min-h-8 shrink-0 rounded-full border-0 bg-surface-raised px-2.5 text-[11px] font-semibold text-muted outline-none hover:text-foreground"
              >
                {CONTEXT_SCOPE_OPTIONS.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={(option.id === "personal" && !personalContextAvailable) ||
                      (option.id === "mission" && !missionContextAvailable)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={contextReady || contextError ? onReviewContext : onContext}
                disabled={contextLoading || goalMissing || Boolean(readDisabledReason)}
                title={goalMissing ? "Write a message first." : readDisabledReason}
                className={clsx(
                  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold transition",
                  contextLocked ? "bg-success/10 text-success" : contextReady || contextError ? "bg-warning/10 text-warning" : "bg-surface-raised text-muted hover:text-foreground",
                )}
              >
                {contextLoading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />}
                <span className="hidden md:inline">{contextLabel}</span>
                {contextReady ? (
                  <span className="md:hidden">
                    {contextScope === "explicit_selection"
                      ? `${contextSelectedCount}/${contextTotalCount}`
                      : "Scope"}
                  </span>
                ) : null}
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

            <div className="flex shrink-0 items-center gap-1">
              <VoiceMode
                disabled={draftLocked || contextLoading || Boolean(voiceDisabledReason)}
                disabledReason={voiceDisabledReason}
                agentName={preferredAgent?.name || "Asael"}
                agentVoice={preferredAgent?.voice}
                conversationId={voiceConversationId}
                mode={mode}
                onConversationBound={onVoiceConversationBound}
                onTranscript={onVoiceTranscript}
              />
              <button
                type="button"
                onClick={onQueue}
                disabled={draftLocked || goalMissing || Boolean(runDisabledReason)}
                title={goalMissing ? "Write a message first." : "Add to the persistent prompt queue"}
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-[11px] font-semibold text-primary transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="Add prompt to queue"
              >
                <Clock3 size={14} aria-hidden="true" />
                <span className="hidden sm:inline">Queue</span>
              </button>
              {loading === "agent" ? (
                <button type="button" onClick={onStop} className="grid size-9 shrink-0 place-items-center rounded-full bg-danger text-white" aria-label="Stop response">
                  <Square size={13} aria-hidden="true" />
                </button>
              ) : activeRun ? null : (
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
              )}
            </div>
          </div>
        </div>
        {workflowInProgress ? <p className="mt-1.5 px-2 text-center text-[10px] leading-4 text-muted">This conversation is locked while active work finishes. New messages can be added to the persistent queue.</p> : null}
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

function RunCheckpointForkPanel({
  runId,
  disabled,
  disabledReason,
  onFork,
}: {
  runId: string;
  disabled: boolean;
  disabledReason?: string;
  onFork: (checkpointId: string, correction: string) => Promise<void>;
}) {
  const [checkpoints, setCheckpoints] = useState<TrajectoryCheckpoint[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState("");
  const [correction, setCorrection] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [childForkCount, setChildForkCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void readJson(`/api/runs/${encodeURIComponent(runId)}/trajectory`, {
      signal: controller.signal,
    }).then((payload) => {
      if (controller.signal.aborted) return;
      const record = asRecord(payload);
      const trajectory = asRecord(record.trajectory);
      const items = Array.isArray(trajectory.checkpoints)
        ? trajectory.checkpoints.map(asRecord).flatMap((item) => {
            const checkpointId = stringValue(item.checkpointId);
            const checkpointSha256 = stringValue(item.checkpointSha256);
            const boundaryKind = stringValue(item.boundaryKind);
            const boundaryPhase = stringValue(item.boundaryPhase);
            const lifecycleState = stringValue(item.lifecycleState);
            const resumeDisposition = stringValue(item.resumeDisposition);
            if (
              !checkpointId ||
              !checkpointSha256 ||
              !isTrajectoryBoundaryKind(boundaryKind) ||
              !isTrajectoryBoundaryPhase(boundaryPhase) ||
              !isTrajectoryLifecycleState(lifecycleState) ||
              !isTrajectoryResumeDisposition(resumeDisposition)
            ) return [];
            return [{
              checkpointId,
              checkpointSha256,
              sequence: numberValue(item.sequence, 0),
              boundaryKind,
              boundaryPhase,
              boundaryAttempt: numberValue(item.boundaryAttempt, 1),
              lifecycleState,
              resumeDisposition,
              recordedAt: stringValue(item.recordedAt),
            } satisfies TrajectoryCheckpoint];
          })
        : [];
      items.sort((left, right) => left.sequence - right.sequence);
      setCheckpoints(items);
      setSelectedCheckpointId(items.at(-1)?.checkpointId || "");
      const lineage = asRecord(record.lineage);
      setChildForkCount(Array.isArray(lineage.children) ? lineage.children.length : 0);
      setState("ready");
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "Trajectory could not be loaded.");
      setState("error");
    });
    return () => controller.abort();
  }, [runId]);

  const selected = checkpoints.find(
    (checkpoint) => checkpoint.checkpointId === selectedCheckpointId,
  );
  const submitDisabled = disabled || submitting || !selected || !correction.trim();

  return (
    <section className="mt-4 rounded-xl border border-line/80 bg-background px-3 py-3" aria-labelledby="run-fork-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p id="run-fork-title" className="text-sm font-semibold">Correct from a checkpoint</p>
          <p className="mt-1 text-xs leading-5 text-muted">
            Inspect a recorded boundary, add a correction, and continue as a new trace. The original history stays unchanged.
          </p>
        </div>
        {childForkCount ? (
          <span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
            {childForkCount} fork{childForkCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {state === "loading" ? (
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-muted" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading checkpoint trajectory…
        </p>
      ) : null}
      {state === "error" ? (
        <p className="mt-3 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger" role="alert">
          {loadError || "Trajectory could not be loaded."}
        </p>
      ) : null}
      {state === "ready" && !checkpoints.length ? (
        <p className="mt-3 rounded-md border border-dashed border-line bg-surface px-3 py-2 text-xs leading-5 text-muted">
          This run predates checkpoint capture, so it cannot be forked from an exact recorded boundary.
        </p>
      ) : null}
      {state === "ready" && checkpoints.length ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-xs font-semibold" htmlFor={`run-fork-checkpoint-${runId}`}>
              Recorded boundary
            </label>
            <select
              id={`run-fork-checkpoint-${runId}`}
              value={selectedCheckpointId}
              disabled={disabled || submitting}
              onChange={(event) => setSelectedCheckpointId(event.currentTarget.value)}
              className="mt-2 min-h-10 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none focus:border-primary disabled:opacity-60"
            >
              {checkpoints.map((checkpoint) => (
                <option key={checkpoint.checkpointId} value={checkpoint.checkpointId}>
                  {`Step ${checkpoint.sequence + 1} · ${checkpoint.boundaryKind} ${checkpoint.boundaryPhase} · attempt ${checkpoint.boundaryAttempt}`}
                </option>
              ))}
            </select>
            {selected ? (
              <p className="mt-2 font-mono text-[11px] leading-5 text-muted">
                {selected.lifecycleState} · {selected.resumeDisposition} · {formatCheckpointTime(selected.recordedAt)} · {selected.checkpointId.slice(0, 18)}…
              </p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-semibold" htmlFor={`run-fork-correction-${runId}`}>
              Correction for the new trace
            </label>
            <textarea
              id={`run-fork-correction-${runId}`}
              value={correction}
              maxLength={4_000}
              rows={3}
              disabled={disabled || submitting}
              onChange={(event) => setCorrection(event.currentTarget.value)}
              placeholder="Explain what should change from this boundary…"
              className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm leading-5 outline-none focus:border-primary disabled:opacity-60"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-muted">
              Prior approvals never carry over; consequential actions require a new decision.
            </p>
            <button
              type="button"
              disabled={submitDisabled}
              title={disabledReason}
              onClick={() => {
                if (!selected || !correction.trim()) return;
                setSubmitting(true);
                void onFork(selected.checkpointId, correction).finally(() => setSubmitting(false));
              }}
              className="primary-button shrink-0"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
              Fork corrected trace
            </button>
          </div>
        </div>
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

function WorkflowOutcomePill({ status }: { status: unknown }) {
  const outcome = stringValue(status).trim().toLowerCase();
  if (!outcome) {
    return null;
  }
  const label = outcome.replaceAll("_", " ");
  return (
    <span
      aria-label={`Workflow outcome: ${label}`}
      className={clsx(
        "inline-flex shrink-0 items-center self-center rounded-md px-2 py-1 font-mono text-[11px]",
        pillTone(toneForWorkflowOutcome(outcome)),
      )}
    >
      Outcome: {label}
    </span>
  );
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

function personalContextConsentView(value: unknown): PersonalContextConsentView {
  const record = asRecord(value);
  const notice = asRecord(record.notice);
  const state = stringValue(record.state);
  const text = stringValue(notice.text);
  const sha256 = stringValue(notice.sha256);
  if (
    (state !== "active" && state !== "inactive") ||
    !text ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new Error("The personal-context consent response is invalid.");
  }
  return { state, notice: { text, sha256 } };
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
    const contextCount = numberValue(event.contextCount, 0);
    const context = {
      disabled_session: "durable context off for this session",
      disabled_project_unavailable: "project context isolated until authorized",
      excluded_by_user: "saved context excluded by you",
      selected_by_user: `${contextCount} selected context item${contextCount === 1 ? "" : "s"} resolved`,
      retrieved: `${contextCount} relevant context item${contextCount === 1 ? "" : "s"} retrieved`,
      skipped: "memory retrieval skipped as unnecessary",
    }[event.contextDecision] || "context decision recorded";
    const toolCount = numberValue(event.toolCount, 0);
    const tools = `${toolCount} governed tool${toolCount === 1 ? "" : "s"} available`;
    const budgetLimits = asRecord(event.budgetLimits);
    const budget = `${numberValue(budgetLimits.modelTurns, 0)} turns, ${numberValue(budgetLimits.toolCalls, 0)} tool calls, ${numberValue(budgetLimits.tokens, 0).toLocaleString()} tokens, ${(numberValue(budgetLimits.wallTimeMs, 0) / 1_000).toFixed(0)}s`;
    const adaptationVersions = Array.isArray(event.adaptationActivationVersions)
      ? event.adaptationActivationVersions.filter((version): version is number => typeof version === "number" && Number.isFinite(version))
      : [];
    const adaptationEvidenceCount = numberValue(event.adaptationEvidenceCount, 0);
    const learningSampleSize = numberValue(event.learningSampleSize, 0);
    const adaptation = adaptationVersions.length
      ? `adaptation ${adaptationVersions.map((version) => `v${version}`).join(", ")} active`
      : adaptationEvidenceCount
        ? `${adaptationEvidenceCount} outcome${adaptationEvidenceCount === 1 ? "" : "s"} observed with no implicit behavior change`
        : learningSampleSize
          ? `legacy outcome evidence from ${learningSampleSize} prior run${learningSampleSize === 1 ? "" : "s"}`
          : "adaptation baseline";
    const reason = Array.isArray(event.contextRationale)
      ? stringValue(event.contextRationale[0])
      : "";
    const provider = event.provider === "google"
      ? "Gemini"
      : event.provider === "openai"
        ? "OpenAI"
        : event.provider === "anthropic"
          ? "Anthropic"
          : "Local fallback";
    return `${provider} · ${event.tier} route · ${context} · ${tools} · budget ${budget} · ${adaptation}.${reason ? ` ${reason}` : ""}`;
  }
  if (event.type === "model") {
    const estimatedCostUsd = numberValue(event.estimatedCostUsd, Number.NaN);
    const cost = Number.isFinite(estimatedCostUsd) ? `$${estimatedCostUsd.toFixed(6)}` : "cost rate not configured";
    const iterationCount = numberValue(event.iterationCount, 0);
    const iteration = numberValue(event.iteration, 0);
    const loop = iterationCount
      ? ` across ${iterationCount} loop pass${iterationCount === 1 ? "" : "es"}`
      : iteration
        ? ` on loop pass ${iteration}`
        : "";
    const thinking = event.reasoningEffort
      ? ` · ${reasoningEffortLabel(event.reasoningEffort)} thinking`
      : "";
    const selected = event.commandSelectionSha256 ? " · chosen for this message" : "";
    return `${event.provider === "google" ? "Google · " : event.provider === "anthropic" ? "Anthropic · " : "OpenAI · "}${stringValue(event.model, "Assigned model")}${thinking}${selected} used ${numberValue(event.totalTokens, 0).toLocaleString()} tokens${loop} in ${(numberValue(event.latencyMs, 0) / 1_000).toFixed(1)}s (${cost})${event.fallbackUsed ? "; fallback used" : ""}.`;
  }
  if (event.type === "council_member") {
    if (event.status === "thinking") return `${event.agentName} is working independently as ${event.role}.`;
    if (event.status === "failed") return `${event.agentName} could not complete its council pass${event.summary ? `: ${event.summary}` : "."}`;
    const lifecycle = event.lifecycleState === "result_accepted"
      ? " Parent evaluation accepted the proposed result."
      : event.lifecycleState === "completed_proposed"
        ? " The result remains proposed pending parent evaluation."
        : "";
    const confidence = numberValue(event.confidence, Number.NaN);
    return `${stringValue(event.agentName, "Specialist")} completed its ${stringValue(event.role, "review").toLowerCase()} pass${Number.isFinite(confidence) ? ` at ${Math.round(confidence * 100)}% confidence.` : "."}${lifecycle}`;
  }
  if (event.type === "council_verdict") {
    const score = numberValue(event.score, 0);
    return event.status === "passed"
      ? `Sentinel accepted the result at ${Math.round(score * 100)}%.`
      : event.status === "revised"
        ? `Sentinel requested changes; Atlas revised the answer (${Math.round(score * 100)}% initial score).`
        : stringValue(event.assessment, "Sentinel could not accept the result.");
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
  if (event.type === "budget_exhausted") {
    return event.message || "The run stopped before exceeding its authorized budget.";
  }
  if (event.type === "done") {
    return "Agent run completed.";
  }
  if (event.type === "delegated") {
    return event.reason || "Task delegated to a durable workflow.";
  }
  if (event.type === "clarification") {
    return event.message || "The agent needs an exact target before it can continue.";
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
  if (event.type === "budget_exhausted") return "Budget authorization required";
  if (event.type === "delegated") return "Moved to workflow";
  if (event.type === "clarification") return "Clarification needed";
  if (event.type === "done") return "Task complete";
  if (event.type === "canceled") return "Task canceled";
  if (event.type === "error") return "Task failed";
  return "Task started";
}

function reasoningEffortLabel(
  effort: Extract<StreamEvent, { type: "model" }>["reasoningEffort"],
) {
  if (effort === "xhigh") return "extra high";
  if (effort === "max") return "ultra";
  return effort || "default";
}

function activityDotTone(event: StreamEvent) {
  if (event.type === "error" || event.type === "canceled" || event.type === "budget_exhausted") return "bg-danger";
  if (event.type === "waiting_approval" || event.type === "clarification") return "bg-warning";
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
    "workflow.budget_reserved": "Run-wide budget authority was reserved before work.",
    "workflow.budget_exhausted": "The workflow stopped before exceeding its authorized budget.",
  };
  return labels[type] || type.replaceAll(".", " · ").replaceAll("_", " ");
}

function ClaimEvidencePanel({
  content,
  claimEvidence,
}: {
  content: string;
  claimEvidence: NonNullable<GroundingReport["claimEvidence"]>;
}) {
  const coverage = claimEvidence.coverage;
  return (
    <details className="mt-3 rounded-xl border border-line/80 bg-background px-3">
      <summary className="flex min-h-10 cursor-pointer items-center justify-between gap-3 text-xs font-semibold">
        <span>Claim evidence</span>
        <span className="text-muted">
          {coverage.supportedMaterialClaimCount}/{coverage.materialClaimCount} supported
        </span>
      </summary>
      <ol className="max-h-96 space-y-2 overflow-y-auto border-t border-line/70 py-3">
        {claimEvidence.claims.map((claim) => {
          const claimText = content.slice(
            claim.startUtf16,
            claim.endUtf16Exclusive,
          );
          return (
            <li key={claim.claimId} className="rounded-lg bg-surface px-3 py-2.5 text-xs">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 leading-5 text-foreground">{claimText}</p>
                <span className={clsx(
                  "shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  claimSupportTone(claim.supportState),
                )}>
                  {claimSupportLabel(claim.supportState)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {claim.evidenceUnitIds.length
                  ? `${claim.evidenceUnitIds.length} authorized evidence ${claim.evidenceUnitIds.length === 1 ? "unit" : "units"}`
                  : "No authorized evidence established support"}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function claimSupportLabel(state: ClaimSupportState) {
  return state === "supported"
    ? "Supported"
    : state === "inferred"
      ? "Inferred"
      : state === "disputed"
        ? "Disputed"
        : state === "stale"
          ? "Stale"
          : "Unsupported";
}

function claimSupportTone(state: ClaimSupportState) {
  if (state === "supported") return "bg-success/10 text-success";
  if (state === "inferred") return "bg-primary/10 text-primary";
  if (state === "disputed") return "bg-danger/10 text-danger";
  if (state === "stale") return "bg-warning/10 text-warning";
  return "bg-surface-raised text-muted";
}

function groundingLabel(grounding: GroundingReport) {
  const coverage = grounding.claimEvidence?.coverage;
  if (coverage) {
    if (coverage.materialClaimCount === 0) return "No material claims";
    if (coverage.coverageBps === 10_000) return "Claims supported";
    return `${coverage.supportedMaterialClaimCount}/${coverage.materialClaimCount} claims supported`;
  }
  if (grounding.status === "verified") return "Sources cited";
  if (grounding.status === "not_required") return "No citations required";
  if (grounding.status === "invalid") return "Invalid source";
  return "Citation needed";
}

function renderSafeGroundingReport(value: unknown): GroundingReport | undefined {
  const record = asRecord(value);
  const status = stringValue(record.status);
  if (!["verified", "not_required", "missing", "invalid"].includes(status)) {
    return undefined;
  }
  const stringArray = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
  const sources = Array.isArray(record.sources)
    ? record.sources.flatMap((candidate) => {
        const source = asRecord(candidate);
        const citationId = stringValue(source.citationId);
        const kind = stringValue(source.kind);
        const title = stringValue(source.title);
        if (!citationId || !kind || !title) return [];
        const confidence = numberValue(source.confidence, Number.NaN);
        return [{
          citationId,
          kind,
          title,
          ...(Number.isFinite(confidence) ? { confidence } : {}),
          ...(stringValue(source.url) ? { url: stringValue(source.url) } : {}),
          ...(stringValue(source.snippet) ? { snippet: stringValue(source.snippet) } : {}),
          ...(stringValue(source.accessedAt) ? { accessedAt: stringValue(source.accessedAt) } : {}),
        }];
      })
    : [];
  const claimEvidenceRecord = asRecord(record.claimEvidence);
  const coverageRecord = asRecord(claimEvidenceRecord.coverage);
  const rawClaims = claimEvidenceRecord.claims;
  const claims = Array.isArray(rawClaims)
    ? rawClaims.flatMap((candidate) => {
        const claim = asRecord(candidate);
        const claimId = stringValue(claim.claimId);
        const materiality = stringValue(claim.materiality);
        const supportState = stringValue(claim.supportState);
        const startUtf16 = numberValue(claim.startUtf16, Number.NaN);
        const endUtf16Exclusive = numberValue(claim.endUtf16Exclusive, Number.NaN);
        if (
          !claimId ||
          !["material", "non_material"].includes(materiality) ||
          !["supported", "inferred", "disputed", "stale", "unsupported"].includes(supportState) ||
          !Number.isSafeInteger(startUtf16) ||
          !Number.isSafeInteger(endUtf16Exclusive) ||
          startUtf16 < 0 ||
          endUtf16Exclusive < startUtf16
        ) return [];
        return [{
          claimId,
          startUtf16,
          endUtf16Exclusive,
          materiality: materiality as "material" | "non_material",
          supportState: supportState as ClaimSupportState,
          supportReason: stringValue(claim.supportReason),
          evidenceUnitIds: stringArray(claim.evidenceUnitIds),
        }];
      })
    : [];
  const claimEvidenceMapId = stringValue(claimEvidenceRecord.claimEvidenceMapId);
  const materialClaimCount = numberValue(coverageRecord.materialClaimCount, Number.NaN);
  const supportedMaterialClaimCount = numberValue(coverageRecord.supportedMaterialClaimCount, Number.NaN);
  const coverageBpsValue = coverageRecord.coverageBps === null
    ? null
    : numberValue(coverageRecord.coverageBps, Number.NaN);
  const validClaimEvidence = claimEvidenceRecord.schemaVersion === 1 &&
    claimEvidenceMapId &&
    Number.isSafeInteger(materialClaimCount) &&
    Number.isSafeInteger(supportedMaterialClaimCount) &&
    (coverageBpsValue === null || Number.isSafeInteger(coverageBpsValue));
  return {
    status: status as GroundingReport["status"],
    citedIds: stringArray(record.citedIds),
    invalidIds: stringArray(record.invalidIds),
    sources,
    ...(validClaimEvidence ? {
      claimEvidence: {
        schemaVersion: 1,
        claimEvidenceMapId,
        evaluatedAt: stringValue(claimEvidenceRecord.evaluatedAt),
        coverage: {
          materialClaimCount,
          supportedMaterialClaimCount,
          coverageBps: coverageBpsValue,
        },
        claims,
      },
    } : {}),
  };
}

function citedGroundingSources(grounding: GroundingReport) {
  const citedIds = new Set(Array.isArray(grounding.citedIds) ? grounding.citedIds : []);
  const sources = Array.isArray(grounding.sources) ? grounding.sources : [];
  return sources.filter((source, index, values) =>
    citedIds.has(source.citationId) &&
    values.findIndex((candidate) => candidate.citationId === source.citationId) === index);
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

function builtInAgentPresentation(agentId: AgentId) {
  const agent = arsenalAgents.find((candidate) => candidate.id === agentId);
  if (!agent) return undefined;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    voice: agent.persona.voice,
    visualIdentity: agent.persona.visualIdentity,
    accent: agent.accent,
  } satisfies AgentPresentation;
}

function commandContextReferenceRequest(
  item: CommandContextCatalogItem,
): CommandContextReference {
  return {
    kind: item.kind,
    id: item.id,
    expectedVersion: item.expectedVersion,
    versionId: item.versionId,
    bindingSha256: item.bindingSha256,
  };
}

function commandReferenceKindLabel(kind: CommandContextCatalogItem["kind"]) {
  return ({
    agent: "Agent",
    skill: "Skill",
    plugin: "Extension",
    project: "Project",
    integration: "Connection",
    file: "file",
  } as const)[kind];
}

function agentPresentationFromApi(agent: JsonRecord): AgentPresentation {
  const persona = asRecord(agent.persona);
  const accent = stringValue(agent.accent, "emerald");
  return {
    id: stringValue(agent.id),
    name: stringValue(agent.name, "Custom agent"),
    role: stringValue(agent.role, "Specialist"),
    voice: stringValue(persona.voice, "Clear, direct, and calm."),
    visualIdentity: stringValue(
      persona.visualIdentity,
      "A focused specialist companion.",
    ),
    accent: ["emerald", "blue", "amber", "violet", "rose"].includes(accent)
      ? accent as AgentPresentation["accent"]
      : "emerald",
  };
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

function contextUseReceiptFromPayload(payload: JsonRecord): ContextUseReceipt | undefined {
  const receipt = asRecord(payload.contextReceipt);
  const stringList = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const receiptSha256 = stringValue(receipt.receiptSha256);
  const selectionSha256 = stringValue(receipt.selectionSha256);
  if (!receiptSha256 || !selectionSha256) return undefined;
  return {
    receiptSha256,
    selectionSha256,
    candidateEvidenceIds: stringList(receipt.candidateEvidenceIds),
    userInclusionIds: stringList(receipt.userInclusionIds),
    userExclusionIds: stringList(receipt.userExclusionIds),
    actualEvidenceIds: stringList(receipt.actualEvidenceIds),
    droppedEvidenceIds: stringList(receipt.droppedEvidenceIds),
    candidateCount: numberValue(receipt.candidateCount, 0),
    includedCount: numberValue(receipt.includedCount, 0),
    excludedCount: numberValue(receipt.excludedCount, 0),
    actualCount: numberValue(receipt.actualCount, 0),
    droppedCount: numberValue(receipt.droppedCount, 0),
    recordedAt: stringValue(receipt.recordedAt),
  };
}

function sameOrderedStringValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function promptQueueItemsFromPayload(value: unknown): PromptQueueItem[] {
  return arrayPath(value, "items")
    .map(promptQueueItemFromValue)
    .filter((item): item is PromptQueueItem => Boolean(item));
}

function promptQueueItemFromValue(value: unknown): PromptQueueItem | undefined {
  const item = asRecord(value);
  const target = asRecord(item.target);
  const agent = asRecord(item.agent);
  const model = asRecord(item.model);
  const commandSelection = asRecord(model.commandSelection);
  const contextPin = asRecord(item.context);
  const contextReferences = Array.isArray(contextPin.references)
    ? contextPin.references
    : [];
  const state = stringValue(item.state);
  const mode = stringValue(item.mode);
  const strategy = stringValue(item.strategy);
  const executionTarget = stringValue(target.executionTarget);
  const providerId = stringValue(model.providerId);
  const tier = stringValue(model.tier);
  if (
    !stringValue(item.id) ||
    !stringValue(item.prompt) ||
    !["queued", "paused", "dispatching", "completed", "failed"].includes(state) ||
    !["orchestrate", "research", "execute", "learn"].includes(mode) ||
    !["direct", "auto"].includes(strategy) ||
    !["asael", "local_macos"].includes(executionTarget) ||
    !["openai", "google", "anthropic", "aws_bedrock"].includes(providerId) ||
    !["fast", "reasoning"].includes(tier) ||
    item.queueGrantsAuthority !== false
  ) return undefined;
  return {
    id: stringValue(item.id),
    clientCorrelationId: stringValue(item.clientCorrelationId),
    prompt: stringValue(item.prompt),
    promptSha256: stringValue(item.promptSha256),
    mode: mode as AgentMode,
    strategy: strategy as PromptQueueItem["strategy"],
    target: {
      threadId: stringValue(target.threadId) || null,
      missionId: stringValue(target.missionId) || null,
      projectId: stringValue(target.projectId) || null,
      executionTarget: executionTarget as PromptQueueItem["target"]["executionTarget"],
    },
    agent: {
      logicalAgentId: stringValue(agent.logicalAgentId),
      definitionVersion: numberValue(agent.definitionVersion, 0),
      definitionVersionId: stringValue(agent.definitionVersionId),
    },
    model: {
      providerId: providerId as PromptQueueItem["model"]["providerId"],
      modelId: stringValue(model.modelId),
      tier: tier as PromptQueueItem["model"]["tier"],
      reasoningLevel: stringValue(commandSelection.reasoningLevel) || undefined,
    },
    contextReferenceCount: contextReferences.length,
    state: state as PromptQueueItem["state"],
    position: numberValue(item.position, 0),
    lifecycleRevision: numberValue(item.lifecycleRevision, 0),
    runId: stringValue(item.runId) || null,
    resultThreadId: stringValue(item.resultThreadId) || null,
    progressLabel: stringValue(item.progressLabel) || null,
    failureCode: stringValue(item.failureCode) || null,
    updatedAt: stringValue(item.updatedAt),
    queueGrantsAuthority: false,
  };
}

function mergePromptQueueItems(
  current: PromptQueueItem[],
  replacements: PromptQueueItem[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of replacements) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => {
    const leftTerminal = left.state === "completed" || left.state === "failed";
    const rightTerminal = right.state === "completed" || right.state === "failed";
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    if (left.position !== right.position) return left.position - right.position;
    return left.id.localeCompare(right.id);
  });
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

function isTrajectoryBoundaryKind(
  value: string,
): value is TrajectoryCheckpoint["boundaryKind"] {
  return ["model", "tool", "approval", "delegation", "verifier"].includes(value);
}

function isTrajectoryBoundaryPhase(
  value: string,
): value is TrajectoryCheckpoint["boundaryPhase"] {
  return ["before", "waiting", "after"].includes(value);
}

function isTrajectoryLifecycleState(
  value: string,
): value is TrajectoryCheckpoint["lifecycleState"] {
  return ["active", "waiting", "terminal"].includes(value);
}

function isTrajectoryResumeDisposition(
  value: string,
): value is TrajectoryCheckpoint["resumeDisposition"] {
  return ["resumable", "awaiting_signal", "not_resumable"].includes(value);
}

function formatCheckpointTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "recorded time unavailable";
}

function formatMediaBytes(byteCount: number) {
  const bounded = Math.max(0, byteCount);
  if (bounded < 1_024) return `${bounded} B`;
  if (bounded < 1_024 ** 2) return `${(bounded / 1_024).toFixed(1)} KB`;
  if (bounded < 1_024 ** 3) return `${(bounded / 1_024 ** 2).toFixed(1)} MB`;
  return `${(bounded / 1_024 ** 3).toFixed(1)} GB`;
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

function toneForWorkflowOutcome(value: unknown): Tone {
  const text = stringValue(value).toLowerCase();
  if (text === "succeeded") {
    return "success";
  }
  if (["failed", "blocked"].includes(text)) {
    return "danger";
  }
  if (["waiting", "partial"].includes(text)) {
    return "warning";
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
