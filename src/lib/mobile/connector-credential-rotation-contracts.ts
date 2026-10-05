import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, connectorNativeScopeSchema, connectorNativeShaSchema,
  type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialRotationIntent, credentialPreparationIntentFromProof,
  connectorNativeCredentialPrepareRequestSchema, connectorNativeCredentialPreparationAbandonRequestSchema,
  connectorNativeCredentialPreparationAbandonedReadSchema, connectorNativeCredentialPreparationPreparedReadSchema,
  connectorNativeCredentialPreparationReadSchema, connectorNativeCredentialRotationActionSchema, connectorNativeCredentialRotationRequestSchema,
  type ConnectorNativeCredentialPreparationIntent, type ConnectorNativeCredentialPreparationRead,
  type ConnectorNativeCredentialRotationAction, type ConnectorNativeCredentialRotationRequest } from "@/lib/connectors/native-credential-rotation-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorCredentialReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = {
  prepare: "app.connectors.native.credentialPreparations.submit",
  preparationRead: "app.connectors.native.credentialPreparations.read",
  abandon: "app.connectors.native.credentialPreparations.abandon",
  rotate: "app.connectors.native.credentialRotations.submit",
  rotationRead: "app.connectors.native.credentialRotations.read",
} as const;
type Kind = keyof typeof operations;
type PreparationResponse = { scope: ConnectorNativeScope; prepared: ConnectorNativeCredentialPreparationRead | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type RotationResponse = { scope: ConnectorNativeScope; action: ConnectorNativeCredentialRotationAction | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type Authority = { scope: ConnectorNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope;
  keySha256?: string; idempotencyKey?: string };
const same = (left: unknown, right: unknown) => canonicalJsonSha256(left) === canonicalJsonSha256(right);
function preparationIntent(prepared: ConnectorNativeCredentialPreparationRead) {
  return prepared.availability === "abandoned" ? prepared.intent : credentialPreparationIntentFromProof(prepared.preparation);
}
function bindReceipt(value: PreparationResponse | RotationResponse, context: z.RefinementCtx, kind: Kind) {
  const { serviceReceipt: proof, ...body } = value;
  const preparation = "prepared" in value, mutation = kind === "prepare" || kind === "abandon" || kind === "rotate";
  const evidence = "prepared" in value ? value.prepared ? preparationIntent(value.prepared) : null : value.action?.acceptance;
  if (proof.operation !== operations[kind] || proof.action !== (kind === "prepare" || kind === "rotate" ? "manage.connector" : "read") ||
    proof.resourceType !== (preparation ? "connector_native_preparation" : "connector_native_action") ||
    proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== (evidence ? 1 : 0) ||
    proof.eventContract !== (mutation ? preparation ? "connector-native-credential-preparation-events.v1" : "connector-native-credential-rotation-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    evidence && (!same(value.scope, evidence.scope) || mutation && proof.idempotencyKeySha256 !== evidence.keySha256)) {
    context.addIssue({ code: "custom", message: "Credential service evidence differs from this exact response." });
  }
}
export const nativeConnectorCredentialPreparationSubmitResponseSchema = z.object({ ...base,
  prepared: connectorNativeCredentialPreparationPreparedReadSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "prepare"));
export const nativeConnectorCredentialPreparationReadResponseSchema = z.object({ ...base,
  prepared: connectorNativeCredentialPreparationReadSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "preparationRead"));
export const nativeConnectorCredentialPreparationAbandonResponseSchema = z.object({ ...base,
  prepared: connectorNativeCredentialPreparationAbandonedReadSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "abandon"));
export const nativeConnectorCredentialRotationSubmitResponseSchema = z.object({ ...base,
  action: connectorNativeCredentialRotationActionSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "rotate"));
export const nativeConnectorCredentialRotationReadResponseSchema = z.object({ ...base,
  action: connectorNativeCredentialRotationActionSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "rotationRead"));

function assertAuthority(value: PreparationResponse | RotationResponse, expected: Authority) {
  if (!same(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
    role: expected.role, executionScope: expected.executionScope ?? null,
  })) throw new Error("Credential response authority differs.");
  if (expected.idempotencyKey && value.serviceReceipt.idempotencyKeySha256 !== connectorNativeKeySha256(expected.scope, expected.idempotencyKey)) {
    throw new Error("Credential response mutation key differs.");
  }
}
export function assertNativeConnectorCredentialPreparationResponseScope(value: PreparationResponse,
  expected: Authority & { intent?: ConnectorNativeCredentialPreparationIntent }) {
  assertAuthority(value, expected);
  const intent = value.prepared ? preparationIntent(value.prepared) : null;
  if (intent && expected.keySha256 && intent.keySha256 !== expected.keySha256) throw new Error("Credential preparation recovery key differs.");
  if (expected.intent && (!intent || !same(intent, expected.intent))) throw new Error("Credential preparation acknowledgement differs from its saved intent.");
}
export function assertNativeConnectorCredentialRotationResponseScope(value: RotationResponse,
  expected: Authority & { request?: ConnectorNativeCredentialRotationRequest }) {
  assertAuthority(value, expected);
  if (value.action && expected.keySha256 && value.action.acceptance.keySha256 !== expected.keySha256) throw new Error("Credential rotation recovery key differs.");
  if (expected.request && expected.idempotencyKey) {
    const intent = buildConnectorNativeCredentialRotationIntent(expected.scope, expected.idempotencyKey, expected.request), acceptance = value.action?.acceptance;
    if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.keySha256 !== intent.keySha256 ||
      acceptance.reviewSha256 !== intent.request.preparationSha256 || acceptance.kind !== intent.request.kind ||
      acceptance.connectorId !== intent.request.connectorId || acceptance.action !== intent.request.action ||
      value.action?.settlement && value.action.settlement.result.credentialVersion !== intent.request.review.credentialVersion + 1) {
      throw new Error("Credential rotation acknowledgement differs from its frozen action.");
    }
  }
}
export const nativeConnectorCredentialRotationSchemas = Object.freeze({
  NativeConnectorCredentialReadInput: nativeConnectorCredentialReadInputSchema,
  NativeConnectorCredentialPrepareRequest: connectorNativeCredentialPrepareRequestSchema,
  NativeConnectorCredentialPreparationAbandonRequest: connectorNativeCredentialPreparationAbandonRequestSchema,
  NativeConnectorCredentialRotationRequest: connectorNativeCredentialRotationRequestSchema,
  NativeConnectorCredentialPreparationSubmitResponse: nativeConnectorCredentialPreparationSubmitResponseSchema,
  NativeConnectorCredentialPreparationReadResponse: nativeConnectorCredentialPreparationReadResponseSchema,
  NativeConnectorCredentialPreparationAbandonResponse: nativeConnectorCredentialPreparationAbandonResponseSchema,
  NativeConnectorCredentialRotationSubmitResponse: nativeConnectorCredentialRotationSubmitResponseSchema,
  NativeConnectorCredentialRotationReadResponse: nativeConnectorCredentialRotationReadResponseSchema,
});
