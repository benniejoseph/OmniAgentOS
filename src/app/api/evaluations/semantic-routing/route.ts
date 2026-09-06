import { createHash, randomUUID } from "node:crypto";
import semanticRoutingSuite from "../../../../../evals/p62/semantic-routing.v1.json";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { runSemanticRoutingBenchmark } from "@/lib/evals2/semantic-routing-runtime";
import {
  appendScopedDomainEvent,
  listStreamEvents,
} from "@/lib/events/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
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
        suite: "p6.2-semantic-routing-v1",
        safetyMode: "synthetic",
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
    purpose: "evaluation.p6_2.semantic_routing",
  });
  const streamId = `evaluation:${correlationId}`;
  const existing = (await listStreamEvents(streamId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    limit: 1,
    order: "desc",
  })).find((event) =>
    event.type === "evaluation.semantic_routing.completed"
  );
  if (existing) {
    return Response.json({
      report: existing.payload,
      observations: [],
      replayed: true,
    });
  }
  const result = await runSemanticRoutingBenchmark({
    suite: semanticRoutingSuite,
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId,
  });
  await appendScopedDomainEvent({
    id: `evaluation-p62:${createHash("sha256")
      .update(`${context.tenantId}\u0000${context.actorId}\u0000${correlationId}`)
      .digest("hex")}`,
    streamId,
    type: "evaluation.semantic_routing.completed",
    executionScope,
    payload: {
      ...result.report,
      routeFailures: [...result.report.routeFailures],
      missingToolBindings: [...result.report.missingToolBindings],
      fallbackCases: [...result.report.fallbackCases],
      safetyMode: "synthetic",
      selectedToolIds: [],
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
