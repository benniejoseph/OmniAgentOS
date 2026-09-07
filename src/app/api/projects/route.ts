import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService, listProjectsService } from "@/lib/app-services/projects";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { listProjectSummaries } from "@/lib/projects/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  title: z.string().trim().min(1).max(180),
  objective: z.string().trim().min(1).max(2_000),
  status: z.enum(["draft", "active"]).optional(),
  targetDate: z.string().datetime().optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "projects" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (url.searchParams.get("view") === "summary") {
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
    return Response.json({
      projects: await listProjectSummaries(limit, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding,
      }),
      generatedAt: new Date().toISOString(),
    }, { headers: { "cache-control": "private, no-store" } });
  }
  const result = await listProjectsService(createAppServiceCaller({ context }), { limit: 80 });
  return Response.json({ ...result.data, generatedAt: new Date().toISOString(), serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  const parsed = await parse(request, createSchema);
  if (parsed instanceof Response) return parsed;
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "project" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await createProjectService(
      createRequestMutationAppServiceCaller(request, context, { purpose: "project.create" }),
      parsed,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project creation failed.";
    return Response.json(
      { error: message },
      { status: message.startsWith("Idempotency-Key") ? 400 : 409 },
    );
  }
}

async function parse<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | Response> {
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : Response.json({ error: "Invalid project", details: parsed.error.flatten() }, { status: 400 });
}
