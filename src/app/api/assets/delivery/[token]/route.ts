import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  AssetObjectError,
  redeemAssetObjectDelivery,
} from "@/lib/storage/object-plane";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const allowedPurposes = new Set([
  "capture.asset.download",
  "capture.recording.playback",
]);

async function GETHandler(
  request: Request,
  route: { params: Promise<{ token: string }> },
) {
  const purpose = new URL(request.url).searchParams.get("purpose")?.trim() || "";
  if (!allowedPurposes.has(purpose)) {
    return Response.json(
      { error: "This private asset delivery link is invalid." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "asset_object",
      metadata: { operation: "redeem_private_delivery", purpose },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const { token } = await route.params;
  try {
    const delivery = await redeemAssetObjectDelivery({
      token,
      tenantId: context.tenantId,
      actorId: context.actorId,
      purpose,
    });
    return new Response(Buffer.from(delivery.bytes), {
      headers: {
        "content-type": delivery.object.mediaType,
        "content-length": String(delivery.object.byteCount),
        "content-disposition": purpose === "capture.recording.playback"
          ? "inline"
          : "attachment",
        etag: `"${delivery.object.contentSha256}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return assetDeliveryErrorResponse(error);
  }
}

function assetDeliveryErrorResponse(error: unknown) {
  if (error instanceof AssetObjectError) {
    if (
      error.code === "storage_not_configured" ||
      error.code === "storage_read_failed"
    ) {
      return Response.json(
        { error: "Private asset delivery is temporarily unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    if (error.code === "storage_integrity_failed") {
      return Response.json(
        { error: "Private asset content could not be verified safely." },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    return Response.json(
      { error: "This private asset delivery link is invalid." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  return Response.json(
    { error: "Private asset delivery is temporarily unavailable." },
    { status: 503, headers: privateNoStoreHeaders },
  );
}
