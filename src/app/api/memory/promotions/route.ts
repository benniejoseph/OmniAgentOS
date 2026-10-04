import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { decideMemoryPromotionService, listMemoryPromotionService } from "@/lib/app-services/memory-promotion";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { JsonBodyError, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { MemoryPromotionNativeError } from "@/lib/memory/promotion-native-contracts";
import { nativeMemoryPromotionDecisionRequestSchema, nativeMemoryPromotionQuerySchema } from "@/lib/mobile/memory-promotion-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
const headers = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const entries = [...new URL(request.url).searchParams];
  const raw = Object.fromEntries(entries);
  const query = nativeMemoryPromotionQuerySchema.safeParse({ ...raw,
    ...(raw.limit === undefined ? {} : { limit: /^\d+$/.test(raw.limit) ? Number(raw.limit) : NaN }),
  });
  if (!query.success || new Set(entries.map(([key]) => key)).size !== entries.length) {
    return Response.json({ error: "Invalid Memory promotion query." }, { status: 400, headers });
  }
  try {
    const context = await authorizeRequest({ request, action: "read", resourceType: "memory_promotion_review" });
    const result = await listMemoryPromotionService(createAppServiceCaller({ context }), query.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return failure(error); }
}

async function PATCHHandler(request: Request) {
  if ([...new URL(request.url).searchParams].length) {
    return Response.json({ error: "Memory promotion decisions do not accept query parameters." }, { status: 400, headers });
  }
  try {
    const parsed = nativeMemoryPromotionDecisionRequestSchema.safeParse(await parseJsonBody(request, 4_096));
    if (!parsed.success) return Response.json({ error: "Invalid Memory promotion decision." }, { status: 400, headers });
    const context = await authorizeRequest({
      request, action: "write.memory", nativeMutationCapability: "memory.promotions.decide",
      resourceType: "memory_promotion_review", resourceId: parsed.data.reviewId,
      metadata: { decision: parsed.data.decision },
    });
    const result = await decideMemoryPromotionService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.memory.promotions.decide", causationId: parsed.data.reviewId,
    }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  if (error instanceof JsonBodyError || error instanceof MemoryPromotionNativeError) {
    return Response.json({ error: error.message,
      ...(error instanceof MemoryPromotionNativeError ? { code: error.code } : {}),
    }, { status: error.status, headers });
  }
  try {
    const response = forbiddenResponse(error);
    response.headers.set("cache-control", headers["cache-control"]);
    return response;
  } catch {
    return Response.json({ error: "Memory promotion is temporarily unavailable.", code: "memory_promotion_unavailable" }, { status: 503, headers });
  }
}
