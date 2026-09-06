import { createHash, randomUUID } from "node:crypto";

import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  OUTCOME_CONTRACT_GATE_SUITE_ID,
  runOutcomeContractGate,
} from "@/lib/evals2/outcome-contracts";
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
      {
        error: error instanceof Error
          ? error.message
          : "Invalid idempotency key.",
      },
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
        suite: OUTCOME_CONTRACT_GATE_SUITE_ID,
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
    purpose: "evaluation.p1_3.outcome_contracts",
  });
  const streamId = `evaluation:${correlationId}`;
  const existing = (await listStreamEvents(streamId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    limit: 1,
    order: "desc",
  })).find((event) => event.type === "evaluation.outcome_contracts.completed");
  if (existing) {
    return Response.json({
      report: existing.payload,
      observations: [],
      replayed: true,
    });
  }

  const result = runOutcomeContractGate({
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId,
  });
  await appendScopedDomainEvent({
    id: `evaluation-p13-outcomes:${createHash("sha256")
      .update(`${context.tenantId}\u0000${context.actorId}\u0000${correlationId}`)
      .digest("hex")}`,
    streamId,
    type: "evaluation.outcome_contracts.completed",
    executionScope,
    payload: {
      ...result.report,
      failedCaseIds: [...result.report.failedCaseIds],
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
