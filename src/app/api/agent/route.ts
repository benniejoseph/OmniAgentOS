import { createHash, randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import {
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_MESSAGES,
  AGENT_MAX_TOOL_STEPS,
  AGENT_RUN_BUDGET_LIMITS,
  AGENT_RUNS_PER_MINUTE,
  LOCAL_COMPUTER_MAX_TOOL_STEPS,
  LOCAL_COMPUTER_RUN_BUDGET_LIMITS,
  WORKFLOW_RUN_BUDGET_LIMITS,
} from "@/lib/config";
import { hasDatabaseUrl, withDatabaseRequestScope } from "@/lib/db/client";
import {
  PROMPT_QUEUE_DISPATCH_ID_HEADER,
  PROMPT_QUEUE_DISPATCH_REVISION_HEADER,
  PROMPT_QUEUE_DISPATCH_TOKEN_HEADER,
} from "@/lib/command/prompt-queue-contracts";
import {
  PromptQueueStoreError,
  validatePromptQueueDispatch,
} from "@/lib/command/prompt-queue-store";
import {
  createPromptQueueDispatchLifecycle,
  promptQueueTerminalPersistenceErrorEvent,
  PromptQueueTerminalReceiptError,
} from "@/lib/command/prompt-queue-lifecycle";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { encodeSse, sseResponse } from "@/lib/http/sse";
import {
  createMission,
  ensureMissionTask,
  getMission,
  transitionMission,
  type MissionOwner,
} from "@/lib/missions/store";
import {
  attachMissionExecutor,
  syncMissionExecutor,
} from "@/lib/missions/runtime";
import type { Mission, MissionTask } from "@/lib/missions/types";
import { getOwnedProject } from "@/lib/projects/store";
import {
  assertContextScopeRequest,
  CONTEXT_SCOPE_IDS,
  contextScopeUsesThreadHistory,
  getContextScopePolicy,
} from "@/lib/rag/context-scope";
import {
  contextSelectionRequestSchema,
  verifyContextSelectionLock,
  type ContextSelectionLockBinding,
} from "@/lib/rag/context-selection-lock";
import {
  formAssistantInferenceCandidate,
  formExplicitUserAssertionMemory,
} from "@/lib/memory/evidence-formation";
import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
import { agentPromptMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  personalContextMemoryAccessFromSecurityContext,
  type RequestPersonalContextMemoryAccessV1,
} from "@/lib/memory/personal-context-access";
import {
  PersonalContextConsentError,
  requireActivePersonalContextConsent,
} from "@/lib/memory/personal-context-consent-store";
import {
  LocalComputerUnavailableError,
  startLocalComputerSession,
} from "@/lib/local-computer/store";
import {
  requestSharedMemoryAccessFromSecurityContext,
  SharedContextAuthorityError,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { runAgent } from "@/lib/orchestration/agent-runner";
import type { AgentEvent } from "@/lib/orchestration/types";
import {
  narrowRunBudgetLimits,
  runBudgetCountersV1Schema,
} from "@/lib/runs/budgets";
import {
  resolveLoopV2ReadOnlyCanaryEnrollment,
  runLoopV2ReadOnlyCanary,
} from "@/lib/orchestration/loop-v2-runtime";
import {
  resolveLoopV2ContextTextEnrollment,
  resolveLoopV2ModelTextEnrollment,
  runLoopV2ModelText,
} from "@/lib/orchestration/loop-v2-model-text-runtime";
import { getAgentPerformance } from "@/lib/agents/performance";
import {
  AgentIdentityResolutionError,
  resolveAgentIdentityForExecution,
} from "@/lib/agents/identity-store";
import {
  measureSupervisorOutcomeEvidence,
  applySupervisorStrategy,
  compileThreadContext,
  routeAgentRequest,
} from "@/lib/orchestration/supervisor";
import { resolveSemanticIntent } from "@/lib/orchestration/semantic-intent-resolver";
import { runRoutingSemanticDecisionShadow } from "@/lib/semantic-decisions/routing-shadow";
import { redactSensitive } from "@/lib/security/context";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  getCustomAgent,
  isAgentSkillRuntimeActive,
  listAgentSkills,
} from "@/lib/skills/store";
import {
  bindDurableSpecialistsToWorkflow,
  prepareDurableSpecialistDelegation,
  scheduleDurableSpecialistDrain,
} from "@/lib/subagents/scheduler";
import type { PreparedDurableSpecialist } from "@/lib/subagents/types";
import {
  buildWorkflowProcedureSnapshot,
  listSavedProcedures,
  mergeSavedProcedureCatalogs,
  parseWorkflowProcedureSnapshot,
  savedProceduresFromWorkspaceTemplates,
  toSupervisorKnownProcedures,
} from "@/lib/workflows/saved-procedures";
import {
  createWorkflowSharedContextBinding,
  isWorkflowSharedContextScope,
  WORKFLOW_SHARED_CONTEXT_METADATA_KEY,
} from "@/lib/workflows/shared-context";
import {
  createWorkflowAgentPrivateContextBinding,
  WORKFLOW_AGENT_PRIVATE_CONTEXT_METADATA_KEY,
} from "@/lib/workflows/agent-private-context";
import {
  createWorkflowPersonalContextBinding,
  WORKFLOW_PERSONAL_CONTEXT_METADATA_KEY,
} from "@/lib/workflows/personal-context";
import { listWorkspaceTemplates } from "@/lib/workspace-templates/store";
import { personalWorkspaceId } from "@/lib/workspaces/contracts";

export const runtime = "nodejs";
// gpt-5 research/orchestrate runs can exceed 60s; 300s is the Vercel Pro ceiling.
// On Hobby this is silently capped to 60s (harmless).
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
}).strict();

const voiceInputSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("realtime_voice"),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  provider: z.literal("openai"),
  confidenceBand: z.enum(["high", "low", "unavailable", "edited"]),
  confidenceMean: z.number().min(0).max(1).optional(),
  confidenceMinimum: z.number().min(0).max(1).optional(),
  confidenceSampleCount: z.number().int().min(0).max(10_000),
  reviewMethod: z.enum(["send_button", "explicit_checkbox"]),
  reviewAttested: z.literal(true),
}).strict();

const requestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(AGENT_MAX_MESSAGES).optional(),
  threadId: z.string().uuid().optional(),
  resumeRunId: z.string().uuid().optional(),
  missionId: z.string().uuid().optional(),
  projectId: z.string().trim().min(1).max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  requestId: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
  message: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS).optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  agentId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  specialistIds: z.array(z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"])).max(5).optional(),
  strategy: z.enum(["auto", "direct", "durable"]).optional(),
  computerUseTarget: z.enum(["local_macos", "isolated_browser"]).optional(),
  contextScope: z.enum(CONTEXT_SCOPE_IDS).optional(),
  contextSelection: contextSelectionRequestSchema.optional(),
  budgets: runBudgetCountersV1Schema.partial().optional(),
  voiceInput: voiceInputSchema.optional(),
}).strict()
  .refine((value) => Boolean(value.message || value.messages?.length), {
    message: "A message is required.",
  })
  .refine((value) => !value.resumeRunId || Boolean(value.threadId), {
    message: "A thread is required to resume a run.",
    path: ["threadId"],
  })
  .refine((value) => !value.resumeRunId || !value.budgets, {
    message: "A resumed run keeps the budget authorized when it started.",
    path: ["budgets"],
  })
  .refine((value) => !value.voiceInput || value.threadId === value.voiceInput.conversationId, {
    message: "The voice review must be bound to its conversation.",
    path: ["voiceInput", "conversationId"],
  })
  .refine((value) => !value.voiceInput || Boolean(value.message) && !value.resumeRunId, {
    message: "A voice review applies only to a new direct command.",
    path: ["voiceInput"],
  })
  .refine((value) => value.contextScope !== "project" || Boolean(value.projectId), {
    message: "A project is required for project context.",
    path: ["projectId"],
  })
  .refine((value) => value.contextScope !== "mission" || Boolean(value.missionId), {
    message: "A mission is required for mission context.",
    path: ["missionId"],
  })
  .refine((value) => value.contextScope !== "mission" || !value.projectId, {
    message: "Mission context resolves its canonical project on the server.",
    path: ["projectId"],
  })
  .refine((value) => !["project", "workspace"].includes(value.contextScope || "") || !value.missionId, {
    message: "Shared context cannot be combined with mission context.",
    path: ["missionId"],
  });

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (parsed.data.computerUseTarget === "isolated_browser") {
    return Response.json({
      error: "Computer Use target retired",
      code: "computer_use_target_retired",
      target: "isolated_browser",
      message:
        "Isolated Browser has been retired. Start a new task and explicitly choose This Mac if you want Asael to operate the installed Mac.",
    }, {
      status: 410,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const computerUseTarget = parsed.data.computerUseTarget === "local_macos"
    ? "local_macos" as const
    : undefined;

  const requestMessage = parsed.data.message || parsed.data.messages?.at(-1)?.content || "";
  const safeRequestMessage = String(redactSensitive(requestMessage));
  if (
    parsed.data.contextSelection &&
    normalizeTaskQuery(parsed.data.contextSelection.query) !== normalizeTaskQuery(requestMessage)
  ) {
    return Response.json(
      {
        error: "Context selection is out of date.",
        message: "The reviewed context does not match this task. Rebuild the task context before starting.",
      },
      { status: 409 },
    );
  }
  if (parsed.data.contextScope) {
    try {
      assertContextScopeRequest(
        parsed.data.contextScope,
        Boolean(parsed.data.contextSelection),
      );
    } catch (error) {
      const policy = getContextScopePolicy(parsed.data.contextScope);
      return Response.json(
        {
          error: policy.state === "authority_held"
            ? "Context scope unavailable"
            : "Invalid context scope",
          message: error instanceof Error
            ? error.message
            : "The requested context scope is invalid.",
        },
        { status: policy.state === "authority_held" ? 409 : 400 },
      );
    }
  }
  let requestId: string;
  try {
    requestId = resolveRequestId(request, parsed.data.requestId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request id." },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "agent_run",
      nativeMutationCapability: "conversation.send",
      metadata: {
        mode: parsed.data.mode || "orchestrate",
        messageCount: parsed.data.messages?.length || 1,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const directRootRunId = parsed.data.resumeRunId || randomUUID();
  const requestActorBinding =
    canonicalRequestActorBindingFromSecurityContext(context);
  const queuedItemId = request.headers
    .get(PROMPT_QUEUE_DISPATCH_ID_HEADER)?.trim();
  const queuedDispatchToken = request.headers
    .get(PROMPT_QUEUE_DISPATCH_TOKEN_HEADER)?.trim();
  if (Boolean(queuedItemId) !== Boolean(queuedDispatchToken)) {
    return Response.json({
      error: "Invalid prompt queue dispatch",
      message: "The queued command binding is incomplete.",
    }, { status: 400 });
  }
  const queuedDispatchRevision = request.headers
    .get(PROMPT_QUEUE_DISPATCH_REVISION_HEADER)?.trim();
  const activeDeploymentRevision =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.OMNIAGENT_RELEASE_SHA?.trim();
  if (
    queuedItemId &&
    queuedDispatchToken &&
    (
      queuedDispatchRevision
        ? queuedDispatchRevision !== activeDeploymentRevision
        : process.env.NODE_ENV === "production" ||
          process.env.VERCEL_ENV === "production"
    )
  ) {
    return Response.json({
      error: "Prompt queue deployment changed",
      message: "Reconnect before starting this queued command on the active release.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
  let queuedDispatch: Awaited<ReturnType<typeof validatePromptQueueDispatch>> | undefined;
  let queuedLifecycle: ReturnType<
    typeof createPromptQueueDispatchLifecycle
  > | undefined;
  if (queuedItemId && queuedDispatchToken) {
    const queuedSessionId = context.auth?.sessionId?.trim();
    if (!queuedSessionId) {
      return Response.json({
        error: "Invalid prompt queue dispatch",
        message: "A current authenticated session is required for queued commands.",
      }, { status: 409 });
    }
    const queueActorBinding =
      canonicalRequestActorBindingFromSecurityContext(context);
    if (!queueActorBinding) {
      return Response.json({
        error: "Invalid prompt queue dispatch",
        message: "A canonical authenticated account is required for queued commands.",
      }, { status: 409 });
    }
    try {
      queuedDispatch = await validatePromptQueueDispatch({
        itemId: queuedItemId,
        dispatchToken: queuedDispatchToken,
        tenantId: context.tenantId,
        ownerActorId: queueActorBinding.canonicalActorId,
        sessionId: queuedSessionId,
        request: {
          message: parsed.data.message || requestMessage,
          mode: parsed.data.mode,
          strategy: parsed.data.strategy,
          agentId: parsed.data.agentId,
          threadId: parsed.data.threadId,
          missionId: parsed.data.missionId,
          projectId: parsed.data.projectId,
          computerUseTarget: parsed.data.computerUseTarget,
        },
      });
      const canonicalQueueContext = {
        ...context,
        actorId: queueActorBinding.canonicalActorId,
      };
      queuedLifecycle = createPromptQueueDispatchLifecycle({
        itemId: queuedItemId,
        dispatchToken: queuedDispatchToken,
        tenantId: context.tenantId,
        ownerActorId: queueActorBinding.canonicalActorId,
        executionScope: executionScopeFromSecurityContext(
          canonicalQueueContext,
          {
            correlationId: `prompt-queue:${queuedItemId}:${requestId}`,
            causationId: queuedItemId,
            purpose: "prompt_queue.dispatch",
          },
        ),
      });
    } catch (error) {
      if (!(error instanceof PromptQueueStoreError)) throw error;
      return Response.json({ error: error.code, message: error.message }, {
        status: error.status,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  let contextSelection: ContextSelectionLockBinding | undefined;
  if (parsed.data.contextSelection) {
    try {
      contextSelection = verifyContextSelectionLock({
        tenantId: context.tenantId,
        actorId: context.actorId,
        selection: parsed.data.contextSelection,
      });
    } catch (error) {
      return Response.json({
        error: "Context selection lock is invalid.",
        message: error instanceof Error
          ? error.message
          : "Refresh and review context again.",
      }, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  if (parsed.data.projectId) {
    const project = await getOwnedProject(parsed.data.projectId, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    if (!project) {
      return Response.json(
        { error: "Project not found." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    }
  }
  let promptSharedMemoryAccess: RequestSharedMemoryAccessV1 | undefined;
  if (
    parsed.data.contextScope === "mission" ||
    parsed.data.contextScope === "project" ||
    parsed.data.contextScope === "workspace"
  ) {
    try {
      promptSharedMemoryAccess =
        await requestSharedMemoryAccessFromSecurityContext(context, {
          scope: parsed.data.contextScope === "mission"
            ? "project"
            : parsed.data.contextScope,
          projectId: parsed.data.contextScope === "mission"
            ? parsed.data.missionId
            : parsed.data.projectId,
          correlationId: directRootRunId,
        });
    } catch (error) {
      if (!(error instanceof SharedContextAuthorityError)) throw error;
      return Response.json({
        error: error.code === "scope_not_found"
          ? "Shared context not found"
          : "Shared context unavailable",
        message: error.code === "scope_not_found"
          ? "The selected shared context is unavailable to this account."
          : "Shared context authority could not be verified.",
      }, {
        status: error.code === "scope_not_found" ? 404 : 503,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  let promptPersonalMemoryAccess: RequestPersonalContextMemoryAccessV1 | undefined;
  if (parsed.data.contextScope === "personal") {
    const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
    if (!actorBinding) {
      return Response.json({
        error: "Personal context unavailable",
        message: "Personal automatic context requires an authenticated account.",
      }, {
        status: 403,
        headers: { "cache-control": "private, no-store" },
      });
    }
    try {
      const consentAuthority = await requireActivePersonalContextConsent({
        tenantId: context.tenantId,
        actorBinding,
      });
      promptPersonalMemoryAccess =
        personalContextMemoryAccessFromSecurityContext(context, {
          correlationId: directRootRunId,
          consentAuthority,
        });
      if (!promptPersonalMemoryAccess) {
        throw new PersonalContextConsentError(
          "invalid_authority",
          "Personal-context request authority is invalid.",
        );
      }
    } catch (error) {
      const inactive = error instanceof PersonalContextConsentError &&
        error.code === "inactive";
      return Response.json({
        error: inactive
          ? "Personal context not authorized"
          : "Personal context unavailable",
        message: inactive
          ? "Turn on Personal automatic context before using this scope."
          : "Personal automatic context authority could not be verified.",
      }, {
        status: inactive ? 409 : 503,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  const promptMemoryAccess = contextSelection?.evidenceIds.length
    ? agentPromptMemoryAccessFromSecurityContext(context, {
        correlationId: directRootRunId,
      })
    : undefined;
  const promptEntityGraphAccess = contextSelection?.evidenceIds.some((id) =>
    id.startsWith("graph:relationship_path_")
  )
    ? requestEntityAccessFromSecurityContext(context, {
        purposeId: "entity.read.v1",
        correlationId: directRootRunId,
      })
    : undefined;
  let budgetLimits;
  let workflowBudgetLimits;
  try {
    const agentBudgetAuthority =
      computerUseTarget === "local_macos"
        ? LOCAL_COMPUTER_RUN_BUDGET_LIMITS
        : AGENT_RUN_BUDGET_LIMITS;
    budgetLimits = narrowRunBudgetLimits(
      agentBudgetAuthority,
      parsed.data.budgets,
    );
    workflowBudgetLimits = narrowRunBudgetLimits(
      WORKFLOW_RUN_BUDGET_LIMITS,
      parsed.data.budgets,
    );
  } catch (error) {
    return Response.json(
      {
        error: "Invalid run budget",
        message: error instanceof Error
          ? error.message
          : "The requested run budget is invalid.",
      },
      { status: 400 },
    );
  }

  let rate;
  try {
    rate = await checkSharedRateLimit({
      key: `agent:${context.tenantId}:${context.actorId}`,
      limit: AGENT_RUNS_PER_MINUTE,
    });
  } catch (error) {
    if (!(error instanceof RateLimitStoreUnavailableError)) {
      throw error;
    }
    return Response.json(
      {
        error: "Agent temporarily unavailable",
        message: "The safety limiter is unavailable. Please try again shortly.",
      },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
  if (!rate.allowed) {
    return Response.json(
      { error: "Rate limited", message: "Too many agent runs. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  if (computerUseTarget === "local_macos") {
    try {
      await startLocalComputerSession(context, directRootRunId);
    } catch (error) {
      if (!(error instanceof LocalComputerUnavailableError)) throw error;
      return Response.json({
        error: "This Mac is unavailable",
        message: error.message,
      }, {
        status: error.status,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }

  const mode = parsed.data.mode || "orchestrate";
  const requestedBuiltInAgent = isBuiltInAgentId(parsed.data.agentId) ? parsed.data.agentId : undefined;
  const customAgent = parsed.data.agentId && !requestedBuiltInAgent
    ? await getCustomAgent(parsed.data.agentId, { tenantId: context.tenantId, actorId: context.actorId })
    : undefined;
  if (parsed.data.agentId && !requestedBuiltInAgent && !customAgent) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }
  if (customAgent?.status === "paused") {
    return Response.json({ error: "Agent paused", message: "Resume this agent in the Agent Builder before assigning work." }, { status: 409 });
  }
  const customSkills = customAgent
    ? (await listAgentSkills({ tenantId: context.tenantId, actorId: context.actorId })).filter((skill) => customAgent.skillIds.includes(skill.id) && isAgentSkillRuntimeActive(skill))
    : [];
  let requestedCustomIdentity;
  try {
    requestedCustomIdentity = customAgent
      ? await resolveAgentIdentityForExecution({
          tenantId: context.tenantId,
          actorId: context.actorId,
          agentId: customAgent.id,
          customAgent,
          customSkills,
        })
      : undefined;
  } catch (error) {
    if (!(error instanceof AgentIdentityResolutionError)) throw error;
    return Response.json({
      error: "Agent identity unavailable",
      message: "The exact definition and authority versions could not be verified.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const agentProfile = requestedCustomIdentity ? {
    name: requestedCustomIdentity.definition.name,
    role: requestedCustomIdentity.definition.role,
    description: requestedCustomIdentity.definition.description,
    instructions: requestedCustomIdentity.definition.instructions,
    persona: requestedCustomIdentity.definition.persona,
    modelPolicy: requestedCustomIdentity.definition.modelPolicy,
    autonomy: requestedCustomIdentity.principal.autonomy,
    approvalPolicy: requestedCustomIdentity.principal.approvalPolicy,
    memoryScope: requestedCustomIdentity.principal.memoryScope,
    toolIds: requestedCustomIdentity.principal.toolGrantIds,
    skills: customSkills.map(({ id, name, description, instructions, toolIds }) => ({ id, name, description, instructions, toolIds })),
  } : undefined;
  let savedProcedures;
  try {
    const memoryProcedures = await listSavedProcedures({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
    const templateProcedures = hasDatabaseUrl() && actorBinding
      ? savedProceduresFromWorkspaceTemplates(await listWorkspaceTemplates({
          tenantId: context.tenantId,
          workspaceId: promptSharedMemoryAccess?.authority.workspaceId ||
            personalWorkspaceId(actorBinding.canonicalActorId),
          canonicalActorId: actorBinding.canonicalActorId,
        }, { activeOnly: true, limit: 100 }))
      : [];
    savedProcedures = mergeSavedProcedureCatalogs(
      memoryProcedures,
      templateProcedures,
    );
  } catch (error) {
    console.error(
      "Saved procedure catalog unavailable.",
      String(redactSensitive(error instanceof Error ? error.message : "Unknown procedure catalog error.")),
    );
    return Response.json(
      { error: "Saved procedures unavailable", message: "The saved procedure catalog could not be validated." },
      { status: 503 },
    );
  }
  let safeMessages = (parsed.data.messages || []).map((message) => ({
    ...message,
    content: String(redactSensitive(message.content)),
  }));
  if (
    parsed.data.contextScope === "none" ||
    parsed.data.contextScope === "current_turn"
  ) {
    safeMessages = safeMessages.slice(-1);
  }
  const semanticConversation = safeMessages.length
    ? safeMessages
    : [{ role: "user" as const, content: safeRequestMessage }];
  const deterministicDecision = routeAgentRequest(
    requestMessage,
    mode,
    requestedBuiltInAgent,
    toSupervisorKnownProcedures(savedProcedures),
  );
  const semanticExecutionScope = executionScopeFromSecurityContext(context, {
    executingPrincipalType: "agent",
    executingPrincipalId:
      customAgent?.id || requestedBuiltInAgent || "atlas",
    projectId: parsed.data.projectId,
    correlationId: requestId,
    purpose: "agent.intent.semantic_resolution",
  });
  const semanticResolution = await resolveSemanticIntent({
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestId,
    message: safeRequestMessage,
    recentConversation: semanticConversation,
    mode,
    baseline: deterministicDecision,
    preferredAgentId: requestedBuiltInAgent,
    executionScope: semanticExecutionScope,
  });
  const preliminaryDecision = applySupervisorStrategy(
    semanticResolution.decision,
    computerUseTarget === "local_macos"
      ? "direct"
      : parsed.data.strategy,
  );
  const semanticDecisionShadowScope = executionScopeFromSecurityContext(context, {
    executingPrincipalType: "agent",
    executingPrincipalId:
      customAgent?.id || requestedBuiltInAgent || "atlas",
    projectId: parsed.data.projectId,
    correlationId: requestId,
    purpose: "agent.intent.semantic_decision_shadow",
  });
  after(async () => {
    try {
      await runRoutingSemanticDecisionShadow({
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestId,
        message: safeRequestMessage,
        deterministicFallbackRoute: deterministicDecision.route,
        observedLiveRoute: preliminaryDecision.route,
        executionScope: semanticDecisionShadowScope,
      });
    } catch (error) {
      console.warn(
        "Semantic decision shadow receipt persistence failed.",
        String(redactSensitive(
          error instanceof Error
            ? error.message
            : "Unknown semantic decision shadow error.",
        )),
      );
    }
  });

  try {
    await appendScopedDomainEvent({
      id: semanticIntentEventId(
        context.tenantId,
        context.actorId,
        requestId,
      ),
      streamId: `intent:${requestId}`,
      type: "intent.semantic_resolved",
      executionScope: semanticExecutionScope,
      payload: {
        schemaVersion: semanticResolution.receipt.schemaVersion,
        policyVersion: semanticResolution.receipt.policyVersion,
        source: semanticResolution.receipt.source,
        intent: semanticResolution.receipt.intent,
        executionShape: semanticResolution.receipt.executionShape,
        confidence: semanticResolution.receipt.confidence,
        entityCount: semanticResolution.receipt.entityCount,
        unresolvedEntityCount:
          semanticResolution.receipt.unresolvedEntityCount,
        capabilityQuerySha256: semanticResolution.capabilitySearchQuery
          ? createHash("sha256")
              .update(semanticResolution.capabilitySearchQuery)
              .digest("hex")
          : null,
        matchedCapabilityIds:
          semanticResolution.receipt.matchedCapabilityIds,
        selectedAgentCardSha256s:
          semanticResolution.receipt.selectedAgentCardSha256s || [],
        agentSelectionSha256:
          semanticResolution.receipt.agentSelectionSha256 || null,
        agentDiscoveryReceiptSha256s:
          semanticResolution.receipt.agentDiscoveryReceiptSha256s || [],
        semanticRoute: semanticResolution.receipt.route,
        appliedRoute: preliminaryDecision.route,
        requiresApproval: preliminaryDecision.requiresApproval,
        clarificationAdvisory:
          semanticResolution.receipt.clarificationAdvisory,
        model: semanticResolution.receipt.model || null,
        fallbackReasonCode:
          semanticResolution.receipt.fallbackReasonCode || null,
        selectedTargetIds: computerUseTarget
          ? [`computer:${computerUseTarget}`]
          : [],
        selectedToolIds: [],
        effectCount: 0,
      },
    });
  } catch (error) {
    console.error(
      "Semantic intent receipt persistence failed.",
      String(redactSensitive(
        error instanceof Error
          ? error.message
          : "Unknown semantic receipt error.",
      )),
    );
    return Response.json(
      {
        error: "Intent routing unavailable",
        message: "The routing decision could not be recorded. Try again shortly.",
      },
      { status: 503 },
    );
  }

  if (
    parsed.data.contextScope &&
    preliminaryDecision.route === "durable_workflow"
  ) {
    return Response.json(
      {
        error: "Context scope unavailable for durable workflow",
        message:
          "This reviewed context scope is currently available only for a direct agent run.",
      },
      { status: 409 },
    );
  }

  if (preliminaryDecision.route === "durable_workflow") {
    try {
      await authorizeRequest({
        request,
        action: "manage.workflow",
        resourceType: "workflow",
        nativeMutationCapability: "conversation.send",
        metadata: { source: "atomic_supervisor", threadId: parsed.data.threadId },
      });
    } catch (error) {
      return forbiddenResponse(error);
    }
  }

  const encoder = new TextEncoder();
  let threadId = parsed.data.threadId;
  let threadProjectId = parsed.data.projectId;
  const agentAbortController = new AbortController();
  let transportCanceled = false;
  if (request.signal.aborted) {
    transportCanceled = true;
    agentAbortController.abort(request.signal.reason);
  } else {
    request.signal.addEventListener(
      "abort",
      () => {
        transportCanceled = true;
        agentAbortController.abort(request.signal.reason);
      },
      { once: true },
    );
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let queueReceiptFailureEmitted = false;
      const enqueueTransportEvent = (event: AgentEvent) => {
        if (transportCanceled) return;
        controller.enqueue(encoder.encode(encodeSse(event)));
      };
      const enqueueEvent = async (event: AgentEvent) => {
        const events = queuedLifecycle
          ? await queuedLifecycle.beforeEmit(event, threadId)
          : [event];
        for (const projectedEvent of events) {
          enqueueTransportEvent(projectedEvent);
        }
        return events;
      };
      const enqueueQueueReceiptFailure = () => {
        if (queueReceiptFailureEmitted) return;
        queueReceiptFailureEmitted = true;
        enqueueTransportEvent(promptQueueTerminalPersistenceErrorEvent());
      };
      const stopBeforeMutationIfCanceled = async () => {
        if (!agentAbortController.signal.aborted) return false;
        await enqueueEvent({
          type: "canceled",
          message: "The Agent run was canceled.",
        });
        return true;
      };
      try {
        enqueueTransportEvent({
          type: "status",
          label: "supervisor routing",
          detail: preliminaryDecision.reasons[0] || "Selecting the right execution path.",
        });
        const decision = measureSupervisorOutcomeEvidence(
          preliminaryDecision,
          await getAgentPerformance(context.tenantId).catch((error: unknown) => {
            console.warn(
              "Agent adaptation evidence was temporarily unavailable.",
              String(redactSensitive(error instanceof Error ? error.message : "Unknown adaptation evidence error.")),
            );
            return [];
          }),
        );
        const executingAgentId = customAgent?.id || decision.primaryAgentId;
        const agentIdentity = requestedCustomIdentity ||
          await resolveAgentIdentityForExecution({
            tenantId: context.tenantId,
            actorId: context.actorId,
            agentId: executingAgentId,
          });
        if (queuedDispatch && (
          queuedDispatch.agent.logicalAgentId !== agentIdentity.definition.logicalAgentId ||
          queuedDispatch.agent.definitionVersionId !== agentIdentity.definition.definitionVersionId ||
          queuedDispatch.agent.definitionSha256 !== agentIdentity.definition.definitionSha256 ||
          queuedDispatch.agent.principalVersionId !== agentIdentity.principal.principalVersionId ||
          queuedDispatch.agent.principalSha256 !== agentIdentity.principal.principalSha256
        )) {
          throw new Error(
            "The queued Agent identity changed before governed execution began.",
          );
        }
        const agentPrincipalExecution = {
          executingPrincipalType: "agent" as const,
          executingPrincipalId: agentIdentity.principal.principalId,
          contextGrantIds: agentIdentity.principal.contextGrantIds,
          capabilityGrantIds: agentIdentity.principal.capabilityGrantIds,
        };
        let loopV2CanaryEnrollment;
        let loopV2ModelTextEnrollment;
        let loopV2ContextTextEnrollment;
        try {
          loopV2CanaryEnrollment = queuedDispatch || parsed.data.budgets || parsed.data.contextScope ||
              parsed.data.voiceInput || computerUseTarget
            ? undefined
            :
            await resolveLoopV2ReadOnlyCanaryEnrollment({
              tenantId: context.tenantId,
              message: safeRequestMessage,
              mode,
              route: decision.route,
              requiresApproval: decision.requiresApproval,
              requestUsesMessageField: Boolean(
                parsed.data.message && !parsed.data.messages?.length,
              ),
              requestedAgentId: parsed.data.agentId,
              requestedSpecialistIds: parsed.data.specialistIds,
              missionId: parsed.data.missionId,
              contextEvidenceIds: contextSelection?.evidenceIds,
              resumeRunId: parsed.data.resumeRunId,
            });
          if (
            !loopV2CanaryEnrollment &&
            !queuedDispatch &&
            !parsed.data.budgets &&
            !parsed.data.voiceInput &&
            !computerUseTarget
          ) {
            if (parsed.data.contextScope) {
              loopV2ContextTextEnrollment =
                await resolveLoopV2ContextTextEnrollment({
                  tenantId: context.tenantId,
                  message: safeRequestMessage,
                  mode,
                  route: decision.route,
                  requiresApproval: decision.requiresApproval,
                  requestUsesMessageField: Boolean(
                    parsed.data.message && !parsed.data.messages?.length,
                  ),
                  requestedAgentId: executingAgentId,
                  requestedSpecialistIds: parsed.data.specialistIds,
                  missionId: parsed.data.missionId,
                  contextEvidenceIds: contextSelection?.evidenceIds,
                  contextScope: parsed.data.contextScope,
                  resumeRunId: parsed.data.resumeRunId,
                });
            } else {
              loopV2ModelTextEnrollment =
                await resolveLoopV2ModelTextEnrollment({
                tenantId: context.tenantId,
                message: safeRequestMessage,
                mode,
                route: decision.route,
                requiresApproval: decision.requiresApproval,
                requestUsesMessageField: Boolean(
                  parsed.data.message && !parsed.data.messages?.length,
                ),
                requestedAgentId: parsed.data.agentId,
                requestedSpecialistIds: parsed.data.specialistIds,
                missionId: parsed.data.missionId,
                contextEvidenceIds: contextSelection?.evidenceIds,
                resumeRunId: parsed.data.resumeRunId,
              });
            }
          }
        } catch (error) {
          console.warn(
            "Loop v2 canary enrollment was unavailable.",
            String(
              redactSensitive(
                error instanceof Error
                  ? error.message
                  : "Unknown Loop v2 rollout error.",
              ),
            ).slice(0, 1_000),
          );
        }
        const loopV2Enrollment =
          loopV2CanaryEnrollment || loopV2ContextTextEnrollment ||
          loopV2ModelTextEnrollment;
        if (parsed.data.resumeRunId && !loopV2CanaryEnrollment) {
          throw new Error(
            "The paused run could not be resumed by its pinned Loop v2 runtime.",
          );
        }
        if (await stopBeforeMutationIfCanceled()) return;
        let missionOwner = {
          tenantId: context.tenantId,
          actorId: context.actorId,
          idempotencyKey: `agent-request:${requestId}`,
          executionScope: executionScopeFromSecurityContext(context, {
            ...agentPrincipalExecution,
            missionId: parsed.data.missionId,
            projectId: threadProjectId,
            correlationId: requestId,
            purpose: "mission.orchestrate",
          }),
        };
        let mission = parsed.data.missionId
          ? await getMission(parsed.data.missionId, missionOwner)
          : undefined;
        if (parsed.data.missionId && !mission) throw new Error("Mission not found.");
        if (mission) assertMissionAcceptsWork(mission);
        let missionTask: MissionTask | undefined;
        let durableSpecialists: PreparedDurableSpecialist[] = [];
        if (parsed.data.message || decision.route === "durable_workflow" || decision.route === "clarify") {
          if (await stopBeforeMutationIfCanceled()) return;
          const {
            appendThreadTurn,
            createThread,
            getThread,
            listConversationSummaries,
            listThreadTurns,
          } = await import("@/lib/threads/store");
          const safeMessage = String(redactSensitive(parsed.data.message || requestMessage));
          let thread = threadId ? await getThread(threadId, { tenantId: context.tenantId }) : null;
          if (thread && thread.actorId !== context.actorId) thread = null;
          if (threadId && !thread) throw new Error("Thread not found.");
          if (
            thread && parsed.data.projectId &&
            thread.projectId !== parsed.data.projectId
          ) {
            throw new Error("Thread belongs to a different project scope.");
          }
          if (!thread) {
            if (await stopBeforeMutationIfCanceled()) return;
            thread = await createThread({
              tenantId: context.tenantId,
              actorId: context.actorId,
              projectId: parsed.data.projectId,
              title: safeMessage,
              mode: parsed.data.mode || "orchestrate",
            });
            threadId = thread.id;
          }
          threadProjectId = thread.projectId;
          if (await stopBeforeMutationIfCanceled()) return;
          const userTurn = await appendThreadTurn({ tenantId: context.tenantId, threadId: thread.id, role: "user", content: safeMessage });
          if (parsed.data.voiceInput) {
            if (await stopBeforeMutationIfCanceled()) return;
            const voiceInput = parsed.data.voiceInput;
            await appendScopedDomainEvent({
              streamId: `thread:${thread.id}`,
              type: "voice.command_reviewed",
              executionScope: executionScopeFromSecurityContext(context, {
                ...agentPrincipalExecution,
                projectId: threadProjectId,
                correlationId: requestId,
                causationId: userTurn.id,
                purpose: "voice.command.review",
              }),
              payload: {
                schemaVersion: 1,
                threadId: thread.id,
                voiceSessionId: voiceInput.sessionId,
                provider: voiceInput.provider,
                transcriptSha256: createHash("sha256")
                  .update(safeMessage, "utf8")
                  .digest("hex"),
                transcriptCharacters: safeMessage.length,
                confidenceBand: voiceInput.confidenceBand,
                confidenceMean: voiceInput.confidenceMean ?? null,
                confidenceMinimum: voiceInput.confidenceMinimum ?? null,
                confidenceSampleCount: voiceInput.confidenceSampleCount,
                reviewMethod: voiceInput.reviewMethod,
                reviewAttested: true,
                forceApprovalAboveRisk: 0,
              },
            });
          }
          if (await stopBeforeMutationIfCanceled()) return;
          const explicitMemory = await formExplicitUserAssertionMemory({
            context,
            requestId,
            threadId: thread.id,
            turnId: userTurn.id,
            message: safeMessage,
          });
          if (explicitMemory) {
            enqueueTransportEvent({
              type: "memory",
              title: "Explicit memory saved",
              count: 1,
            });
          }
          if (decision.route === "clarify" && !loopV2Enrollment) {
            if (await stopBeforeMutationIfCanceled()) return;
            const ambiguity = decision.ambiguity.state === "detected"
              ? decision.ambiguity
              : {
                  reasonCode: "ambiguous_destructive_target" as const,
                  clarificationPrompt: "Name or identify the exact item you want changed before I continue.",
                };
            await appendScopedDomainEvent({
              streamId: `thread:${thread.id}`,
              type: "intent.clarification_requested",
              executionScope: executionScopeFromSecurityContext(context, {
                ...agentPrincipalExecution,
                missionId: mission?.id,
                projectId: threadProjectId,
                correlationId: requestId,
                causationId: userTurn.id,
                purpose: "agent.intent.clarification",
              }),
              payload: {
                schemaVersion: 1,
                threadId: thread.id,
                route: decision.route,
                reasonCode: ambiguity.reasonCode,
                selectedTargetIds: [],
                selectedToolIds: [],
                effectCount: 0,
              },
            });
            await appendThreadTurn({
              tenantId: context.tenantId,
              threadId: thread.id,
              role: "assistant",
              content: ambiguity.clarificationPrompt,
            });
            await enqueueEvent({
              type: "clarification",
              threadId: thread.id,
              message: ambiguity.clarificationPrompt,
              reasonCode: ambiguity.reasonCode,
            });
            return;
          }
          const needsMission = Boolean(parsed.data.missionId) || decision.route === "durable_workflow";
          if (needsMission) {
            if (await stopBeforeMutationIfCanceled()) return;
            if (missionOwner.executionScope.projectId !== (threadProjectId || null)) {
              missionOwner = {
                ...missionOwner,
                executionScope: executionScopeFromSecurityContext(context, {
                  ...agentPrincipalExecution,
                  projectId: threadProjectId,
                  missionId: parsed.data.missionId,
                  correlationId: requestId,
                  purpose: "mission.orchestrate",
                }),
              };
            }
            mission = mission || await createMission({
                ...missionOwner,
                title: missionTitle(safeMessage),
                objective: safeMessage,
                priority: decision.route === "durable_workflow" ? "high" : "normal",
                source: "talk",
                sourceKey: `agent-request:${requestId}`,
                metadata: {
                  threadId: thread.id,
                  turnId: userTurn.id,
                  requestId,
                  route: decision.route,
                  ...(threadProjectId ? { projectId: threadProjectId } : {}),
                },
              });
            if (!mission) throw new Error("Mission not found.");
            if (missionOwner.executionScope.missionId !== mission.id) {
              missionOwner = {
                ...missionOwner,
                executionScope: executionScopeFromSecurityContext(context, {
                  ...agentPrincipalExecution,
                  projectId: threadProjectId,
                  missionId: mission.id,
                  correlationId: requestId,
                  purpose: "mission.orchestrate",
                }),
              };
            }
            assertMissionAcceptsWork(mission);
            const executionMessage = parsed.data.missionId
              ? missionInstruction(mission, safeMessage)
              : safeMessage;
            if (decision.route === "durable_workflow") {
              if (await stopBeforeMutationIfCanceled()) return;
              const parentExecutionScope = executionScopeFromSecurityContext(
                context,
                {
                  ...agentPrincipalExecution,
                  projectId: threadProjectId,
                  missionId: mission.id,
                  correlationId: requestId,
                  purpose: "agent.run",
                },
              );
              durableSpecialists = await prepareDurableSpecialistDelegation({
                owner: missionOwner,
                parentExecutionScope,
                missionId: mission.id,
                requestId,
                objective: executionMessage,
                mode,
                primaryAgentId: decision.primaryAgentId,
                specialistIds: decision.specialistIds,
                parentBudgetLimits: budgetLimits,
              });
            }
            if (await stopBeforeMutationIfCanceled()) return;
            missionTask = await ensureMissionTask(mission.id, {
              sourceKey: `agent-request:${requestId}`,
              title: missionTitle(safeMessage),
              instructions: executionMessage,
              definitionOfDone: "Deliver the requested outcome, preserve evidence, and report blockers honestly.",
              priority: mission.priority,
              position: durableSpecialists.length + 1,
              dependencyIds: durableSpecialists.map((item) => item.taskId),
              input: { threadId: thread.id, turnId: userTurn.id, route: decision.route },
            }, missionOwner);
          }
          if (decision.route === "durable_workflow") {
            if (await stopBeforeMutationIfCanceled()) return;
            if (!mission || !missionTask) throw new Error("Durable mission initialization failed.");
            const executionMessage = parsed.data.missionId
              ? missionInstruction(mission, safeMessage)
              : safeMessage;
            const matchedProcedure = decision.procedure
              ? savedProcedures.find((procedure) => procedure.id === decision.procedure?.workflowId)
              : undefined;
            if (decision.procedure && !matchedProcedure) {
              throw new Error("The matched saved procedure is no longer available.");
            }
            const savedProcedure = matchedProcedure && decision.procedure
              ? buildWorkflowProcedureSnapshot(
                  matchedProcedure,
                  decision.procedure.matchedAlias,
                )
              : undefined;
            const workflowMode = savedProcedure?.schemaVersion === 2
              ? savedProcedure.mode
              : mode;
            const { createWorkflowRun } = await import("@/lib/workflows/store");
            const workflowExecutionScope = executionScopeFromSecurityContext(
              context,
              {
                ...agentPrincipalExecution,
                workspaceId: promptSharedMemoryAccess?.authority.workspaceId,
                projectId: parsed.data.contextScope === "personal"
                  ? undefined
                  : promptSharedMemoryAccess?.authority.projectId ||
                    threadProjectId,
                missionId: mission.id,
                correlationId: directRootRunId,
                causationId: missionTask.id,
                purpose: "workflow.run",
              },
            );
            const workflowSharedContext = promptSharedMemoryAccess &&
                isWorkflowSharedContextScope(parsed.data.contextScope)
              ? createWorkflowSharedContextBinding({
                  access: promptSharedMemoryAccess,
                  contextScope: parsed.data.contextScope,
                  workflowExecutionScope,
                })
              : undefined;
            const workflowAgentPrivateContext =
              parsed.data.contextScope === "agent_private"
                ? createWorkflowAgentPrivateContextBinding({
                    identity: agentIdentity,
                    requestingActorId: context.actorId,
                    workflowExecutionScope,
                  })
                : undefined;
            const workflowPersonalContext = promptPersonalMemoryAccess
              ? createWorkflowPersonalContextBinding({
                  access: promptPersonalMemoryAccess,
                  workflowExecutionScope,
                })
              : undefined;
            if (await stopBeforeMutationIfCanceled()) return;
            const detail = await createWorkflowRun({
              tenantId: context.tenantId,
              executionAuthority: {
                executionScope: workflowExecutionScope,
                requesterRole: context.role,
              },
              goal: executionMessage,
              mode: workflowMode,
              requireApproval: Boolean(parsed.data.voiceInput) || decision.requiresApproval || customAgent?.approvalPolicy === "always",
              budgetLimits: workflowBudgetLimits,
              metadata: {
                source: "atomic_supervisor",
                threadId: thread.id,
                requestId,
                actorId: context.actorId,
                ...(threadProjectId ? { projectId: threadProjectId } : {}),
                missionId: mission.id,
                missionTaskId: missionTask.id,
                primaryAgentId: customAgent?.id || decision.primaryAgentId,
                customAgentName: customAgent?.name,
                skillIds: customSkills.map((skill) => skill.id),
                agentProfile,
                agentIdentity,
                specialistIds: decision.specialistIds,
                specialistTaskIds: durableSpecialists.map((item) => item.taskId),
                specialistRunIds: durableSpecialists.map((item) => item.runId),
                adaptationEvidence: decision.adaptationEvidence,
                ...(savedProcedure ? { savedProcedure } : {}),
                ...(parsed.data.contextScope
                  ? { contextScope: parsed.data.contextScope }
                  : {}),
                ...(contextSelection ? { contextSelection } : {}),
                ...(workflowSharedContext
                  ? {
                      [WORKFLOW_SHARED_CONTEXT_METADATA_KEY]:
                        workflowSharedContext,
                    }
                  : {}),
                ...(workflowAgentPrivateContext
                  ? {
                      [WORKFLOW_AGENT_PRIVATE_CONTEXT_METADATA_KEY]:
                        workflowAgentPrivateContext,
                    }
                  : {}),
                ...(workflowPersonalContext
                  ? {
                      [WORKFLOW_PERSONAL_CONTEXT_METADATA_KEY]:
                        workflowPersonalContext,
                    }
                  : {}),
              },
              idempotencyKey: `supervisor:${context.actorId}:${requestId}`,
            });
            if (detail.run.goal !== executionMessage.trim()) {
              throw new Error("requestId was already used for a different instruction. Submit this work with a new requestId.");
            }
            if (!sameContextSelection(detail.run.input.metadata?.contextSelection, contextSelection)) {
              throw new Error("requestId was already used with a different context selection. Submit this work with a new requestId.");
            }
            if (
              detail.run.input.metadata?.contextScope !==
                parsed.data.contextScope ||
              (detail.run.input.metadata?.[WORKFLOW_SHARED_CONTEXT_METADATA_KEY] !==
                undefined && !workflowSharedContext) ||
              (workflowSharedContext &&
                asBindingSha256(
                  detail.run.input.metadata?.[WORKFLOW_SHARED_CONTEXT_METADATA_KEY],
                ) !== workflowSharedContext.bindingSha256)
              || (detail.run.input.metadata?.[WORKFLOW_PERSONAL_CONTEXT_METADATA_KEY] !==
                undefined && !workflowPersonalContext)
              || (workflowPersonalContext &&
                asBindingSha256(
                  detail.run.input.metadata?.[WORKFLOW_PERSONAL_CONTEXT_METADATA_KEY],
                ) !== workflowPersonalContext.bindingSha256)
            ) {
              throw new Error("requestId was already used with a different context boundary. Submit this work with a new requestId.");
            }
            if (!sameSavedProcedure(detail.run.input.metadata?.savedProcedure, savedProcedure)) {
              throw new Error("requestId was already used with a different saved procedure. Submit this work with a new requestId.");
            }
            await bindDurableSpecialistsToWorkflow(
              durableSpecialists,
              detail.run.id,
              missionOwner,
            );
            if (mission.status === "draft") {
              mission = await transitionMission(mission.id, "queued", missionOwner);
            }
            scheduleDurableSpecialistDrain(
              context.tenantId,
              durableSpecialists.length,
            );
            const acknowledgement = decision.requiresApproval || customAgent?.approvalPolicy === "always"
              ? "I moved this into a durable workflow. It will preserve progress and pause before consequential external actions."
              : "I moved this into a durable workflow so it can continue in the background and preserve progress.";
            await appendThreadTurn({
              tenantId: context.tenantId,
              threadId: thread.id,
              role: "assistant",
              content: acknowledgement,
            });
            await enqueueEvent({
              type: "delegated",
              threadId: thread.id,
              workflowId: detail.run.id,
              missionId: mission.id,
              acknowledgement,
              reason: decision.reasons[0] || "Durable execution selected.",
            });
            return;
          }
          if (
            !parsed.data.contextScope ||
            contextScopeUsesThreadHistory(parsed.data.contextScope)
          ) {
            const turns = await listThreadTurns(thread.id, { tenantId: context.tenantId, limit: AGENT_MAX_MESSAGES * 2 });
            const summaries = await listConversationSummaries(thread.id, {
              tenantId: context.tenantId,
              levels: ["episode"],
              limit: 500,
            });
            safeMessages = compileThreadContext(turns, {
              maxMessages: AGENT_MAX_MESSAGES,
              summaries,
            }).messages;
          } else {
            safeMessages = [{ role: "user", content: safeMessage }];
          }
        }
        if (parsed.data.missionId && (!mission || !missionTask)) {
          if (await stopBeforeMutationIfCanceled()) return;
          if (!mission) throw new Error("Mission not found.");
          assertMissionAcceptsWork(mission);
          missionTask = await ensureMissionTask(mission.id, {
            sourceKey: `agent-request:${requestId}`,
            title: missionTitle(requestMessage),
            instructions: requestMessage,
            definitionOfDone: "Deliver the requested outcome with a verifiable terminal result.",
            input: { route: decision.route },
          }, missionOwner);
        }
        if (parsed.data.missionId && mission && !parsed.data.contextScope) {
          safeMessages = includeMissionContext(safeMessages, mission);
        }
        if (await stopBeforeMutationIfCanceled()) return;
        const directExecutionScope = executionScopeFromSecurityContext(
          context,
          {
            ...agentPrincipalExecution,
            workspaceId: promptSharedMemoryAccess?.authority.workspaceId,
            projectId: parsed.data.contextScope === "personal"
              ? undefined
              : loopV2ContextTextEnrollment
              ? promptSharedMemoryAccess?.authority.projectId
              : promptSharedMemoryAccess?.authority.projectId || threadProjectId,
            missionId: parsed.data.contextScope === "personal"
              ? undefined
              : loopV2ContextTextEnrollment
              ? parsed.data.contextScope === "mission"
                ? mission?.id
                : undefined
              : mission?.id,
            correlationId: directRootRunId,
            causationId: requestId,
            purpose: loopV2CanaryEnrollment
              ? "agent.loop.v2.read_only_canary"
              : loopV2ContextTextEnrollment
                ? "agent.loop.v2.context_text_canary"
              : loopV2ModelTextEnrollment
                ? "agent.loop.v2.model_text_canary"
                : "agent.run",
          },
        );
        const directEvents = loopV2CanaryEnrollment
          ? runLoopV2ReadOnlyCanary(
              {
                runId: directRootRunId,
                message: safeRequestMessage,
                messages: safeMessages,
                mode,
                threadId,
                agentId: executingAgentId,
                securityContext: context,
                executionScope: directExecutionScope,
                agentIdentity,
                requestActorBinding,
                enrollment: loopV2CanaryEnrollment,
                resumeRunId: parsed.data.resumeRunId,
              },
              agentAbortController.signal,
            )
          : loopV2ModelTextEnrollment
            ? runLoopV2ModelText(
                {
                  runId: directRootRunId,
                  message: safeRequestMessage,
                  mode,
                  threadId,
                  agentId: executingAgentId,
                  securityContext: context,
                  executionScope: directExecutionScope,
                  agentIdentity,
                  requestActorBinding,
                  enrollment: loopV2ModelTextEnrollment,
                },
                agentAbortController.signal,
              )
          : loopV2ContextTextEnrollment
            ? runLoopV2ModelText(
                {
                  runId: directRootRunId,
                  message: safeRequestMessage,
                  messages: safeMessages,
                  mode,
                  threadId,
                  agentId: executingAgentId,
                  securityContext: context,
                  executionScope: directExecutionScope,
                  agentIdentity,
                  requestActorBinding,
                  enrollment: loopV2ContextTextEnrollment,
                  contextScope: parsed.data.contextScope,
                  contextSelection,
                  promptMemoryAccess,
                  promptSharedMemoryAccess,
                  promptPersonalMemoryAccess,
                  promptEntityGraphAccess,
                },
                agentAbortController.signal,
              )
          : runAgent(
              {
                runId: directRootRunId,
                mode: parsed.data.mode,
                threadId,
                messages: safeMessages,
                computerUseTarget,
                securityContext: context,
                requestActorBinding,
                semanticRouting: {
                  capabilitySearchQuery:
                    semanticResolution.capabilitySearchQuery,
                  matchedCapabilityIds:
                    semanticResolution.receipt.matchedCapabilityIds,
                  policyVersion: semanticResolution.receipt.policyVersion,
                },
                contextScope: parsed.data.contextScope,
                contextSelection,
                promptMemoryAccess,
                promptSharedMemoryAccess,
                promptPersonalMemoryAccess,
                promptEntityGraphAccess,
                executionScope: directExecutionScope,
                agentIdentity,
                runtimeModelPin: queuedDispatch ? {
                  provider: queuedDispatch.model.providerId,
                  model: queuedDispatch.model.modelId,
                  tier: queuedDispatch.model.tier,
                  routingPolicySha256:
                    queuedDispatch.model.routingPolicySha256,
                } : undefined,
                tenantId: context.tenantId,
                actorId: context.actorId,
                role: context.role,
                agentId: executingAgentId,
                specialistIds: decision.specialistIds,
                adaptationEvidence: decision.adaptationEvidence,
                agentProfile,
                budgetLimits,
                maxToolSteps:
                  computerUseTarget === "local_macos"
                    ? LOCAL_COMPUTER_MAX_TOOL_STEPS
                    : AGENT_MAX_TOOL_STEPS,
                voiceInput: parsed.data.voiceInput,
              },
              agentAbortController.signal,
            );
        let directExecutorId = "";
        let directTerminal = false;
        let directMissionAttachment: Promise<{ error?: unknown }> | undefined;
        for await (const event of directEvents) {
          if (event.type === "run") {
            if (!directExecutorId) directExecutorId = event.runId;
            if (!directMissionAttachment && mission && missionTask) {
              directMissionAttachment = attachMissionExecutor({
                taskId: missionTask.id,
                executorType: "agent_run",
                executorId: directExecutorId,
                status: "running",
                payload: { threadId, route: decision.route },
              }, missionOwner).then(
                () => ({}),
                (error) => ({ error }),
              );
            }
            await enqueueEvent(
              mission ? { ...event, missionId: mission.id } : event,
            );
            continue;
          }

          if (isDirectTerminalEvent(event)) {
            directTerminal = true;
            // The Agent/queue terminal outcome is the source of truth. Project
            // it before ancillary mission or memory work so those projections
            // can never replace a durable success/wait/cancel with run_failed.
            const projectedEvents = await enqueueEvent(event);
            if (!projectedEvents.includes(event)) continue;
            if (
              event.type === "done" &&
              directExecutorId &&
              !loopV2Enrollment
            ) {
              await formAssistantInferenceCandidate({
                context,
                requestId,
                runId: directExecutorId,
                threadId,
                response: event.response,
              }).catch((error: unknown) => {
                console.error(
                  "Assistant inference candidate persistence failed.",
                  String(redactSensitive(
                    error instanceof Error
                      ? error.message
                      : "Unknown memory formation error.",
                  )),
                );
              });
            }
            if (directExecutorId && directMissionAttachment) {
              await syncDirectMissionTerminal({
                attachment: directMissionAttachment,
                event,
                executorId: directExecutorId,
                owner: missionOwner,
              }).catch((error: unknown) => {
                console.error(
                  "Mission executor synchronization failed after durable Agent outcome.",
                  String(redactSensitive(
                    error instanceof Error
                      ? error.message
                      : "Unknown mission synchronization error.",
                  )).slice(0, 1_000),
                );
              });
            }
            continue;
          }
          await enqueueEvent(event);
        }
        if (agentAbortController.signal.aborted && !directTerminal) {
          directTerminal = true;
          const canceledEvent: AgentEvent = {
            type: "canceled",
            message: "The Agent run was canceled.",
          };
          await enqueueEvent(canceledEvent);
          if (directExecutorId && directMissionAttachment) {
            await syncDirectMissionTerminal({
              attachment: directMissionAttachment,
              event: canceledEvent,
              executorId: directExecutorId,
              owner: missionOwner,
            }).catch((error: unknown) => {
              console.error(
                "Mission executor synchronization failed after durable Agent outcome.",
                String(redactSensitive(
                  error instanceof Error
                    ? error.message
                    : "Unknown mission synchronization error.",
                )).slice(0, 1_000),
              );
            });
          }
        }
        if (directExecutorId && directMissionAttachment && !directTerminal && mission) {
          try {
            await requireMissionAttachment(directMissionAttachment);
            // Waiting approvals remain resumable. Every other non-terminal exit
            // is projected as canceled without changing the durable Agent run.
            const waiting = await getMission(mission.id, missionOwner);
            if (waiting?.status !== "waiting") {
              await syncMissionExecutor({
                executorType: "agent_run",
                executorId: directExecutorId,
                status: "canceled",
              }, missionOwner);
            }
          } catch (error) {
            console.error(
              "Mission executor reconciliation failed after Agent stream EOF.",
              String(redactSensitive(
                error instanceof Error
                  ? error.message
                  : "Unknown mission reconciliation error.",
              )).slice(0, 1_000),
            );
          }
        }
      } catch (error) {
        if (error instanceof PromptQueueTerminalReceiptError) {
          enqueueQueueReceiptFailure();
        } else {
          const errorEvent: AgentEvent = agentAbortController.signal.aborted
            ? {
                type: "canceled",
                message: "The Agent run was canceled.",
              }
            : {
                type: "error",
                message: String(
                  redactSensitive(
                    error instanceof Error ? error.message : "Agent run failed.",
                  ),
                ).slice(0, 1_000),
              };
          try {
            await enqueueEvent(errorEvent);
          } catch (queueError) {
            if (queueError instanceof PromptQueueTerminalReceiptError) {
              enqueueQueueReceiptFailure();
            } else {
              throw queueError;
            }
          }
        }
      } finally {
        if (queuedLifecycle && !queuedLifecycle.terminalWasChosen()) {
          try {
            const finalEvents = await queuedLifecycle.finalizeEof(threadId);
            for (const event of finalEvents) {
              enqueueTransportEvent(event);
            }
          } catch (error) {
            if (error instanceof PromptQueueTerminalReceiptError) {
              enqueueQueueReceiptFailure();
            } else {
              console.error(
                "Prompt queue dispatch finalization failed.",
                String(redactSensitive(
                  error instanceof Error ? error.message : "Unknown queue finalization error.",
                )).slice(0, 1_000),
              );
              enqueueQueueReceiptFailure();
            }
          }
        }
        if (!transportCanceled) controller.close();
      }
    },
    cancel(reason) {
      transportCanceled = true;
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(reason);
      }
    },
  });

  return sseResponse(stream);
}

function missionTitle(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.slice(0, 90) || "New Asael mission";
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function semanticIntentEventId(
  tenantId: string,
  actorId: string,
  requestId: string,
) {
  return `intent-semantic:${createHash("sha256")
    .update(`${tenantId}\u0000${actorId}\u0000${requestId}`)
    .digest("hex")}`;
}

function sameContextSelection(
  stored: unknown,
  expected: ContextSelectionLockBinding | undefined,
) {
  if (!expected) return stored === undefined;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;

  const value = stored as Record<string, unknown>;
  if (
    typeof value.query !== "string" ||
    !Array.isArray(value.evidenceIds) ||
    typeof value.selectionSha256 !== "string"
  ) return false;
  const storedIds = value.evidenceIds.filter((id): id is string => typeof id === "string").sort();
  const expectedIds = [...expected.evidenceIds].sort();
  return normalizeTaskQuery(String(redactSensitive(value.query))) === normalizeTaskQuery(String(redactSensitive(expected.query)))
    && storedIds.length === value.evidenceIds.length
    && storedIds.length === expectedIds.length
    && storedIds.every((id, index) => id === expectedIds[index])
    && value.selectionSha256 === expected.selectionSha256;
}

function asBindingSha256(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const bindingSha256 = (value as Record<string, unknown>).bindingSha256;
  return typeof bindingSha256 === "string" ? bindingSha256 : undefined;
}

function sameSavedProcedure(
  stored: unknown,
  expected: { snapshotSha256: string } | undefined,
) {
  if (!expected) return stored === undefined;
  return parseWorkflowProcedureSnapshot(stored)?.snapshotSha256 === expected.snapshotSha256;
}

function resolveRequestId(request: Request, bodyRequestId?: string) {
  const headerRequestId = request.headers.get("idempotency-key")?.trim();
  if (headerRequestId && (headerRequestId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(headerRequestId))) {
    throw new Error("Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.");
  }
  if (bodyRequestId && headerRequestId && bodyRequestId !== headerRequestId) {
    throw new Error("requestId and Idempotency-Key must match when both are provided.");
  }
  return bodyRequestId || headerRequestId || randomUUID();
}

function assertMissionAcceptsWork(mission: Mission) {
  if (["succeeded", "failed", "canceled", "archived"].includes(mission.status)) {
    throw new Error("This mission is terminal. Create a new mission to continue the outcome.");
  }
}

function includeMissionContext(messages: SafeChatMessages, mission: Mission) {
  const contextual = [...messages];
  const lastUserIndex = contextual.findLastIndex((message) => message.role === "user");
  const context = missionContext(mission);
  if (lastUserIndex < 0) {
    return [{ role: "user" as const, content: context }, ...contextual];
  }
  contextual[lastUserIndex] = {
    ...contextual[lastUserIndex],
    content: `${context}\n\nCurrent instruction:\n${contextual[lastUserIndex].content}`.slice(0, AGENT_MAX_MESSAGE_CHARS),
  };
  return contextual;
}

function missionInstruction(mission: Mission, instruction: string) {
  return `${missionContext(mission)}\n\nCurrent instruction:\n${instruction}`.slice(0, AGENT_MAX_MESSAGE_CHARS);
}

function missionContext(mission: Mission) {
  return `Selected mission: ${mission.title}\nMission objective: ${mission.objective}`;
}

type SafeChatMessages = Array<{ role: "user" | "assistant"; content: string }>;

async function requireMissionAttachment(attachment: Promise<{ error?: unknown }>) {
  const result = await attachment;
  if (result.error) throw result.error;
}

function isDirectTerminalEvent(event: AgentEvent) {
  return event.type === "delegated" ||
    event.type === "clarification" ||
    event.type === "waiting_approval" ||
    event.type === "done" ||
    event.type === "error" ||
    event.type === "canceled" ||
    (event.type === "status" && event.label === "Canceled");
}

async function syncDirectMissionTerminal(input: {
  attachment: Promise<{ error?: unknown }>;
  event: AgentEvent;
  executorId: string;
  owner: MissionOwner;
}) {
  await requireMissionAttachment(input.attachment);
  if (input.event.type === "waiting_approval") {
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: input.executorId,
      status: "waiting",
    }, input.owner);
    return;
  }
  if (input.event.type === "done") {
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: input.executorId,
      status: "succeeded",
      output: {
        responseLength: input.event.response.length,
        responseSha256: createHash("sha256")
          .update(input.event.response)
          .digest("hex"),
        groundingStatus: input.event.grounding?.status,
      },
    }, input.owner);
    return;
  }
  if (input.event.type === "error") {
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: input.executorId,
      status: "failed",
      error: input.event.message,
    }, input.owner);
    return;
  }
  if (
    input.event.type === "canceled" ||
    (input.event.type === "status" && input.event.label === "Canceled")
  ) {
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: input.executorId,
      status: "canceled",
    }, input.owner);
  }
}

function isBuiltInAgentId(value?: string): value is "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne" {
  return value === "atlas" || value === "scout" || value === "forge" || value === "sentinel" || value === "mnemosyne";
}
