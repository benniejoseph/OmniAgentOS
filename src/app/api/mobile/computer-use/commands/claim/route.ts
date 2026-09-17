import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { localComputerClaimRequestSchema } from "@/lib/local-computer/contracts";
import { claimLocalComputerCommand } from "@/lib/local-computer/store";
import { nativeLocalComputerClaimResponseSchema } from "@/lib/mobile/contracts";
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
      "The local Computer Use claim request is invalid.",
    );
  }
  if (!localComputerClaimRequestSchema.safeParse(body).success) {
    return localComputerInvalidRequest(
      "The local Computer Use claim request is invalid.",
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "local_computer_command",
      nativeMutationCapability: "computer.use.command.claim",
    });
    return Response.json(
      nativeLocalComputerClaimResponseSchema.parse(
        await claimLocalComputerCommand(context),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}
