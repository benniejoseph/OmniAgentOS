import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { decideKnowledgeCognitionNativeService, readKnowledgeCognitionNativeService } from "@/lib/app-services/knowledge-cognification";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cognitionDecisionBody, cognitionFailure, cognitionQuery, privateCognitionHeaders, privateCognitionResponse } from "../native-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export const GET = withDatabaseRequestScope(async (request: Request, route: Context) => {
  const { id } = await route.params; let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "knowledge_cognition", resourceId: id }); }
  catch (error) { return privateCognitionResponse(forbiddenResponse(error)); }
  try { cognitionQuery(request); const result = await readKnowledgeCognitionNativeService(createAppServiceCaller({ context }), id);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateCognitionHeaders });
  } catch (error) { return cognitionFailure(error); }
});
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
async function PATCHHandler(request: Request, route: Context) {
  const { id } = await route.params; let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "knowledge_cognition", resourceId: id }); }
  catch (error) { return privateCognitionResponse(forbiddenResponse(error)); }
  try { cognitionQuery(request); const result = await decideKnowledgeCognitionNativeService(createRequestMutationAppServiceCaller(request, context,
    { purpose: "api.knowledge.cognification.decide", causationId: id }), id, await cognitionDecisionBody(request));
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateCognitionHeaders });
  } catch (error) { return cognitionFailure(error); }
}
