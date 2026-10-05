import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, connectorNativeScopeSchema, connectorNativeShaSchema,
  type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeOpenapiImportIntent,
  connectorNativeOpenapiImportPrepareRequestSchema, connectorNativeOpenapiImportPreparationAbandonRequestSchema,
  connectorNativeOpenapiImportPreparationAbandonedReadSchema,
  connectorNativeOpenapiImportPreparationReadSchema, connectorNativeOpenapiImportActionSchema, connectorNativeOpenapiImportRequestSchema,
  type ConnectorNativeOpenapiImportPreparationIntent, type ConnectorNativeOpenapiImportPreparationRead,
  type ConnectorNativeOpenapiImportAction, type ConnectorNativeOpenapiImportRequest } from "@/lib/connectors/native-openapi-import-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorOpenapiImportReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = {
  prepare: "app.connectors.native.openapiImportPreparations.submit",
  preparationRead: "app.connectors.native.openapiImportPreparations.read",
  abandon: "app.connectors.native.openapiImportPreparations.abandon",
  register: "app.connectors.native.openapiImports.submit",
  registrationRead: "app.connectors.native.openapiImports.read",
} as const;
type Kind = keyof typeof operations;
type PreparationResponse = { scope: ConnectorNativeScope; prepared: ConnectorNativeOpenapiImportPreparationRead | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type RegistrationResponse = { scope: ConnectorNativeScope; action: ConnectorNativeOpenapiImportAction | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type Authority = { scope: ConnectorNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope;
  keySha256?: string; idempotencyKey?: string };
const same = (left: unknown, right: unknown) => canonicalJsonSha256(left) === canonicalJsonSha256(right);
function preparationIntent(prepared: ConnectorNativeOpenapiImportPreparationRead) {
  return prepared.intent;
}
function bindReceipt(value: PreparationResponse | RegistrationResponse, context: z.RefinementCtx, kind: Kind) {
  const { serviceReceipt: proof, ...body } = value;
  const preparation = "prepared" in value, mutation = kind === "prepare" || kind === "abandon" || kind === "register";
  const evidence = "prepared" in value ? value.prepared ? preparationIntent(value.prepared) : null : value.action?.acceptance;
  if (proof.operation !== operations[kind] || proof.action !== (kind === "prepare" || kind === "register" ? "manage.connector" : "read") ||
    proof.resourceType !== (preparation ? "connector_native_preparation" : "connector_native_action") ||
    proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== (evidence ? 1 : 0) ||
    proof.eventContract !== (mutation ? preparation ? "connector-native-openapi-import-preparation-events.v1" : "connector-native-openapi-import-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    evidence && (!same(value.scope, evidence.scope) || mutation && proof.idempotencyKeySha256 !== evidence.keySha256)) {
    context.addIssue({ code: "custom", message: "OpenAPI import service evidence differs from this exact response." });
  }
}
export const nativeConnectorOpenapiImportPreparationSubmitResponseSchema = z.object({ ...base,
  prepared: connectorNativeOpenapiImportPreparationReadSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "prepare"));
export const nativeConnectorOpenapiImportPreparationReadResponseSchema = z.object({ ...base,
  prepared: connectorNativeOpenapiImportPreparationReadSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "preparationRead"));
export const nativeConnectorOpenapiImportPreparationAbandonResponseSchema = z.object({ ...base,
  prepared: connectorNativeOpenapiImportPreparationAbandonedReadSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "abandon"));
export const nativeConnectorOpenapiImportSubmitResponseSchema = z.object({ ...base,
  action: connectorNativeOpenapiImportActionSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "register"));
export const nativeConnectorOpenapiImportReadResponseSchema = z.object({ ...base,
  action: connectorNativeOpenapiImportActionSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "registrationRead"));

function assertAuthority(value: PreparationResponse | RegistrationResponse, expected: Authority) {
  if (!same(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
    role: expected.role, executionScope: expected.executionScope ?? null,
  })) throw new Error("OpenAPI import response authority differs.");
  if (expected.idempotencyKey && value.serviceReceipt.idempotencyKeySha256 !== connectorNativeKeySha256(expected.scope, expected.idempotencyKey)) {
    throw new Error("OpenAPI import response mutation key differs.");
  }
}
export function assertNativeConnectorOpenapiImportPreparationResponseScope(value: PreparationResponse,
  expected: Authority & { intent?: ConnectorNativeOpenapiImportPreparationIntent }) {
  assertAuthority(value, expected);
  const intent = value.prepared ? preparationIntent(value.prepared) : null;
  if (intent && expected.keySha256 && intent.keySha256 !== expected.keySha256) throw new Error("OpenAPI import preparation recovery key differs.");
  if (expected.intent && (!intent || !same(intent, expected.intent))) throw new Error("OpenAPI import preparation acknowledgement differs from its saved intent.");
}
export function assertNativeConnectorOpenapiImportResponseScope(value: RegistrationResponse,
  expected: Authority & { request?: ConnectorNativeOpenapiImportRequest }) {
  assertAuthority(value, expected);
  if (value.action && expected.keySha256 && value.action.acceptance.keySha256 !== expected.keySha256) throw new Error("OpenAPI import recovery key differs.");
  if (expected.request && expected.idempotencyKey) {
    const intent = buildConnectorNativeOpenapiImportIntent(expected.scope, expected.idempotencyKey, expected.request), acceptance = value.action?.acceptance;
    if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.keySha256 !== intent.keySha256 ||
      acceptance.reviewSha256 !== intent.request.preparationSha256 || acceptance.kind !== intent.request.kind ||
      acceptance.connectorId !== intent.request.connectorId || acceptance.action !== intent.request.action) {
      throw new Error("OpenAPI import acknowledgement differs from its frozen action.");
    }
  }
}
export const nativeConnectorOpenapiImportSchemas = Object.freeze({
  NativeConnectorOpenapiImportReadInput: nativeConnectorOpenapiImportReadInputSchema,
  NativeConnectorOpenapiImportPrepareRequest: connectorNativeOpenapiImportPrepareRequestSchema,
  NativeConnectorOpenapiImportPreparationAbandonRequest: connectorNativeOpenapiImportPreparationAbandonRequestSchema,
  NativeConnectorOpenapiImportRequest: connectorNativeOpenapiImportRequestSchema,
  NativeConnectorOpenapiImportPreparationSubmitResponse: nativeConnectorOpenapiImportPreparationSubmitResponseSchema,
  NativeConnectorOpenapiImportPreparationReadResponse: nativeConnectorOpenapiImportPreparationReadResponseSchema,
  NativeConnectorOpenapiImportPreparationAbandonResponse: nativeConnectorOpenapiImportPreparationAbandonResponseSchema,
  NativeConnectorOpenapiImportSubmitResponse: nativeConnectorOpenapiImportSubmitResponseSchema,
  NativeConnectorOpenapiImportReadResponse: nativeConnectorOpenapiImportReadResponseSchema,
});
