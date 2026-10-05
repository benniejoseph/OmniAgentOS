import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeScopeSchema, connectorNativeShaSchema, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialRemovalIntent, connectorNativeCredentialRemovalActionSchema,
  connectorNativeCredentialRemovalRequestSchema, type ConnectorNativeCredentialRemovalRequest } from "@/lib/connectors/native-credential-removal-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorCredentialRemovalReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = {
  submit: "app.connectors.native.credentialRemovals.submit",
  read: "app.connectors.native.credentialRemovals.read",
} as const;
type RemovalResponse = {
  scope: ConnectorNativeScope;
  action: z.infer<typeof connectorNativeCredentialRemovalActionSchema> | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema>;
};

function bindReceipt(value: RemovalResponse, context: z.RefinementCtx, mutation: boolean) {
  const { serviceReceipt: proof, ...body } = value;
  if (proof.operation !== operations[mutation ? "submit" : "read"] ||
    proof.action !== (mutation ? "manage.connector" : "read") || proof.resourceType !== "connector_native_action" ||
    proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== (value.action ? 1 : 0) ||
    proof.eventContract !== (mutation ? "connector-native-credential-removal-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    value.action && (canonicalJsonSha256(value.scope) !== canonicalJsonSha256(value.action.acceptance.scope) ||
      mutation && proof.idempotencyKeySha256 !== value.action.acceptance.keySha256)) {
    context.addIssue({ code: "custom", message: "Credential removal service evidence differs from this exact response." });
  }
}

export const nativeConnectorCredentialRemovalSubmitResponseSchema = z.object({
  ...base, action: connectorNativeCredentialRemovalActionSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, true));
export const nativeConnectorCredentialRemovalReadResponseSchema = z.object({
  ...base, action: connectorNativeCredentialRemovalActionSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, false));

export function assertNativeConnectorCredentialRemovalResponseScope(value: RemovalResponse, expected: {
  scope: ConnectorNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope;
  keySha256?: string; idempotencyKey?: string; request?: ConnectorNativeCredentialRemovalRequest;
}) {
  if (canonicalJsonSha256(value.scope) !== canonicalJsonSha256(expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
    role: expected.role, executionScope: expected.executionScope ?? null,
  })) throw new Error("Credential removal response authority differs.");
  if (value.action && expected.keySha256 && value.action.acceptance.keySha256 !== expected.keySha256) {
    throw new Error("Credential removal recovery key differs.");
  }
  if (expected.request && expected.idempotencyKey) {
    const intent = buildConnectorNativeCredentialRemovalIntent(expected.scope, expected.idempotencyKey, expected.request);
    const acceptance = value.action?.acceptance;
    if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.keySha256 !== intent.keySha256 ||
      acceptance.reviewSha256 !== intent.request.review.reviewSha256 || acceptance.kind !== intent.request.kind ||
      acceptance.connectorId !== intent.request.connectorId || acceptance.action !== intent.request.action ||
      value.action?.settlement && value.action.settlement.result.credentialVersion !== intent.request.review.credentialVersion + 1) {
      throw new Error("Credential removal acknowledgement differs from the frozen action.");
    }
  }
}

export const nativeConnectorCredentialRemovalSchemas = Object.freeze({
  NativeConnectorCredentialRemovalReadInput: nativeConnectorCredentialRemovalReadInputSchema,
  NativeConnectorCredentialRemovalRequest: connectorNativeCredentialRemovalRequestSchema,
  NativeConnectorCredentialRemovalSubmitResponse: nativeConnectorCredentialRemovalSubmitResponseSchema,
  NativeConnectorCredentialRemovalReadResponse: nativeConnectorCredentialRemovalReadResponseSchema,
});
