import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeIdSchema, connectorNativeScopeSchema, connectorNativeShaSchema,
  type ConnectorNativeReview, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeTrashIntent, connectorNativeTrashActionSchema, connectorNativeTrashPreviewSchema,
  connectorNativeTrashRequestSchema, type ConnectorNativeTrashAction, type ConnectorNativeTrashRequest } from "@/lib/connectors/native-trash-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorTrashPreviewInputSchema = z.object({ id: connectorNativeIdSchema }).strict();
export const nativeConnectorTrashReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
type TrashResponse = { scope: ConnectorNativeScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema>;
  action?: ConnectorNativeTrashAction | null; review?: ConnectorNativeReview | null };
function bindReceipt(value: TrashResponse, context: z.RefinementCtx, kind: "preview" | "submit" | "read") {
  const { serviceReceipt: proof, ...body } = value, mutation = kind === "submit";
  if (proof.operation !== `app.connectors.native.trash.${kind}` || proof.action !== (kind === "read" ? "read" : "manage.connector") ||
    proof.resourceType !== "connector_native_action" || proof.accessMode !== (mutation ? "mutation" : "read") ||
    proof.resourceCount !== (kind === "preview" ? value.review ? 1 : 0 : value.action ? 1 : 0) ||
    proof.eventContract !== (mutation ? "connector-native-trash-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    value.action && (canonicalJsonSha256(value.scope) !== canonicalJsonSha256(value.action.acceptance.scope) ||
      mutation && proof.idempotencyKeySha256 !== value.action.acceptance.keySha256)) {
    context.addIssue({ code: "custom", message: "Connector Trash service evidence differs from this exact response." });
  }
}
export const nativeConnectorTrashPreviewResponseSchema = z.object({
  ...base, ...connectorNativeTrashPreviewSchema.shape, serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => {
  if (!connectorNativeTrashPreviewSchema.safeParse({ review: value.review, preview: value.preview, compensation: value.compensation }).success) {
    context.addIssue({ code: "custom", message: "Connector Trash preview differs from its complete current review." });
  }
  bindReceipt(value, context, "preview");
});
export const nativeConnectorTrashSubmitResponseSchema = z.object({
  ...base, action: connectorNativeTrashActionSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "submit"));
export const nativeConnectorTrashReadResponseSchema = z.object({
  ...base, action: connectorNativeTrashActionSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "read"));

export function assertNativeConnectorTrashResponseScope(value: TrashResponse, expected: {
  scope: ConnectorNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope;
  connectorId?: string; keySha256?: string; idempotencyKey?: string; request?: ConnectorNativeTrashRequest;
}) {
  if (canonicalJsonSha256(value.scope) !== canonicalJsonSha256(expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
    role: expected.role, executionScope: expected.executionScope ?? null,
  })) throw new Error("Connector Trash response authority differs.");
  if (value.review && expected.connectorId && value.review.connector.id !== expected.connectorId) throw new Error("Connector Trash preview target differs.");
  if (value.action && expected.keySha256 && value.action.acceptance.keySha256 !== expected.keySha256) throw new Error("Connector Trash recovery key differs.");
  if (expected.request && expected.idempotencyKey) {
    const intent = buildConnectorNativeTrashIntent(expected.scope, expected.idempotencyKey, expected.request), acceptance = value.action?.acceptance;
    if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.keySha256 !== intent.keySha256 ||
      acceptance.reviewSha256 !== intent.request.review.reviewSha256 || acceptance.kind !== intent.request.kind ||
      acceptance.connectorId !== intent.request.connectorId || acceptance.action !== intent.request.action) {
      throw new Error("Connector Trash acknowledgement differs from the frozen action.");
    }
  }
}
export const nativeConnectorTrashSchemas = Object.freeze({
  NativeConnectorTrashPreviewInput: nativeConnectorTrashPreviewInputSchema,
  NativeConnectorTrashReadInput: nativeConnectorTrashReadInputSchema,
  NativeConnectorTrashRequest: connectorNativeTrashRequestSchema,
  NativeConnectorTrashPreviewResponse: nativeConnectorTrashPreviewResponseSchema,
  NativeConnectorTrashSubmitResponse: nativeConnectorTrashSubmitResponseSchema,
  NativeConnectorTrashReadResponse: nativeConnectorTrashReadResponseSchema,
});
