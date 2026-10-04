import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectMemoryPromotionService } from "@/lib/app-services/memory-promotion";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { MemoryPromotionNativeError, memoryPromotionNativeIdSchema } from "@/lib/memory/promotion-native-contracts";
import { nativeMemoryPromotionReadQuerySchema } from "@/lib/mobile/memory-promotion-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };

async function GETHandler(request: Request, route: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await route.params;
  const entries = [...new URL(request.url).searchParams];
  const query = nativeMemoryPromotionReadQuerySchema.safeParse(Object.fromEntries(entries));
  if (!memoryPromotionNativeIdSchema.safeParse(reviewId).success || !query.success ||
    new Set(entries.map(([key]) => key)).size !== entries.length) {
    return Response.json({ error: "Invalid Memory promotion target." }, { status: 400, headers });
  }
  try {
    const context = await authorizeRequest({ request, action: "read", resourceType: "memory_promotion_review", resourceId: reviewId });
    const result = await inspectMemoryPromotionService(createAppServiceCaller({ context }), reviewId, query.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) {
    if (error instanceof MemoryPromotionNativeError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    }
    try {
      const response = forbiddenResponse(error);
      response.headers.set("cache-control", headers["cache-control"]);
      return response;
    } catch {
      return Response.json({ error: "Memory promotion is temporarily unavailable.", code: "memory_promotion_unavailable" }, { status: 503, headers });
    }
  }
}
