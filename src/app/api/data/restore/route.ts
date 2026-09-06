import { randomUUID } from "node:crypto";
import { restorePortableArchive } from "@/lib/data/portable";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "portable_archive", metadata: { operation: "restore" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 4 * 1024 * 1024); } catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const requestBody = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined;
    const archive = requestBody?.archive ?? body;
    const assetPassphrase = typeof requestBody?.assetPassphrase === "string"
      ? requestBody.assetPassphrase
      : undefined;
    const requestAccess = requestMemoryAccessFromSecurityContext(context, {
      purposeId: MEMORY_PURPOSE_IDS.write,
      auditPurpose: "api.portable.restore",
      correlationId: `memory_restore_${randomUUID()}`,
    });
    const restored = await restorePortableArchive(archive, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      privateMemoryOwnerActorId:
        requestAccess?.actorBinding.canonicalActorId,
      memoryAccessScope: requestAccess?.databaseAccessScope,
      memoryExecutionScope: requestAccess?.executionScope,
      abortSignal: request.signal,
      assetPassphrase,
    });
    return Response.json({ restored }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Archive restore failed." }, { status: 400 });
  }
}
