import { z } from "zod";
import {
  connectorNativeIdSchema,
  connectorNativeKeySha256,
  connectorNativePinSchema,
  connectorNativeScopeSchema,
  connectorNativeShaSchema,
  type ConnectorNativeReview,
  type ConnectorNativeScope,
} from "@/lib/connectors/native-control-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NATIVE_MCP_DISCOVERY_ATTEMPT_MS = 45_000;
export const NATIVE_MCP_DISCOVERY_MAX_TOOLS = 200;
export const NATIVE_MCP_DISCOVERY_REVIEW_BYTES = 1_048_576;
const instant = z.string().datetime();
const attemptId = z.string().regex(/^mcp-discovery-attempt:[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(2_147_483_647);
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function issue(context: z.RefinementCtx, message: string) {
  context.addIssue({ code: "custom", message });
}

export const connectorNativeMcpDiscoveryRequestSchema = z.object({
  contract: z.literal("asael-connector-lifecycle-action:1"),
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  action: z.literal("discover"),
  review: connectorNativePinSchema,
  preview: z.null(),
}).strict().superRefine((value, context) => {
  if (value.review.kind !== "mcp" || value.review.connectorId !== value.connectorId) {
    issue(context, "Discovery must bind the exact reviewed MCP connector.");
  }
});
export const connectorNativeMcpDiscoveryIntentSchema = z.object({
  contract: z.literal("asael-connector-action-intent:1"),
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  request: connectorNativeMcpDiscoveryRequestSchema,
}).strict();

export function connectorNativeMcpDiscoveryAttemptId(scope: ConnectorNativeScope, keySha256: string) {
  return `mcp-discovery-attempt:${canonicalJsonSha256({ family: "mcp-discovery-attempt:1", scope, keySha256 })}`;
}
export const connectorNativeMcpDiscoveryAttemptSchema = z.object({
  contract: z.literal("asael-mcp-discovery-attempt:1"),
  id: attemptId,
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  intentSha256: connectorNativeShaSchema,
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  reviewSha256: connectorNativeShaSchema,
  startedAt: instant,
  expiresAt: instant,
  attemptSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { attemptSha256, ...body } = value;
  if (value.id !== connectorNativeMcpDiscoveryAttemptId(value.scope, value.keySha256) ||
    attemptSha256 !== canonicalJsonSha256(body) ||
    Date.parse(value.expiresAt) - Date.parse(value.startedAt) !== NATIVE_MCP_DISCOVERY_ATTEMPT_MS) {
    issue(context, "The discovery attempt identity or exact deadline differs.");
  }
});
export const connectorNativeMcpDiscoveryFailureCodeSchema = z.enum([
  "discovery_failed", "catalog_unreviewable", "target_changed", "deadline_exceeded",
]);
const completeResult = z.object({
  status: z.literal("complete"),
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  connectorStatus: z.literal("disabled"),
  contractCount: count.max(NATIVE_MCP_DISCOVERY_MAX_TOOLS),
  pendingCount: count.max(NATIVE_MCP_DISCOVERY_MAX_TOOLS),
  credentialVersion: count,
  review: connectorNativePinSchema,
}).strict().superRefine((value, context) => {
  if (value.pendingCount > value.contractCount || value.review.kind !== "mcp" ||
    value.review.connectorId !== value.connectorId || value.review.credentialVersion !== value.credentialVersion ||
    (value.contractCount === 0) !== (value.review.contractsSha256 === canonicalJsonSha256([]))) {
    issue(context, "Discovery completion must bind the complete disabled catalog.");
  }
});
const failedResult = z.object({
  status: z.literal("failed"),
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  failureCode: connectorNativeMcpDiscoveryFailureCodeSchema,
}).strict();
export const connectorNativeMcpDiscoverySettlementSchema = z.object({
  contract: z.literal("asael-mcp-discovery-settlement:1"),
  attemptId,
  attemptSha256: connectorNativeShaSchema,
  settledAt: instant,
  result: z.discriminatedUnion("status", [completeResult, failedResult]),
  settlementSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { settlementSha256, ...body } = value;
  if (settlementSha256 !== canonicalJsonSha256(body)) issue(context, "Discovery settlement digest differs.");
});
export const connectorNativeMcpDiscoveryClosureSchema = z.object({
  contract: z.literal("asael-mcp-discovery-closure:1"),
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  intentSha256: connectorNativeShaSchema,
  attemptId: attemptId.nullable(),
  attemptSha256: connectorNativeShaSchema.nullable(),
  closedAt: instant,
  closureSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { closureSha256, ...body } = value;
  if (closureSha256 !== canonicalJsonSha256(body) || (value.attemptId === null) !== (value.attemptSha256 === null)) {
    issue(context, "Discovery closure identity differs.");
  }
});

const original = { intent: connectorNativeMcpDiscoveryIntentSchema, attempt: connectorNativeMcpDiscoveryAttemptSchema };
export const connectorNativeMcpDiscoveryPendingReadSchema = z.object({ state: z.literal("pending"), ...original }).strict();
export const connectorNativeMcpDiscoveryExpiredReadSchema = z.object({ state: z.literal("expired"), ...original }).strict();
export const connectorNativeMcpDiscoverySettledReadSchema = z.object({
  state: z.literal("settled"), ...original, settlement: connectorNativeMcpDiscoverySettlementSchema,
}).strict();
export const connectorNativeMcpDiscoveryClosedReadSchema = z.object({
  state: z.literal("closed"), intent: connectorNativeMcpDiscoveryIntentSchema,
  attempt: connectorNativeMcpDiscoveryAttemptSchema.nullable(), closure: connectorNativeMcpDiscoveryClosureSchema,
}).strict();
const readUnion = z.discriminatedUnion("state", [
  connectorNativeMcpDiscoveryPendingReadSchema, connectorNativeMcpDiscoveryExpiredReadSchema,
  connectorNativeMcpDiscoverySettledReadSchema, connectorNativeMcpDiscoveryClosedReadSchema,
]);
type ReadShape = z.infer<typeof readUnion>;
function bindRead(value: ReadShape, context: z.RefinementCtx) {
  const { intent, attempt } = value;
  if (attempt && (!same(attempt.scope, intent.scope) || attempt.keySha256 !== intent.keySha256 ||
    attempt.intentSha256 !== canonicalJsonSha256(intent) || attempt.connectorId !== intent.request.connectorId ||
    attempt.reviewSha256 !== intent.request.review.reviewSha256)) {
    issue(context, "Discovery attempt belongs to another original intent.");
  }
  if (value.state === "settled") {
    const settled = value.settlement, result = settled.result, admitted = value.attempt;
    if (settled.attemptId !== admitted.id || settled.attemptSha256 !== admitted.attemptSha256 ||
      result.connectorId !== intent.request.connectorId || Date.parse(settled.settledAt) < Date.parse(admitted.startedAt) ||
      result.status === "complete" && (result.credentialVersion !== intent.request.review.credentialVersion ||
        Date.parse(settled.settledAt) >= Date.parse(admitted.expiresAt)) ||
      result.status === "failed" && result.failureCode === "deadline_exceeded" &&
        Date.parse(settled.settledAt) < Date.parse(admitted.expiresAt)) {
      issue(context, "Discovery settlement differs from its admitted target and deadline.");
    }
  }
  if (value.state === "closed") {
    const closed = value.closure;
    if (!same(closed.scope, intent.scope) || closed.keySha256 !== intent.keySha256 ||
      closed.intentSha256 !== canonicalJsonSha256(intent) || closed.attemptId !== (attempt?.id ?? null) ||
      closed.attemptSha256 !== (attempt?.attemptSha256 ?? null) ||
      attempt && Date.parse(closed.closedAt) < Date.parse(attempt.startedAt)) {
      issue(context, "Discovery closure differs from its original admission or absent-key tombstone.");
    }
  }
}
export const connectorNativeMcpDiscoveryReadSchema = readUnion.superRefine(bindRead);
export const connectorNativeMcpDiscoveryCloseReadSchema = z.discriminatedUnion("state", [
  connectorNativeMcpDiscoveryClosedReadSchema, connectorNativeMcpDiscoverySettledReadSchema,
]).superRefine(bindRead);
export const connectorNativeMcpDiscoveryCloseRequestSchema = z.object({
  contract: z.literal("asael-mcp-discovery-close:1"), intent: connectorNativeMcpDiscoveryIntentSchema,
}).strict();
export type ConnectorNativeMcpDiscoveryRequest = z.infer<typeof connectorNativeMcpDiscoveryRequestSchema>;
export type ConnectorNativeMcpDiscoveryIntent = z.infer<typeof connectorNativeMcpDiscoveryIntentSchema>;
export type ConnectorNativeMcpDiscoveryAttempt = z.infer<typeof connectorNativeMcpDiscoveryAttemptSchema>;
export type ConnectorNativeMcpDiscoverySettlement = z.infer<typeof connectorNativeMcpDiscoverySettlementSchema>;
export type ConnectorNativeMcpDiscoveryClosure = z.infer<typeof connectorNativeMcpDiscoveryClosureSchema>;
export type ConnectorNativeMcpDiscoveryRead = z.infer<typeof connectorNativeMcpDiscoveryReadSchema>;
export type ConnectorNativeMcpDiscoveryCloseRead = z.infer<typeof connectorNativeMcpDiscoveryCloseReadSchema>;
export type ConnectorNativeMcpDiscoveryCloseRequest = z.infer<typeof connectorNativeMcpDiscoveryCloseRequestSchema>;
export type ConnectorNativeMcpDiscoveryFailureCode = z.infer<typeof connectorNativeMcpDiscoveryFailureCodeSchema>;
export function buildConnectorNativeMcpDiscoveryIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeMcpDiscoveryRequest) {
  return connectorNativeMcpDiscoveryIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), request });
}
export function canDiscoverNativeMcpConnector(review: ConnectorNativeReview) {
  return review.connector.kind === "mcp" && review.connector.status === "disabled" && review.pin !== null &&
    review.unavailableReason === null && ["none", "bearer_env", "bearer_vault"].includes(review.connector.authType) &&
    (review.connector.authType !== "bearer_vault" || review.connector.credentialConfigured && review.connector.credentialOriginMatch);
}
