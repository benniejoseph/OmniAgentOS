import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, connectorNativeScopeSchema, connectorNativeShaSchema,
  type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeMcpDiscoveryIntent, connectorNativeMcpDiscoveryRequestSchema, connectorNativeMcpDiscoveryCloseRequestSchema,
  connectorNativeMcpDiscoveryReadSchema, connectorNativeMcpDiscoveryCloseReadSchema,
  type ConnectorNativeMcpDiscoveryIntent, type ConnectorNativeMcpDiscoveryRead, type ConnectorNativeMcpDiscoveryRequest } from "@/lib/connectors/native-mcp-discovery-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorMcpDiscoveryReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = { submit: "app.connectors.native.mcpDiscoveries.submit", read: "app.connectors.native.mcpDiscoveries.read", close: "app.connectors.native.mcpDiscoveries.close" } as const;
type Response = { scope: ConnectorNativeScope; discovery: ConnectorNativeMcpDiscoveryRead | null; serviceReceipt: z.infer<typeof appServiceReceiptSchema> };
type Authority = { scope: ConnectorNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope; keySha256?: string; idempotencyKey?: string };
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function bindReceipt(value: Response, context: z.RefinementCtx, kind: keyof typeof operations) {
  const { serviceReceipt: proof, ...body } = value, mutation = kind !== "read", intent = value.discovery?.intent;
  if (proof.operation !== operations[kind] || proof.action !== (kind === "submit" ? "manage.connector" : "read") ||
    proof.resourceType !== "connector_native_discovery" || proof.accessMode !== (mutation ? "mutation" : "read") ||
    proof.resourceCount !== (intent ? 1 : 0) || proof.eventContract !== (mutation ? "connector-native-mcp-discovery-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    intent && (!same(value.scope, intent.scope) || mutation && proof.idempotencyKeySha256 !== intent.keySha256)) {
    context.addIssue({ code: "custom", message: "MCP discovery service evidence differs from this exact response." });
  }
}
export const nativeConnectorMcpDiscoverySubmitResponseSchema = z.object({ ...base, discovery: connectorNativeMcpDiscoveryReadSchema,
  replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema }).strict().superRefine((value, context) => bindReceipt(value, context, "submit"));
export const nativeConnectorMcpDiscoveryReadResponseSchema = z.object({ ...base, discovery: connectorNativeMcpDiscoveryReadSchema.nullable(),
  serviceReceipt: appServiceReceiptSchema }).strict().superRefine((value, context) => bindReceipt(value, context, "read"));
export const nativeConnectorMcpDiscoveryCloseResponseSchema = z.object({ ...base, discovery: connectorNativeMcpDiscoveryCloseReadSchema,
  replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema }).strict().superRefine((value, context) => bindReceipt(value, context, "close"));
export function assertNativeConnectorMcpDiscoveryResponseScope(value: Response,
  expected: Authority & { request?: ConnectorNativeMcpDiscoveryRequest; intent?: ConnectorNativeMcpDiscoveryIntent }) {
  if (!same(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: expected.scope.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope: expected.executionScope ?? null })) {
    throw new Error("MCP discovery response authority differs.");
  }
  if (expected.idempotencyKey && value.serviceReceipt.idempotencyKeySha256 !== connectorNativeKeySha256(expected.scope, expected.idempotencyKey)) {
    throw new Error("MCP discovery response mutation key differs.");
  }
  const intent = value.discovery?.intent;
  if (intent && expected.keySha256 && intent.keySha256 !== expected.keySha256) throw new Error("MCP discovery recovery key differs.");
  const original = expected.intent ?? (expected.request && expected.idempotencyKey
    ? buildConnectorNativeMcpDiscoveryIntent(expected.scope, expected.idempotencyKey, expected.request) : undefined);
  if (original && (!intent || !same(original, intent))) throw new Error("MCP discovery response differs from its saved original intent.");
}
export const nativeConnectorMcpDiscoverySchemas = Object.freeze({
  NativeConnectorMcpDiscoveryReadInput: nativeConnectorMcpDiscoveryReadInputSchema,
  NativeConnectorMcpDiscoveryRequest: connectorNativeMcpDiscoveryRequestSchema,
  NativeConnectorMcpDiscoveryCloseRequest: connectorNativeMcpDiscoveryCloseRequestSchema,
  NativeConnectorMcpDiscoverySubmitResponse: nativeConnectorMcpDiscoverySubmitResponseSchema,
  NativeConnectorMcpDiscoveryReadResponse: nativeConnectorMcpDiscoveryReadResponseSchema,
  NativeConnectorMcpDiscoveryCloseResponse: nativeConnectorMcpDiscoveryCloseResponseSchema,
});
