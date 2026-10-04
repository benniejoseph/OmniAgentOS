import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { reviewKnowledgeSourceDeletionNativeService } from "@/lib/app-services/knowledge-source-deletion";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { privateSourceHeaders, privateSourceResponse, sourceDeletionFailure, sourceDeletionQuery } from "../../native-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ sourceKind: string }> }) => {
  const { sourceKind } = await route.params; let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "knowledge", resourceId: sourceKind }); }
  catch (error) { return privateSourceResponse(forbiddenResponse(error)); }
  try { sourceDeletionQuery(request); const result = await reviewKnowledgeSourceDeletionNativeService(createAppServiceCaller({ context }),sourceKind);
    return Response.json({ ...result.data, serviceReceipt: result.receipt },{ headers: privateSourceHeaders });
  } catch (error) { return sourceDeletionFailure(error); }
});
