import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { localComputerClaimRequestSchema } from "@/lib/local-computer/contracts";
import { claimLocalComputerCommand } from "@/lib/local-computer/store";
import { nativeLocalComputerClaimResponseForClient } from "@/lib/mobile/contracts";
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
  const parsed = localComputerClaimRequestSchema.safeParse(body);
  if (!parsed.success) {
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
    const deadline = Date.now() + (parsed.data.waitSeconds || 0) * 1_000;
    for (;;) {
      const claimed = nativeLocalComputerClaimResponseForClient(
        await claimLocalComputerCommand(context),
        context.native?.clientContractVersion || 0,
      );
      if (claimed.command || Date.now() >= deadline || request.signal.aborted) {
        return Response.json(claimed, { headers: mobileNoStoreHeaders });
      }
      await waitForCommand(Math.min(1_250, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}

function waitForCommand(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
