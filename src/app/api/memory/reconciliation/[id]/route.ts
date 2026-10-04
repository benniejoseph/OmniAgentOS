import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectMemoryReconciliationService } from "@/lib/app-services/memory-reconciliation";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { MemoryReconciliationNativeError } from "@/lib/memory/reconciliation-native-contracts";
import { nativeMemoryReconciliationIdSchema, nativeMemoryReconciliationReadQuerySchema } from "@/lib/mobile/memory-reconciliation-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  const params = [...new URL(request.url).searchParams];
  const query = nativeMemoryReconciliationReadQuerySchema.safeParse(Object.fromEntries(params));
  if (!nativeMemoryReconciliationIdSchema.safeParse(id).success || !query.success ||
    new Set(params.map(([key]) => key)).size !== params.length) {
    return Response.json({ error: "Invalid Memory reconciliation target." }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "memory_reconciliation", resourceId: id });
  } catch (error) {
    const response = forbiddenResponse(error);
    response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]);
    return response;
  }
  try {
    const result = await inspectMemoryReconciliationService(createAppServiceCaller({ context }), id, query.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return error instanceof MemoryReconciliationNativeError
      ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateNoStoreHeaders })
      : Response.json({ error: "Memory reconciliation is temporarily unavailable.", code: "memory_reconciliation_unavailable" }, { status: 503, headers: privateNoStoreHeaders });
  }
}
