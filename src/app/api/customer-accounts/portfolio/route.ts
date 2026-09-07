import {
  customerSuccessPortfolioServiceInputSchema,
  showCustomerSuccessPortfolioService,
} from "@/lib/app-services/customer-success-intelligence";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const parsed = customerSuccessPortfolioServiceInputSchema.safeParse({
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 100),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "customer_success_portfolio",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showCustomerSuccessPortfolioService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "portfolio intelligence");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid customer-success portfolio request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
