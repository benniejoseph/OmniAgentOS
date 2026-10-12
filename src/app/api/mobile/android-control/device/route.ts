import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { localAndroidDeviceUpdateSchema } from "@/lib/local-computer/android-contracts";
import {
  getLocalComputerDevice,
  updateLocalComputerDevice,
} from "@/lib/local-computer/store";
import {
  nativeLocalAndroidDeviceReadResponseSchema,
  nativeLocalAndroidDeviceResponseSchema,
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
    const device = await getLocalComputerDevice(context, "local_android");
    return Response.json(
      nativeLocalAndroidDeviceReadResponseSchema.parse(device),
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
      "The phone control device update is invalid.",
    );
  }
  const parsed = localAndroidDeviceUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return localComputerInvalidRequest(
      "The phone control device update is invalid.",
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "local_computer_device",
      nativeMutationCapability: "android.control.device.update",
    });
    return Response.json(
      nativeLocalAndroidDeviceResponseSchema.parse(
        await updateLocalComputerDevice(context, parsed.data),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return localComputerErrorResponse(error);
  }
}
