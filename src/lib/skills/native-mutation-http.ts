import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { mutateNativeAgentSkillService, nativeAgentSkillReadServiceInputSchema, nativeAgentSkillReviewServiceInputSchema,
  readNativeAgentSkillAcceptanceService, reviewNativeAgentSkillService } from "@/lib/app-services/agent-skill-mutations";
import { JsonBodyError, jsonBodyErrorResponse, readRequestTextLimited } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { AgentSkillNativeError, agentSkillNativeCreateRequestSchema, agentSkillNativeDeleteRequestSchema,
  agentSkillNativeUpdateRequestSchema } from "@/lib/skills/native-mutation-contracts";
import { MoltbookConnectionError } from "@/lib/moltbook/store";

const headers = { "cache-control": "private, no-store" };
export const nativeAgentSkillResponse = (error: string, status: number, code?: string) => Response.json({ error, ...(code ? { code } : {}) }, { status, headers });
export async function readAgentSkillCompatibleBody(request: Request, nativeLimit: number, legacyLimit: number) {
  try {
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (request.body && type !== "application/json" && !type?.endsWith("+json")) throw new JsonBodyError("JSON requests require an application/json content type.", 415);
    const raw = await readRequestTextLimited(request, nativeLimit);
    if (raw.truncated) throw new JsonBodyError("Request body is too large.", 413);
    let body: unknown;
    try { body = raw.text.trim() ? JSON.parse(raw.text) : {}; } catch { throw new JsonBodyError("Request body is not valid JSON."); }
    const native = body !== null && typeof body === "object" && "contract" in body;
    if (!native && (raw.bytesRead > legacyLimit || Number(request.headers.get("content-length") || 0) > legacyLimit)) throw new JsonBodyError("Request body is too large.", 413);
    return { body, native };
  } catch (error) {
    if (error instanceof JsonBodyError) { const response = jsonBodyErrorResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
    return nativeAgentSkillResponse("Catalog request is temporarily unavailable.", 503);
  }
}
export function nativeAgentSkillFailure(error: unknown) {
  if (error instanceof AgentSkillNativeError || error instanceof MoltbookConnectionError) return nativeAgentSkillResponse(error.message.slice(0, 4_000), error.status, error.code);
  if (error instanceof z.ZodError) return nativeAgentSkillResponse("Catalog response or request could not be verified.", 409, "agent_skill_contract_invalid");
  if (error instanceof Error && /unique|duplicate|already exists/i.test(error.message)) return nativeAgentSkillResponse("A catalog resource with this identity already exists.", 409);
  return nativeAgentSkillResponse("Catalog operation could not be confirmed.", 503);
}
function denied(error: unknown) {
  try { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  catch { return nativeAgentSkillResponse("Catalog authorization is temporarily unavailable.", 503); }
}
export async function nativeAgentSkillWriteResponse(request: Request, input: { resourceType: "custom_agent" | "agent_skill"; resourceId?: string; operation: "create" | "update" | "delete"; body: unknown }) {
  if ([...new URL(request.url).searchParams].length) return nativeAgentSkillResponse("Unexpected native catalog query.", 400);
  const parsed = input.operation === "create" ? agentSkillNativeCreateRequestSchema.safeParse(input.body)
    : input.operation === "update" ? agentSkillNativeUpdateRequestSchema.safeParse(input.body) : agentSkillNativeDeleteRequestSchema.safeParse(input.body);
  if (!parsed.success) return nativeAgentSkillResponse("Invalid exact native catalog request.", 400);
  const agent = input.resourceType === "custom_agent";
  const nativeMutationCapability = agent ? "agents.delete" : input.operation === "create" ? "skills.create" : input.operation === "update" ? "skills.update" : "skills.delete";
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: input.resourceType, resourceId: input.resourceId,
    nativeMutationCapability, metadata: { operation: input.operation, nativeContract: parsed.data.contract } }); }
  catch (error) { return denied(error); }
  try {
    const result = await mutateNativeAgentSkillService(createRequestMutationAppServiceCaller(request, context, {
      purpose: agent ? "agent.move_to_trash" : input.operation === "delete" ? "skill.move_to_trash" : `skill.${input.operation}`,
      causationId: input.resourceId ?? "skills:create",
    }), { resourceType: input.resourceType, resourceId: input.resourceId, request: parsed.data });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: input.operation === "create" && !result.data.replayed ? 201 : 200, headers });
  } catch (error) { return nativeAgentSkillFailure(error); }
}
export async function nativeAgentSkillReviewResponse(request: Request, resourceId: string, agent: boolean) {
  const entries = [...new URL(request.url).searchParams], operation = agent ? "agent.delete" : entries[0]?.[1] === "update" ? "skill.update" : "skill.delete";
  if (agent ? entries.length !== 0 : entries.length !== 1 || entries[0][0] !== "operation" || !["update", "delete"].includes(entries[0][1])) return nativeAgentSkillResponse("An exact catalog review operation is required.", 400);
  const parsed = nativeAgentSkillReviewServiceInputSchema.safeParse({ resourceId, operation });
  if (!parsed.success) return nativeAgentSkillResponse("Invalid catalog review target.", 400);
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: agent ? "custom_agent" : "agent_skill", resourceId }); }
  catch (error) { return denied(error); }
  try { const result = await reviewNativeAgentSkillService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers }); }
  catch (error) { return nativeAgentSkillFailure(error); }
}
export async function nativeAgentSkillReceiptResponse(request: Request, keySha256: string, agent: boolean) {
  const parsed = nativeAgentSkillReadServiceInputSchema.safeParse({ keySha256, resourceType: agent ? "custom_agent" : "agent_skill" });
  if (!parsed.success || [...new URL(request.url).searchParams].length) return nativeAgentSkillResponse("An exact native catalog acceptance key is required.", 400);
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: parsed.data.resourceType }); }
  catch (error) { return denied(error); }
  try { const result = await readNativeAgentSkillAcceptanceService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers }); }
  catch (error) { return nativeAgentSkillFailure(error); }
}
