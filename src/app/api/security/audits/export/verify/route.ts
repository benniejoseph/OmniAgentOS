import { verifySignedAuditExport } from "@/lib/security/audit-export";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  try { await authorizeRequest({ request, action: "read.security", resourceType: "security_audit", metadata: { operation: "verify_signed_export" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 10 * 1024 * 1024); } catch (error) { return jsonBodyErrorResponse(error); }
  try { const result = verifySignedAuditExport(body); return Response.json(result, { status: result.valid ? 200 : 422, headers: { "cache-control": "private, no-store" } }); }
  catch (error) { return Response.json({ valid: false, error: error instanceof Error ? error.message : "Audit verification failed." }, { status: 503 }); }
}
