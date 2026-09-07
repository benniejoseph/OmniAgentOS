import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showAp2PaymentTransactionService } from "@/lib/app-services/payments";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { ap2ErrorResponse, ap2PrivateHeaders } from "@/lib/payments/ap2-http";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request, routeContext: Context) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "ap2_payment_transaction",
      resourceId: (await routeContext.params).id,
      metadata: { operation: "show_evidence_derived_payment" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const transactionId = (await routeContext.params).id;
    const result = await showAp2PaymentTransactionService(
      createAppServiceCaller({ context }),
      { transactionId },
    );
    if (!result.data.transaction) {
      return Response.json(
        { error: "not_found", message: "AP2 payment transaction not found." },
        { status: 404, headers: ap2PrivateHeaders },
      );
    }
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: ap2PrivateHeaders },
    );
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}
