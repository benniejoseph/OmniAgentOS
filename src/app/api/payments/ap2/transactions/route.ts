import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listAp2PaymentTransactionsService } from "@/lib/app-services/payments";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { ap2ErrorResponse, ap2PrivateHeaders } from "@/lib/payments/ap2-http";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "ap2_payment_transaction",
      metadata: { operation: "list_evidence_derived_payments" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await listAp2PaymentTransactionsService(
      createAppServiceCaller({ context }),
      {},
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: ap2PrivateHeaders },
    );
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}
