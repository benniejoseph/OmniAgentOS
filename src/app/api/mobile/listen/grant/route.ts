import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { listenGrantRequestSchema } from "@/lib/capture/listen-contracts";
import { updateListenGrant } from "@/lib/capture/listen-grants";
import { boundedListenRequest, listenFailure, listenResponse } from "@/lib/capture/listen-http";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(async (request: Request) => {
  try {
    const context = await authorizeRequest({ request, action: "write.memory", resourceType: "listen_grant",
      nativeMutationCapability: "listen.configure" });
    const input = listenGrantRequestSchema.parse(await (await boundedListenRequest(request, 4096)).json());
    return listenResponse(await updateListenGrant(context, request, input));
  } catch (error) { return listenFailure(error); }
});
