import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_MAX_MESSAGE_CHARS, AGENT_MAX_MESSAGES, AGENT_RUNS_PER_MINUTE, hasOpenAIKey } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
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
import { runAgent } from "@/lib/orchestration/agent-runner";
import { getAgentPerformance } from "@/lib/agents/performance";
import {
  adaptSupervisorDecision,
  compileThreadContext,
  routeAgentRequest,
} from "@/lib/orchestration/supervisor";
import { redactSensitive } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getCustomAgent, listAgentSkills } from "@/lib/skills/store";
import {
  bindDurableSpecialistsToWorkflow,
  prepareDurableSpecialistDelegation,
  scheduleDurableSpecialistDrain,
} from "@/lib/subagents/scheduler";
import type { PreparedDurableSpecialist } from "@/lib/subagents/types";

export const runtime = "nodejs";
// gpt-5 research/orchestrate runs can exceed 60s; 300s is the Vercel Pro ceiling.
// On Hobby this is silently capped to 60s (harmless).
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
}).strict();

const requestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(AGENT_MAX_MESSAGES).optional(),
  threadId: z.string().uuid().optional(),
  missionId: z.string().uuid().optional(),
  requestId: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
  message: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS).optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  agentId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  specialistIds: z.array(z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"])).max(5).optional(),
  strategy: z.enum(["auto", "direct", "durable"]).optional(),
}).strict().refine((value) => Boolean(value.message || value.messages?.length), { message: "A message is required." });

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
  const requestMessage = parsed.data.message || parsed.data.messages?.at(-1)?.content || "";
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
  const agentProfile = customAgent ? {
    name: customAgent.name,
    role: customAgent.role,
    description: customAgent.description,
    instructions: customAgent.instructions,
    modelPolicy: customAgent.modelPolicy,
    autonomy: customAgent.autonomy,
    approvalPolicy: customAgent.approvalPolicy,
    memoryScope: customAgent.memoryScope,
    toolIds: customAgent.toolIds,
    skills: customSkills.map(({ id, name, description, instructions, toolIds }) => ({ id, name, description, instructions, toolIds })),
  } : undefined;
  const inferredDecision = routeAgentRequest(requestMessage, mode, requestedBuiltInAgent);
  const preliminaryDecision = parsed.data.strategy === "direct"
    ? { ...inferredDecision, route: "direct" as const, reasons: ["Direct execution was explicitly selected."] }
    : parsed.data.strategy === "durable"
      ? { ...inferredDecision, route: "durable_workflow" as const, reasons: ["Durable execution was explicitly selected."] }
      : inferredDecision;

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
  let safeMessages = (parsed.data.messages || []).map((message) => ({
    ...message,
    content: String(redactSensitive(message.content)),
  }));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(encodeSse({
          type: "status",
          label: "supervisor routing",
          detail: preliminaryDecision.reasons[0] || "Selecting the right execution path.",
        })));
        const decision = adaptSupervisorDecision(
          preliminaryDecision,
          hasOpenAIKey() ? await getAgentPerformance(context.tenantId) : [],
        );
        const missionOwner = {
          tenantId: context.tenantId,
          actorId: context.actorId,
        };
        let mission = parsed.data.missionId
          ? await getMission(parsed.data.missionId, missionOwner)
          : undefined;
        if (parsed.data.missionId && !mission) throw new Error("Mission not found.");
        if (mission) assertMissionAcceptsWork(mission);
        let missionTask: MissionTask | undefined;
        let durableSpecialists: PreparedDurableSpecialist[] = [];
        if (parsed.data.message || decision.route === "durable_workflow") {
          const { appendThreadTurn, createThread, getThread, listThreadTurns } = await import("@/lib/threads/store");
          const safeMessage = String(redactSensitive(parsed.data.message || requestMessage));
          let thread = threadId ? await getThread(threadId, { tenantId: context.tenantId }) : null;
          if (thread && thread.actorId !== context.actorId) thread = null;
          if (threadId && !thread) throw new Error("Thread not found.");
          if (!thread) {
            thread = await createThread({ tenantId: context.tenantId, actorId: context.actorId, title: safeMessage, mode: parsed.data.mode || "orchestrate" });
            threadId = thread.id;
          }
          const userTurn = await appendThreadTurn({ tenantId: context.tenantId, threadId: thread.id, role: "user", content: safeMessage });
          const needsMission = Boolean(parsed.data.missionId) || decision.route === "durable_workflow";
          if (needsMission) {
            mission = mission || await createMission({
                ...missionOwner,
                title: missionTitle(safeMessage),
                objective: safeMessage,
                priority: decision.route === "durable_workflow" ? "high" : "normal",
                source: "talk",
                sourceKey: `agent-request:${requestId}`,
                metadata: { threadId: thread.id, turnId: userTurn.id, requestId, route: decision.route },
              });
            if (!mission) throw new Error("Mission not found.");
            assertMissionAcceptsWork(mission);
            const executionMessage = parsed.data.missionId
              ? missionInstruction(mission, safeMessage)
              : safeMessage;
            if (decision.route === "durable_workflow") {
              durableSpecialists = await prepareDurableSpecialistDelegation({
                owner: missionOwner,
                missionId: mission.id,
                requestId,
                objective: executionMessage,
                mode,
                primaryAgentId: decision.primaryAgentId,
                specialistIds: decision.specialistIds,
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
            const { createWorkflowRun } = await import("@/lib/workflows/store");
            const detail = await createWorkflowRun({
              tenantId: context.tenantId,
              goal: executionMessage,
              mode,
              requireApproval: decision.requiresApproval || customAgent?.approvalPolicy === "always",
              metadata: {
                source: "atomic_supervisor",
                threadId: thread.id,
                requestId,
                actorId: context.actorId,
                missionId: mission.id,
                missionTaskId: missionTask.id,
                primaryAgentId: customAgent?.id || decision.primaryAgentId,
                customAgentName: customAgent?.name,
                skillIds: customSkills.map((skill) => skill.id),
                agentProfile,
                specialistIds: decision.specialistIds,
                specialistTaskIds: durableSpecialists.map((item) => item.taskId),
                specialistRunIds: durableSpecialists.map((item) => item.runId),
                learning: decision.learning,
              },
              idempotencyKey: `supervisor:${context.actorId}:${requestId}`,
            });
            if (detail.run.goal !== executionMessage.trim()) {
              throw new Error("requestId was already used for a different instruction. Submit this work with a new requestId.");
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
          const turns = await listThreadTurns(thread.id, { tenantId: context.tenantId, limit: AGENT_MAX_MESSAGES * 2 });
          safeMessages = compileThreadContext(turns, { maxMessages: AGENT_MAX_MESSAGES }).messages;
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
        if (parsed.data.missionId && mission) {
          safeMessages = includeMissionContext(safeMessages, mission);
        }
        let directExecutorId = "";
        let directTerminal = false;
        let directMissionAttachment: Promise<{ error?: unknown }> | undefined;
        for await (const event of runAgent(
          {
            mode: parsed.data.mode,
            threadId,
            messages: safeMessages,
            tenantId: context.tenantId,
            actorId: context.actorId,
            role: context.role,
            agentId: customAgent?.id || decision.primaryAgentId,
            specialistIds: decision.specialistIds,
            agentProfile,
          },
          request.signal,
        )) {
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
