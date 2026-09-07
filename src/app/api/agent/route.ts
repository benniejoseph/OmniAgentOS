import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_MESSAGES,
  AGENT_RUN_BUDGET_LIMITS,
  AGENT_RUNS_PER_MINUTE,
  WORKFLOW_RUN_BUDGET_LIMITS,
} from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
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
import { runAgent } from "@/lib/orchestration/agent-runner";
import {
  narrowRunBudgetLimits,
  runBudgetCountersV1Schema,
} from "@/lib/runs/budgets";
import {
  resolveLoopV2ReadOnlyCanaryEnrollment,
  runLoopV2ReadOnlyCanary,
} from "@/lib/orchestration/loop-v2-runtime";
import {
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
import { redactSensitive } from "@/lib/security/context";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getCustomAgent, listAgentSkills } from "@/lib/skills/store";
import {
  bindDurableSpecialistsToWorkflow,
  prepareDurableSpecialistDelegation,
  scheduleDurableSpecialistDrain,
} from "@/lib/subagents/scheduler";
import type { PreparedDurableSpecialist } from "@/lib/subagents/types";
import {
  buildWorkflowProcedureSnapshot,
  listSavedProcedures,
  parseWorkflowProcedureSnapshot,
  toSupervisorKnownProcedures,
} from "@/lib/workflows/saved-procedures";

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
      metadata: {
        mode: parsed.data.mode || "orchestrate",
        messageCount: parsed.data.messages?.length || 1,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
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
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
    });
    if (!project) {
      return Response.json(
        { error: "Project not found." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    }
  }
  const promptMemoryAccess = contextSelection?.evidenceIds.length
    ? agentPromptMemoryAccessFromSecurityContext(context, {
        correlationId: requestId,
      })
    : undefined;
  const promptEntityGraphAccess = contextSelection?.evidenceIds.some((id) =>
    id.startsWith("graph:relationship_path_")
  )
    ? requestEntityAccessFromSecurityContext(context, {
        purposeId: "entity.read.v1",
        correlationId: requestId,
      })
    : undefined;
  let budgetLimits;
  let workflowBudgetLimits;
  try {
    budgetLimits = narrowRunBudgetLimits(
      AGENT_RUN_BUDGET_LIMITS,
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
    ? (await listAgentSkills({ tenantId: context.tenantId, actorId: context.actorId })).filter((skill) => customAgent.skillIds.includes(skill.id) && skill.status === "active")
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
    savedProcedures = await listSavedProcedures({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
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
    parsed.data.strategy,
  );

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
        selectedTargetIds: [],
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
        metadata: { source: "atomic_supervisor", threadId: parsed.data.threadId },
      });
    } catch (error) {
      return forbiddenResponse(error);
    }
  }

  const encoder = new TextEncoder();
  let threadId = parsed.data.threadId;
  let threadProjectId = parsed.data.projectId;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(encodeSse({
          type: "status",
          label: "supervisor routing",
          detail: preliminaryDecision.reasons[0] || "Selecting the right execution path.",
        })));
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
        const agentPrincipalExecution = {
          executingPrincipalType: "agent" as const,
          executingPrincipalId: agentIdentity.principal.principalId,
          contextGrantIds: agentIdentity.principal.contextGrantIds,
          capabilityGrantIds: agentIdentity.principal.capabilityGrantIds,
        };
        let loopV2CanaryEnrollment;
        let loopV2ModelTextEnrollment;
        try {
          loopV2CanaryEnrollment = parsed.data.budgets || parsed.data.contextScope || parsed.data.voiceInput
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
            !parsed.data.budgets &&
            !parsed.data.contextScope &&
            !parsed.data.voiceInput
          ) {
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
          loopV2CanaryEnrollment || loopV2ModelTextEnrollment;
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
          const userTurn = await appendThreadTurn({ tenantId: context.tenantId, threadId: thread.id, role: "user", content: safeMessage });
          if (parsed.data.voiceInput) {
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
          const explicitMemory = await formExplicitUserAssertionMemory({
            context,
            requestId,
            threadId: thread.id,
            turnId: userTurn.id,
            message: safeMessage,
          });
          if (explicitMemory) {
            controller.enqueue(encoder.encode(encodeSse({
              type: "memory",
              title: "Explicit memory saved",
              count: 1,
            })));
          }
          if (decision.route === "clarify" && !loopV2Enrollment) {
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
            controller.enqueue(encoder.encode(encodeSse({
              type: "clarification",
              threadId: thread.id,
              message: ambiguity.clarificationPrompt,
              reasonCode: ambiguity.reasonCode,
            })));
            return;
          }
          const needsMission = Boolean(parsed.data.missionId) || decision.route === "durable_workflow";
          if (needsMission) {
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
            const { createWorkflowRun } = await import("@/lib/workflows/store");
            const detail = await createWorkflowRun({
              tenantId: context.tenantId,
              executionAuthority: {
                executionScope: executionScopeFromSecurityContext(context, {
                  ...agentPrincipalExecution,
                  projectId: threadProjectId,
                  missionId: mission.id,
                  correlationId: requestId,
                  causationId: missionTask.id,
                  purpose: "workflow.run",
                }),
                requesterRole: context.role,
              },
              goal: executionMessage,
              mode,
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
              },
              idempotencyKey: `supervisor:${context.actorId}:${requestId}`,
            });
            if (detail.run.goal !== executionMessage.trim()) {
              throw new Error("requestId was already used for a different instruction. Submit this work with a new requestId.");
            }
            if (!sameContextSelection(detail.run.input.metadata?.contextSelection, contextSelection)) {
              throw new Error("requestId was already used with a different context selection. Submit this work with a new requestId.");
            }
            if (!sameSavedProcedure(detail.run.input.metadata?.savedProcedure, savedProcedure)) {
              throw new Error("requestId was already used with a different saved procedure. Submit this work with a new requestId.");
            }
            await bindDurableSpecialistsToWorkflow(
              durableSpecialists,
              detail.run.id,
              missionOwner,
            );
            await attachMissionExecutor({
              taskId: missionTask.id,
              executorType: "workflow_run",
              executorId: detail.run.id,
              status: "queued",
              payload: { route: decision.route, threadId: thread.id },
            }, missionOwner);
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
            controller.enqueue(encoder.encode(encodeSse({
              type: "delegated",
              threadId: thread.id,
              workflowId: detail.run.id,
              missionId: mission.id,
              acknowledgement,
              reason: decision.reasons[0] || "Durable execution selected.",
            })));
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
        const directExecutionScope = executionScopeFromSecurityContext(
          context,
          {
            ...agentPrincipalExecution,
            projectId: threadProjectId,
            missionId: mission?.id,
            correlationId: requestId,
            purpose: loopV2CanaryEnrollment
              ? "agent.loop.v2.read_only_canary"
              : loopV2ModelTextEnrollment
                ? "agent.loop.v2.model_text_canary"
                : "agent.run",
          },
        );
        const directEvents = loopV2CanaryEnrollment
          ? runLoopV2ReadOnlyCanary(
              {
                message: safeRequestMessage,
                messages: safeMessages,
                mode,
                threadId,
                agentId: executingAgentId,
                securityContext: context,
                executionScope: directExecutionScope,
                agentIdentity,
                enrollment: loopV2CanaryEnrollment,
                resumeRunId: parsed.data.resumeRunId,
              },
              request.signal,
            )
          : loopV2ModelTextEnrollment
            ? runLoopV2ModelText(
                {
                  message: safeRequestMessage,
                  mode,
                  threadId,
                  agentId: executingAgentId,
                  securityContext: context,
                  executionScope: directExecutionScope,
                  agentIdentity,
                  enrollment: loopV2ModelTextEnrollment,
                },
                request.signal,
              )
          : runAgent(
              {
                mode: parsed.data.mode,
                threadId,
                messages: safeMessages,
                securityContext: context,
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
                promptEntityGraphAccess,
                executionScope: directExecutionScope,
                agentIdentity,
                tenantId: context.tenantId,
                actorId: context.actorId,
                role: context.role,
                agentId: executingAgentId,
                specialistIds: decision.specialistIds,
                adaptationEvidence: decision.adaptationEvidence,
                agentProfile,
                budgetLimits,
                voiceInput: parsed.data.voiceInput,
              },
              request.signal,
            );
        let directExecutorId = "";
        let directTerminal = false;
        let directMissionAttachment: Promise<{ error?: unknown }> | undefined;
        for await (const event of directEvents) {
          if (event.type === "run") {
            directExecutorId = event.runId;
            controller.enqueue(encoder.encode(encodeSse(
              mission ? { ...event, missionId: mission.id } : event,
            )));
            if (mission && missionTask) {
              directMissionAttachment = attachMissionExecutor({
                taskId: missionTask.id,
                executorType: "agent_run",
                executorId: event.runId,
                status: "running",
                payload: { threadId, route: decision.route },
              }, missionOwner).then(
                () => ({}),
                (error) => ({ error }),
              );
            }
            continue;
          } else if (event.type === "waiting_approval" && directExecutorId && directMissionAttachment) {
            await requireMissionAttachment(directMissionAttachment);
            await syncMissionExecutor({
              executorType: "agent_run",
              executorId: directExecutorId,
              status: "waiting",
            }, missionOwner);
          } else if (event.type === "done" && directExecutorId && directMissionAttachment) {
            await requireMissionAttachment(directMissionAttachment);
            directTerminal = true;
            await syncMissionExecutor({
              executorType: "agent_run",
              executorId: directExecutorId,
              status: "succeeded",
              output: {
                responseLength: event.response.length,
                responseSha256: createHash("sha256").update(event.response).digest("hex"),
                groundingStatus: event.grounding?.status,
              },
            }, missionOwner);
          } else if (event.type === "error" && directExecutorId && directMissionAttachment) {
            await requireMissionAttachment(directMissionAttachment);
            directTerminal = true;
            await syncMissionExecutor({
              executorType: "agent_run",
              executorId: directExecutorId,
              status: "failed",
              error: event.message,
            }, missionOwner);
          } else if (event.type === "status" && event.label === "Canceled" && directExecutorId && directMissionAttachment) {
            await requireMissionAttachment(directMissionAttachment);
            directTerminal = true;
            await syncMissionExecutor({
              executorType: "agent_run",
              executorId: directExecutorId,
              status: "canceled",
            }, missionOwner);
          }
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
          controller.enqueue(encoder.encode(encodeSse(event)));
        }
        if (directExecutorId && directMissionAttachment && !directTerminal && mission) {
          await requireMissionAttachment(directMissionAttachment);
          // Waiting approvals remain resumable. Every other non-terminal exit is
          // treated as a canceled execution receipt rather than left running.
          const waiting = await getMission(mission.id, missionOwner);
          if (waiting?.status !== "waiting") {
            await syncMissionExecutor({
              executorType: "agent_run",
              executorId: directExecutorId,
              status: "canceled",
            }, missionOwner);
          }
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeSse({
              type: "error",
              message: String(
                redactSensitive(
                  error instanceof Error ? error.message : "Agent run failed.",
                ),
              ).slice(0, 1_000),
            }),
          ),
        );
      } finally {
        controller.close();
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

function isBuiltInAgentId(value?: string): value is "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne" {
  return value === "atlas" || value === "scout" || value === "forge" || value === "sentinel" || value === "mnemosyne";
}
