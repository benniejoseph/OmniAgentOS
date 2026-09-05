import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AGENT_RUNS_PER_MINUTE } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { publicAgentRun } from "@/lib/runs/public";
import {
  createRunForkFromCheckpoint,
  runForkRequestCorrelationId,
} from "@/lib/runs/fork-store";
import {
  MAX_RUN_FORK_CORRECTION_CHARS,
  RUN_FORK_PURPOSE,
} from "@/lib/runs/forks";
import {
  claimQueuedAgentRun,
  getAgentRun,
} from "@/lib/runs/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getCustomAgent, listAgentSkills } from "@/lib/skills/store";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

const requestSchema = z.object({
  checkpointId: z.string().trim().min(1).max(240),
  correction: z.string().trim().min(1).max(MAX_RUN_FORK_CORRECTION_CHARS),
  requestId: z.string().trim().min(1).max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/).optional(),
}).strict();

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: sourceRunId } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid checkpoint correction", details: parsed.error.flatten() },
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

  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "run_checkpoint_fork",
      resourceId: sourceRunId,
      metadata: { checkpointId: parsed.data.checkpointId },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let rate;
  try {
    rate = await checkSharedRateLimit({
      key: `agent:${auth.tenantId}:${auth.actorId}`,
      limit: AGENT_RUNS_PER_MINUTE,
    });
  } catch (error) {
    if (!(error instanceof RateLimitStoreUnavailableError)) throw error;
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

  const source = await getAgentRun(sourceRunId, { tenantId: auth.tenantId });
  if (!source) return Response.json({ error: "Run not found." }, { status: 404 });
  const agentId = source.agentId || "atlas";
  const profileResult = await resolveAgentProfile(agentId, {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
  });
  if (profileResult.error) {
    return Response.json(
      { error: profileResult.error },
      { status: profileResult.status },
    );
  }
  const executionScope = executionScopeFromSecurityContext(auth, {
    executingPrincipalType: "agent",
    executingPrincipalId: agentId,
    correlationId: runForkRequestCorrelationId(requestId),
    causationId: parsed.data.checkpointId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: RUN_FORK_PURPOSE,
  });

  let fork;
  try {
    fork = await createRunForkFromCheckpoint({
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      sourceRunId,
      checkpointId: parsed.data.checkpointId,
      correction: parsed.data.correction,
      idempotencyKey: requestId,
      executionScope,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run fork failed.";
    const status = /not found|expected exactly one source/i.test(message)
      ? 404
      : /idempotency|already exists|invalid|does not match|missing|requires/i.test(message)
        ? 409
        : 500;
    return Response.json({ error: "Run fork failed", message }, { status });
  }

  if (["completed", "failed", "canceled", "waiting_approval", "running", "resuming"]
    .includes(fork.run.status)) {
    return forkResponse(fork.lineage, fork.run, fork.created);
  }
  const claimed = await claimQueuedAgentRun(fork.run.id, {
    tenantId: auth.tenantId,
  });
  if (!claimed) {
    const current = await getAgentRun(fork.run.id, { tenantId: auth.tenantId });
    if (!current) {
      return Response.json(
        { error: "Fork target disappeared before execution." },
        { status: 500 },
      );
    }
    return forkResponse(fork.lineage, current, fork.created);
  }

  for await (const event of runAgent({
    preclaimedRunId: claimed.id,
    executionScope,
    mode: claimed.mode,
    messages: claimed.messages,
    threadId: claimed.threadId,
    tenantId: auth.tenantId,
    actorId: auth.actorId,
    role: auth.role,
    agentId,
    specialistIds: claimed.specialistIds,
    agentProfile: profileResult.profile,
  })) {
    void event;
  }
  const completed = await getAgentRun(claimed.id, { tenantId: auth.tenantId });
  if (!completed) {
    return Response.json(
      { error: "Fork target disappeared after execution." },
      { status: 500 },
    );
  }
  return forkResponse(fork.lineage, completed, fork.created);
}

function forkResponse(
  lineage: Awaited<ReturnType<typeof createRunForkFromCheckpoint>>["lineage"],
  run: Awaited<ReturnType<typeof getAgentRun>> extends infer Run
    ? Exclude<Run, undefined>
    : never,
  created: boolean,
) {
  const pending = ["queued", "running", "resuming", "waiting_approval"]
    .includes(run.status);
  return Response.json(
    { lineage, run: publicAgentRun(run), created },
    {
      status: pending ? 202 : 200,
      headers: { "cache-control": "private, no-store" },
    },
  );
}

async function resolveAgentProfile(
  agentId: string,
  owner: { tenantId: string; actorId: string },
) {
  if (isBuiltInAgentId(agentId)) return { profile: undefined };
  const agent = await getCustomAgent(agentId, owner);
  if (!agent) return { error: "The source run's custom agent no longer exists.", status: 409 as const };
  if (agent.status === "paused") {
    return { error: "Resume the source run's custom agent before forking this checkpoint.", status: 409 as const };
  }
  const skills = (await listAgentSkills(owner)).filter(
    (skill) => agent.skillIds.includes(skill.id) && skill.status === "active",
  );
  return {
    profile: {
      name: agent.name,
      role: agent.role,
      description: agent.description,
      instructions: agent.instructions,
      modelPolicy: agent.modelPolicy,
      autonomy: agent.autonomy,
      approvalPolicy: agent.approvalPolicy,
      memoryScope: agent.memoryScope,
      toolIds: agent.toolIds,
      skills: skills.map(({ id, name, description, instructions, toolIds }) => ({
        id, name, description, instructions, toolIds,
      })),
    },
  };
}

function resolveRequestId(request: Request, bodyRequestId?: string) {
  const headerRequestId = request.headers.get("idempotency-key")?.trim();
  if (
    headerRequestId &&
    (headerRequestId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(headerRequestId))
  ) {
    throw new Error(
      "Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  if (bodyRequestId && headerRequestId && bodyRequestId !== headerRequestId) {
    throw new Error("requestId and Idempotency-Key must match when both are provided.");
  }
  return bodyRequestId || headerRequestId || randomUUID();
}

function isBuiltInAgentId(value: string) {
  return ["atlas", "scout", "forge", "sentinel", "mnemosyne"].includes(value);
}
