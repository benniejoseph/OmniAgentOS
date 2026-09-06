import { randomUUID } from "node:crypto";
import { createPortableArchive } from "@/lib/data/portable";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  return exportArchive(request, { includeAssets: false });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 2_048);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Export options must be a JSON object." }, { status: 400 });
  }
  const options = body as Record<string, unknown>;
  if (options.includeAssets !== true) {
    return Response.json({ error: "POST export is reserved for encrypted asset inclusion." }, { status: 400 });
  }
  if (typeof options.assetPassphrase !== "string" || options.assetPassphrase.normalize("NFKC").length < 12 || options.assetPassphrase.length > 256) {
    return Response.json({ error: "Encrypted asset export requires a 12-256 character passphrase." }, { status: 400 });
  }
  return exportArchive(request, {
    includeAssets: true,
    assetPassphrase: options.assetPassphrase,
  });
}

async function exportArchive(request: Request, options: {
  includeAssets: boolean;
  assetPassphrase?: string;
}) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "portable_archive", metadata: { operation: "export" } }); }
  catch (error) { return forbiddenResponse(error); }
  const requestAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.export,
    auditPurpose: "api.portable.export",
    correlationId: `memory_export_${randomUUID()}`,
  });
  const archive = await createPortableArchive({
    tenantId: context.tenantId,
    actorId: context.actorId,
    memoryAccessScope: requestAccess?.databaseAccessScope,
    includeAssets: options.includeAssets,
    assetPassphrase: options.assetPassphrase,
  });
  const date = new Date().toISOString().slice(0, 10);
  return Response.json(archive, { headers: { "cache-control": "private, no-store", "content-disposition": `attachment; filename=asael-${date}-v2.json`, "x-content-type-options": "nosniff", "x-asael-archive-sha256": archive.archiveSha256 } });
}
