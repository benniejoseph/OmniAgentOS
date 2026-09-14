import { z } from "zod";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  createProjectBuilderService,
  listProjectBuilderTreeService,
  readProjectBuilderFileService,
  runProjectBuilderCommandService,
  showProjectBuilderService,
  stopProjectBuilderService,
  updateProjectBuilderFileService,
} from "@/lib/app-services/app-builder";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const sessionIdSchema = z.string().regex(/^app_build_[a-f0-9]{48}$/);
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("file.update"), sessionId: sessionIdSchema, path: z.string().trim().min(1).max(240), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().max(500_000) }).strict(),
  z.object({ action: z.literal("command.run"), sessionId: sessionIdSchema, command: z.enum(["lint", "typecheck", "test", "build", "start_preview"]) }).strict(),
  z.object({ action: z.literal("stop"), sessionId: sessionIdSchema }).strict(),
]);

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "app_builder_session", resourceId: id });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "session";
  const sessionId = url.searchParams.get("sessionId") || "";
  try {
    const caller = createAppServiceCaller({ context });
    const result = view === "tree"
      ? await listProjectBuilderTreeService(caller, { projectId: id, sessionId })
      : view === "file"
        ? await readProjectBuilderFileService(caller, { projectId: id, sessionId, path: url.searchParams.get("path") || "" })
        : await showProjectBuilderService(caller, { projectId: id });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "App Builder could not be read." }, { status: 404, headers: privateNoStoreHeaders });
  }
}

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid App Builder operation.", details: parsed.error.flatten() }, { status: 400 });
  const action = parsed.data.action;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: action === "file.update" ? "app_builder_file" : action === "command.run" ? "app_builder_command" : "app_builder_session",
      resourceId: id,
      riskLevel: action === "create" || action === "stop" ? 2 : 1,
      nativeMutationCapability: "workspaces.update",
      metadata: { action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const caller = createRequestMutationAppServiceCaller(request, context, { projectId: id, purpose: `project.builder.${action}` });
    const result = action === "create"
      ? await createProjectBuilderService(caller, { projectId: id })
      : action === "file.update"
        ? await updateProjectBuilderFileService(caller, { projectId: id, sessionId: parsed.data.sessionId, path: parsed.data.path, expectedSha256: parsed.data.expectedSha256, content: parsed.data.content })
        : action === "command.run"
          ? await runProjectBuilderCommandService(caller, { projectId: id, sessionId: parsed.data.sessionId, command: parsed.data.command })
          : await stopProjectBuilderService(caller, { projectId: id, sessionId: parsed.data.sessionId });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "App Builder operation failed." }, { status: 409, headers: privateNoStoreHeaders });
  }
}
