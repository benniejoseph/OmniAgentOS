import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId, connectorNativeExtendedSettlementSchema, connectorNativeFutureAcceptanceSchema,
  connectorNativeFutureActionSchema, connectorNativeKeySha256, connectorNativePinSchema, connectorNativePreparationIntentSchema,
  connectorNativePreparationSchema, connectorNativePrepareRequestSchema, connectorNativePreparedRequestSchema,
  connectorNativeScopeSchema, connectorNativeShaSchema, type ConnectorNativeReview, type ConnectorNativeScope } from "./native-control-contracts";

export const NATIVE_CREDENTIAL_PREPARATION_TTL_MS = 900_000;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const review = connectorNativePinSchema.refine((v) => v.kind === "mcp" && v.credentialVersion < 2147483647,
  "An exact MCP credential version below the ceiling is required.");
const rotationFields = { operation: z.literal("rotate_mcp"), review };

export const connectorNativeCredentialPreparationIntentSchema = z.object({
  ...connectorNativePreparationIntentSchema.shape, ...rotationFields,
}).strict().superRefine((value, context) => {
  if (!connectorNativePreparationIntentSchema.safeParse(value).success || Buffer.byteLength(JSON.stringify(value), "utf8") > 16384) {
    issue(context, "The safe credential preparation intent is inconsistent.");
  }
});
export const connectorNativeCredentialPrepareRequestSchema = z.object({
  ...connectorNativePrepareRequestSchema.shape, ...rotationFields,
  payload: z.object({ endpoint: z.null(), specUrl: z.null(), specText: z.null(), bearerToken: z.string().min(1).max(8192)
    .refine((v) => Buffer.byteLength(v, "utf8") >= 8 && Buffer.byteLength(v, "utf8") <= 8192 && v.trim() === v && !/[\r\n]/.test(v),
      "A bounded bearer credential is required.") }).strict(),
}).strict().superRefine((value, context) => {
  // The dormant prototype counts characters; this enrolled path counts UTF-8 bytes.
  if (!connectorNativePrepareRequestSchema.safeParse({ ...value, payload: { ...value.payload, bearerToken: "shape-only-placeholder" } }).success) {
    issue(context, "The credential preparation declaration is inconsistent.");
  }
});

export function buildConnectorNativeCredentialPreparationIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeCredentialPrepareRequest) {
  const { contract: _contract, payload: _payload, ...safe } = connectorNativeCredentialPrepareRequestSchema.parse(request);
  return connectorNativeCredentialPreparationIntentSchema.parse({ contract: "asael-connector-preparation-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), ...safe });
}
export function credentialPreparationIntentFromProof(value: z.infer<typeof connectorNativePreparationSchema>) {
  return connectorNativeCredentialPreparationIntentSchema.parse({ contract: "asael-connector-preparation-intent:1", scope: value.scope,
    keySha256: value.keySha256, nonce: value.nonce, operation: value.operation, connectorId: value.connectorId,
    review: value.review, declaration: value.declaration });
}
export const connectorNativeCredentialPreparationSchema = z.object({
  ...connectorNativePreparationSchema.shape, ...rotationFields,
}).strict().superRefine((value, context) => {
  const intent = connectorNativeCredentialPreparationIntentSchema.safeParse({ contract: "asael-connector-preparation-intent:1", scope: value.scope,
    keySha256: value.keySha256, nonce: value.nonce, operation: value.operation, connectorId: value.connectorId,
    review: value.review, declaration: value.declaration });
  if (!connectorNativePreparationSchema.safeParse(value).success ||
    Date.parse(value.expiresAt) - Date.parse(value.preparedAt) !== NATIVE_CREDENTIAL_PREPARATION_TTL_MS ||
    value.configurationSha256 !== value.review.configurationSha256 ||
    !intent.success || value.intentSha256 !== canonicalJsonSha256(intent.data)) {
    issue(context, "The credential preparation proof differs from its original intent.");
  }
});
export const connectorNativeCredentialPreparationAbandonRequestSchema = z.object({
  contract: z.literal("asael-connector-credential-preparation-abandon:1"), intent: connectorNativeCredentialPreparationIntentSchema,
}).strict();
export function connectorNativeCredentialPreparationAbandonmentId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-preparation-abandonment:${canonicalJsonSha256({ scope, keySha256 })}`;
}
export const connectorNativeCredentialPreparationAbandonmentSchema = z.object({
  contract: z.literal("asael-connector-credential-preparation-abandonment:1"),
  id: z.string().regex(/^connector-preparation-abandonment:[a-f0-9]{64}$/), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, intentSha256: connectorNativeShaSchema, preparationSha256: connectorNativeShaSchema.nullable(),
  abandonedAt: connectorNativePreparationSchema.shape.preparedAt, abandonmentSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { abandonmentSha256, ...body } = value;
  if (abandonmentSha256 !== canonicalJsonSha256(body) || value.id !== connectorNativeCredentialPreparationAbandonmentId(value.scope, value.keySha256)) {
    issue(context, "The credential preparation abandonment identity differs.");
  }
});
export const connectorNativeCredentialPreparationAvailableReadSchema = z.object({
  preparation: connectorNativeCredentialPreparationSchema, availability: z.enum(["ready", "expired"]),
  consumedBy: z.null(), consumedKeySha256: z.null(),
}).strict();
export const connectorNativeCredentialPreparationConsumedReadSchema = z.object({
  preparation: connectorNativeCredentialPreparationSchema, availability: z.literal("consumed"),
  consumedBy: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/), consumedKeySha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  if (value.consumedBy !== connectorNativeAcceptanceId(value.preparation.scope, value.consumedKeySha256)) {
    issue(context, "The preparation consumption recovery key differs.");
  }
});
export const connectorNativeCredentialPreparationAbandonedReadSchema = z.object({
  intent: connectorNativeCredentialPreparationIntentSchema, preparation: connectorNativeCredentialPreparationSchema.nullable(),
  availability: z.literal("abandoned"), consumedBy: z.null(), consumedKeySha256: z.null(),
  abandonment: connectorNativeCredentialPreparationAbandonmentSchema,
}).strict().superRefine((value, context) => {
  const a = value.abandonment, i = value.intent, p = value.preparation;
  if (!same(a.scope, i.scope) || a.keySha256 !== i.keySha256 || a.intentSha256 !== canonicalJsonSha256(i) ||
    a.preparationSha256 !== (p?.preparationSha256 ?? null) || p && (!same(credentialPreparationIntentFromProof(p), i) ||
      Date.parse(a.abandonedAt) < Date.parse(p.preparedAt))) issue(context, "The abandonment does not bind the original preparation.");
});
export const connectorNativeCredentialPreparationPreparedReadSchema = z.union([
  connectorNativeCredentialPreparationAvailableReadSchema, connectorNativeCredentialPreparationConsumedReadSchema,
]);
export const connectorNativeCredentialPreparationReadSchema = z.union([
  connectorNativeCredentialPreparationPreparedReadSchema, connectorNativeCredentialPreparationAbandonedReadSchema,
]);

export const connectorNativeCredentialRotationRequestSchema = z.object({
  ...connectorNativePreparedRequestSchema.shape, kind: z.literal("mcp"), action: z.literal("rotate_mcp"), review,
}).strict().superRefine((value, context) => {
  if (!connectorNativePreparedRequestSchema.safeParse(value).success) issue(context, "Credential rotation must bind one reviewed preparation.");
});
export const connectorNativeCredentialRotationIntentSchema = z.object({ contract: z.literal("asael-connector-action-intent:1"),
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, request: connectorNativeCredentialRotationRequestSchema }).strict();
export const connectorNativeCredentialRotationAcceptanceSchema = z.object({
  ...connectorNativeFutureAcceptanceSchema.shape, kind: z.literal("mcp"), action: z.literal("rotate_mcp"),
}).strict().superRefine((value, context) => {
  if (!connectorNativeFutureAcceptanceSchema.safeParse(value).success) issue(context, "Credential rotation acceptance identity differs.");
});
export const connectorNativeCredentialRotationSettlementSchema = z.object({
  ...connectorNativeExtendedSettlementSchema.shape,
  result: z.object({ ...connectorNativeExtendedSettlementSchema.shape.result.shape, kind: z.literal("mcp"), operation: z.literal("rotate_mcp"),
    status: z.literal("complete"), connectorStatus: z.literal("disabled"), contractCount: z.literal(0),
    credentialVersion: z.number().int().min(1).max(2147483647), connectorSha256: connectorNativeShaSchema,
    contractsSha256: connectorNativeShaSchema, configurationSha256: connectorNativeShaSchema, trash: z.null(), failureCode: z.null() }).strict(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeExtendedSettlementSchema.safeParse(value).success || value.result.contractsSha256 !== canonicalJsonSha256([])) {
    issue(context, "Credential rotation settlement differs from disabled local credential save.");
  }
});
export const connectorNativeCredentialRotationActionSchema = z.object({ acceptance: connectorNativeCredentialRotationAcceptanceSchema,
  state: z.enum(["accepted", "settled"]), settlement: connectorNativeCredentialRotationSettlementSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeFutureActionSchema.safeParse(value).success) issue(context, "Credential rotation settlement does not bind its acceptance.");
});
export function buildConnectorNativeCredentialRotationIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeCredentialRotationRequest) {
  return connectorNativeCredentialRotationIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), request });
}
export function canPrepareNativeConnectorCredential(value: ConnectorNativeReview) {
  return value.unavailableReason === null && value.pin !== null && value.connector.kind === "mcp" &&
    value.connector.credentialVersion < 2147483647 && (value.connector.authType === "bearer_vault" ||
      value.connector.authType === "none" && !value.connector.credentialConfigured);
}
export function nativeCredentialPreparationDeclaration(value: ConnectorNativeReview) {
  const c = value.connector;
  return { name: c.name, endpoint: c.endpoint, endpointRedacted: c.endpointRedacted, authType: "bearer_vault" as const,
    authTokenEnv: null, authHeaderName: null, defaultRiskLevel: c.defaultRiskLevel, approvalRequired: c.approvalRequired,
    specSource: "none" as const, specUrl: null, specUrlRedacted: false };
}

export type ConnectorNativeCredentialPrepareRequest = z.infer<typeof connectorNativeCredentialPrepareRequestSchema>;
export type ConnectorNativeCredentialPreparationIntent = z.infer<typeof connectorNativeCredentialPreparationIntentSchema>;
export type ConnectorNativeCredentialPreparation = z.infer<typeof connectorNativeCredentialPreparationSchema>;
export type ConnectorNativeCredentialPreparationRead = z.infer<typeof connectorNativeCredentialPreparationReadSchema>;
export type ConnectorNativeCredentialPreparationPreparedRead = z.infer<typeof connectorNativeCredentialPreparationPreparedReadSchema>;
export type ConnectorNativeCredentialPreparationAbandonedRead = z.infer<typeof connectorNativeCredentialPreparationAbandonedReadSchema>;
export type ConnectorNativeCredentialPreparationAbandonRequest = z.infer<typeof connectorNativeCredentialPreparationAbandonRequestSchema>;
export type ConnectorNativeCredentialRotationRequest = z.infer<typeof connectorNativeCredentialRotationRequestSchema>;
export type ConnectorNativeCredentialRotationIntent = z.infer<typeof connectorNativeCredentialRotationIntentSchema>;
export type ConnectorNativeCredentialRotationAction = z.infer<typeof connectorNativeCredentialRotationActionSchema>;
export type ConnectorNativeCredentialRotationSettlement = z.infer<typeof connectorNativeCredentialRotationSettlementSchema>;
