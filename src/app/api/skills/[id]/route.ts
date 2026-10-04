import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  deleteSkillService,
  previewSkillDeleteService,
  showSkillService,
  updateSkillService,
} from "@/lib/app-services/agents";
import { isServerFailure, serverErrorResponse } from "@/lib/http/errors";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { skillPatchSchema } from "@/lib/skills/schema";
import { nativeAgentSkillResponse, nativeAgentSkillWriteResponse, readAgentSkillCompatibleBody } from "@/lib/skills/native-mutation-http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
export const DELETE = withDatabaseRequestScope(requireIdempotencyKey(DELETEHandler));

async function GETHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  const previewTrash = new URL(request.url).searchParams.get("mode") === "trash-preview";
  let auth;
  try { auth = await authorizeRequest({ request, action: previewTrash ? "manage.workflow" : "read", resourceType: "agent_skill" }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  if (previewTrash) {
    const result = await previewSkillDeleteService(
      createAppServiceCaller({ context: auth }),
      { id },
    );
    return result.data.target
      ? Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } })
      : Response.json({ error: "Custom skill not found." }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  const result = await showSkillService(createAppServiceCaller({ context: auth }), { id });
  const headers = { "cache-control": "private, no-store" };
  return result.data.skill
    ? Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers })
    : Response.json({ error: "Skill not found." }, { status: 404, headers });
}

async function PATCHHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  const { id } = await context.params;
  const read = await readAgentSkillCompatibleBody(request, 65_536, 24_000);
  if (read instanceof Response) return read;
  if (read.native) return nativeAgentSkillWriteResponse(request, { resourceType: "agent_skill", resourceId: id, operation: "update", body: read.body });
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "update" } }); }
  catch (error) { return forbiddenResponse(error); }
  if (auth.source === "mobile") return nativeAgentSkillResponse("The strict native Skill request is required.", 403);
  const parsed = skillPatchSchema.safeParse(read.body);
  if (!parsed.success) return Response.json({ error: "Invalid skill update", details: parsed.error.flatten() }, { status: 400 });
  const result = await updateSkillService(
    createRequestMutationAppServiceCaller(request, auth, { purpose: "skill.update", causationId: id }),
    { id, change: parsed.data },
  );
  return result.data.skill ? Response.json({ ...result.data, serviceReceipt: result.receipt }) : Response.json({ error: "Custom skill not found." }, { status: 404 });
}

async function DELETEHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  const { id } = await context.params;
  const read = await readAgentSkillCompatibleBody(request, 16_384, 16_000);
  if (read instanceof Response) return read;
  if (read.native) return nativeAgentSkillWriteResponse(request, { resourceType: "agent_skill", resourceId: id, operation: "delete", body: read.body });
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "delete" } }); }
  catch (error) { return forbiddenResponse(error); }
  if (auth.source === "mobile") return nativeAgentSkillResponse("The strict native Skill request is required.", 403);
  const body = read.body;
  try {
    const result = await deleteSkillService(
      createRequestMutationAppServiceCaller(request, auth, {
        purpose: "skill.move_to_trash",
        causationId: id,
      }),
      { id, ...(body && typeof body === "object" ? body : {}) } as never,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt });
  } catch (error) {
    if (isServerFailure(error)) {
      return serverErrorResponse(error, { message: "Skill could not be moved to trash.", request });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Skill could not be moved to trash." },
      { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 409 },
    );
  }
}
