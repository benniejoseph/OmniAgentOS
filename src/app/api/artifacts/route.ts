import { generatedArtifactKindSchema } from "@/lib/artifacts/contracts";
import {
  getGeneratedArtifactVersion,
  listGeneratedArtifacts,
} from "@/lib/artifacts/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { publicGeneratedArtifact } from "@/app/api/artifacts/_lib/public-artifact";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "generated_artifact",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const query = parseListQuery(new URL(request.url));
  if (!query) {
    return Response.json(
      { error: "Invalid generated artifact query." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  try {
    const heads = await listGeneratedArtifacts({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      ...(query.kind ? { kind: query.kind } : {}),
      limit: query.limit,
    });
    const artifacts = await Promise.all(heads.map(async (head) => {
      const version = await getGeneratedArtifactVersion({
        tenantId: context.tenantId,
        ownerActorId: context.actorId,
        artifactId: head.id,
        artifactVersion: head.currentVersion,
      });
      if (!version) {
        throw new Error("Generated artifact current version is unavailable.");
      }
      return publicGeneratedArtifact(head, version);
    }));
    return Response.json({ artifacts }, { headers: privateNoStoreHeaders });
  } catch (error) {
    console.error(
      "Generated artifact list failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Generated artifacts are temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

function parseListQuery(url: URL) {
  if (url.searchParams.getAll("kind").length > 1) return undefined;
  const kindValue = url.searchParams.get("kind");
  const parsedKind = kindValue
    ? generatedArtifactKindSchema.safeParse(kindValue)
    : undefined;
  if (parsedKind && !parsedKind.success) return undefined;

  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) {
    return undefined;
  }
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (limit > 100) return undefined;
  return {
    kind: parsedKind?.success ? parsedKind.data : undefined,
    limit,
  };
}
