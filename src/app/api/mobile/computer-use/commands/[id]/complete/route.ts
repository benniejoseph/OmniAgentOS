import { z } from "zod";

import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { localComputerCompletionRequestSchema } from "@/lib/local-computer/contracts";
import { completeLocalComputerCommand } from "@/lib/local-computer/store";
import { nativeLocalComputerCompletionResponseSchema } from "@/lib/mobile/contracts";
import { authorizeRequest } from "@/lib/security/guard";
import {
  localComputerErrorResponse,
  localComputerInvalidRequest,
} from "@/app/api/mobile/computer-use/http";

const commandIdSchema = z.string().regex(
  /^local_computer_command_[a-f0-9]{48}$/,
);

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id: candidateId } = await route.params;
  const id = commandIdSchema.safeParse(candidateId);
  if (!id.success) {
    return localComputerInvalidRequest(
      "The local Computer Use command identifier is invalid.",
    );
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request, 2_200_000);
  } catch {
    return localComputerInvalidRequest(
      "The local Computer Use completion is invalid.",
    );
  }
  const parsed = localComputerCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return localComputerInvalidRequest(
      "The local Computer Use completion is invalid.",
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "local_computer_command",
      resourceId: id.data,
      nativeMutationCapability: "computer.use.command.complete",
    });
    return Response.json(
      nativeLocalComputerCompletionResponseSchema.parse(
        await completeLocalComputerCommand(context, id.data, parsed.data),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}
