import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { buildNativeMemoryDeterministicIntent, nativeMemoryDeterministicOperation, nativeMemoryDeterministicResourceId,
  nativeMemoryGraphRebuildAcceptanceSchema, nativeMemoryGraphRebuildRequestSchema, nativeMemoryGraphRebuildReviewSchema,
  nativeMemoryMaintenanceAcceptanceSchema, nativeMemoryMaintenanceRequestSchema, nativeMemoryMaintenanceReviewSchema,
  type NativeMemoryDeterministicKind, type NativeMemoryDeterministicRequest } from "@/lib/memory/deterministic-native-contracts";
import { privateActionScopeSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const memoryDeterministicReadContract = (kind: NativeMemoryDeterministicKind) => kind === "maintenance" ? "asael-memory-maintenance-read:1" as const : "asael-memory-graph-rebuild-read:1" as const;
export const memoryDeterministicServicePrefix = (kind: NativeMemoryDeterministicKind) => kind === "maintenance" ? "app.memory.maintenance.native" : "app.memory.graph.native.rebuild";
export const memoryDeterministicResource = (kind: NativeMemoryDeterministicKind) => kind === "maintenance" ? "memory_maintenance" : "memory_graph";
export const memoryDeterministicEventContract = (kind: NativeMemoryDeterministicKind) => kind === "maintenance" ? "memory-maintenance-native-events.v1" : "memory-graph-native-events.v1";
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
export function memoryDeterministicSchemas(kind: NativeMemoryDeterministicKind) {
  const base = { contract: z.literal(memoryDeterministicReadContract(kind)), scope: privateActionScopeSchema };
  const acceptance = kind === "maintenance" ? nativeMemoryMaintenanceAcceptanceSchema : nativeMemoryGraphRebuildAcceptanceSchema;
  function proof(value: { scope: PrivateActionScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx, operation: string, mutation: boolean, count: number) {
    const { serviceReceipt: receipt, ...body } = value;
    if (receipt.operation !== `${memoryDeterministicServicePrefix(kind)}.${operation}` || receipt.resourceType !== memoryDeterministicResource(kind) ||
      receipt.action !== (mutation ? "write.memory" : "read") || receipt.accessMode !== (mutation ? "mutation" : "read") ||
      receipt.eventContract !== (mutation ? memoryDeterministicEventContract(kind) : "read_only:no_domain_mutation") ||
      (receipt.idempotencyKeySha256 !== null) !== mutation || receipt.resourceCount !== count || receipt.outcomeSha256 !== canonicalJsonSha256(body)) {
      issue(context, "Private Memory receipt does not bind this exact response.");
    }
  }
  const exact = { ...base, acceptance: acceptance.nullable(), serviceReceipt: appServiceReceiptSchema };
  function accepted(value: z.infer<z.ZodObject<typeof exact>>, context: z.RefinementCtx) {
    const a = value.acceptance;
    if (a && (!samePrivateActionValue(a.scope, value.scope) || a.operation !== nativeMemoryDeterministicOperation(kind) ||
      a.resourceId !== nativeMemoryDeterministicResourceId(value.scope, kind))) issue(context, "Private Memory receipt belongs to another scope or operation.");
  }
  return {
    Request: kind === "maintenance" ? nativeMemoryMaintenanceRequestSchema : nativeMemoryGraphRebuildRequestSchema,
    ReviewResponse: z.object({ ...base, review: kind === "maintenance" ? nativeMemoryMaintenanceReviewSchema : nativeMemoryGraphRebuildReviewSchema,
      serviceReceipt: appServiceReceiptSchema }).strict().superRefine((v, c) => proof(v, c, "review", false, 1)),
    ReadResponse: z.object(exact).strict().superRefine((v, c) => { proof(v, c, "get", false, v.acceptance ? 1 : 0); accepted(v, c); }),
    Response: z.object({ ...exact, acceptance, replayed: z.boolean() }).strict().superRefine((v, c) => {
      proof(v, c, "run", true, 1); accepted(v, c);
      if (v.acceptance.keySha256 !== v.serviceReceipt.idempotencyKeySha256) issue(c, "Private Memory acceptance key differs.");
    }),
    Error: z.object({ error: z.string().min(1).max(4000), code: z.string().min(1).max(200).optional(), message: z.string().max(4000).optional() }).strict(),
  };
}
type Expected = { scope: PrivateActionScope; kind: NativeMemoryDeterministicKind; requestActorId: string; role: string; executionScope?: ExecutionScope };
export function validateMemoryDeterministicAuthority(value: { scope: PrivateActionScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, expected: Expected) {
  if (!samePrivateActionValue(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: expected.scope.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope: expected.executionScope ?? null })) throw new Error("Private Memory response authority differs.");
}
export function memoryDeterministicResponseForScopeSchema(expected: Expected & { request: NativeMemoryDeterministicRequest; idempotencyKey: string }) {
  const intent = buildNativeMemoryDeterministicIntent(expected);
  return memoryDeterministicSchemas(expected.kind).Response.superRefine((v, c) => {
    try { validateMemoryDeterministicAuthority(v, expected); } catch { issue(c, "Private Memory response belongs to another current caller."); }
    if (v.acceptance.keySha256 !== intent.keySha256 || v.acceptance.requestSha256 !== canonicalJsonSha256(intent) ||
      v.acceptance.reviewSha256 !== intent.request.review.reviewSha256) issue(c, "Private Memory receipt does not prove the exact reviewed intent.");
    if (intent.operation === "memory.maintenance.run" && v.acceptance.operation === "memory.maintenance.run" &&
      v.acceptance.result.scanned !== intent.request.review.eligibleMemoryCount) issue(c, "Maintenance receipt source count differs.");
    if (intent.operation === "memory.graph.rebuild" && v.acceptance.operation === "memory.graph.rebuild" &&
      (v.acceptance.result.memoryCount !== intent.request.review.memoryCount || v.acceptance.result.traceCount !== intent.request.review.traceCount)) issue(c, "Graph receipt source count differs.");
  });
}
const maintenance = memoryDeterministicSchemas("maintenance"), graph = memoryDeterministicSchemas("graph");
export const nativeMemoryMaintenanceSchemas = Object.freeze({ NativeMemoryMaintenanceRequest: maintenance.Request,
  NativeMemoryMaintenanceReviewResponse: maintenance.ReviewResponse, NativeMemoryMaintenanceResponse: maintenance.Response,
  NativeMemoryMaintenanceReadResponse: maintenance.ReadResponse, NativeMemoryMaintenanceError: maintenance.Error });
export const nativeMemoryGraphRebuildSchemas = Object.freeze({ NativeMemoryGraphRebuildRequest: graph.Request,
  NativeMemoryGraphRebuildReviewResponse: graph.ReviewResponse, NativeMemoryGraphRebuildResponse: graph.Response,
  NativeMemoryGraphRebuildReadResponse: graph.ReadResponse, NativeMemoryGraphRebuildError: graph.Error });
