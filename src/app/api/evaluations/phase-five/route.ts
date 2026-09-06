import { createHash, randomUUID } from "node:crypto";

import entityResolutionSuite from "../../../../../evals/p52/entity-resolution.v1.json";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  PHASE_FIVE_GATE_SUITE_ID,
  runPhaseFiveGate,
} from "@/lib/evals2/phase-five";
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
    return privateJson(
      { error: error instanceof Error ? error.message : "Invalid idempotency key." },
      400,
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: {
        suite: PHASE_FIVE_GATE_SUITE_ID,
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
    purpose: "evaluation.p5.phase_gate",
  });
  const streamId = `evaluation:${correlationId}`;
  const existing = (await listStreamEvents(streamId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    limit: 1,
    order: "desc",
  })).find((event) => event.type === "evaluation.phase_five.completed");
  if (existing) {
    return privateJson({
      report: existing.payload,
      observations: [],
      replayed: true,
    });
  }

  const result = await runPhaseFiveGate({
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId,
    entityResolutionSuite,
  });
  await appendScopedDomainEvent({
    id: `evaluation-p5-phase:${createHash("sha256")
      .update(`${context.tenantId}\u0000${context.actorId}\u0000${correlationId}`)
      .digest("hex")}`,
    streamId,
    type: "evaluation.phase_five.completed",
    executionScope,
    payload: {
      ...result.report,
      failedGateIds: [...result.report.failedGateIds],
      safetyMode: "synthetic_read_only",
      effectCount: 0,
    },
  });
  return privateJson(result);
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

function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
