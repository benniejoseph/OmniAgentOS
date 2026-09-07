import {
  customerFactRecordServiceInputSchema,
  recordCustomerFactService,
} from "@/lib/app-services/customer-accounts";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function POSTHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  let body: unknown;
  try {
    body = await parseJsonBody(request, 250_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = customerFactRecordServiceInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    accountId,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid customer fact request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "customer_account_fact",
      resourceId: accountId,
      riskLevel: 2,
      metadata: {
        operation: "record",
        factKind: parsed.data.value.kind,
        sourceKind: parsed.data.source.sourceKind,
        expectedRevision: parsed.data.expectedRevision || null,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await recordCustomerFactService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-account.fact.record",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "fact record");
  }
}
