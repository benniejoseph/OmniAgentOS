import { z } from "zod";
import {
  connectorNativeIdSchema, connectorNativeKeySha256, connectorNativePinSchema,
  connectorNativeScopeSchema, connectorNativeShaSchema, type ConnectorNativeReview,
  type ConnectorNativeScope,
} from "@/lib/connectors/native-control-contracts";
import { OFFICIAL_GITHUB_MCP_ALL_ENDPOINT, isLegacyOfficialGitHubMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NATIVE_GITHUB_UPGRADE_ATTEMPT_MS = 45_000;
export const NATIVE_GITHUB_UPGRADE_MAX_TOOLS = 200;
const instant = z.string().datetime();
const count = z.number().int().min(0).max(2_147_483_647);
const attemptId = z.string().regex(/^github-upgrade-attempt:[a-f0-9]{64}$/);
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function issue(context: z.RefinementCtx, message: string) {
  context.addIssue({ code: "custom", message });
}

export const connectorNativeGithubUpgradeRequestSchema = z.object({
  contract: z.literal("asael-connector-lifecycle-action:1"),
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  action: z.literal("upgrade_github"),
  review: connectorNativePinSchema,
  preview: z.null(),
}).strict().superRefine((value, context) => {
  if (value.review.kind !== "mcp" || value.review.connectorId !== value.connectorId) {
    issue(context, "GitHub upgrade must bind the exact reviewed MCP connector.");
  }
});
export const connectorNativeGithubUpgradeIntentSchema = z.object({
  contract: z.literal("asael-connector-action-intent:1"),
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  request: connectorNativeGithubUpgradeRequestSchema,
}).strict();
export function connectorNativeGithubUpgradeAttemptId(scope: ConnectorNativeScope, keySha256: string) {
  return `github-upgrade-attempt:${canonicalJsonSha256({ family: "github-upgrade-attempt:1", scope, keySha256 })}`;
}
export const connectorNativeGithubUpgradeAttemptSchema = z.object({
  contract: z.literal("asael-github-upgrade-attempt:1"),
  id: attemptId,
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  intentSha256: connectorNativeShaSchema,
  connectorId: connectorNativeIdSchema,
  reviewSha256: connectorNativeShaSchema,
  targetEndpoint: z.literal(OFFICIAL_GITHUB_MCP_ALL_ENDPOINT),
  startedAt: instant,
  expiresAt: instant,
  attemptSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { attemptSha256, ...body } = value;
  if (value.id !== connectorNativeGithubUpgradeAttemptId(value.scope, value.keySha256) ||
    attemptSha256 !== canonicalJsonSha256(body) ||
    Date.parse(value.expiresAt) - Date.parse(value.startedAt) !== NATIVE_GITHUB_UPGRADE_ATTEMPT_MS) {
    issue(context, "GitHub upgrade attempt identity or deadline differs.");
  }
});
export const connectorNativeGithubUpgradeFailureCodeSchema = z.enum([
  "discovery_failed", "catalog_unreviewable", "target_changed", "deadline_exceeded",
]);
const completeResult = z.object({
  status: z.literal("complete"),
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  connectorStatus: z.literal("disabled"),
  endpoint: z.literal(OFFICIAL_GITHUB_MCP_ALL_ENDPOINT),
  defaultRiskLevel: z.literal(2),
  approvalRequired: z.literal(false),
  contractCount: count.min(1).max(NATIVE_GITHUB_UPGRADE_MAX_TOOLS),
  pendingCount: count.min(1).max(NATIVE_GITHUB_UPGRADE_MAX_TOOLS),
  credentialVersion: count,
  review: connectorNativePinSchema,
}).strict().superRefine((value, context) => {
  if (value.pendingCount !== value.contractCount || value.review.kind !== "mcp" ||
    value.review.connectorId !== value.connectorId || value.review.credentialVersion !== value.credentialVersion) {
    issue(context, "GitHub upgrade must leave the complete catalog disabled and pending review.");
  }
});
const failedResult = z.object({
  status: z.literal("failed"),
  kind: z.literal("mcp"),
  connectorId: connectorNativeIdSchema,
  failureCode: connectorNativeGithubUpgradeFailureCodeSchema,
}).strict();
export const connectorNativeGithubUpgradeSettlementSchema = z.object({
  contract: z.literal("asael-github-upgrade-settlement:1"),
  attemptId,
  attemptSha256: connectorNativeShaSchema,
  settledAt: instant,
  result: z.discriminatedUnion("status", [completeResult, failedResult]),
  settlementSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { settlementSha256, ...body } = value;
  if (settlementSha256 !== canonicalJsonSha256(body)) issue(context, "GitHub upgrade settlement digest differs.");
});
export const connectorNativeGithubUpgradeClosureSchema = z.object({
  contract: z.literal("asael-github-upgrade-closure:1"),
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  intentSha256: connectorNativeShaSchema,
  attemptId: attemptId.nullable(),
  attemptSha256: connectorNativeShaSchema.nullable(),
  closedAt: instant,
  closureSha256: connectorNativeShaSchema,
}).strict().superRefine((value, context) => {
  const { closureSha256, ...body } = value;
  if (closureSha256 !== canonicalJsonSha256(body) ||
    (value.attemptId === null) !== (value.attemptSha256 === null)) {
    issue(context, "GitHub upgrade closure identity differs.");
  }
});
const original = { intent: connectorNativeGithubUpgradeIntentSchema, attempt: connectorNativeGithubUpgradeAttemptSchema };
const pending = z.object({ state: z.literal("pending"), ...original }).strict();
const expired = z.object({ state: z.literal("expired"), ...original }).strict();
const settled = z.object({ state: z.literal("settled"), ...original, settlement: connectorNativeGithubUpgradeSettlementSchema }).strict();
const closed = z.object({
  state: z.literal("closed"), intent: connectorNativeGithubUpgradeIntentSchema,
  attempt: connectorNativeGithubUpgradeAttemptSchema.nullable(),
  closure: connectorNativeGithubUpgradeClosureSchema,
}).strict();
function bindRead(value: z.infer<typeof pending> | z.infer<typeof expired> | z.infer<typeof settled> | z.infer<typeof closed>,
  context: z.RefinementCtx) {
    const { intent, attempt } = value;
    if (attempt && (!same(intent.scope, attempt.scope) || intent.keySha256 !== attempt.keySha256 ||
      attempt.id !== connectorNativeGithubUpgradeAttemptId(intent.scope, intent.keySha256) ||
      attempt.intentSha256 !== canonicalJsonSha256(intent) ||
      attempt.connectorId !== intent.request.connectorId ||
      attempt.reviewSha256 !== intent.request.review.reviewSha256)) {
      issue(context, "GitHub upgrade attempt differs from its original intent.");
    }
    if (value.state === "settled") {
      const { settlement, attempt: settledAttempt } = value;
      if (settlement.attemptId !== settledAttempt.id || settlement.attemptSha256 !== settledAttempt.attemptSha256 ||
        settlement.result.connectorId !== intent.request.connectorId ||
        Date.parse(settlement.settledAt) < Date.parse(settledAttempt.startedAt) ||
        settlement.result.status === "complete" &&
          (Date.parse(settlement.settledAt) >= Date.parse(settledAttempt.expiresAt) ||
            settlement.result.credentialVersion !== intent.request.review.credentialVersion) ||
        settlement.result.status === "failed" && settlement.result.failureCode === "deadline_exceeded" &&
          Date.parse(settlement.settledAt) < Date.parse(settledAttempt.expiresAt)) {
        issue(context, "GitHub upgrade settlement differs from its attempt.");
      }
    }
    if (value.state === "closed") {
      const closure = value.closure;
      if (!same(closure.scope, intent.scope) || closure.keySha256 !== intent.keySha256 ||
        closure.intentSha256 !== canonicalJsonSha256(intent) ||
        closure.attemptId !== (attempt?.id ?? null) ||
        closure.attemptSha256 !== (attempt?.attemptSha256 ?? null) ||
        attempt && Date.parse(closure.closedAt) < Date.parse(attempt.startedAt)) {
        issue(context, "GitHub upgrade closure differs from its admission or absent-key tombstone.");
      }
    }
}
export const connectorNativeGithubUpgradeReadSchema =
  z.discriminatedUnion("state", [pending, expired, settled, closed]).superRefine(bindRead);
export const connectorNativeGithubUpgradeCloseReadSchema =
  z.discriminatedUnion("state", [closed, settled]).superRefine(bindRead);
export const connectorNativeGithubUpgradeCloseRequestSchema = z.object({
  contract: z.literal("asael-github-upgrade-close:1"),
  intent: connectorNativeGithubUpgradeIntentSchema,
}).strict();

export type ConnectorNativeGithubUpgradeRequest = z.infer<typeof connectorNativeGithubUpgradeRequestSchema>;
export type ConnectorNativeGithubUpgradeIntent = z.infer<typeof connectorNativeGithubUpgradeIntentSchema>;
export type ConnectorNativeGithubUpgradeAttempt = z.infer<typeof connectorNativeGithubUpgradeAttemptSchema>;
export type ConnectorNativeGithubUpgradeSettlement = z.infer<typeof connectorNativeGithubUpgradeSettlementSchema>;
export type ConnectorNativeGithubUpgradeClosure = z.infer<typeof connectorNativeGithubUpgradeClosureSchema>;
export type ConnectorNativeGithubUpgradeRead = z.infer<typeof connectorNativeGithubUpgradeReadSchema>;
export type ConnectorNativeGithubUpgradeCloseRead = z.infer<typeof connectorNativeGithubUpgradeCloseReadSchema>;
export type ConnectorNativeGithubUpgradeCloseRequest = z.infer<typeof connectorNativeGithubUpgradeCloseRequestSchema>;
export type ConnectorNativeGithubUpgradeFailureCode = z.infer<typeof connectorNativeGithubUpgradeFailureCodeSchema>;

export function buildConnectorNativeGithubUpgradeIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeGithubUpgradeRequest) {
  return connectorNativeGithubUpgradeIntentSchema.parse({
    contract: "asael-connector-action-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), request,
  });
}
export function canUpgradeNativeGithubConnector(review: ConnectorNativeReview) {
  return review.connector.kind === "mcp" && review.pin !== null &&
    review.unavailableReason === null && ["none", "bearer_env", "bearer_vault"].includes(review.connector.authType) &&
    (review.connector.authType !== "bearer_vault" ||
      review.connector.credentialConfigured && review.connector.credentialOriginMatch) &&
    isLegacyOfficialGitHubMcpEndpoint(review.connector.endpoint) && !review.connector.endpointRedacted;
}
