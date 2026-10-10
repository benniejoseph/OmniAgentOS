import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { listListenConversations } from "@/lib/capture/listen-store";
import { listenFailure, listenResponse } from "@/lib/capture/listen-http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  try {
    const context = await authorizeRequest({ request, action: "read", resourceType: "capture_recording" });
    return listenResponse(await listListenConversations(context));
  } catch (error) { return listenFailure(error); }
});
