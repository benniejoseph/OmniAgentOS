import { z } from "zod";
import { AGENT_MAX_MESSAGE_CHARS, AGENT_MAX_MESSAGES, AGENT_RUNS_PER_MINUTE, hasOpenAIKey } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { encodeSse, sseResponse } from "@/lib/http/sse";
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
        if (parsed.data.message) {
          const { appendThreadTurn, createThread, getThread, listThreadTurns } = await import("@/lib/threads/store");
          const safeMessage = String(redactSensitive(parsed.data.message));
          let thread = threadId ? await getThread(threadId, { tenantId: context.tenantId }) : null;
          if (thread && thread.actorId !== context.actorId) thread = null;
          if (threadId && !thread) throw new Error("Thread not found.");
          if (!thread) {
            thread = await createThread({ tenantId: context.tenantId, actorId: context.actorId, title: safeMessage, mode: parsed.data.mode || "orchestrate" });
            threadId = thread.id;
          }
          await appendThreadTurn({ tenantId: context.tenantId, threadId: thread.id, role: "user", content: safeMessage });
          if (decision.route === "durable_workflow") {
            const { enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } = await import("@/lib/workflows/queue");
            const { createWorkflowRun } = await import("@/lib/workflows/store");
            const detail = await createWorkflowRun({
              tenantId: context.tenantId,
              goal: safeMessage,
              mode,
              requireApproval: decision.requiresApproval || customAgent?.approvalPolicy === "always",
              metadata: {
                source: "atomic_supervisor",
                threadId: thread.id,
                actorId: context.actorId,
                primaryAgentId: customAgent?.id || decision.primaryAgentId,
                customAgentName: customAgent?.name,
                skillIds: customSkills.map((skill) => skill.id),
                agentProfile,
                specialistIds: decision.specialistIds,
                learning: decision.learning,
              },
              idempotencyKey: `supervisor:${thread.id}:${Date.now()}`,
            });
            await enqueueWorkflowRunTick(detail.run.id, "supervisor_delegated", undefined, context.tenantId);
            scheduleWorkflowQueueDrain(undefined, context.tenantId);
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
              acknowledgement,
              reason: decision.reasons[0] || "Durable execution selected.",
            })));
            return;
          }
          const turns = await listThreadTurns(thread.id, { tenantId: context.tenantId, limit: AGENT_MAX_MESSAGES * 2 });
          safeMessages = compileThreadContext(turns, { maxMessages: AGENT_MAX_MESSAGES }).messages;
        }
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
          controller.enqueue(encoder.encode(encodeSse(event)));
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

function isBuiltInAgentId(value?: string): value is "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne" {
  return value === "atlas" || value === "scout" || value === "forge" || value === "sentinel" || value === "mnemosyne";
}
