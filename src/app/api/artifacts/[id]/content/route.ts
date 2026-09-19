import {
  GeneratedArtifactError,
  getGeneratedArtifact,
  readGeneratedArtifactContent,
} from "@/lib/artifacts/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  contentDispositionAttachment,
  generatedArtifactFilename,
} from "@/app/api/artifacts/_lib/public-artifact";

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

  const requestedVersion = parseVersion(new URL(request.url));
  if (requestedVersion === null) {
    return Response.json(
      { error: "Artifact version must be a positive integer." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  try {
    const artifact = await getGeneratedArtifact({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      artifactId: id,
    });
    if (!artifact) return notFoundResponse();
    const artifactVersion = requestedVersion ?? artifact.currentVersion;
    const { version, bytes } = await readGeneratedArtifactContent({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      artifactId: artifact.id,
      artifactVersion,
    });
    const filename = generatedArtifactFilename(version.title, version.kind);
    return new Response(bytes, {
      headers: {
        "content-type": version.mediaType,
        "content-length": String(bytes.byteLength),
        "content-disposition": contentDispositionAttachment(filename),
        etag: `"${version.contentSha256}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (
      error instanceof GeneratedArtifactError &&
      (error.code === "artifact_not_found" || error.code === "version_not_found")
    ) {
      return notFoundResponse();
    }
    console.error(
      "Generated artifact content read failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Artifact content is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

function parseVersion(url: URL): number | undefined | null {
  if (url.searchParams.getAll("version").length > 1) return null;
  const raw = url.searchParams.get("version");
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]{0,8}$/u.test(raw)) return null;
  return Number(raw);
}

function notFoundResponse() {
  return Response.json(
    { error: "A ready generated artifact version was not found." },
    { status: 404, headers: privateNoStoreHeaders },
  );
}
