import {
  deleteGooglePhotosPickerSession,
  getGooglePhotosPickerSession,
  googlePhotosPickerErrorResponse,
} from "@/lib/connectors/google-photos-picker";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

type Context = { params: Promise<{ handle: string }> };

async function GETHandler(request: Request, context: Context) {
  const security = await authorize(request, "poll_session");
  if (security instanceof Response) return security;
  const { handle } = await context.params;
  try {
    const session = await getGooglePhotosPickerSession(
      { tenantId: security.tenantId, actorId: security.actorId },
      handle,
      request.signal,
    );
    return Response.json(
      { session },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return googlePhotosPickerErrorResponse(error);
  }
}

async function DELETEHandler(request: Request, context: Context) {
  const security = await authorize(request, "delete_session");
  if (security instanceof Response) return security;
  const { handle } = await context.params;
  try {
    const result = await deleteGooglePhotosPickerSession(
      { tenantId: security.tenantId, actorId: security.actorId },
      handle,
      request.signal,
    );
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return googlePhotosPickerErrorResponse(error);
  }
}

async function authorize(request: Request, operation: "poll_session" | "delete_session") {
  try {
    return await authorizeRequest({
      request,
      action: operation === "poll_session" ? "read" : "write.memory",
      resourceType: "google_photos_picker",
      metadata: { provider: "google", category: "photos", operation },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
}
