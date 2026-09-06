import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  getCurrentTenantCapabilityRollout,
  registerTenantCapabilityRollout,
  transitionTenantCapabilityRolloutStatus,
  TenantCapabilityRolloutError,
} from "@/lib/rollouts/tenant-capability-rollouts";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  ASSET_OBJECT_READ_CAPABILITY_ID,
  ASSET_OBJECT_READ_CONFIGURATION_SHA256,
  ASSET_OBJECT_READ_CONTRACT_VERSION,
  ASSET_OBJECT_READ_ENGINE_VERSION,
  AssetObjectMigrationError,
  getLatestAssetObjectMigration,
  startAssetObjectMigration,
} from "@/lib/storage/object-migration";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const mutationSchema = z
  .object({ action: z.enum(["start", "activate", "rollback"]) })
  .strict();
const privateHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "asset_object_migration",
      resourceId: ASSET_OBJECT_READ_CAPABILITY_ID,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const [migration, rollout] = await Promise.all([
      getLatestAssetObjectMigration({
        tenantId: context.tenantId,
        ownerActorId: context.actorId,
      }),
      getCurrentTenantCapabilityRollout({
        tenantId: context.tenantId,
        capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
      }),
    ]);
    return Response.json(
      { migration: projectMigration(migration), rollout },
      { headers: privateHeaders },
    );
  } catch (error) {
    return migrationErrorResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 4_096);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid asset object migration action." },
      { status: 400, headers: privateHeaders },
    );
  }
  const action = parsed.data.action;
  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: action === "start" ? "write.memory" : "manage.security",
      resourceType: "asset_object_migration",
      resourceId: ASSET_OBJECT_READ_CAPABILITY_ID,
      riskLevel: action === "start" ? 2 : 3,
      metadata: { action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = executionScopeFromSecurityContext(context, {
    correlationId: request.headers.get("x-request-id") || crypto.randomUUID(),
    purpose: `asset.object.migration.${action}`,
  });

  try {
    if (action === "start") {
      const rollout = await ensureShadowRollout(context.tenantId, executionScope);
      const migration = await startAssetObjectMigration({
        tenantId: context.tenantId,
        ownerActorId: context.actorId,
        executionScope,
      });
      return Response.json(
        { migration: projectMigration(migration), rollout },
        { status: 202, headers: privateHeaders },
      );
    }
    const migration = await getLatestAssetObjectMigration({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
    });
    if (action === "activate") {
      if (migration?.status !== "completed" || !migration.verificationSha256) {
        return Response.json(
          { error: "Asset object migration must pass parity verification first." },
          { status: 409, headers: privateHeaders },
        );
      }
      const rollout = await activateObjectReader(
        context.tenantId,
        executionScope,
      );
      return Response.json(
        { migration: projectMigration(migration), rollout },
        { headers: privateHeaders },
      );
    }
    const rollout = await rollbackObjectReader(
      context.tenantId,
      executionScope,
    );
    return Response.json(
      { migration: projectMigration(migration), rollout },
      { headers: privateHeaders },
    );
  } catch (error) {
    return migrationErrorResponse(error);
  }
}

async function ensureShadowRollout(
  tenantId: string,
  executionScope: Parameters<typeof registerTenantCapabilityRollout>[0]["executionScope"],
) {
  const current = await getCurrentTenantCapabilityRollout({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
  });
  if (current && current.mode !== "shadow") return current;
  const registered = current || await registerAssetObjectRollout(
    tenantId,
    1,
    "shadow",
    executionScope,
  );
  if (registered.status === "active") return registered;
  return transitionTenantCapabilityRolloutStatus({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
    expectedRolloutGeneration: registered.rolloutGeneration,
    expectedStatus: registered.status,
    nextStatus: "active",
    executionScope,
  });
}

async function activateObjectReader(
  tenantId: string,
  executionScope: Parameters<typeof registerTenantCapabilityRollout>[0]["executionScope"],
) {
  const current = await getCurrentTenantCapabilityRollout({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
  });
  if (!current) {
    throw new AssetObjectMigrationError(
      "Asset object shadow rollout was not started.",
      "invalid_contract",
    );
  }
  if (current.mode !== "shadow") {
    if (current.status === "active") return current;
    if (current.status === "paused") {
      return transitionTenantCapabilityRolloutStatus({
        tenantId,
        capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
        expectedRolloutGeneration: current.rolloutGeneration,
        expectedStatus: "paused",
        nextStatus: "active",
        executionScope,
      });
    }
  }
  if (current.status !== "active") {
    throw new AssetObjectMigrationError(
      "Asset object shadow rollout is not active.",
      "invalid_contract",
    );
  }
  const registered = await registerAssetObjectRollout(
    tenantId,
    current.rolloutGeneration + 1,
    "canary",
    executionScope,
  );
  return transitionTenantCapabilityRolloutStatus({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
    expectedRolloutGeneration: registered.rolloutGeneration,
    expectedStatus: "registered",
    nextStatus: "active",
    executionScope,
  });
}

async function rollbackObjectReader(
  tenantId: string,
  executionScope: Parameters<typeof registerTenantCapabilityRollout>[0]["executionScope"],
) {
  const current = await getCurrentTenantCapabilityRollout({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
  });
  if (!current) return null;
  if (current.status === "paused") return current;
  if (current.status !== "active") {
    throw new AssetObjectMigrationError(
      "Only an active asset object reader can be rolled back.",
      "invalid_contract",
    );
  }
  return transitionTenantCapabilityRolloutStatus({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
    expectedRolloutGeneration: current.rolloutGeneration,
    expectedStatus: "active",
    nextStatus: "paused",
    executionScope,
  });
}

function registerAssetObjectRollout(
  tenantId: string,
  generation: number,
  mode: "shadow" | "canary",
  executionScope: Parameters<typeof registerTenantCapabilityRollout>[0]["executionScope"],
) {
  return registerTenantCapabilityRollout({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
    rolloutGeneration: generation,
    engineVersion: ASSET_OBJECT_READ_ENGINE_VERSION,
    contractVersionId: ASSET_OBJECT_READ_CONTRACT_VERSION,
    configurationSha256: ASSET_OBJECT_READ_CONFIGURATION_SHA256,
    mode,
    executionScope,
  });
}

function projectMigration(
  migration: Awaited<ReturnType<typeof getLatestAssetObjectMigration>>,
) {
  if (!migration) return null;
  return {
    id: migration.id,
    generation: migration.generation,
    status: migration.status,
    totalCount: migration.totalCount,
    readyCount: migration.readyCount,
    pendingCount: migration.pendingCount,
    failedCount: migration.failedCount,
    missingCount: migration.missingCount,
    mismatchCount: migration.mismatchCount,
    verificationSha256: migration.verificationSha256,
    operationJobId: migration.operationJobId,
    startedAt: migration.startedAt,
    completedAt: migration.completedAt,
    updatedAt: migration.updatedAt,
  };
}

function migrationErrorResponse(error: unknown) {
  if (error instanceof AssetObjectMigrationError) {
    const status = {
      database_required: 503,
      invalid_contract: 409,
      migration_not_found: 404,
      scope_mismatch: 403,
      verification_failed: 409,
    }[error.code];
    return Response.json(
      { error: error.message, code: error.code },
      { status, headers: privateHeaders },
    );
  }
  if (error instanceof TenantCapabilityRolloutError) {
    const status = error.code === "postgres_required"
      ? 503
      : error.code === "scope_mismatch"
        ? 403
        : error.code === "rollout_not_found"
          ? 404
          : error.code === "storage_invariant"
            ? 500
            : 409;
    return Response.json(
      { error: "Asset object rollout failed.", code: error.code },
      { status, headers: privateHeaders },
    );
  }
  throw error;
}
