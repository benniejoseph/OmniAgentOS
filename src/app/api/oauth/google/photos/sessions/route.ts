import {
  createGooglePhotosPickerSession,
  googlePhotosPickerErrorResponse,
  normalizeGooglePhotosItemLimit,
} from "@/lib/connectors/google-photos-picker";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const MAX_REQUEST_BYTES = 1_024;

async function POSTHandler(request: Request) {
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BYTES) {
    return Response.json({ error: "The picker request is too large." }, { status: 413 });
  }

  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "google_photos_picker",
      metadata: { provider: "google", category: "photos", operation: "create_session" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      return Response.json({ error: "The picker request is too large." }, { status: 413 });
    }
    if (text) {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "The picker request must be a JSON object." }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return Response.json({ error: "The picker request contains invalid JSON." }, { status: 400 });
  }

  try {
    const session = await createGooglePhotosPickerSession(
      { tenantId: security.tenantId, actorId: security.actorId },
      normalizeGooglePhotosItemLimit(body.maxItemCount),
      request.signal,
    );
    return Response.json(
      { session },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return googlePhotosPickerErrorResponse(error);
  }
}
