import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId, connectorNativeExtendedSettlementSchema, connectorNativeFutureAcceptanceSchema,
  connectorNativeFutureActionSchema, connectorNativeKeySha256, connectorNativePreparationDeclarationSchema,
  connectorNativePreparationIntentSchema, connectorNativePreparationSchema, connectorNativePrepareRequestSchema,
  connectorNativePreparedRequestSchema, connectorNativeScopeSchema, connectorNativeShaSchema,
  type ConnectorNativeScope } from "./native-control-contracts";
import { connectorNativePublicEndpoint } from "./native-control-private";

export const NATIVE_MCP_REGISTRATION_PREPARATION_TTL_MS = 900_000;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const target = z.string().regex(/^native-mcp-[a-f0-9]{64}$/);

export function connectorNativeMcpRegistrationTargetId(scope: ConnectorNativeScope, nonce: string) {
  return `native-mcp-${canonicalJsonSha256({ scope, nonce })}`;
}
export function connectorNativeMcpRegistrationPreparationId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-preparation:${canonicalJsonSha256({ operation: "register_mcp", scope, keySha256 })}`;
}
export function connectorNativeMcpRegistrationAbandonmentId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-preparation-abandonment:${canonicalJsonSha256({ operation: "register_mcp", scope, keySha256 })}`;
}

/** Preserve the full intended URL; only its separate public projection is redacted. */
export function normalizeNativeMcpRegistrationEndpoint(input: string) {
  if (!input || input.length > 2048 || input.trim() !== input || /[\u0000-\u0020\u007f]/.test(input)) throw new Error("Invalid MCP endpoint.");
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MCP endpoint.");
  const normalized = url.toString();
  if (normalized.length > 2048) throw new Error("Invalid MCP endpoint.");
  return normalized;
}
export function nativeMcpRegistrationEndpointProjection(input: string) {
  const normalized = normalizeNativeMcpRegistrationEndpoint(input);
  const { endpoint } = connectorNativePublicEndpoint(normalized);
  // Empty query/fragment delimiters can survive URL serialization even though
  // URL.search/hash are empty. Never reconstruct those inputs from a false clean flag.
  return { endpoint, endpointRedacted: endpoint !== normalized };
}

export const connectorNativeMcpRegistrationDeclarationSchema = z.object({
  ...connectorNativePreparationDeclarationSchema.shape,
  name: z.string().min(1).max(120).refine((v) => v.trim() === v),
  endpoint: connectorNativePreparationDeclarationSchema.shape.endpoint.unwrap(),
  authType: z.enum(["none", "bearer_env", "bearer_vault"]), authHeaderName: z.null(),
  specSource: z.literal("none"), specUrl: z.null(), specUrlRedacted: z.literal(false),
}).strict().superRefine((v, c) => {
  if ((v.authType === "bearer_env") !== (v.authTokenEnv !== null)) issue(c, "MCP authentication declaration is inconsistent.");
  try { if (normalizeNativeMcpRegistrationEndpoint(v.endpoint) !== v.endpoint || nativeMcpRegistrationEndpointProjection(v.endpoint).endpoint !== v.endpoint) issue(c, "MCP endpoint declaration is not normalized."); }
  catch { issue(c, "MCP endpoint declaration is invalid."); }
});
const fields = { operation: z.literal("register_mcp"), connectorId: target, review: z.null(), declaration: connectorNativeMcpRegistrationDeclarationSchema };
export const connectorNativeMcpRegistrationPreparationIntentSchema = z.object({
  ...connectorNativePreparationIntentSchema.shape, ...fields,
}).strict().superRefine((v, c) => {
  if (v.connectorId !== connectorNativeMcpRegistrationTargetId(v.scope, v.nonce) || Buffer.byteLength(JSON.stringify(v), "utf8") > 16384) {
    issue(c, "MCP registration intent does not bind its derived target.");
  }
});
export const connectorNativeMcpRegistrationPrepareRequestSchema = z.object({
  ...connectorNativePrepareRequestSchema.shape, ...fields,
  payload: z.object({ endpoint: z.string().min(1).max(2048), specUrl: z.null(), specText: z.null(),
    bearerToken: z.string().min(1).max(8192).refine((v) => Buffer.byteLength(v, "utf8") >= 8 && Buffer.byteLength(v, "utf8") <= 8192 &&
      v.trim() === v && !/[\r\n]/.test(v), "A bounded bearer credential is required.").nullable() }).strict(),
}).strict().superRefine((v, c) => {
  if ((v.declaration.authType === "bearer_vault") !== (v.payload.bearerToken !== null)) issue(c, "MCP authentication payload differs from its declaration.");
  try {
    const projected = nativeMcpRegistrationEndpointProjection(v.payload.endpoint);
    if (projected.endpoint !== v.declaration.endpoint || projected.endpointRedacted !== v.declaration.endpointRedacted) issue(c, "MCP endpoint differs from its reviewed declaration.");
  } catch { issue(c, "MCP endpoint is invalid."); }
});
export function buildConnectorNativeMcpRegistrationPreparationIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeMcpRegistrationPrepareRequest) {
  const { contract: _contract, payload: _payload, ...safe } = connectorNativeMcpRegistrationPrepareRequestSchema.parse(request);
  return connectorNativeMcpRegistrationPreparationIntentSchema.parse({ contract: "asael-connector-preparation-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), ...safe });
}
function originalIntent(value: Pick<z.infer<typeof connectorNativePreparationSchema>, "scope" | "keySha256" | "nonce" | "operation" | "connectorId" | "review" | "declaration">) {
  return { contract: "asael-connector-preparation-intent:1", scope: value.scope, keySha256: value.keySha256,
    nonce: value.nonce, operation: value.operation, connectorId: value.connectorId, review: value.review, declaration: value.declaration };
}
export function mcpRegistrationPreparationIntentFromProof(value: ConnectorNativeMcpRegistrationPreparation) {
  return connectorNativeMcpRegistrationPreparationIntentSchema.parse(originalIntent(value));
}
export const connectorNativeMcpRegistrationPreparationSchema = z.object({
  ...connectorNativePreparationSchema.shape, ...fields,
}).strict().superRefine((v, c) => {
  const { preparationSha256, ...body } = v;
  const intent = connectorNativeMcpRegistrationPreparationIntentSchema.safeParse(originalIntent(v));
  if (preparationSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeMcpRegistrationPreparationId(v.scope, v.keySha256) ||
    Date.parse(v.expiresAt) - Date.parse(v.preparedAt) !== NATIVE_MCP_REGISTRATION_PREPARATION_TTL_MS ||
    !intent.success || v.intentSha256 !== canonicalJsonSha256(intent.data)) issue(c, "MCP registration proof differs from its original intent.");
});
export const connectorNativeMcpRegistrationPreparationAbandonRequestSchema = z.object({
  contract: z.literal("asael-mcp-registration-preparation-abandon:1"), intent: connectorNativeMcpRegistrationPreparationIntentSchema,
}).strict();
export const connectorNativeMcpRegistrationPreparationAbandonmentSchema = z.object({
  contract: z.literal("asael-mcp-registration-preparation-abandonment:1"),
  id: z.string().regex(/^connector-preparation-abandonment:[a-f0-9]{64}$/), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, intentSha256: connectorNativeShaSchema, preparationSha256: connectorNativeShaSchema.nullable(),
  abandonedAt: connectorNativePreparationSchema.shape.preparedAt, abandonmentSha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  const { abandonmentSha256, ...body } = v;
  if (abandonmentSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeMcpRegistrationAbandonmentId(v.scope, v.keySha256)) issue(c, "MCP registration abandonment identity differs.");
});
export const connectorNativeMcpRegistrationPreparationAvailableReadSchema = z.object({ preparation: connectorNativeMcpRegistrationPreparationSchema,
  availability: z.enum(["ready", "expired"]), consumedBy: z.null(), consumedKeySha256: z.null() }).strict();
export const connectorNativeMcpRegistrationPreparationConsumedReadSchema = z.object({ preparation: connectorNativeMcpRegistrationPreparationSchema,
  availability: z.literal("consumed"), consumedBy: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/), consumedKeySha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  if (v.consumedBy !== connectorNativeAcceptanceId(v.preparation.scope, v.consumedKeySha256)) issue(c, "MCP registration recovery key differs.");
});
export const connectorNativeMcpRegistrationPreparationAbandonedReadSchema = z.object({ intent: connectorNativeMcpRegistrationPreparationIntentSchema,
  preparation: connectorNativeMcpRegistrationPreparationSchema.nullable(), availability: z.literal("abandoned"),
  consumedBy: z.null(), consumedKeySha256: z.null(), abandonment: connectorNativeMcpRegistrationPreparationAbandonmentSchema,
}).strict().superRefine((v, c) => {
  const a = v.abandonment, i = v.intent, p = v.preparation;
  if (!same(a.scope, i.scope) || a.keySha256 !== i.keySha256 || a.intentSha256 !== canonicalJsonSha256(i) ||
    a.preparationSha256 !== (p?.preparationSha256 ?? null) || p && (!same(mcpRegistrationPreparationIntentFromProof(p), i) || Date.parse(a.abandonedAt) < Date.parse(p.preparedAt))) {
    issue(c, "MCP registration abandonment does not bind its original preparation.");
  }
});
export const connectorNativeMcpRegistrationPreparationPreparedReadSchema = z.union([
  connectorNativeMcpRegistrationPreparationAvailableReadSchema, connectorNativeMcpRegistrationPreparationConsumedReadSchema,
]);
export const connectorNativeMcpRegistrationPreparationReadSchema = z.union([
  connectorNativeMcpRegistrationPreparationPreparedReadSchema, connectorNativeMcpRegistrationPreparationAbandonedReadSchema,
]);
export const connectorNativeMcpRegistrationRequestSchema = z.object({
  ...connectorNativePreparedRequestSchema.shape, kind: z.literal("mcp"), connectorId: target, action: z.literal("register_mcp"), review: z.null(),
}).strict();
export const connectorNativeMcpRegistrationIntentSchema = z.object({ contract: z.literal("asael-connector-action-intent:1"), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, request: connectorNativeMcpRegistrationRequestSchema }).strict();
export const connectorNativeMcpRegistrationAcceptanceSchema = z.object({ ...connectorNativeFutureAcceptanceSchema.shape,
  kind: z.literal("mcp"), connectorId: target, action: z.literal("register_mcp"),
}).strict().superRefine((v, c) => {
  if (!connectorNativeFutureAcceptanceSchema.safeParse(v).success) issue(c, "MCP registration acceptance identity differs.");
});
export const connectorNativeMcpRegistrationSettlementSchema = z.object({ ...connectorNativeExtendedSettlementSchema.shape,
  result: z.object({ ...connectorNativeExtendedSettlementSchema.shape.result.shape, kind: z.literal("mcp"), connectorId: target,
    operation: z.literal("register_mcp"), status: z.literal("complete"), connectorStatus: z.literal("disabled"), contractCount: z.literal(0),
    credentialVersion: z.union([z.literal(0), z.literal(1)]), connectorSha256: connectorNativeShaSchema, contractsSha256: connectorNativeShaSchema,
    configurationSha256: connectorNativeShaSchema, trash: z.null(), failureCode: z.null() }).strict(),
}).strict().superRefine((v, c) => {
  if (!connectorNativeExtendedSettlementSchema.safeParse(v).success || v.result.contractsSha256 !== canonicalJsonSha256([])) issue(c, "MCP registration receipt is not disabled local creation.");
});
export const connectorNativeMcpRegistrationActionSchema = z.object({ acceptance: connectorNativeMcpRegistrationAcceptanceSchema,
  state: z.enum(["accepted", "settled"]), settlement: connectorNativeMcpRegistrationSettlementSchema.nullable(),
}).strict().superRefine((v, c) => {
  if (!connectorNativeFutureActionSchema.safeParse(v).success) issue(c, "MCP registration settlement does not bind its acceptance.");
});
export function buildConnectorNativeMcpRegistrationIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeMcpRegistrationRequest) {
  return connectorNativeMcpRegistrationIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope, keySha256: connectorNativeKeySha256(scope, key), request });
}

export type ConnectorNativeMcpRegistrationPrepareRequest = z.infer<typeof connectorNativeMcpRegistrationPrepareRequestSchema>;
export type ConnectorNativeMcpRegistrationPreparationIntent = z.infer<typeof connectorNativeMcpRegistrationPreparationIntentSchema>;
export type ConnectorNativeMcpRegistrationPreparation = z.infer<typeof connectorNativeMcpRegistrationPreparationSchema>;
export type ConnectorNativeMcpRegistrationPreparationRead = z.infer<typeof connectorNativeMcpRegistrationPreparationReadSchema>;
export type ConnectorNativeMcpRegistrationPreparationPreparedRead = z.infer<typeof connectorNativeMcpRegistrationPreparationPreparedReadSchema>;
export type ConnectorNativeMcpRegistrationPreparationAbandonedRead = z.infer<typeof connectorNativeMcpRegistrationPreparationAbandonedReadSchema>;
export type ConnectorNativeMcpRegistrationPreparationAbandonRequest = z.infer<typeof connectorNativeMcpRegistrationPreparationAbandonRequestSchema>;
export type ConnectorNativeMcpRegistrationRequest = z.infer<typeof connectorNativeMcpRegistrationRequestSchema>;
export type ConnectorNativeMcpRegistrationIntent = z.infer<typeof connectorNativeMcpRegistrationIntentSchema>;
export type ConnectorNativeMcpRegistrationAction = z.infer<typeof connectorNativeMcpRegistrationActionSchema>;
