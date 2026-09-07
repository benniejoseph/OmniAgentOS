import { showAp2ReadinessService } from "@/lib/app-services/payments";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "ap2_readiness",
      metadata: { operation: "inspect_ap2_payment_boundary" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await showAp2ReadinessService(
    createAppServiceCaller({ context }),
    {},
  );
  return Response.json(
    { ...result.data, serviceReceipt: result.receipt },
    { headers: privateNoStoreHeaders },
  );
}
