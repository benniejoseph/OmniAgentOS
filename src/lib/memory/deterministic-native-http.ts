import { ZodError } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { readMemoryDeterministicNativeService, reviewMemoryDeterministicNativeService, submitMemoryDeterministicNativeService } from "@/lib/app-services/memory-deterministic";
import { nativeMemoryDeterministicResourceId, type NativeMemoryDeterministicKind } from "@/lib/memory/deterministic-native-contracts";
import { NativePrivateActionError, privateActionScopeSchema, privateActionShaSchema } from "@/lib/memory/private-action-contracts";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { memoryDeterministicResource, memoryDeterministicSchemas } from "@/lib/mobile/memory-deterministic-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

const headers = { "cache-control": "private, no-store" };
function privateResponse(response: Response) { response.headers.set("cache-control", headers["cache-control"]); return response; }
function failure(error: unknown) {
  return Response.json(error instanceof NativePrivateActionError ? { error: error.message, code: error.code }
    : error instanceof ZodError ? { error: "Invalid private Memory action contract.", code: "private_memory_action_invalid" }
    : { error: "Private Memory action evidence is unavailable. Read the exact receipt before another action.", code: "private_memory_action_unconfirmed" },
  { status: error instanceof NativePrivateActionError ? error.status : error instanceof ZodError ? 400 : 503, headers });
}
export async function readMemoryDeterministicNativeHttp(request: Request, kind: NativeMemoryDeterministicKind, keySha256?: string) {
  if ([...new URL(request.url).searchParams].length || keySha256 !== undefined && !privateActionShaSchema.safeParse(keySha256).success) {
    return Response.json({ error: "Private Memory read query or exact receipt key is invalid." }, { status: 400, headers });
  }
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: memoryDeterministicResource(kind) }); }
  catch (error) { return privateResponse(forbiddenResponse(error)); }
  try {
    const caller = createAppServiceCaller({ context });
    const result = keySha256 === undefined ? await reviewMemoryDeterministicNativeService(caller, kind) : await readMemoryDeterministicNativeService(caller, kind, keySha256);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return failure(error); }
}
export async function submitMemoryDeterministicNativeHttp(request: Request, kind: NativeMemoryDeterministicKind, body: unknown) {
  return requireIdempotencyKey(async (keyed: Request) => {
    if ([...new URL(keyed.url).searchParams].length) return Response.json({ error: "Private Memory mutation query is invalid." }, { status: 400, headers });
    const parsed = memoryDeterministicSchemas(kind).Request.safeParse(body);
    if (!parsed.success) return failure(parsed.error);
    let context;
    try { context = await authorizeRequest({ request: keyed, action: "write.memory", resourceType: memoryDeterministicResource(kind),
      nativeMutationCapability: kind === "maintenance" ? "memory.maintenance.run" : "memory.graph.rebuild", riskLevel: 2 }); }
    catch (error) { return privateResponse(forbiddenResponse(error)); }
    try {
      const canonical = canonicalAuthUserActorFromSecurityContext(context);
      if (!canonical) throw new NativePrivateActionError("private_memory_action_owner", 403, "Current canonical private owner is required.");
      const scope = privateActionScopeSchema.parse({ tenantId: context.tenantId, ownerActorId: context.actorId, canonicalActorId: canonical.actorId });
      const result = await submitMemoryDeterministicNativeService(createRequestMutationAppServiceCaller(keyed, context, {
        purpose: kind === "maintenance" ? "api.memory.maintenance.run" : "api.memory.graph.rebuild", causationId: nativeMemoryDeterministicResourceId(scope, kind),
      }), kind, parsed.data);
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers });
    } catch (error) { return failure(error); }
  })(request);
}
