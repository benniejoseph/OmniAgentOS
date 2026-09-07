import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createSkillService, listSkillsService } from "@/lib/app-services/agents";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { skillInputSchema } from "@/lib/skills/schema";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "agent_skill" }); }
  catch (error) { return forbiddenResponse(error); }
  const result = await listSkillsService(createAppServiceCaller({ context }), {});
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "create" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 24_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = skillInputSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid skill", details: parsed.error.flatten() }, { status: 400 });
  try {
    const result = await createSkillService(
      createRequestMutationAppServiceCaller(request, context, { purpose: "skill.create" }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: 201 });
  } catch (error) {
    const duplicate = error instanceof Error && /unique|duplicate/i.test(error.message);
    return Response.json({ error: duplicate ? "A skill with this name already exists." : "Skill creation failed." }, { status: duplicate ? 409 : 500 });
  }
}
