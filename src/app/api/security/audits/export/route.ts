import { createSignedAuditExport } from "@/lib/security/audit-export";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read.security", resourceType: "security_audit", metadata: { operation: "signed_export" } }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const report = await createSignedAuditExport(context.tenantId);
    return Response.json(report, { headers: { "cache-control": "private, no-store", "content-disposition": `attachment; filename=asael-audit-${new Date().toISOString().slice(0, 10)}.json` } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Signed audit export failed." }, { status: 503 }); }
}
