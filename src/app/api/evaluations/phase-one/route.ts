import { createHash, randomUUID } from "node:crypto";

import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  PHASE_ONE_GATE_SUITE_ID,
  runPhaseOneGate,
} from "@/lib/evals2/phase-one";
import { appendScopedDomainEvent, listStreamEvents } from "@/lib/events/store";
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
        suite: PHASE_ONE_GATE_SUITE_ID,
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
    purpose: "evaluation.p1.phase_gate",
  });
  const streamId = `evaluation:${correlationId}`;
  const existing = (await listStreamEvents(streamId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    limit: 1,
    order: "desc",
  })).find((event) => event.type === "evaluation.phase_one.completed");
  if (existing) {
    return Response.json({
      report: existing.payload,
      observations: [],
      replayed: true,
    });
  }

  const result = await runPhaseOneGate({
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId,
  });
  await appendScopedDomainEvent({
    id: `evaluation-p1-phase:${createHash("sha256")
      .update(`${context.tenantId}\u0000${context.actorId}\u0000${correlationId}`)
      .digest("hex")}`,
    streamId,
    type: "evaluation.phase_one.completed",
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
