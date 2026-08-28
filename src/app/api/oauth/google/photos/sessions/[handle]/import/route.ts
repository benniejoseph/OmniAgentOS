import {
  googlePhotosPickerErrorResponse,
  importGooglePhotosPickerSelection,
} from "@/lib/connectors/google-photos-picker";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ handle: string }> },
) {
  const { handle } = await context.params;
  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "google_photos_picker",
      metadata: { provider: "google", category: "photos", operation: "import_selection" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const result = await importGooglePhotosPickerSelection(
      { tenantId: security.tenantId, actorId: security.actorId },
      handle,
      request.signal,
    );
    return Response.json(
      result,
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return googlePhotosPickerErrorResponse(error);
  }
}
