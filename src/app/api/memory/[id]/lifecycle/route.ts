import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { memoryLifecycleActionSchema } from "@/lib/memory/lifecycle";
import {
  MemoryLifecycleConflictError,
  setMemoryLifecycle,
} from "@/lib/memory/maintenance-store";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { getMemory } from "@/lib/memory/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const requestSchema = z.object({ action: memoryLifecycleActionSchema }).strict();
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function PATCHHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory lifecycle request",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory",
      resourceId: id,
      metadata: { lifecycleAction: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = request.headers.get("x-idempotency-key")?.trim()
    .slice(0, 200) || request.headers.get("x-request-id")?.trim().slice(0, 200) ||
    `memory_lifecycle_${randomUUID()}`;
  const readAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "api.memory.lifecycle.read",
    correlationId,
  });
  const maintenanceAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.maintenance,
    auditPurpose: "api.memory.lifecycle.update",
    correlationId,
  });
  let memory = readAccess
    ? await getMemory(id, {
        tenantId: context.tenantId,
        accessScope: readAccess.databaseAccessScope,
      })
    : null;
  const privateMemory = Boolean(memory);
  if (!memory) {
    memory = await getMemory(id, { tenantId: context.tenantId });
  }
  if (!memory) {
    return Response.json({ error: "Memory not found." }, {
      status: 404,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const lifecycle = await setMemoryLifecycle(memory, parsed.data.action, {
      tenantId: context.tenantId,
      accessScope: privateMemory
        ? maintenanceAccess?.databaseAccessScope
        : undefined,
      executionScope: privateMemory && maintenanceAccess
        ? maintenanceAccess.executionScope
        : executionScopeFromSecurityContext(context, {
            correlationId,
            purpose: "api.memory.lifecycle.update",
          }),
    });
    if (!lifecycle) {
      return Response.json({ error: "Memory not found." }, {
        status: 404,
        headers: privateNoStoreHeaders,
      });
    }
    const refreshed = privateMemory && readAccess
      ? await getMemory(id, {
          tenantId: context.tenantId,
          accessScope: readAccess.databaseAccessScope,
        })
      : await getMemory(id, { tenantId: context.tenantId });
    return Response.json({ lifecycle, memory: refreshed }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    if (error instanceof MemoryLifecycleConflictError) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    throw error;
  }
}
