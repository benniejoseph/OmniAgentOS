import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { deleteKnowledgeSourceNativeService } from "@/lib/app-services/knowledge-source-deletion";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { NATIVE_KNOWLEDGE_SOURCE_PREFIXES, nativeKnowledgeSourceKindSchema } from "@/lib/rag/source-deletion-native-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { privateSourceHeaders, privateSourceResponse, sourceDeletionBody, sourceDeletionFailure, sourceDeletionQuery } from "../native-http";
export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(requireIdempotencyKey(DELETEHandler));
async function DELETEHandler(request: Request, route: { params: Promise<{ sourceKind: string }> }) {
  const { sourceKind } = await route.params; let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "knowledge", resourceId: sourceKind }); }
  catch (error) { return privateSourceResponse(forbiddenResponse(error)); }
  try { sourceDeletionQuery(request); const kind = nativeKnowledgeSourceKindSchema.parse(sourceKind);
    const result = await deleteKnowledgeSourceNativeService(createRequestMutationAppServiceCaller(request,context,{ purpose: "api.knowledge.sources.delete",
      causationId: knowledgeDeletionTargetId(NATIVE_KNOWLEDGE_SOURCE_PREFIXES[kind]) }),kind,await sourceDeletionBody(request));
    return Response.json({ ...result.data, serviceReceipt: result.receipt },{ headers: privateSourceHeaders });
  } catch (error) { return sourceDeletionFailure(error); }
}
