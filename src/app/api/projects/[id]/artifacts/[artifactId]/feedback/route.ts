import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { reflectOnProjectArtifact } from "@/lib/projects/reflection";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  verdict: z.enum(["useful", "needs_work"]),
  lesson: z.string().trim().min(3).max(1_200),
}).strict();

async function POSTHandler(request: Request, route: { params: Promise<{ id: string; artifactId: string }> }) {
  const { id, artifactId } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid artifact reflection", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "project_artifact", resourceId: artifactId });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const artifact = await reflectOnProjectArtifact({
      projectId: id,
      artifactId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      ...parsed.data,
    });
    return artifact
      ? Response.json({ artifact })
      : Response.json({ error: "Project artifact not found." }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Artifact reflection failed." }, { status: 500 });
  }
}
