import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  getCurrentTenantCapabilityRollout,
  registerTenantCapabilityRollout,
  tenantCapabilityRolloutModeSchema,
  tenantCapabilityRolloutStatusSchema,
  transitionTenantCapabilityRolloutStatus,
  TenantCapabilityRolloutError,
} from "@/lib/rollouts/tenant-capability-rollouts";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  sourceContractIdSchema,
  sourceContractSha256Schema,
} from "@/lib/sources/contracts";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const positiveGenerationSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const mutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("register"),
      capabilityId: sourceContractIdSchema,
      rolloutGeneration: positiveGenerationSchema,
      engineVersion: sourceContractIdSchema,
      contractVersionId: sourceContractIdSchema,
      configurationSha256: sourceContractSha256Schema,
      mode: tenantCapabilityRolloutModeSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("transition"),
      capabilityId: sourceContractIdSchema,
      expectedRolloutGeneration: positiveGenerationSchema,
      expectedStatus: tenantCapabilityRolloutStatusSchema,
      nextStatus: tenantCapabilityRolloutStatusSchema,
    })
    .strict(),
]);

async function GETHandler(request: Request) {
  const capabilityId = sourceContractIdSchema.safeParse(
    new URL(request.url).searchParams.get("capabilityId"),
  );
  if (!capabilityId.success) {
    return Response.json(
      { error: "A valid capabilityId query parameter is required." },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "tenant_capability_rollout",
      resourceId: capabilityId.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const rollout = await getCurrentTenantCapabilityRollout({
      tenantId: context.tenantId,
      capabilityId: capabilityId.data,
    });
    return Response.json(
      { rollout },
      { headers: { "cache-control": "no-store, private" } },
    );
  } catch (error) {
    return rolloutErrorResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 16_384);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid capability rollout mutation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.security",
      resourceType: "tenant_capability_rollout",
      resourceId: parsed.data.capabilityId,
      riskLevel: 3,
      metadata: {
        action: parsed.data.action,
        capabilityId: parsed.data.capabilityId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const executionScope = executionScopeFromSecurityContext(context, {
    executingPrincipalType: "system",
    executingPrincipalId: context.actorId,
    correlationId: request.headers.get("x-request-id") || crypto.randomUUID(),
    purpose: `capability.rollout.${parsed.data.action}`,
  });

  try {
    const rollout = parsed.data.action === "register"
      ? await registerTenantCapabilityRollout({
          tenantId: context.tenantId,
          capabilityId: parsed.data.capabilityId,
          rolloutGeneration: parsed.data.rolloutGeneration,
          engineVersion: parsed.data.engineVersion,
          contractVersionId: parsed.data.contractVersionId,
          configurationSha256: parsed.data.configurationSha256,
          mode: parsed.data.mode,
          executionScope,
        })
      : await transitionTenantCapabilityRolloutStatus({
          tenantId: context.tenantId,
          capabilityId: parsed.data.capabilityId,
          expectedRolloutGeneration: parsed.data.expectedRolloutGeneration,
          expectedStatus: parsed.data.expectedStatus,
          nextStatus: parsed.data.nextStatus,
          executionScope,
        });
    return Response.json(
      { rollout },
      {
        status: parsed.data.action === "register" ? 201 : 200,
        headers: { "cache-control": "no-store, private" },
      },
    );
  } catch (error) {
    return rolloutErrorResponse(error);
  }
}

function rolloutErrorResponse(error: unknown) {
  if (!(error instanceof TenantCapabilityRolloutError)) throw error;
  const status = {
    postgres_required: 503,
    scope_mismatch: 403,
    generation_conflict: 409,
    rollout_not_found: 404,
    status_conflict: 409,
    invalid_transition: 409,
    storage_invariant: 500,
  }[error.code];
  return Response.json(
    { error: "Capability rollout operation failed", code: error.code },
    { status },
  );
}
