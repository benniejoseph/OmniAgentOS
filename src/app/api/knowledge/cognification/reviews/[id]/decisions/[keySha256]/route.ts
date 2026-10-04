import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readKnowledgeCognitionNativeAcceptanceService } from "@/lib/app-services/knowledge-cognification";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cognitionFailure, cognitionQuery, privateCognitionHeaders, privateCognitionResponse } from "../../../native-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ id: string; keySha256: string }> }) => {
  const { id, keySha256 } = await route.params; let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "knowledge_cognition", resourceId: id }); }
  catch (error) { return privateCognitionResponse(forbiddenResponse(error)); }
  try { cognitionQuery(request); const result = await readKnowledgeCognitionNativeAcceptanceService(createAppServiceCaller({ context }), id, keySha256);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateCognitionHeaders });
  } catch (error) { return cognitionFailure(error); }
});
