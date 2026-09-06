import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  AssetObjectError,
  issueAssetObjectDelivery,
  type AssetObjectSourceKind,
} from "@/lib/storage/object-plane";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const sourceKind = parseSourceKind(url.searchParams.get("sourceKind"));
  const sourceId = url.searchParams.get("sourceId")?.trim() || "";
  if (!sourceKind || !sourceId || sourceId.length > 200) {
    return Response.json(
      { error: "Choose a valid stored asset." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "asset_object",
      resourceId: sourceId,
      metadata: { operation: "issue_private_delivery", sourceKind },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const purpose = deliveryPurpose(sourceKind);
  try {
    const delivery = await issueAssetObjectDelivery({
      tenantId: context.tenantId,
      actorId: context.actorId,
      sourceKind,
      sourceId,
      purpose,
    });
    const deliveryUrl = new URL(
      `/api/assets/delivery/${encodeURIComponent(delivery.token)}`,
      url.origin,
    );
    deliveryUrl.searchParams.set("purpose", purpose);
    return Response.json({
      delivery: {
        url: `${deliveryUrl.pathname}${deliveryUrl.search}`,
        expiresAt: delivery.expiresAt,
        object: delivery.object,
      },
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return assetDeliveryErrorResponse(error);
  }
}

function parseSourceKind(value: string | null): AssetObjectSourceKind | null {
  return value === "capture_asset" || value === "capture_segment"
    ? value
    : null;
}

function deliveryPurpose(sourceKind: AssetObjectSourceKind) {
  return sourceKind === "capture_asset"
    ? "capture.asset.download"
    : "capture.recording.playback";
}

function assetDeliveryErrorResponse(error: unknown) {
  if (error instanceof AssetObjectError) {
    if (error.code === "storage_not_configured") {
      return Response.json(
        { error: "Private asset delivery is temporarily unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    if (error.code === "invalid_contract") {
      return Response.json(
        { error: "Choose a valid stored asset." },
        { status: 400, headers: privateNoStoreHeaders },
      );
    }
    return Response.json(
      { error: "A deliverable private asset was not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  return Response.json(
    { error: "Private asset delivery is temporarily unavailable." },
    { status: 503, headers: privateNoStoreHeaders },
  );
}
