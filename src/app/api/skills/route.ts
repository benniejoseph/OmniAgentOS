import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createSkillService, listSkillsService } from "@/lib/app-services/agents";
import { serverErrorResponse } from "@/lib/http/errors";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { skillInputSchema } from "@/lib/skills/schema";
import { nativeAgentSkillResponse, nativeAgentSkillWriteResponse, readAgentSkillCompatibleBody } from "@/lib/skills/native-mutation-http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "agent_skill" }); }
  catch (error) { return forbiddenResponse(error); }
  const result = await listSkillsService(createAppServiceCaller({ context }), {});
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  const read = await readAgentSkillCompatibleBody(request, 65_536, 24_000);
  if (read instanceof Response) return read;
  if (read.native) return nativeAgentSkillWriteResponse(request, { resourceType: "agent_skill", operation: "create", body: read.body });
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "create" } }); }
  catch (error) { return forbiddenResponse(error); }
  if (context.source === "mobile") return nativeAgentSkillResponse("The strict native Skill request is required.", 403);
  const parsed = skillInputSchema.safeParse(read.body);
  if (!parsed.success) return Response.json({ error: "Invalid skill", details: parsed.error.flatten() }, { status: 400 });
  try {
    const result = await createSkillService(
      createRequestMutationAppServiceCaller(request, context, { purpose: "skill.create" }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: 201 });
  } catch (error) {
    const duplicate = error instanceof Error && /unique|duplicate/i.test(error.message);
    if (!duplicate) return serverErrorResponse(error, { message: "Skill creation failed.", request });
    return Response.json({ error: "A skill with this name already exists." }, { status: 409 });
  }
}
