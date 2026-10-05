import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, buildConnectorNativeIntent, connectorNativeActionSchema, connectorNativeIdSchema,
  connectorNativeKindSchema, connectorNativeRequestSchema, connectorNativeReviewSchema, connectorNativeScopeSchema,
  connectorNativeShaSchema, connectorNativeSummarySchema, connectorNativeRequestReviewSha, type ConnectorNativeRequest, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorReviewInputSchema = z.object({ kind: connectorNativeKindSchema, id: connectorNativeIdSchema }).strict();
export const nativeConnectorReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = { list: "app.connectors.native.list", review: "app.connectors.native.review", act: "app.connectors.native.act", show: "app.connectors.native.show" } as const;
function issue(context: z.RefinementCtx, message: string) { context.addIssue({ code: "custom", message }); }
function receipt(kind: keyof typeof operations, value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx, count: number) {
  const { serviceReceipt: proof, ...body } = value, mutation = kind === "act";
  if (proof.operation !== operations[kind] || proof.action !== (mutation ? "manage.connector" : "read") || proof.resourceType !== "connector_native_action" ||
    proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== count ||
    proof.eventContract !== (mutation ? "connector-native-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "Connector service evidence differs from this exact response.");
}
export const nativeConnectorListResponseSchema = z.object({ ...base, connectors: z.array(connectorNativeSummarySchema).max(50), hasMore: z.boolean(), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => {
    receipt("list", value, context, value.connectors.length);
    const keys = value.connectors.map((v) => `${v.kind}\0${v.id}`);
    if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) issue(context, "Connector listing must be unique and ordered.");
  });
export const nativeConnectorReviewResponseSchema = z.object({ ...base, review: connectorNativeReviewSchema.nullable(), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => receipt("review", value, context, value.review ? 1 : 0));
function actionBinding(value: { scope: ConnectorNativeScope; action: z.infer<typeof connectorNativeActionSchema> | null; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx, mutation: boolean) {
  receipt(mutation ? "act" : "show", value, context, value.action ? 1 : 0);
  if (value.action && (canonicalJsonSha256(value.scope) !== canonicalJsonSha256(value.action.acceptance.scope) ||
    mutation && value.serviceReceipt.idempotencyKeySha256 !== value.action.acceptance.keySha256)) issue(context, "Connector action belongs to another owner or key.");
}
export const nativeConnectorActionResponseSchema = z.object({ ...base, action: connectorNativeActionSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => actionBinding(value, context, true));
export const nativeConnectorReadResponseSchema = z.object({ ...base, action: connectorNativeActionSchema.nullable(), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => actionBinding(value, context, false));
export function assertNativeConnectorResponseScope(value: { scope: ConnectorNativeScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema>;
  action?: z.infer<typeof connectorNativeActionSchema> | null }, expected: { scope: ConnectorNativeScope; requestActorId: string; role: string;
  executionScope?: ExecutionScope; keySha256?: string; idempotencyKey?: string; request?: ConnectorNativeRequest }) {
  if (canonicalJsonSha256(value.scope) !== canonicalJsonSha256(expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.scope.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope: expected.executionScope ?? null })) {
    throw new Error("Connector response authority differs.");
  }
  if (value.action && expected.keySha256 && value.action.acceptance.keySha256 !== expected.keySha256) throw new Error("Connector action recovery key differs.");
  if (expected.request && expected.idempotencyKey) {
    const intent = buildConnectorNativeIntent(expected.scope, expected.idempotencyKey, expected.request), acceptance = value.action?.acceptance;
    if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.keySha256 !== intent.keySha256 ||
      acceptance.reviewSha256 !== connectorNativeRequestReviewSha(intent.request) || acceptance.kind !== intent.request.kind ||
      acceptance.connectorId !== intent.request.connectorId || acceptance.action !== intent.request.action) throw new Error("Connector acknowledgement differs from the frozen action.");
  }
}
export const nativeConnectorErrorSchema = z.object({ error: z.string().min(1).max(4_000), code: z.string().min(1).max(200).optional(), message: z.string().max(4_000).optional() }).strict();
export const nativeConnectorSchemas = Object.freeze({ NativeConnectorReviewInput: nativeConnectorReviewInputSchema,
  NativeConnectorReadInput: nativeConnectorReadInputSchema, NativeConnectorActionRequest: connectorNativeRequestSchema,
  NativeConnectorListResponse: nativeConnectorListResponseSchema, NativeConnectorReviewResponse: nativeConnectorReviewResponseSchema,
  NativeConnectorActionResponse: nativeConnectorActionResponseSchema, NativeConnectorReadResponse: nativeConnectorReadResponseSchema,
  NativeConnectorError: nativeConnectorErrorSchema });
