import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId, connectorNativeAcceptanceSchema, connectorNativeExtendedSettlementSchema,
  connectorNativeKeySha256, connectorNativePreparationDeclarationSchema, connectorNativePreparedRequestSchema,
  connectorNativeScopeSchema, connectorNativeShaSchema, type ConnectorNativeScope } from "./native-control-contracts";

export const NATIVE_OPENAPI_IMPORT_ATTEMPT_MS = 45_000;
export const NATIVE_OPENAPI_IMPORT_PREPARATION_TTL_MS = 900_000;
export const NATIVE_OPENAPI_IMPORT_SOURCE_MAX_BYTES = 2_000_000;
export const NATIVE_OPENAPI_IMPORT_SNAPSHOT_MAX_BYTES = 4_000_000;
export const NATIVE_OPENAPI_IMPORT_SUMMARY_MAX_BYTES = 262_144;
export const NATIVE_OPENAPI_IMPORT_REVIEW_MAX_BYTES = 1_048_576;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const target = z.string().regex(/^native-openapi-[a-f0-9]{64}$/);
const instant = z.string().datetime();
const risk = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const identity = (scope: ConnectorNativeScope, keySha256: string) => canonicalJsonSha256({ operation: "import_openapi", scope, keySha256 });

export function connectorNativeOpenapiImportTargetId(scope: ConnectorNativeScope, nonce: string) {
  return `native-openapi-${canonicalJsonSha256({ scope, nonce })}`;
}
export function connectorNativeOpenapiImportAttemptId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-openapi-import-attempt:${identity(scope, keySha256)}`;
}
export function connectorNativeOpenapiImportPreparationId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-preparation:${identity(scope, keySha256)}`;
}
export function connectorNativeOpenapiImportAbandonmentId(scope: ConnectorNativeScope, keySha256: string) {
  return `connector-preparation-abandonment:${identity(scope, keySha256)}`;
}

/** Full source URLs are transient; their public projection never keeps query/fragment. */
export function normalizeNativeOpenapiImportSourceUrl(input: string) {
  if (!input || input.length > 2048 || input.trim() !== input || /[\u0000-\u0020\u007f]/.test(input)) throw new Error("Invalid OpenAPI source URL.");
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid OpenAPI source URL.");
  const normalized = url.toString();
  if (normalized.length > 2048) throw new Error("Invalid OpenAPI source URL.");
  return normalized;
}
export function nativeOpenapiImportSourceProjection(input: string) {
  const normalized = normalizeNativeOpenapiImportSourceUrl(input), url = new URL(normalized);
  url.search = "";
  url.hash = "";
  const specUrl = url.toString();
  return { specUrl, specUrlRedacted: specUrl !== normalized };
}
export function normalizeNativeOpenapiImportBaseUrl(input: string) {
  if (/[?#]/.test(input)) throw new Error("OpenAPI base URL cannot contain query or fragment delimiters.");
  return normalizeNativeOpenapiImportSourceUrl(input).replace(/\/$/, "");
}

/** Mirrors assertSafeCallerHeader plus its caller's bounded HTTP-token syntax. */
export function isNativeOpenapiImportHeaderAllowed(name: string) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name) &&
    !/^(authorization|cookie|host|connection|content-length|transfer-encoding|forwarded|proxy-|sec-|cf-connecting-ip|true-client-ip|x-(?:forwarded-|original-|rewrite-|http-method-override$|method-override$|real-ip$|client-ip$|vercel-))/i.test(name);
}
/** The existing importer path rules, additionally refusing unsupported URL delimiters. */
export function isNativeOpenapiImportPathAllowed(path: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  return path.length >= 1 && path.length <= 2048 && path.startsWith("/") && !path.startsWith("//") &&
    !/[?#\\\u0000-\u001f\u007f]/.test(path) && !/%5c|%25(?:2e|2f|5c)/i.test(path) &&
    !decoded.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(decoded) &&
    !decoded.split("/").some((part) => part === "." || part === "..");
}

export const connectorNativeOpenapiImportDeclarationSchema = z.object({
  ...connectorNativePreparationDeclarationSchema.shape,
  name: z.string().min(1).max(120).refine((v) => v.trim() === v), endpoint: z.string().max(2048).nullable(),
  endpointRedacted: z.literal(false), authType: z.enum(["none", "bearer_env", "api_key_header_env"]),
  specSource: z.enum(["url", "text"]),
}).strict().superRefine((v, c) => {
  if ((v.authType !== "none") !== (v.authTokenEnv !== null) || (v.authType === "api_key_header_env") !== (v.authHeaderName !== null) ||
    v.authHeaderName !== null && !isNativeOpenapiImportHeaderAllowed(v.authHeaderName) ||
    (v.specSource === "url") !== (v.specUrl !== null) || v.specSource === "text" && v.specUrlRedacted) {
    issue(c, "OpenAPI import declaration is inconsistent.");
  }
  try {
    if (v.endpoint !== null && normalizeNativeOpenapiImportBaseUrl(v.endpoint) !== v.endpoint ||
      v.specUrl !== null && nativeOpenapiImportSourceProjection(v.specUrl).specUrl !== v.specUrl) issue(c, "OpenAPI declaration URL is not normalized.");
  } catch { issue(c, "OpenAPI declaration URL is invalid."); }
});
export const connectorNativeOpenapiImportResolvedDeclarationSchema = z.object({
  ...connectorNativeOpenapiImportDeclarationSchema.shape, endpoint: z.string().min(1).max(2048),
}).strict().superRefine((v, c) => {
  if (!connectorNativeOpenapiImportDeclarationSchema.safeParse(v).success) issue(c, "Resolved OpenAPI declaration is invalid.");
});
const originalFields = { kind: z.literal("openapi"), nonce: z.string().uuid(), operation: z.literal("import_openapi"),
  connectorId: target, review: z.null(), declaration: connectorNativeOpenapiImportDeclarationSchema };
export const connectorNativeOpenapiImportPreparationIntentSchema = z.object({
  contract: z.literal("asael-openapi-import-preparation-intent:1"), scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema, ...originalFields,
}).strict().superRefine((v, c) => {
  if (v.connectorId !== connectorNativeOpenapiImportTargetId(v.scope, v.nonce) || Buffer.byteLength(JSON.stringify(v), "utf8") > 16_384) {
    issue(c, "OpenAPI import intent does not bind its derived target.");
  }
});
export const connectorNativeOpenapiImportPrepareRequestSchema = z.object({
  contract: z.literal("asael-openapi-import-prepare:1"), ...originalFields,
  payload: z.object({ endpoint: z.string().min(1).max(2048).nullable(), specUrl: z.string().min(1).max(2048).nullable(),
    specText: z.string().min(1).max(NATIVE_OPENAPI_IMPORT_SOURCE_MAX_BYTES).refine((v) => Buffer.byteLength(v, "utf8") <= NATIVE_OPENAPI_IMPORT_SOURCE_MAX_BYTES,
      "OpenAPI source exceeds the supported byte limit.").nullable() }).strict(),
}).strict().superRefine((v, c) => {
  if ((v.declaration.specSource === "url") !== (v.payload.specUrl !== null) ||
    (v.declaration.specSource === "text") !== (v.payload.specText !== null) ||
    (v.declaration.endpoint !== null) !== (v.payload.endpoint !== null)) issue(c, "OpenAPI payload differs from its original declaration.");
  try {
    if (v.payload.endpoint !== null && normalizeNativeOpenapiImportBaseUrl(v.payload.endpoint) !== v.declaration.endpoint) issue(c, "OpenAPI base differs from its declaration.");
    if (v.payload.specUrl !== null) {
      const projected = nativeOpenapiImportSourceProjection(v.payload.specUrl);
      if (projected.specUrl !== v.declaration.specUrl || projected.specUrlRedacted !== v.declaration.specUrlRedacted) issue(c, "OpenAPI source differs from its declaration.");
    }
  } catch { issue(c, "OpenAPI payload URL is invalid."); }
});
export function buildConnectorNativeOpenapiImportPreparationIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeOpenapiImportPrepareRequest) {
  const { contract: _contract, payload: _payload, ...safe } = connectorNativeOpenapiImportPrepareRequestSchema.parse(request);
  return connectorNativeOpenapiImportPreparationIntentSchema.parse({ contract: "asael-openapi-import-preparation-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), ...safe });
}
export const connectorNativeOpenapiImportAttemptSchema = z.object({
  contract: z.literal("asael-openapi-import-attempt:1"), id: z.string().regex(/^connector-openapi-import-attempt:[a-f0-9]{64}$/),
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, intentSha256: connectorNativeShaSchema,
  startedAt: instant, expiresAt: instant, attemptSha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  const { attemptSha256, ...body } = v;
  if (attemptSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeOpenapiImportAttemptId(v.scope, v.keySha256) ||
    Date.parse(v.expiresAt) - Date.parse(v.startedAt) !== NATIVE_OPENAPI_IMPORT_ATTEMPT_MS) issue(c, "OpenAPI attempt identity or deadline differs.");
});
export const connectorNativeOpenapiImportSummarySchema = z.object({
  contract: z.literal("asael-openapi-import-summary:1"), connectorId: target,
  operations: z.array(z.object({ id: z.string().min(1).max(1000), operationId: z.string().regex(/^[A-Za-z0-9_]{1,500}$/),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    path: z.string().min(1).max(2048).refine(isNativeOpenapiImportPathAllowed, "OpenAPI operation path is unsupported."),
    riskLevel: risk, approvalRequired: z.boolean(), definitionSha256: connectorNativeShaSchema }).strict()).min(1).max(200),
}).strict().superRefine((v, c) => {
  if (Buffer.byteLength(JSON.stringify(v), "utf8") > NATIVE_OPENAPI_IMPORT_SUMMARY_MAX_BYTES ||
    new Set(v.operations.map((op) => op.id)).size !== v.operations.length ||
    new Set(v.operations.map((op) => op.operationId)).size !== v.operations.length ||
    v.operations.some((op) => op.id !== `openapi:${v.connectorId}:${encodeURIComponent(op.operationId)}` ||
      !["GET", "HEAD", "OPTIONS"].includes(op.method) && op.riskLevel < 2)) issue(c, "OpenAPI summary is not a complete supported operation set.");
});
export function openapiImportPreparationIntentFromProof(value: ConnectorNativeOpenapiImportPreparation) {
  return connectorNativeOpenapiImportPreparationIntentSchema.parse({ contract: "asael-openapi-import-preparation-intent:1",
    scope: value.scope, keySha256: value.keySha256, kind: value.kind, nonce: value.nonce, operation: value.operation,
    connectorId: value.connectorId, review: value.review, declaration: value.declaration });
}
export const connectorNativeOpenapiImportPreparationSchema = z.object({
  contract: z.literal("asael-openapi-import-preparation:1"), id: z.string().regex(/^connector-preparation:[a-f0-9]{64}$/),
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, intentSha256: connectorNativeShaSchema, ...originalFields,
  resolvedDeclaration: connectorNativeOpenapiImportResolvedDeclarationSchema, attemptSha256: connectorNativeShaSchema,
  configurationSha256: connectorNativeShaSchema, snapshotSha256: connectorNativeShaSchema, summarySha256: connectorNativeShaSchema,
  reviewProjectionSha256: connectorNativeShaSchema, contractCount: z.number().int().min(1).max(200),
  preparedAt: instant, expiresAt: instant, preparationSha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  const { preparationSha256, ...body } = v;
  const intent = connectorNativeOpenapiImportPreparationIntentSchema.safeParse({ contract: "asael-openapi-import-preparation-intent:1",
    scope: v.scope, keySha256: v.keySha256, kind: v.kind, nonce: v.nonce, operation: v.operation, connectorId: v.connectorId, review: v.review, declaration: v.declaration });
  if (preparationSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeOpenapiImportPreparationId(v.scope, v.keySha256) ||
    Date.parse(v.expiresAt) - Date.parse(v.preparedAt) !== NATIVE_OPENAPI_IMPORT_PREPARATION_TTL_MS ||
    !intent.success || v.intentSha256 !== canonicalJsonSha256(intent.data) ||
    !same({ ...v.resolvedDeclaration, endpoint: v.declaration.endpoint }, v.declaration) ||
    v.declaration.endpoint !== null && v.resolvedDeclaration.endpoint !== v.declaration.endpoint) issue(c, "OpenAPI proof differs from its original declaration.");
});
export const connectorNativeOpenapiImportPreparationAbandonRequestSchema = z.object({
  contract: z.literal("asael-openapi-import-preparation-abandon:1"), intent: connectorNativeOpenapiImportPreparationIntentSchema,
}).strict();
export const connectorNativeOpenapiImportPreparationAbandonmentSchema = z.object({
  contract: z.literal("asael-openapi-import-preparation-abandonment:1"), id: z.string().regex(/^connector-preparation-abandonment:[a-f0-9]{64}$/),
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, intentSha256: connectorNativeShaSchema,
  attemptSha256: connectorNativeShaSchema.nullable(), preparationSha256: connectorNativeShaSchema.nullable(),
  abandonedAt: instant, abandonmentSha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  const { abandonmentSha256, ...body } = v;
  if (abandonmentSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeOpenapiImportAbandonmentId(v.scope, v.keySha256) ||
    v.preparationSha256 !== null && v.attemptSha256 === null) issue(c, "OpenAPI abandonment identity differs.");
});

const readFields = { intent: connectorNativeOpenapiImportPreparationIntentSchema, attempt: connectorNativeOpenapiImportAttemptSchema };
function correlateRead(v: { intent: ConnectorNativeOpenapiImportPreparationIntent; attempt: ConnectorNativeOpenapiImportAttempt | null;
  preparation?: ConnectorNativeOpenapiImportPreparation | null }, c: z.RefinementCtx) {
  const i = v.intent, a = v.attempt, p = v.preparation;
  if (a && (!same(a.scope, i.scope) || a.keySha256 !== i.keySha256 || a.intentSha256 !== canonicalJsonSha256(i)) ||
    p && (!a || !same(openapiImportPreparationIntentFromProof(p), i) || p.attemptSha256 !== a.attemptSha256 ||
      Date.parse(p.preparedAt) < Date.parse(a.startedAt) || Date.parse(p.preparedAt) >= Date.parse(a.expiresAt))) {
    issue(c, "OpenAPI preparation evidence belongs to another intent or attempt.");
  }
}
export const connectorNativeOpenapiImportPreparationPreparingReadSchema = z.object({
  availability: z.literal("preparing"), ...readFields,
}).strict().superRefine(correlateRead);
export const connectorNativeOpenapiImportPreparationReadyReadSchema = z.object({
  availability: z.literal("ready"), ...readFields, preparation: connectorNativeOpenapiImportPreparationSchema, summary: connectorNativeOpenapiImportSummarySchema,
}).strict().superRefine((v, c) => {
  correlateRead(v, c);
  if (v.summary.connectorId !== v.intent.connectorId || v.preparation.summarySha256 !== canonicalJsonSha256(v.summary) ||
    v.preparation.contractCount !== v.summary.operations.length || v.summary.operations.some((op) =>
      op.riskLevel < v.intent.declaration.defaultRiskLevel || v.intent.declaration.approvalRequired && !op.approvalRequired)) issue(c, "OpenAPI ready proof does not bind its complete safe summary.");
});
export const connectorNativeOpenapiImportPreparationExpiredReadSchema = z.object({
  availability: z.literal("expired"), ...readFields, preparation: connectorNativeOpenapiImportPreparationSchema.nullable(),
}).strict().superRefine(correlateRead);
export const connectorNativeOpenapiImportPreparationFailedReadSchema = z.object({
  availability: z.literal("failed"), ...readFields, failure: z.object({
    code: z.enum(["source_unavailable", "invalid_spec", "unsupported_spec", "scope_too_large", "admission_failed"]), failedAt: instant,
  }).strict(),
}).strict().superRefine((v, c) => {
  correlateRead(v, c);
  if (Date.parse(v.failure.failedAt) < Date.parse(v.attempt.startedAt) || Date.parse(v.failure.failedAt) > Date.parse(v.attempt.expiresAt)) issue(c, "OpenAPI failure is outside its original attempt.");
});
export const connectorNativeOpenapiImportPreparationConsumedReadSchema = z.object({
  availability: z.literal("consumed"), ...readFields, preparation: connectorNativeOpenapiImportPreparationSchema,
  consumedBy: z.string().regex(/^connector-acceptance:[a-f0-9]{64}$/), consumedKeySha256: connectorNativeShaSchema,
}).strict().superRefine((v, c) => {
  correlateRead(v, c);
  if (v.consumedBy !== connectorNativeAcceptanceId(v.intent.scope, v.consumedKeySha256)) issue(c, "OpenAPI consumed recovery key differs.");
});
export const connectorNativeOpenapiImportPreparationAbandonedReadSchema = z.object({
  availability: z.literal("abandoned"), intent: connectorNativeOpenapiImportPreparationIntentSchema,
  attempt: connectorNativeOpenapiImportAttemptSchema.nullable(), preparation: connectorNativeOpenapiImportPreparationSchema.nullable(),
  abandonment: connectorNativeOpenapiImportPreparationAbandonmentSchema,
}).strict().superRefine((v, c) => {
  correlateRead(v, c);
  const a = v.abandonment, i = v.intent;
  if (!same(a.scope, i.scope) || a.keySha256 !== i.keySha256 || a.intentSha256 !== canonicalJsonSha256(i) ||
    a.attemptSha256 !== (v.attempt?.attemptSha256 ?? null) || a.preparationSha256 !== (v.preparation?.preparationSha256 ?? null) ||
    v.attempt && Date.parse(a.abandonedAt) < Date.parse(v.attempt.startedAt) ||
    v.preparation && Date.parse(a.abandonedAt) < Date.parse(v.preparation.preparedAt)) issue(c, "OpenAPI abandonment differs from its original evidence.");
});
export const connectorNativeOpenapiImportPreparationReadSchema = z.union([
  connectorNativeOpenapiImportPreparationPreparingReadSchema, connectorNativeOpenapiImportPreparationReadyReadSchema,
  connectorNativeOpenapiImportPreparationExpiredReadSchema, connectorNativeOpenapiImportPreparationFailedReadSchema,
  connectorNativeOpenapiImportPreparationConsumedReadSchema, connectorNativeOpenapiImportPreparationAbandonedReadSchema,
]);
export const connectorNativeOpenapiImportRequestSchema = z.object({
  ...connectorNativePreparedRequestSchema.shape, kind: z.literal("openapi"), connectorId: target, action: z.literal("import_openapi"), review: z.null(),
}).strict();
export const connectorNativeOpenapiImportIntentSchema = z.object({ contract: z.literal("asael-connector-action-intent:1"),
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, request: connectorNativeOpenapiImportRequestSchema }).strict();
export const connectorNativeOpenapiImportAcceptanceSchema = z.object({ ...connectorNativeAcceptanceSchema.shape,
  kind: z.literal("openapi"), connectorId: target, action: z.literal("import_openapi"),
}).strict().superRefine((v, c) => {
  const { acceptanceSha256, ...body } = v;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || v.id !== connectorNativeAcceptanceId(v.scope, v.keySha256)) issue(c, "OpenAPI acceptance identity differs.");
});
export const connectorNativeOpenapiImportSettlementSchema = z.object({ ...connectorNativeExtendedSettlementSchema.shape,
  result: z.object({ ...connectorNativeExtendedSettlementSchema.shape.result.shape, kind: z.literal("openapi"), connectorId: target,
    operation: z.literal("import_openapi"), status: z.literal("complete"), connectorStatus: z.literal("disabled"),
    contractCount: z.number().int().min(1).max(200), credentialVersion: z.literal(0), connectorSha256: connectorNativeShaSchema,
    contractsSha256: connectorNativeShaSchema, configurationSha256: connectorNativeShaSchema, trash: z.null(), failureCode: z.null() }).strict(),
}).strict().superRefine((v, c) => {
  const { settlementSha256, ...body } = v;
  if (settlementSha256 !== canonicalJsonSha256(body)) issue(c, "OpenAPI settlement digest differs.");
});
export const connectorNativeOpenapiImportActionSchema = z.object({ acceptance: connectorNativeOpenapiImportAcceptanceSchema,
  state: z.enum(["accepted", "settled"]), settlement: connectorNativeOpenapiImportSettlementSchema.nullable(),
}).strict().superRefine((v, c) => {
  if ((v.state === "settled") !== (v.settlement !== null) || v.settlement && (v.settlement.acceptanceId !== v.acceptance.id ||
    v.settlement.result.connectorId !== v.acceptance.connectorId || Date.parse(v.settlement.settledAt) < Date.parse(v.acceptance.acceptedAt))) {
    issue(c, "OpenAPI settlement does not bind its acceptance.");
  }
});
export function buildConnectorNativeOpenapiImportIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeOpenapiImportRequest) {
  return connectorNativeOpenapiImportIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope, keySha256: connectorNativeKeySha256(scope, key), request });
}

export type ConnectorNativeOpenapiImportDeclaration = z.infer<typeof connectorNativeOpenapiImportDeclarationSchema>;
export type ConnectorNativeOpenapiImportResolvedDeclaration = z.infer<typeof connectorNativeOpenapiImportResolvedDeclarationSchema>;
export type ConnectorNativeOpenapiImportPrepareRequest = z.infer<typeof connectorNativeOpenapiImportPrepareRequestSchema>;
export type ConnectorNativeOpenapiImportPreparationIntent = z.infer<typeof connectorNativeOpenapiImportPreparationIntentSchema>;
export type ConnectorNativeOpenapiImportAttempt = z.infer<typeof connectorNativeOpenapiImportAttemptSchema>;
export type ConnectorNativeOpenapiImportPreparation = z.infer<typeof connectorNativeOpenapiImportPreparationSchema>;
export type ConnectorNativeOpenapiImportSummary = z.infer<typeof connectorNativeOpenapiImportSummarySchema>;
export type ConnectorNativeOpenapiImportPreparationPreparingRead = z.infer<typeof connectorNativeOpenapiImportPreparationPreparingReadSchema>;
export type ConnectorNativeOpenapiImportPreparationReadyRead = z.infer<typeof connectorNativeOpenapiImportPreparationReadyReadSchema>;
export type ConnectorNativeOpenapiImportPreparationExpiredRead = z.infer<typeof connectorNativeOpenapiImportPreparationExpiredReadSchema>;
export type ConnectorNativeOpenapiImportPreparationFailedRead = z.infer<typeof connectorNativeOpenapiImportPreparationFailedReadSchema>;
export type ConnectorNativeOpenapiImportPreparationConsumedRead = z.infer<typeof connectorNativeOpenapiImportPreparationConsumedReadSchema>;
export type ConnectorNativeOpenapiImportPreparationAbandonedRead = z.infer<typeof connectorNativeOpenapiImportPreparationAbandonedReadSchema>;
export type ConnectorNativeOpenapiImportPreparationRead = z.infer<typeof connectorNativeOpenapiImportPreparationReadSchema>;
export type ConnectorNativeOpenapiImportPreparationAbandonRequest = z.infer<typeof connectorNativeOpenapiImportPreparationAbandonRequestSchema>;
export type ConnectorNativeOpenapiImportPreparationAbandonment = z.infer<typeof connectorNativeOpenapiImportPreparationAbandonmentSchema>;
export type ConnectorNativeOpenapiImportRequest = z.infer<typeof connectorNativeOpenapiImportRequestSchema>;
export type ConnectorNativeOpenapiImportIntent = z.infer<typeof connectorNativeOpenapiImportIntentSchema>;
export type ConnectorNativeOpenapiImportAcceptance = z.infer<typeof connectorNativeOpenapiImportAcceptanceSchema>;
export type ConnectorNativeOpenapiImportSettlement = z.infer<typeof connectorNativeOpenapiImportSettlementSchema>;
export type ConnectorNativeOpenapiImportAction = z.infer<typeof connectorNativeOpenapiImportActionSchema>;
