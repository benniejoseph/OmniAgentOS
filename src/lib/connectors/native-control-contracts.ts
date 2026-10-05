import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { trashActionPreviewV1Schema } from "@/lib/trash/contracts";

export const CONNECTOR_NATIVE_READ_CONTRACT = "asael-connector-control-read:1" as const;
export const connectorNativeShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const connectorNativeKindSchema = z.enum(["mcp", "openapi"]);
export const connectorNativeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$/);
export const connectorNativeScopeSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  ownerActorId: z.string().min(1).max(320).refine((v) => v.trim() === v),
  canonicalActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
}).strict();
const risk = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const fingerprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const instant = z.string().datetime();
const count = z.number().int().min(0).max(2147483647);
export const connectorNativeSummarySchema = z.object({
  kind: connectorNativeKindSchema, id: connectorNativeIdSchema, name: z.string().min(1).max(120),
  endpoint: z.string().url().max(2048).refine((v) => { try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }),
  endpointRedacted: z.boolean(), status: z.enum(["active", "disabled", "error"]),
  authType: z.enum(["none", "bearer_env", "bearer_vault", "api_key_header_env"]),
  authTokenEnv: z.string().max(120).nullable(), authHeaderName: z.string().max(120).nullable(),
  credentialConfigured: z.boolean(), credentialVersion: count, credentialOriginMatch: z.boolean(),
  defaultRiskLevel: risk, approvalRequired: z.boolean(), contractCount: count,
  discoveredAt: instant.nullable(), updatedAt: instant,
}).strict();
export const connectorNativeContractSchema = z.object({
  id: z.string().min(1).max(1000), name: z.string().min(1).max(500),
  description: z.string().max(16000).nullable(), status: z.enum(["active", "disabled", "pending_review"]),
  riskLevel: risk, approvalRequired: z.boolean(), fingerprint,
  definition: z.record(z.string(), z.unknown()),
}).strict();
const pinBody = z.object({ kind: connectorNativeKindSchema, connectorId: connectorNativeIdSchema,
  connectorSha256: connectorNativeShaSchema, contractsSha256: connectorNativeShaSchema, configurationSha256: connectorNativeShaSchema,
  reviewFingerprint: fingerprint.nullable(), credentialVersion: count }).strict();
export const connectorNativePinSchema = pinBody.extend({ reviewSha256: connectorNativeShaSchema }).strict().superRefine((v, c) => {
  const { reviewSha256, ...body } = v;
  if (reviewSha256 !== canonicalJsonSha256(body)) c.addIssue({ code: "custom", message: "Connector review digest differs." });
});
export const connectorNativeStateActionNameSchema = z.enum(["review_contracts", "enable", "disable"]);
export const connectorNativeActionNameSchema = connectorNativeStateActionNameSchema;
// Preserved preparation work for a later release. These shapes are not enrolled
// by237 or published as an executable native operation.
export const connectorNativeLifecycleActionNameSchema = z.enum(["discover", "upgrade_github", "remove_credential", "trash"]);
export const connectorNativePreparationOperationSchema = z.enum(["register_mcp", "rotate_mcp", "import_openapi"]);
export const connectorNativeFutureActionNameSchema = z.union([connectorNativeStateActionNameSchema, connectorNativeLifecycleActionNameSchema, connectorNativePreparationOperationSchema]);
export const connectorNativeReviewSchema = z.object({
  connector: connectorNativeSummarySchema, contracts: z.array(connectorNativeContractSchema).max(200),
  pin: connectorNativePinSchema.nullable(), availableActions: z.array(connectorNativeStateActionNameSchema).max(3),
  unavailableReason: z.enum(["scope_too_large", "unsupported_connector"]).nullable(),
}).strict().superRefine((v, c) => {
  if (new Set(v.availableActions).size !== v.availableActions.length ||
    (v.availableActions.length > 0 && v.pin === null) ||
    (v.unavailableReason !== null && (v.pin !== null || v.availableActions.length !== 0)) ||
    (v.pin && (v.pin.kind !== v.connector.kind || v.pin.connectorId !== v.connector.id ||
      v.pin.credentialVersion !== v.connector.credentialVersion || v.pin.connectorSha256 !== canonicalJsonSha256(v.connector) ||
      v.pin.contractsSha256 !== canonicalJsonSha256(v.contracts))) ||
    (v.connector.kind === "openapi" && v.availableActions.some((action) => action !== "review_contracts"))) {
    c.addIssue({ code: "custom", message: "Connector review does not bind its complete current target." });
  }
});
export const connectorNativeRequestSchema = z.object({ contract: z.literal("asael-connector-action:1"), kind: connectorNativeKindSchema,
  connectorId: connectorNativeIdSchema, action: connectorNativeStateActionNameSchema, review: connectorNativePinSchema }).strict().superRefine((v, c) => {
  if (v.kind !== v.review.kind || v.connectorId !== v.review.connectorId || v.kind === "openapi" && v.action !== "review_contracts") {
    c.addIssue({ code: "custom", message: "Connector action and reviewed target differ." });
  }
});
export const connectorNativeLifecycleRequestSchema = z.object({ contract: z.literal("asael-connector-lifecycle-action:1"), kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema, action: connectorNativeLifecycleActionNameSchema, review: connectorNativePinSchema,
  preview: trashActionPreviewV1Schema.nullable() }).strict().superRefine((v, c) => {
  if (v.review.kind !== v.kind || v.review.connectorId !== v.connectorId || (v.action === "trash") !== Boolean(v.preview) ||
    v.preview && (v.preview.resourceType !== "mcp_connector" || v.preview.resourceId !== v.connectorId || v.preview.action !== "trash" ||
      v.preview.targetSha256 !== canonicalJsonSha256(connectorNativeTrashTarget(v.review)))) c.addIssue({ code: "custom", message: "Lifecycle action does not bind its exact reviewed target." });
});
const preparationId = z.string().regex(/^connector-preparation:[a-f0-9]{64}$/);
const preparationNonce = z.string().uuid();
const safeEndpoint = connectorNativeSummarySchema.shape.endpoint.nullable();
export const connectorNativePreparationDeclarationSchema = z.object({ name: z.string().trim().min(1).max(120), endpoint: safeEndpoint,
  endpointRedacted: z.boolean(), authType: z.enum(["none", "bearer_env", "bearer_vault", "api_key_header_env"]),
  authTokenEnv: z.string().regex(/^[A-Z0-9_]{1,120}$/).nullable(), authHeaderName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/).nullable(),
  defaultRiskLevel: risk, approvalRequired: z.boolean(), specSource: z.enum(["none", "url", "text"]), specUrl: safeEndpoint, specUrlRedacted: z.boolean() }).strict();
const preparationFields = { nonce: preparationNonce, operation: connectorNativePreparationOperationSchema, connectorId: connectorNativeIdSchema,
  review: connectorNativePinSchema.nullable(), declaration: connectorNativePreparationDeclarationSchema };
function preparationShape(v: { operation: z.infer<typeof connectorNativePreparationOperationSchema>; connectorId: string;
  review: z.infer<typeof connectorNativePinSchema> | null; declaration: z.infer<typeof connectorNativePreparationDeclarationSchema> }, c: z.RefinementCtx) {
  const d = v.declaration, openapi = v.operation === "import_openapi", rotating = v.operation === "rotate_mcp";
  if (rotating !== Boolean(v.review) || v.review && (v.review.kind !== "mcp" || v.review.connectorId !== v.connectorId) ||
    (!openapi && (!d.endpoint || d.specSource !== "none" || d.specUrl !== null || d.specUrlRedacted || d.authType === "api_key_header_env")) ||
    (openapi && (d.authType === "bearer_vault" || d.specSource === "none")) || rotating && d.authType !== "bearer_vault" ||
    (d.authType === "bearer_env" || d.authType === "api_key_header_env") !== Boolean(d.authTokenEnv) ||
    (d.authType === "api_key_header_env") !== Boolean(d.authHeaderName) || (d.specSource === "url") !== Boolean(d.specUrl) ||
    d.specSource !== "url" && d.specUrlRedacted || d.endpoint === null && d.endpointRedacted) c.addIssue({ code: "custom", message: "Prepared connector declaration is inconsistent." });
}
export const connectorNativePreparationIntentSchema = z.object({ contract: z.literal("asael-connector-preparation-intent:1"), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, ...preparationFields }).strict().superRefine(preparationShape);
const transientUrl = z.string().url().max(2048).nullable();
export const connectorNativePrepareRequestSchema = z.object({ contract: z.literal("asael-connector-prepare:1"), ...preparationFields,
  payload: z.object({ endpoint: transientUrl, specUrl: transientUrl, specText: z.string().min(1).max(2_000_000).nullable(),
    bearerToken: z.string().min(8).max(8192).refine((v) => v.trim() === v && !/[\r\n]/.test(v)).nullable() }).strict() }).strict().superRefine((v, c) => {
  preparationShape(v, c);
  if ((v.declaration.authType === "bearer_vault") !== Boolean(v.payload.bearerToken) ||
    (v.declaration.specSource === "url") !== Boolean(v.payload.specUrl) || (v.declaration.specSource === "text") !== Boolean(v.payload.specText) ||
    (v.operation === "rotate_mcp" ? v.payload.endpoint !== null : Boolean(v.declaration.endpoint) !== Boolean(v.payload.endpoint))) {
    c.addIssue({ code: "custom", message: "Transient connector payload does not match its safe declaration." });
  }
});
export const connectorNativePreparationSchema = z.object({ contract: z.literal("asael-connector-preparation:1"), id: preparationId,
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, intentSha256: connectorNativeShaSchema, ...preparationFields,
  configurationSha256: connectorNativeShaSchema, preparedAt: instant, expiresAt: instant, preparationSha256: connectorNativeShaSchema }).strict().superRefine((v, c) => {
  preparationShape(v, c);
  const { preparationSha256, ...body } = v;
  if (preparationSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativePreparationId(v.scope, v.keySha256) ||
    Date.parse(v.expiresAt) <= Date.parse(v.preparedAt) || Date.parse(v.expiresAt) - Date.parse(v.preparedAt) > 900_000) c.addIssue({ code: "custom", message: "Prepared connector identity or expiry differs." });
});
export const connectorNativePreparationReadSchema = z.object({ preparation: connectorNativePreparationSchema,
  availability: z.enum(["ready", "expired", "consumed"]), consumedBy: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/).nullable() }).strict()
  .superRefine((v, c) => { if ((v.availability === "consumed") !== Boolean(v.consumedBy)) c.addIssue({ code: "custom", message: "Preparation consumption differs." }); });
export const connectorNativePreparedRequestSchema = z.object({ contract: z.literal("asael-connector-prepared-action:1"), kind: connectorNativeKindSchema,
  connectorId: connectorNativeIdSchema, action: connectorNativePreparationOperationSchema, preparationId, preparationSha256: connectorNativeShaSchema,
  review: connectorNativePinSchema.nullable() }).strict().superRefine((v, c) => {
  if ((v.action === "import_openapi") !== (v.kind === "openapi") || (v.action === "rotate_mcp") !== Boolean(v.review) ||
    v.review && (v.review.kind !== v.kind || v.review.connectorId !== v.connectorId)) c.addIssue({ code: "custom", message: "Prepared action target differs." });
});
export const connectorNativeAnyRequestSchema = z.union([connectorNativeRequestSchema, connectorNativeLifecycleRequestSchema, connectorNativePreparedRequestSchema]);
export const connectorNativeIntentSchema = z.object({ contract: z.literal("asael-connector-action-intent:1"), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, request: connectorNativeRequestSchema }).strict();
export const connectorNativeFutureIntentSchema = z.object({ contract: z.literal("asael-connector-action-intent:1"), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, request: connectorNativeAnyRequestSchema }).strict();
export const connectorNativeAcceptanceSchema = z.object({ contract: z.literal("asael-connector-acceptance:1"),
  id: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, requestSha256: connectorNativeShaSchema, kind: connectorNativeKindSchema,
  connectorId: connectorNativeIdSchema, action: connectorNativeActionNameSchema, reviewSha256: connectorNativeShaSchema,
  acceptedAt: instant, acceptanceSha256: connectorNativeShaSchema }).strict().superRefine((v, c) => {
  const { acceptanceSha256, ...body } = v;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeAcceptanceId(v.scope, v.keySha256)) {
    c.addIssue({ code: "custom", message: "Connector acceptance identity differs." });
  }
});
export const connectorNativeStateSettlementSchema = z.object({ contract: z.literal("asael-connector-settlement:1"),
  acceptanceId: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/), settledAt: instant,
  result: z.object({ kind: connectorNativeKindSchema, connectorId: connectorNativeIdSchema,
    status: z.enum(["active", "disabled", "error"]), contractCount: count.max(200), promotedCount: count.max(200),
    connectorSha256: connectorNativeShaSchema, contractsSha256: connectorNativeShaSchema }).strict(),
  settlementSha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  const { settlementSha256, ...body } = v;
  if (settlementSha256 !== canonicalJsonSha256(body)) c.addIssue({ code: "custom", message: "Connector settlement digest differs." });
});
export const connectorNativeExtendedSettlementSchema = z.object({ contract: z.literal("asael-connector-settlement:2"),
  acceptanceId: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/), settledAt: instant,
  result: z.object({ kind: connectorNativeKindSchema, connectorId: connectorNativeIdSchema,
    operation: z.union([connectorNativeLifecycleActionNameSchema, connectorNativePreparationOperationSchema]),
    status: z.enum(["complete", "failed"]), connectorStatus: z.enum(["active", "disabled", "error"]).nullable(),
    contractCount: count.max(200).nullable(), credentialVersion: count.nullable(), connectorSha256: connectorNativeShaSchema.nullable(),
    contractsSha256: connectorNativeShaSchema.nullable(), configurationSha256: connectorNativeShaSchema.nullable(),
    trash: z.object({ trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/), proofSha256: connectorNativeShaSchema,
      restoreUntil: instant, compensation: z.enum(["exact_restore", "equivalent_action", "unavailable"]), limitation: z.string().max(500).nullable() }).strict().nullable(),
    failureCode: z.enum(["discovery_failed", "import_failed", "target_changed"]).nullable() }).strict(), settlementSha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  const { settlementSha256, ...body } = v, r = v.result;
  if (settlementSha256 !== canonicalJsonSha256(body) || (r.status === "failed") !== Boolean(r.failureCode) ||
    (r.operation === "trash" && r.status === "complete") !== Boolean(r.trash) || r.status === "complete" && r.operation !== "trash" &&
    (!r.connectorStatus || r.contractCount === null || r.credentialVersion === null || !r.connectorSha256 || !r.contractsSha256 || !r.configurationSha256)) {
    c.addIssue({ code: "custom", message: "Extended connector settlement evidence differs." });
  }
});
export const connectorNativeFutureSettlementSchema = z.union([connectorNativeStateSettlementSchema, connectorNativeExtendedSettlementSchema]);
export const connectorNativeSettlementSchema = connectorNativeStateSettlementSchema;
export const connectorNativeActionSchema = z.object({ acceptance: connectorNativeAcceptanceSchema,
  state: z.enum(["accepted", "settled"]), settlement: connectorNativeSettlementSchema.nullable() }).strict().superRefine((v, c) => {
  if ((v.state === "settled") !== (v.settlement !== null) || v.settlement &&
    (v.settlement.acceptanceId !== v.acceptance.id || v.settlement.result.kind !== v.acceptance.kind ||
      v.settlement.result.connectorId !== v.acceptance.connectorId || Date.parse(v.settlement.settledAt) < Date.parse(v.acceptance.acceptedAt))) {
    c.addIssue({ code: "custom", message: "Connector action settlement belongs to another acceptance." });
  }
});
export const connectorNativeFutureAcceptanceSchema = z.object({ ...connectorNativeAcceptanceSchema.shape,
  action: connectorNativeFutureActionNameSchema }).strict().superRefine((v, c) => {
  const { acceptanceSha256, ...body } = v;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeAcceptanceId(v.scope, v.keySha256)) {
    c.addIssue({ code: "custom", message: "Connector acceptance identity differs." });
  }
});
export const connectorNativeFutureActionSchema = z.object({ acceptance: connectorNativeFutureAcceptanceSchema,
  state: z.enum(["accepted", "settled"]), settlement: connectorNativeFutureSettlementSchema.nullable() }).strict().superRefine((v, c) => {
  if ((v.state === "settled") !== (v.settlement !== null) || v.settlement &&
    (v.settlement.acceptanceId !== v.acceptance.id || v.settlement.result.kind !== v.acceptance.kind ||
      v.settlement.result.connectorId !== v.acceptance.connectorId || Date.parse(v.settlement.settledAt) < Date.parse(v.acceptance.acceptedAt))) {
    c.addIssue({ code: "custom", message: "Connector action settlement belongs to another acceptance." });
  }
  if (v.settlement && (v.settlement.contract === "asael-connector-settlement:2"
    ? v.settlement.result.operation !== v.acceptance.action : !connectorNativeStateActionNameSchema.safeParse(v.acceptance.action).success)) {
    c.addIssue({ code: "custom", message: "Settlement operation differs." });
  }
});
export type ConnectorNativeScope = z.infer<typeof connectorNativeScopeSchema>;
export type ConnectorNativeKind = z.infer<typeof connectorNativeKindSchema>;
export type ConnectorNativeRequest = z.infer<typeof connectorNativeRequestSchema>;
export type ConnectorNativeAnyRequest = z.infer<typeof connectorNativeAnyRequestSchema>;
export type ConnectorNativeLifecycleRequest = z.infer<typeof connectorNativeLifecycleRequestSchema>;
export type ConnectorNativePreparedRequest = z.infer<typeof connectorNativePreparedRequestSchema>;
export type ConnectorNativePrepareRequest = z.infer<typeof connectorNativePrepareRequestSchema>;
export type ConnectorNativePreparationIntent = z.infer<typeof connectorNativePreparationIntentSchema>;
export type ConnectorNativeIntent = z.infer<typeof connectorNativeIntentSchema>;
export type ConnectorNativeReview = z.infer<typeof connectorNativeReviewSchema>;
export type ConnectorNativeAction = z.infer<typeof connectorNativeActionSchema>;
export function connectorNativeKeySha256(scope: ConnectorNativeScope, key: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(key)) throw new NativeConnectorError("connector_key", 400, "An exact connector action key is required.");
  return createHash("sha256").update(`${scope.tenantId}\0${key}`).digest("hex");
}
export function connectorNativeAcceptanceId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-acceptance:${canonicalJsonSha256({ scope, keySha256 })}`;
}
export function buildConnectorNativeIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeRequest) {
  return connectorNativeIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope, keySha256: connectorNativeKeySha256(scope, key), request });
}
export function buildConnectorNativeFutureIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeAnyRequest) {
  return connectorNativeFutureIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope, keySha256: connectorNativeKeySha256(scope, key), request });
}
export function connectorNativeRequestReviewSha(request: ConnectorNativeAnyRequest) {
  return request.contract === "asael-connector-prepared-action:1" ? request.preparationSha256 : request.review.reviewSha256;
}
export function connectorNativeTrashTarget(pin: z.infer<typeof connectorNativePinSchema>) {
  return { kind: pin.kind, connectorId: pin.connectorId, reviewSha256: pin.reviewSha256 };
}
export function connectorNativePreparationId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-preparation:${canonicalJsonSha256({ scope, keySha256 })}`;
}
export function connectorNativeNewTargetId(scope: ConnectorNativeScope, nonce: string) {
  return `native-connector:${canonicalJsonSha256({ scope, nonce })}`;
}
export function buildConnectorNativePreparationIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativePrepareRequest) {
  const { payload: _payload, contract: _contract, ...safe } = connectorNativePrepareRequestSchema.parse(request);
  return connectorNativePreparationIntentSchema.parse({ contract: "asael-connector-preparation-intent:1", scope, keySha256: connectorNativeKeySha256(scope, key), ...safe });
}
export function sealConnectorNativePin(input: z.input<typeof pinBody>) {
  const body = pinBody.parse(input); return connectorNativePinSchema.parse({ ...body, reviewSha256: canonicalJsonSha256(body) });
}
export class NativeConnectorError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); this.name = "NativeConnectorError"; }
}
