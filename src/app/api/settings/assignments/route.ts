import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { listModelAssignments, saveModelAssignment } from "@/lib/settings/store";
import { MODEL_ASSIGNMENT_SCOPES, MODEL_PROVIDERS } from "@/lib/settings/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PUT = withDatabaseRequestScope(PUTHandler);

const assignmentSchema = z.object({
  scope: z.enum(MODEL_ASSIGNMENT_SCOPES),
  provider: z.enum(MODEL_PROVIDERS),
  modelId: z.string().trim().min(1).max(240),
  fallbackProvider: z.enum(MODEL_PROVIDERS).optional(),
  fallbackModelId: z.string().trim().min(1).max(240).optional(),
  crossProviderFallbackConsent: z.literal(true).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "model_assignment" }); }
  catch (error) { return forbiddenResponse(error); }
  try { return Response.json({ assignments: await listModelAssignments(context) }); }
  catch (error) { return settingsErrorResponse(error); }
}

async function PUTHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = assignmentSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid model assignment", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "model_assignment", resourceId: parsed.data.scope, metadata: { scope: parsed.data.scope, provider: parsed.data.provider, fallbackProvider: parsed.data.fallbackProvider, crossProviderFallbackConsent: parsed.data.crossProviderFallbackConsent === true } });
  } catch (error) { return forbiddenResponse(error); }
  try { return Response.json({ assignment: await saveModelAssignment({ ...context, ...parsed.data }) }); }
  catch (error) { return settingsErrorResponse(error); }
}
