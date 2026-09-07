import {
  customerSuccessIntelligenceServiceInputSchema,
  showCustomerSuccessIntelligenceService,
} from "@/lib/app-services/customer-success-intelligence";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  const url = new URL(request.url);
  const parsed = customerSuccessIntelligenceServiceInputSchema.safeParse({
    accountId,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    historyLimit: numericQuery(url.searchParams.get("historyLimit"), 100),
    timelineLimit: numericQuery(url.searchParams.get("timelineLimit"), 100),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "customer_success_intelligence",
      resourceId: accountId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showCustomerSuccessIntelligenceService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "account intelligence");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid customer-success intelligence request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
