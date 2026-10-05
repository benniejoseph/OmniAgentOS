import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, connectorNativeScopeSchema, connectorNativeShaSchema,
  type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeMcpRegistrationIntent, mcpRegistrationPreparationIntentFromProof,
  connectorNativeMcpRegistrationPrepareRequestSchema, connectorNativeMcpRegistrationPreparationAbandonRequestSchema,
  connectorNativeMcpRegistrationPreparationAbandonedReadSchema, connectorNativeMcpRegistrationPreparationPreparedReadSchema,
  connectorNativeMcpRegistrationPreparationReadSchema, connectorNativeMcpRegistrationActionSchema, connectorNativeMcpRegistrationRequestSchema,
  type ConnectorNativeMcpRegistrationPreparationIntent, type ConnectorNativeMcpRegistrationPreparationRead,
  type ConnectorNativeMcpRegistrationAction, type ConnectorNativeMcpRegistrationRequest } from "@/lib/connectors/native-mcp-registration-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorMcpRegistrationReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = {
  prepare: "app.connectors.native.mcpRegistrationPreparations.submit",
  preparationRead: "app.connectors.native.mcpRegistrationPreparations.read",
  abandon: "app.connectors.native.mcpRegistrationPreparations.abandon",
  register: "app.connectors.native.mcpRegistrations.submit",
  registrationRead: "app.connectors.native.mcpRegistrations.read",
} as const;
type Kind = keyof typeof operations;
type PreparationResponse = { scope: ConnectorNativeScope; prepared: ConnectorNativeMcpRegistrationPreparationRead | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type RegistrationResponse = { scope: ConnectorNativeScope; action: ConnectorNativeMcpRegistrationAction | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type Authority = { scope: ConnectorNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope;
  keySha256?: string; idempotencyKey?: string };
const same = (left: unknown, right: unknown) => canonicalJsonSha256(left) === canonicalJsonSha256(right);
function preparationIntent(prepared: ConnectorNativeMcpRegistrationPreparationRead) {
  return prepared.availability === "abandoned" ? prepared.intent : mcpRegistrationPreparationIntentFromProof(prepared.preparation);
}
function bindReceipt(value: PreparationResponse | RegistrationResponse, context: z.RefinementCtx, kind: Kind) {
  const { serviceReceipt: proof, ...body } = value;
  const preparation = "prepared" in value, mutation = kind === "prepare" || kind === "abandon" || kind === "register";
  const evidence = "prepared" in value ? value.prepared ? preparationIntent(value.prepared) : null : value.action?.acceptance;
  if (proof.operation !== operations[kind] || proof.action !== (kind === "prepare" || kind === "register" ? "manage.connector" : "read") ||
    proof.resourceType !== (preparation ? "connector_native_preparation" : "connector_native_action") ||
    proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== (evidence ? 1 : 0) ||
    proof.eventContract !== (mutation ? preparation ? "connector-native-mcp-registration-preparation-events.v1" : "connector-native-mcp-registration-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    evidence && (!same(value.scope, evidence.scope) || mutation && proof.idempotencyKeySha256 !== evidence.keySha256)) {
    context.addIssue({ code: "custom", message: "MCP registration service evidence differs from this exact response." });
  }
}
export const nativeConnectorMcpRegistrationPreparationSubmitResponseSchema = z.object({ ...base,
  prepared: connectorNativeMcpRegistrationPreparationPreparedReadSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "prepare"));
export const nativeConnectorMcpRegistrationPreparationReadResponseSchema = z.object({ ...base,
  prepared: connectorNativeMcpRegistrationPreparationReadSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "preparationRead"));
export const nativeConnectorMcpRegistrationPreparationAbandonResponseSchema = z.object({ ...base,
  prepared: connectorNativeMcpRegistrationPreparationAbandonedReadSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "abandon"));
export const nativeConnectorMcpRegistrationSubmitResponseSchema = z.object({ ...base,
  action: connectorNativeMcpRegistrationActionSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "register"));
export const nativeConnectorMcpRegistrationReadResponseSchema = z.object({ ...base,
  action: connectorNativeMcpRegistrationActionSchema.nullable(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "registrationRead"));

function assertAuthority(value: PreparationResponse | RegistrationResponse, expected: Authority) {
  if (!same(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
    role: expected.role, executionScope: expected.executionScope ?? null,
  })) throw new Error("MCP registration response authority differs.");
  if (expected.idempotencyKey && value.serviceReceipt.idempotencyKeySha256 !== connectorNativeKeySha256(expected.scope, expected.idempotencyKey)) {
    throw new Error("MCP registration response mutation key differs.");
  }
}
export function assertNativeConnectorMcpRegistrationPreparationResponseScope(value: PreparationResponse,
  expected: Authority & { intent?: ConnectorNativeMcpRegistrationPreparationIntent }) {
  assertAuthority(value, expected);
  const intent = value.prepared ? preparationIntent(value.prepared) : null;
  if (intent && expected.keySha256 && intent.keySha256 !== expected.keySha256) throw new Error("MCP registration preparation recovery key differs.");
  if (expected.intent && (!intent || !same(intent, expected.intent))) throw new Error("MCP registration preparation acknowledgement differs from its saved intent.");
}
export function assertNativeConnectorMcpRegistrationResponseScope(value: RegistrationResponse,
  expected: Authority & { request?: ConnectorNativeMcpRegistrationRequest }) {
  assertAuthority(value, expected);
  if (value.action && expected.keySha256 && value.action.acceptance.keySha256 !== expected.keySha256) throw new Error("MCP registration recovery key differs.");
  if (expected.request && expected.idempotencyKey) {
    const intent = buildConnectorNativeMcpRegistrationIntent(expected.scope, expected.idempotencyKey, expected.request), acceptance = value.action?.acceptance;
    if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.keySha256 !== intent.keySha256 ||
      acceptance.reviewSha256 !== intent.request.preparationSha256 || acceptance.kind !== intent.request.kind ||
      acceptance.connectorId !== intent.request.connectorId || acceptance.action !== intent.request.action) {
      throw new Error("MCP registration acknowledgement differs from its frozen action.");
    }
  }
}
export const nativeConnectorMcpRegistrationSchemas = Object.freeze({
  NativeConnectorMcpRegistrationReadInput: nativeConnectorMcpRegistrationReadInputSchema,
  NativeConnectorMcpRegistrationPrepareRequest: connectorNativeMcpRegistrationPrepareRequestSchema,
  NativeConnectorMcpRegistrationPreparationAbandonRequest: connectorNativeMcpRegistrationPreparationAbandonRequestSchema,
  NativeConnectorMcpRegistrationRequest: connectorNativeMcpRegistrationRequestSchema,
  NativeConnectorMcpRegistrationPreparationSubmitResponse: nativeConnectorMcpRegistrationPreparationSubmitResponseSchema,
  NativeConnectorMcpRegistrationPreparationReadResponse: nativeConnectorMcpRegistrationPreparationReadResponseSchema,
  NativeConnectorMcpRegistrationPreparationAbandonResponse: nativeConnectorMcpRegistrationPreparationAbandonResponseSchema,
  NativeConnectorMcpRegistrationSubmitResponse: nativeConnectorMcpRegistrationSubmitResponseSchema,
  NativeConnectorMcpRegistrationReadResponse: nativeConnectorMcpRegistrationReadResponseSchema,
});
