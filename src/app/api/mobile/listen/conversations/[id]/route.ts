import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { listenRecordingIdSchema } from "@/lib/capture/listen-contracts";
import { readListenConversation } from "@/lib/capture/listen-store";
import { listenFailure, listenResponse } from "@/lib/capture/listen-http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ id: string }> }) => {
  try {
    const id = listenRecordingIdSchema.parse((await route.params).id);
    const context = await authorizeRequest({ request, action: "read", resourceType: "capture_recording", resourceId: id });
    return listenResponse(await readListenConversation(context, id));
  } catch (error) { return listenFailure(error); }
});
