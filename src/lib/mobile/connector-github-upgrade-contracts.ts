import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, connectorNativeScopeSchema,
  connectorNativeShaSchema, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { connectorNativeIdSchema, connectorNativePinSchema } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeGithubUpgradeIntent, connectorNativeGithubUpgradeRequestSchema,
  connectorNativeGithubUpgradeCloseRequestSchema, connectorNativeGithubUpgradeReadSchema,
  connectorNativeGithubUpgradeCloseReadSchema, type ConnectorNativeGithubUpgradeIntent,
  type ConnectorNativeGithubUpgradeRead, type ConnectorNativeGithubUpgradeRequest,
} from "@/lib/connectors/native-github-upgrade-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeConnectorGithubUpgradeReadInputSchema = z.object({ keySha256: connectorNativeShaSchema }).strict();
const base = { contract: z.literal(CONNECTOR_NATIVE_READ_CONTRACT), scope: connectorNativeScopeSchema };
const operations = {
  submit: "app.connectors.native.githubUpgrades.submit",
  review: "app.connectors.native.githubUpgrades.review",
  read: "app.connectors.native.githubUpgrades.read",
  close: "app.connectors.native.githubUpgrades.close",
} as const;
type Response = {
  scope: ConnectorNativeScope; upgrade: ConnectorNativeGithubUpgradeRead | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema>;
};
type Authority = {
  scope: ConnectorNativeScope; requestActorId: string; role: string;
  executionScope?: ExecutionScope; keySha256?: string; idempotencyKey?: string;
};
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function bindReceipt(value: Response, context: z.RefinementCtx, kind: keyof typeof operations) {
  const { serviceReceipt: proof, ...body } = value;
  const mutation = kind !== "read", intent = value.upgrade?.intent;
  if (proof.operation !== operations[kind] ||
    proof.action !== (kind === "submit" ? "manage.connector" : "read") ||
    proof.resourceType !== "connector_native_upgrade" ||
    proof.accessMode !== (mutation ? "mutation" : "read") ||
    proof.resourceCount !== (intent ? 1 : 0) ||
    proof.eventContract !== (mutation ? "connector-native-github-upgrade-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation ||
    proof.outcomeSha256 !== canonicalJsonSha256(body) ||
    intent && (!same(value.scope, intent.scope) ||
      mutation && proof.idempotencyKeySha256 !== intent.keySha256)) {
    context.addIssue({ code: "custom", message: "GitHub upgrade service evidence differs from this exact response." });
  }
}
export const nativeConnectorGithubUpgradeReviewSchema = z.object({
  connectorId: connectorNativeIdSchema,
  eligible: z.boolean(),
  reason: z.enum(["eligible", "unavailable"]),
  review: connectorNativePinSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.eligible !== (value.reason === "eligible") ||
    value.review && (value.review.kind !== "mcp" || value.review.connectorId !== value.connectorId) ||
    value.eligible && !value.review) {
    context.addIssue({ code: "custom", message: "GitHub upgrade eligibility and exact review differ." });
  }
});
export const nativeConnectorGithubUpgradeReviewResponseSchema = z.object({
  ...base, upgradeReview: nativeConnectorGithubUpgradeReviewSchema.nullable(),
  serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => {
  const { serviceReceipt: proof, ...body } = value;
  if (proof.operation !== operations.review || proof.action !== "manage.connector" ||
    proof.resourceType !== "connector_native_upgrade" || proof.accessMode !== "read" ||
    proof.resourceCount !== (value.upgradeReview ? 1 : 0) ||
    proof.eventContract !== "read_only:no_domain_mutation" ||
    proof.idempotencyKeySha256 !== null || proof.outcomeSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", message: "GitHub upgrade review service evidence differs." });
  }
});
export function assertNativeConnectorGithubUpgradeReviewResponseScope(
  value: z.infer<typeof nativeConnectorGithubUpgradeReviewResponseSchema>,
  expected: Authority & { connectorId: string },
) {
  if (!same(value.scope, expected.scope) ||
    value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
      boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
      role: expected.role, executionScope: null,
    }) || value.upgradeReview && value.upgradeReview.connectorId !== expected.connectorId) {
    throw new Error("GitHub upgrade review authority or target differs.");
  }
}
export const nativeConnectorGithubUpgradeSubmitResponseSchema = z.object({
  ...base, upgrade: connectorNativeGithubUpgradeReadSchema,
  replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "submit"));
export const nativeConnectorGithubUpgradeReadResponseSchema = z.object({
  ...base, upgrade: connectorNativeGithubUpgradeReadSchema.nullable(),
  serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "read"));
export const nativeConnectorGithubUpgradeCloseResponseSchema = z.object({
  ...base, upgrade: connectorNativeGithubUpgradeCloseReadSchema,
  replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema,
}).strict().superRefine((value, context) => bindReceipt(value, context, "close"));
export function assertNativeConnectorGithubUpgradeResponseScope(value: Response,
  expected: Authority & { request?: ConnectorNativeGithubUpgradeRequest; intent?: ConnectorNativeGithubUpgradeIntent }) {
  if (!same(value.scope, expected.scope) ||
    value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
      boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: expected.scope.tenantId, actorId: expected.requestActorId,
      role: expected.role, executionScope: expected.executionScope ?? null,
    })) {
    throw new Error("GitHub upgrade response authority differs.");
  }
  if (expected.idempotencyKey &&
    value.serviceReceipt.idempotencyKeySha256 !== connectorNativeKeySha256(expected.scope, expected.idempotencyKey)) {
    throw new Error("GitHub upgrade response mutation key differs.");
  }
  const intent = value.upgrade?.intent;
  if (intent && expected.keySha256 && intent.keySha256 !== expected.keySha256) {
    throw new Error("GitHub upgrade recovery key differs.");
  }
  const original = expected.intent ?? (expected.request && expected.idempotencyKey
    ? buildConnectorNativeGithubUpgradeIntent(expected.scope, expected.idempotencyKey, expected.request) : undefined);
  if (original && (!intent || !same(original, intent))) {
    throw new Error("GitHub upgrade response differs from its saved original intent.");
  }
}
export const nativeConnectorGithubUpgradeSchemas = Object.freeze({
  NativeConnectorGithubUpgradeReadInput: nativeConnectorGithubUpgradeReadInputSchema,
  NativeConnectorGithubUpgradeReviewResponse: nativeConnectorGithubUpgradeReviewResponseSchema,
  NativeConnectorGithubUpgradeRequest: connectorNativeGithubUpgradeRequestSchema,
  NativeConnectorGithubUpgradeCloseRequest: connectorNativeGithubUpgradeCloseRequestSchema,
  NativeConnectorGithubUpgradeSubmitResponse: nativeConnectorGithubUpgradeSubmitResponseSchema,
  NativeConnectorGithubUpgradeReadResponse: nativeConnectorGithubUpgradeReadResponseSchema,
  NativeConnectorGithubUpgradeCloseResponse: nativeConnectorGithubUpgradeCloseResponseSchema,
});
