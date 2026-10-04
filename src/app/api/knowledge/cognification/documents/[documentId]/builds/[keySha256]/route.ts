import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readKnowledgeCognitionBuildService } from "@/lib/app-services/knowledge-cognition-build";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cognitionFailure, cognitionQuery, privateCognitionHeaders, privateCognitionResponse } from "../../../../reviews/native-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request,route: { params: Promise<{ documentId: string;keySha256: string }> }) {
  const { documentId,keySha256 } = await route.params; let context;
  try { context = await authorizeRequest({ request,action: "read",resourceType: "knowledge_cognition",resourceId: documentId }); }
  catch (error) { return privateCognitionResponse(forbiddenResponse(error)); }
  try { cognitionQuery(request); const result = await readKnowledgeCognitionBuildService(createAppServiceCaller({ context }),documentId,keySha256);
    return Response.json({ ...result.data,serviceReceipt: result.receipt },{ headers: privateCognitionHeaders }); }
  catch (error) { return cognitionFailure(error); }
}
