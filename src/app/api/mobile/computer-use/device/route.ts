import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { localComputerDeviceUpdateSchema } from "@/lib/local-computer/contracts";
import {
  getLocalComputerDevice,
  updateLocalComputerDevice,
} from "@/lib/local-computer/store";
import {
  nativeLocalComputerDeviceReadResponseSchema,
  nativeLocalComputerDeviceResponseSchema,
} from "@/lib/mobile/contracts";
import { authorizeRequest } from "@/lib/security/guard";
import {
  localComputerErrorResponse,
  localComputerInvalidRequest,
} from "@/app/api/mobile/computer-use/http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PUT = withDatabaseRequestScope(PUTHandler);

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "local_computer_device",
    });
    const device = await getLocalComputerDevice(context);
    return Response.json(
      nativeLocalComputerDeviceReadResponseSchema.parse(device),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}

async function PUTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 8_192);
  } catch {
    return localComputerInvalidRequest(
      "The local Computer Use device update is invalid.",
    );
  }
  const parsed = localComputerDeviceUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return localComputerInvalidRequest(
      "The local Computer Use device update is invalid.",
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "local_computer_device",
      nativeMutationCapability: "computer.use.device.update",
    });
    return Response.json(
      nativeLocalComputerDeviceResponseSchema.parse(
        await updateLocalComputerDevice(context, parsed.data),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}
