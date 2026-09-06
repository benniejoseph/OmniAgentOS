import { createHash, randomUUID } from "node:crypto";

import p05Suite from "../../../../../evals/p05/suite.v1.json";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { runPhaseZeroGate } from "@/lib/evals2/phase-zero";
import { appendScopedDomainEvent, listStreamEvents } from "@/lib/events/store";
import { LOOP_V2_CAPABILITY_ID } from "@/lib/orchestration/loop-v2";
import { getCurrentTenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let correlationId: string;
  try {
    correlationId = resolveCorrelationId(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid idempotency key." },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: {
        suite: "p0-production-phase-gate-v1",
        safetyMode: "synthetic_read_only",
        effectCount: 0,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const executionScope = executionScopeFromSecurityContext(context, {
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId,
    purpose: "evaluation.p0.phase_gate",
  });
  const streamId = `evaluation:${correlationId}`;
  const existing = (await listStreamEvents(streamId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    limit: 1,
    order: "desc",
  })).find((event) => event.type === "evaluation.phase_zero.completed");
  if (existing) {
    return Response.json({
      report: existing.payload,
      observations: [],
      replayed: true,
    });
  }

  const currentRollout = await getCurrentTenantCapabilityRollout({
    tenantId: context.tenantId,
    capabilityId: LOOP_V2_CAPABILITY_ID,
  });
  const result = runPhaseZeroGate({
    p05Suite,
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId,
    currentRollout,
  });
  await appendScopedDomainEvent({
    id: `evaluation-p0-phase:${createHash("sha256")
      .update(`${context.tenantId}\u0000${context.actorId}\u0000${correlationId}`)
      .digest("hex")}`,
    streamId,
    type: "evaluation.phase_zero.completed",
    executionScope,
    payload: {
      ...result.report,
      failedGateIds: [...result.report.failedGateIds],
      safetyMode: "synthetic_read_only",
      effectCount: 0,
    },
  });
  return Response.json(result);
}

function resolveCorrelationId(request: Request) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return randomUUID();
  if (
    idempotencyKey.length > 160 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    throw new Error(
      "Idempotency-Key must be 160 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  return idempotencyKey;
}

