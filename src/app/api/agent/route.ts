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
import { withRuntimeModelRequestCache } from "@/lib/settings/runtime-models";
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
  persistPromptQueueDispatchReceipt,
  promptQueueTerminalPersistenceErrorEvent,
  PromptQueueTerminalReceiptError,
  type PromptQueueDispatchReceiptBinding,
} from "@/lib/command/prompt-queue-lifecycle";
import { commandContextReferencesSchema } from "@/lib/command/composer-context-contract";
import { commandModelSelectionRequestSchema } from "@/lib/models/command-selection";
import {
  CommandContextResolutionError,
  resolveCommandContextReferences,
} from "@/lib/command/context-reference-runtime";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { encodeSse, sseResponse, startSseHeartbeat } from "@/lib/http/sse";
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
import { firstOutputTimer } from "@/lib/observability/agent-quality";
import { runAgent } from "@/lib/orchestration/agent-runner";
import type { AgentEvent } from "@/lib/orchestration/types";
import {
  admitAgentRequest,
  agentRequestDelegatedTurnId,
  agentRequestFingerprint,
  agentRequestRunId,
  agentRequestThreadId,
  agentRequestUserTurnId,
  durableWorkflowAcknowledgement,
} from "@/lib/runs/request-admission";
import { runEventCursor, withRunEventCursor } from "@/lib/runs/event-cursor";
import {
  agentRunTailResponse,
  parseRunEventCursor,
} from "@/lib/runs/event-tail";
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
  AgentSkillChangedSinceReleaseError,
  selectReleasedAgentSkills,
} from "@/lib/agents/release-skills";
import {
  measureSupervisorOutcomeEvidence,
  applySupervisorStrategy,
  requireDirectRoute,
  compileThreadContext,
  routeAgentRequest,
} from "@/lib/orchestration/supervisor";
import { resolveSemanticIntent } from "@/lib/orchestration/semantic-intent-resolver";
import { deterministicSemanticInvariant } from "@/lib/orchestration/semantic-intent";
import { runRoutingSemanticDecisionShadow } from "@/lib/semantic-decisions/routing-shadow";
import { redactSensitive } from "@/lib/security/context";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
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
import type {
  DurableSpecialistAgentId,
  PreparedDurableSpecialist,
} from "@/lib/subagents/types";
import {
  buildWorkflowProcedureSnapshot,
  parseWorkflowProcedureSnapshot,
  savedProceduresFromWorkspaceTemplates,
  toSupervisorKnownProcedures,
  type SavedProcedure,
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
import { resolveVoiceCommandGate, type VoiceCommandGate } from "@/lib/voice/command-gate";
import { voiceCommandInputSchema } from "@/lib/voice/command-input";
import { listWorkspaceTemplates } from "@/lib/workspace-templates/store";
import { personalWorkspaceId } from "@/lib/workspaces/contracts";

export const runtime = "nodejs";
// gpt-5 research/orchestrate runs can exceed 60s; 300s is the Vercel Pro ceiling.
// On Hobby this is silently capped to 60s (harmless).
export const maxDuration = 300;
export const POST = withRuntimeModelRequestCache(
  withDatabaseRequestScope(POSTHandler),
);

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
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
  requireReadOnlyAgent: z.boolean().optional(),
  specialistIds: z.array(z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"])).max(5).optional(),
  strategy: z.enum(["auto", "direct", "durable"]).optional(),
  computerUseTarget: z.enum(["local_macos", "isolated_browser"]).optional(),
  contextScope: z.enum(CONTEXT_SCOPE_IDS).optional(),
  contextSelection: contextSelectionRequestSchema.optional(),
  contextReferences: commandContextReferencesSchema.optional(),
  modelSelection: commandModelSelectionRequestSchema.optional(),
  budgets: runBudgetCountersV1Schema.partial().optional(),
  voiceInput: voiceCommandInputSchema.optional(),
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
  .refine((value) => !value.resumeRunId || !value.modelSelection, {
    message: "A resumed run keeps the model choice pinned when it started.",
    path: ["modelSelection"],
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
  const receivedAtMs = Date.now();
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
  let clientRequestId: string | undefined;
  try {
    clientRequestId = resolveClientRequestId(request, parsed.data.requestId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request id." },
      { status: 400 },
    );
  }
  const requestId = clientRequestId || randomUUID();

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
  let requiredReadOnlyAgent: Awaited<ReturnType<typeof resolveRequestedAgent>> | undefined;
  if (parsed.data.requireReadOnlyAgent) {
    if (
      parsed.data.message || parsed.data.threadId || parsed.data.resumeRunId ||
      parsed.data.missionId || computerUseTarget ||
      queuedItemId || queuedDispatchToken
    ) {
      return Response.json({
        error: "Read-only replay requires a new direct run",
        message: "Use messages for a fresh run without a conversation, mission, Computer Use, or queued dispatch.",
      }, { status: 409, headers: { "cache-control": "private, no-store" } });
    }
    requiredReadOnlyAgent = await resolveRequestedAgent(context, parsed.data.agentId);
    if (requiredReadOnlyAgent instanceof Response) return requiredReadOnlyAgent;
    if (
      !requiredReadOnlyAgent.customAgent ||
      requiredReadOnlyAgent.requestedCustomIdentity?.principal.approvalPolicy !== "read_only"
    ) {
      return Response.json({
        error: "Read-only Agent required",
        message: "Select a custom Agent whose active execution principal has the read-only approval policy.",
      }, { status: 409, headers: { "cache-control": "private, no-store" } });
    }
  }
  if (
    parsed.data.contextReferences?.length &&
    parsed.data.resumeRunId
  ) {
    return Response.json({
      error: "Command context cannot be changed",
      message:
        "Resume the paused run with the context it already pinned. Start a new command to choose different context.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (
    parsed.data.contextReferences?.length &&
    parsed.data.strategy === "durable"
  ) {
    return Response.json({
      error: "Command context requires direct execution",
      message: "Send this contextual command directly so its exact selections remain pinned for the run.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (
    parsed.data.modelSelection &&
    parsed.data.strategy === "durable"
  ) {
    return Response.json({
      error: "Model selection requires direct execution",
      message:
        "Choose Automatic or Direct when selecting a model. Durable work pins its runtime model when the workflow starts.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
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
  let queuedLifecycleBinding: PromptQueueDispatchReceiptBinding | undefined;
  let commandContextSecurity = context;
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
          contextReferences: parsed.data.contextReferences,
          modelSelection: parsed.data.modelSelection,
        },
      });
      const canonicalQueueContext = {
        ...context,
        actorId: queueActorBinding.canonicalActorId,
      };
      commandContextSecurity = canonicalQueueContext;
      queuedLifecycleBinding = {
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
      };
      queuedLifecycle = createPromptQueueDispatchLifecycle(
        queuedLifecycleBinding,
      );
    } catch (error) {
      if (!(error instanceof PromptQueueStoreError)) throw error;
      return Response.json({ error: error.code, message: error.message }, {
        status: error.status,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  // A client-identified direct request is replay-protected: its run, new
  // thread, and user turn take ids derived from the requestId, so a retry
  // finds what its first attempt started instead of running it again.
  // Resumes continue an existing run, and queued dispatches carry the prompt
  // queue's own lifecycle binding.
  const replayProtectedRequest = Boolean(
    clientRequestId && !parsed.data.resumeRunId && !queuedLifecycle,
  );
  const directRootRunId = parsed.data.resumeRunId || (
    replayProtectedRequest
      ? agentRequestRunId(context.tenantId, context.actorId, requestId)
      : randomUUID()
  );
  const effectiveContextReferences = queuedDispatch?.context?.references ||
    parsed.data.contextReferences || [];
  const effectiveModelSelection = queuedDispatch?.model.commandSelection ||
    parsed.data.modelSelection;
  // A selected model changes only the runtime used after routing. It must not
  // suppress saved-procedure matching or change the execution shape. Local
  // Computer Use remains a fixed direct harness because its governed tool set
  // and target are established before semantic routing.
  const deterministicIntentInvariant = computerUseTarget === "local_macos";
  let commandContext;
  try {
    commandContext = await resolveCommandContextReferences({
      context: commandContextSecurity,
      references: effectiveContextReferences,
      query: safeRequestMessage,
      agentId: parsed.data.agentId,
      projectId: parsed.data.projectId,
    });
  } catch (error) {
    if (!(error instanceof CommandContextResolutionError)) throw error;
    if (queuedLifecycleBinding) {
      try {
        await persistPromptQueueDispatchReceipt(queuedLifecycleBinding, {
          terminal: "failed",
          progressLabel: "Queued context could not be revalidated",
          failureCode: error.code,
        });
      } catch {
        return Response.json({
          error: "Prompt queue receipt unavailable",
          message:
            "The queued context failed validation, but its terminal receipt could not be recorded. Reconnect before retrying.",
        }, {
          status: 503,
          headers: { "cache-control": "private, no-store" },
        });
      }
    }
    return Response.json({
      error: error.code,
      message: error.message,
    }, {
      status: error.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (
    queuedDispatch?.context &&
    (
      !commandContext ||
      commandContext.selectionSha256 !==
        queuedDispatch.context.selectionSha256 ||
      commandContext.contextBlockSha256 !==
        queuedDispatch.context.contextBlockSha256 ||
      commandContext.receiptSha256 !== queuedDispatch.context.receiptSha256
    )
  ) {
    if (queuedLifecycleBinding) {
      try {
        await persistPromptQueueDispatchReceipt(queuedLifecycleBinding, {
          terminal: "failed",
          progressLabel: "Queued context changed before admission",
          failureCode: "command_context_changed",
        });
      } catch {
        return Response.json({
          error: "Prompt queue receipt unavailable",
          message:
            "The queued context changed, but its terminal receipt could not be recorded. Reconnect before retrying.",
        }, {
          status: 503,
          headers: { "cache-control": "private, no-store" },
        });
      }
    }
    return Response.json({
      error: "command_context_changed",
      message:
        "The selected context changed after it entered the queue. Edit the queued prompt to review and pin it again.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
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

  if (replayProtectedRequest) {
    let admission;
    try {
      admission = await admitAgentRequest({
        context,
        requestId,
        requestFingerprintSha256: agentRequestFingerprint(
          context.tenantId,
          context.actorId,
          requestId,
          parsed.data,
        ),
      });
    } catch (error) {
      console.error(
        "Agent request admission was unavailable.",
        String(
          redactSensitive(
            error instanceof Error ? error.message : "Unknown admission error.",
          ),
        ).slice(0, 1_000),
      );
      return Response.json(
        {
          error: "Agent temporarily unavailable",
          message: "Request replay protection is unavailable. Please try again shortly.",
        },
        {
          status: 503,
          headers: { "Retry-After": "30", "cache-control": "private, no-store" },
        },
      );
    }
    if (admission.state === "reused") {
      return Response.json(
        {
          error: "request_id_reused",
          code: "request_id_reused",
          message:
            "requestId was already used for a different instruction. Submit this work with a new requestId.",
        },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    if (admission.state === "in_progress") {
      // The first attempt's run is still going. Follow it from its event log
      // (after the last event this client saw, if it says) instead of running
      // the instruction again.
      return agentRunTailResponse({
        runId: admission.runId,
        tenantId: context.tenantId,
        threadId: admission.threadId,
        afterSeq: parseRunEventCursor(request),
        signal: request.signal,
        headers: { "X-Asael-Run-Id": admission.runId },
      });
    }
    if (admission.state === "replay") {
      return replayedAgentRequestResponse(admission.events);
    }
  }

  // Voice policy is server-derived: a declared review and an unmarked command
  // on a conversation with an unconsumed realtime session both force approval.
  // A resume only continues a pinned read-only canary run, so it keeps the
  // policy that run started with.
  let voiceGate: VoiceCommandGate;
  try {
    voiceGate = parsed.data.resumeRunId
      ? { state: "none" }
      : await resolveVoiceCommandGate({
          tenantId: context.tenantId,
          actorId: context.actorId,
          threadId: parsed.data.threadId,
          declaredSessionId: parsed.data.voiceInput?.sessionId,
          requestId,
        });
  } catch (error) {
    console.error(
      "Voice command history was unavailable.",
      String(
        redactSensitive(
          error instanceof Error ? error.message : "Unknown voice history error.",
        ),
      ).slice(0, 1_000),
    );
    return Response.json(
      {
        error: "Agent temporarily unavailable",
        message: "Voice command safety checks are unavailable. Please try again shortly.",
      },
      {
        status: 503,
        headers: { "Retry-After": "30", "cache-control": "private, no-store" },
      },
    );
  }
  const voiceOrigin = voiceGate.state === "none" ? undefined : voiceGate.state;
  const voiceCommand = voiceOrigin !== undefined;

  let localComputerWorkspaces:
    | readonly Readonly<{ id: string; name: string }>[]
    | undefined;
  if (computerUseTarget === "local_macos") {
    try {
      const localSession = await startLocalComputerSession(
        context,
        directRootRunId,
      );
      localComputerWorkspaces = localSession.workspaces;
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
  const requestedAgent = requiredReadOnlyAgent ||
    await resolveRequestedAgent(context, parsed.data.agentId);
  if (requestedAgent instanceof Response) return requestedAgent;
  const { requestedBuiltInAgent, customAgent, requestedCustomIdentity, customSkills } = requestedAgent;
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
  if (commandContext) {
    const pinExecutionScope = executionScopeFromSecurityContext(context, {
      executingPrincipalType: "agent",
      executingPrincipalId:
        requestedCustomIdentity?.principal.principalId ||
        requestedBuiltInAgent ||
        "atlas",
      projectId: parsed.data.projectId,
      correlationId: requestId,
      causationId: requestId,
      purpose: "command.context.pin",
    });
    const pinPayload = {
      schemaVersion: commandContext.schemaVersion,
      receiptKind: "command_context_pin",
      referenceCount: commandContext.pins.length,
      kindCounts: commandContext.kindCounts,
      selectionSha256: commandContext.selectionSha256,
      contextBlockSha256: commandContext.contextBlockSha256,
      receiptSha256: commandContext.receiptSha256,
      pins: commandContext.pins,
      toolGrantCount: 0,
      delegationCount: 0,
    };
    try {
      await appendScopedDomainEvent({
        id: commandContextPinEventId(
          context.tenantId,
          context.actorId,
          requestId,
          pinPayload,
        ),
        streamId: `command:${requestId}`,
        type: "command.context.pinned",
        executionScope: pinExecutionScope,
        payload: pinPayload,
      });
    } catch (error) {
      console.error(
        "Command context pin receipt persistence failed.",
        String(redactSensitive(
          error instanceof Error
            ? error.message
            : "Unknown context receipt error.",
        )),
      );
      return Response.json({
        error: "Command context unavailable",
        message: "The selected context could not be pinned to this run. Retry with a fresh command.",
      }, {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  // Only active playbooks of workspace templates the requester published can
  // pick a deterministic procedure: they are versioned, owner-bound, and
  // published through an approval-required tool. Procedure memories are not a
  // routing source, because any member or governed tool call can write
  // workspace memory; they run only through an explicitly reviewed schedule.
  let savedProcedures: readonly SavedProcedure[] = [];
  if (!deterministicIntentInvariant) {
    try {
      const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
      if (hasDatabaseUrl() && actorBinding) {
        const workspaceTemplates = await listWorkspaceTemplates({
          tenantId: context.tenantId,
          workspaceId: promptSharedMemoryAccess?.authority.workspaceId ||
            personalWorkspaceId(actorBinding.canonicalActorId),
          canonicalActorId: actorBinding.canonicalActorId,
        }, { activeOnly: true, limit: 100 });
        savedProcedures = savedProceduresFromWorkspaceTemplates(
          workspaceTemplates,
          actorBinding,
        );
      }
    } catch (error) {
      console.error(
        "Saved procedure catalog unavailable.",
        String(redactSensitive(error instanceof Error ? error.message : "Unknown procedure catalog error.")),
      );
      return Response.json(
        { error: "Saved procedures unavailable", message: "The saved procedure catalog could not be loaded." },
        { status: 503 },
      );
    }
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
  const semanticResolution = deterministicIntentInvariant
    ? deterministicSemanticInvariant({ baseline: deterministicDecision })
    : await resolveSemanticIntent({
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
  // A workflow started here cannot carry Local Computer Use, pinned Command
  // context, or a scope's durable memory, so those run direct unless durable
  // is asked for, which is refused below.
  const scopeCarriesDurableContext = Boolean(
    parsed.data.contextScope &&
      getContextScopePolicy(parsed.data.contextScope).durableContext !== "none",
  );
  const preliminaryDecision =
    parsed.data.requireReadOnlyAgent || computerUseTarget === "local_macos" || commandContext ||
      (scopeCarriesDurableContext && parsed.data.strategy !== "durable")
      ? requireDirectRoute(semanticResolution.decision)
      : applySupervisorStrategy(
          semanticResolution.decision,
          parsed.data.strategy,
        );
  if (parsed.data.requireReadOnlyAgent && preliminaryDecision.route === "clarify") {
    return Response.json({
      error: "Read-only replay requires clarification",
      message: "Clarify the task before replaying it as a new read-only run.",
    }, { status: 409, headers: { "cache-control": "private, no-store" } });
  }
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
        actorRole: context.role,
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

  const semanticPayload = {
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
  };
  try {
    await appendScopedDomainEvent({
      id: semanticIntentEventId(
        context.tenantId,
        context.actorId,
        requestId,
        semanticPayload,
      ),
      streamId: `intent:${requestId}`,
      type: "intent.semantic_resolved",
      executionScope: semanticExecutionScope,
      payload: semanticPayload,
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
    scopeCarriesDurableContext &&
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
  // A disconnect before the run exists stops the request before it creates
  // anything. Once the run exists it outlives this connection: the client
  // detaches, can follow it again from /api/runs/:id/stream, and only an
  // explicit cancel stops it.
  let runStarted = false;
  let stopHeartbeat = () => {};
  const detachTransport = (reason: unknown) => {
    transportCanceled = true;
    stopHeartbeat();
    if (!runStarted && !agentAbortController.signal.aborted) {
      agentAbortController.abort(reason);
    }
  };
  if (request.signal.aborted) {
    detachTransport(request.signal.reason);
  } else {
    request.signal.addEventListener(
      "abort",
      () => detachTransport(request.signal.reason),
      { once: true },
    );
  }
  let settleExecution!: () => void;
  const execution = new Promise<void>((resolve) => {
    settleExecution = resolve;
  });
  const firstOutput = firstOutputTimer({
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId: requestId,
    receivedAtMs,
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let queueReceiptFailureEmitted = false;
      const write = (chunk: string) => {
        if (transportCanceled) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          detachTransport(error);
        }
      };
      stopHeartbeat = startSseHeartbeat(write);
      const enqueueTransportEvent = (event: AgentEvent) => {
        firstOutput.observe(event);
        write(encodeSse(event, { id: runEventCursor(event) }));
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
        if (commandContext) {
          enqueueTransportEvent({
            type: "status",
            label: "selected context pinned",
            detail: `${commandContext.pins.length} exact selection${commandContext.pins.length === 1 ? "" : "s"} revalidated for this run; no extra authority was granted.`,
          });
        }
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
          loopV2CanaryEnrollment = parsed.data.requireReadOnlyAgent || queuedDispatch || parsed.data.budgets || parsed.data.contextScope || commandContext ||
              voiceCommand || computerUseTarget
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
            !parsed.data.requireReadOnlyAgent &&
            !loopV2CanaryEnrollment &&
            !queuedDispatch &&
            !commandContext &&
            !parsed.data.budgets &&
            !voiceCommand &&
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
          effectiveModelSelection
            ? undefined
            : loopV2CanaryEnrollment || loopV2ContextTextEnrollment ||
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
              ...(replayProtectedRequest
                ? {
                    id: agentRequestThreadId(
                      context.tenantId,
                      context.actorId,
                      requestId,
                    ),
                  }
                : {}),
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
          const userTurn = await appendThreadTurn({
            ...(replayProtectedRequest
              ? {
                  id: agentRequestUserTurnId(
                    context.tenantId,
                    context.actorId,
                    thread.id,
                    requestId,
                  ),
                }
              : {}),
            tenantId: context.tenantId,
            threadId: thread.id,
            role: "user",
            content: safeMessage,
          });
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
                sessionEvidence: voiceGate.state === "declared"
                  ? voiceGate.sessionEvidence
                  : "not_found",
                forceApprovalAboveRisk: 0,
              },
            });
          } else if (voiceGate.state === "inferred") {
            if (await stopBeforeMutationIfCanceled()) return;
            await appendScopedDomainEvent({
              streamId: `thread:${thread.id}`,
              type: "voice.command_inferred",
              executionScope: executionScopeFromSecurityContext(context, {
                ...agentPrincipalExecution,
                projectId: threadProjectId,
                correlationId: requestId,
                causationId: userTurn.id,
                purpose: "voice.command.infer",
              }),
              payload: {
                schemaVersion: 1,
                threadId: thread.id,
                voiceSessionIds: [...voiceGate.sessionIds],
                inference: voiceGate.inference,
                transcriptSha256: createHash("sha256")
                  .update(safeMessage, "utf8")
                  .digest("hex"),
                transcriptCharacters: safeMessage.length,
                forceApprovalAboveRisk: 0,
              },
            });
          }
          if (await stopBeforeMutationIfCanceled()) return;
          const explicitMemory = parsed.data.requireReadOnlyAgent ? undefined : await formExplicitUserAssertionMemory({
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
                primaryAgentId: isDurableSpecialistAgentId(decision.primaryAgentId)
                  ? decision.primaryAgentId
                  : "atlas",
                specialistIds: decision.specialistIds.filter(
                  isDurableSpecialistAgentId,
                ),
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
            const workflowRequiresApproval = voiceCommand ||
              decision.requiresApproval ||
              customAgent?.approvalPolicy === "always";
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
              requireApproval: workflowRequiresApproval,
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
              { routeMaxDurationSeconds: maxDuration },
            );
            // The stored workflow decides, so a retry that finds it records
            // and replays the same acknowledgement.
            const acknowledgement = durableWorkflowAcknowledgement(
              detail.run.approvalRequired,
            );
            await appendThreadTurn({
              ...(replayProtectedRequest
                ? {
                    id: agentRequestDelegatedTurnId(
                      context.tenantId,
                      context.actorId,
                      thread.id,
                      requestId,
                    ),
                  }
                : {}),
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
        const directEvents = loopV2CanaryEnrollment && !effectiveModelSelection
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
          : loopV2ModelTextEnrollment && !effectiveModelSelection
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
          : loopV2ContextTextEnrollment && !effectiveModelSelection
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
                invocation: {
                  receivedAtMs,
                  endsAtMs: receivedAtMs + maxDuration * 1_000,
                },
                mode: parsed.data.mode,
                threadId,
                messages: safeMessages,
                computerUseTarget,
                localComputerWorkspaces,
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
                commandModelSelection: effectiveModelSelection,
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
                ...(parsed.data.requireReadOnlyAgent ? { memoryFormation: "withheld" as const } : {}),
                budgetLimits,
                maxToolSteps:
                  computerUseTarget === "local_macos"
                    ? LOCAL_COMPUTER_MAX_TOOL_STEPS
                    : AGENT_MAX_TOOL_STEPS,
                voiceInput: parsed.data.voiceInput,
                voiceOrigin,
                commandContext: commandContext ? {
                  schemaVersion: commandContext.schemaVersion,
                  content: commandContext.contextBlock,
                  receiptSha256: commandContext.receiptSha256,
                  selectionSha256: commandContext.selectionSha256,
                  pinCount: commandContext.pins.length,
                } : undefined,
              },
              agentAbortController.signal,
            );
        let directExecutorId = "";
        let directTerminal = false;
        let directMissionAttachment: Promise<{ error?: unknown }> | undefined;
        let directMemoryFormation: "durable" | "withheld" | undefined;
        for await (const event of directEvents) {
          if (event.type === "harness") {
            directMemoryFormation = directMemoryFormation !== "withheld" &&
                event.memoryFormation === "durable"
              ? "durable"
              : "withheld";
          }
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
            runStarted = true;
            await enqueueEvent(
              mission
                ? withRunEventCursor(event, { ...event, missionId: mission.id })
                : event,
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
            // The run's own memory decision also governs its inference
            // candidate, so a scoped or session-only run saves none.
            if (
              event.type === "done" &&
              !parsed.data.requireReadOnlyAgent &&
              directExecutorId &&
              !loopV2Enrollment &&
              directMemoryFormation === "durable"
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
        stopHeartbeat();
        if (!transportCanceled) {
          try {
            controller.close();
          } catch {
            // The transport went away after the last write.
          }
        }
        settleExecution();
      }
    },
    cancel(reason) {
      detachTransport(reason);
    },
  });

  // A detached run keeps executing after its response closes, so the
  // function stays alive until the run settles and its first output is
  // recorded.
  after(async () => {
    await execution;
    await firstOutput.settled();
  });
  return sseResponse(stream, { "X-Asael-Run-Id": directRootRunId });
}

async function resolveRequestedAgent(
  context: Awaited<ReturnType<typeof authorizeRequest>>,
  agentId?: string,
) {
  const requestedBuiltInAgent = isBuiltInAgentId(agentId) ? agentId : undefined;
  const customAgent = agentId && !requestedBuiltInAgent
    ? await getCustomAgent(agentId, { tenantId: context.tenantId, actorId: context.actorId })
    : undefined;
  if (agentId && !requestedBuiltInAgent && !customAgent) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }
  if (customAgent?.status === "paused") {
    return Response.json({ error: "Agent paused", message: "Resume this agent in the Agent Builder before assigning work." }, { status: 409 });
  }
  const availableSkills = customAgent
    ? await listAgentSkills({ tenantId: context.tenantId, actorId: context.actorId })
    : [];
  try {
    const requestedCustomIdentity = customAgent
      ? await resolveAgentIdentityForExecution({
          tenantId: context.tenantId,
          actorId: context.actorId,
          agentId: customAgent.id,
          customAgent,
          customSkills: availableSkills.filter((skill) => customAgent.skillIds.includes(skill.id) && isAgentSkillRuntimeActive(skill)),
        })
      : undefined;
    const customSkills = requestedCustomIdentity
      ? selectReleasedAgentSkills(requestedCustomIdentity, availableSkills)
      : [];
    return { requestedBuiltInAgent, customAgent, requestedCustomIdentity, customSkills };
  } catch (error) {
    if (error instanceof AgentSkillChangedSinceReleaseError) {
      return Response.json({
        error: "Agent release out of date",
        message: error.message,
      }, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (!(error instanceof AgentIdentityResolutionError)) throw error;
    return Response.json({
      error: "Agent identity unavailable",
      message: "The exact definition and authority versions could not be verified.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
}

function missionTitle(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.slice(0, 90) || "New Asael mission";
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// Both receipts are keyed by their payload as well as the request: a retry
// that re-resolves the same request records a differing decision as its own
// receipt instead of failing on the first attempt's.
function semanticIntentEventId(
  tenantId: string,
  actorId: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  return `intent-semantic:${createHash("sha256")
    .update(`${tenantId}\u0000${actorId}\u0000${requestId}\u0000${canonicalJsonSha256(payload)}`)
    .digest("hex")}`;
}

function commandContextPinEventId(
  tenantId: string,
  actorId: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  return `command-context:${createHash("sha256")
    .update(`${tenantId}\u0000${actorId}\u0000${requestId}\u0000${canonicalJsonSha256(payload)}`)
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

function resolveClientRequestId(request: Request, bodyRequestId?: string) {
  const headerRequestId = request.headers.get("idempotency-key")?.trim();
  if (headerRequestId && (headerRequestId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(headerRequestId))) {
    throw new Error("Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.");
  }
  if (bodyRequestId && headerRequestId && bodyRequestId !== headerRequestId) {
    throw new Error("requestId and Idempotency-Key must match when both are provided.");
  }
  return bodyRequestId || headerRequestId || undefined;
}

/** Streams the recorded outcome of a request that already ran. */
function replayedAgentRequestResponse(events: readonly AgentEvent[]) {
  const encoder = new TextEncoder();
  return sseResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(encodeSse(event)));
      }
      controller.close();
    },
  }));
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

function isBuiltInAgentId(value?: string): value is "atlas" | "scout" | "meridian" | "forge" | "sentinel" | "mnemosyne" {
  return value === "atlas" || value === "scout" || value === "meridian" || value === "forge" || value === "sentinel" || value === "mnemosyne";
}

function isDurableSpecialistAgentId(
  value: string,
): value is DurableSpecialistAgentId {
  return value === "atlas" || value === "scout" || value === "forge" || value === "sentinel" || value === "mnemosyne";
}
