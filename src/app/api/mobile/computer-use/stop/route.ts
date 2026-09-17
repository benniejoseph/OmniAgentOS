import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { localComputerStopRequestSchema } from "@/lib/local-computer/contracts";
import { stopLocalComputerDevice } from "@/lib/local-computer/store";
import { nativeLocalComputerStopResponseSchema } from "@/lib/mobile/contracts";
import { authorizeRequest } from "@/lib/security/guard";
import {
  localComputerErrorResponse,
  localComputerInvalidRequest,
} from "@/app/api/mobile/computer-use/http";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 1_024);
  } catch {
    return localComputerInvalidRequest(
      "The local Computer Use stop request is invalid.",
    );
  }
  const parsed = localComputerStopRequestSchema.safeParse(body);
  if (!parsed.success) {
    return localComputerInvalidRequest(
      "The local Computer Use stop request is invalid.",
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "local_computer_device",
      nativeMutationCapability: "computer.use.stop",
    });
    return Response.json(
      nativeLocalComputerStopResponseSchema.parse(
        await stopLocalComputerDevice(context, parsed.data.reason),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}
