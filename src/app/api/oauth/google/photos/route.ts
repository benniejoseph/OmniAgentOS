import {
  deleteImportedGooglePhotos,
  googlePhotosPickerErrorResponse,
} from "@/lib/connectors/google-photos-picker";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function DELETEHandler(request: Request) {
  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge",
      metadata: { provider: "google", category: "photos", operation: "delete_source" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const deleted = await deleteImportedGooglePhotos({
      tenantId: security.tenantId,
      actorId: security.actorId,
    });
    return Response.json(
      { deleted, source: "google:photos" },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return googlePhotosPickerErrorResponse(error);
  }
}
