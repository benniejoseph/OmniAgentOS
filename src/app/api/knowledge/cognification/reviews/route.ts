import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listKnowledgeCognitionNativeService } from "@/lib/app-services/knowledge-cognification";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cognitionFailure, cognitionQuery, privateCognitionHeaders, privateCognitionResponse } from "./native-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "knowledge_cognition" }); }
  catch (error) { return privateCognitionResponse(forbiddenResponse(error)); }
  try { const result = await listKnowledgeCognitionNativeService(createAppServiceCaller({ context }), cognitionQuery(request, ["status","limit"]));
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateCognitionHeaders });
  } catch (error) { return cognitionFailure(error); }
});
