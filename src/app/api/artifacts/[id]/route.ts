import {
  getGeneratedArtifact,
  getGeneratedArtifactVersion,
} from "@/lib/artifacts/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { publicGeneratedArtifact } from "@/app/api/artifacts/_lib/public-artifact";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "generated_artifact",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const artifact = await getGeneratedArtifact({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      artifactId: id,
    });
    if (!artifact) {
      return Response.json(
        { error: "Generated artifact not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    const version = await getGeneratedArtifactVersion({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
    });
    if (!version) {
      return Response.json(
        { error: "Generated artifact not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    return Response.json(
      { artifact: publicGeneratedArtifact(artifact, version) },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    console.error(
      "Generated artifact read failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "The generated artifact is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}
