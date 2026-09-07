import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { loadAp2Readiness } from "@/lib/payments/ap2-readiness";

const emptySchema = z.object({}).strict();

export async function showAp2ReadinessService(
  caller: AppServiceCaller,
  input: z.input<typeof emptySchema>,
) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.payments.ap2.readiness"),
  );
  return completeAppServiceCall(
    authorized,
    { readiness: loadAp2Readiness() },
    { resourceCount: 1 },
  );
}
