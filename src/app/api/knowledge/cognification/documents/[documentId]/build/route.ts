import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { submitKnowledgeCognitionBuildService } from "@/lib/app-services/knowledge-cognition-build";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cognitionDecisionBody as cognitionBody, cognitionFailure, cognitionQuery, privateCognitionHeaders, privateCognitionResponse } from "../../../reviews/native-http";
export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function POSTHandler(request: Request,route: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await route.params; let context;
  try { context = await authorizeRequest({ request,action: "write.memory",resourceType: "knowledge_cognition",resourceId: documentId }); }
  catch (error) { return privateCognitionResponse(forbiddenResponse(error)); }
  try { cognitionQuery(request); const result = await submitKnowledgeCognitionBuildService(createRequestMutationAppServiceCaller(request,context,
    { purpose: "api.knowledge.cognification.build",causationId: documentId }),documentId,await cognitionBody(request));
    return Response.json({ ...result.data,serviceReceipt: result.receipt },{ status: 202,headers: privateCognitionHeaders }); }
  catch (error) { return cognitionFailure(error); }
}
