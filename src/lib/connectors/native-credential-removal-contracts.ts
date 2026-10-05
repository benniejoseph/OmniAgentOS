import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  connectorNativeExtendedSettlementSchema,
  connectorNativeFutureAcceptanceSchema,
  connectorNativeFutureActionSchema,
  connectorNativeKeySha256,
  connectorNativeLifecycleRequestSchema,
  connectorNativeScopeSchema,
  connectorNativeShaSchema,
  type ConnectorNativeReview,
  type ConnectorNativeScope,
} from "@/lib/connectors/native-control-contracts";

/** Only local removal is enrolled. The dormant lifecycle union remains unpublished. */
export const connectorNativeCredentialRemovalRequestSchema = z.object({
  ...connectorNativeLifecycleRequestSchema.shape,
  action: z.literal("remove_credential"),
  preview: z.null(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeLifecycleRequestSchema.safeParse(value).success ||
    value.review.credentialVersion < 1 || value.review.credentialVersion >= 2147483647) {
    context.addIssue({ code: "custom", message: "Credential removal requires an exact configured credential version below the version ceiling." });
  }
});

export const connectorNativeCredentialRemovalIntentSchema = z.object({
  contract: z.literal("asael-connector-action-intent:1"),
  scope: connectorNativeScopeSchema,
  keySha256: connectorNativeShaSchema,
  request: connectorNativeCredentialRemovalRequestSchema,
}).strict();

export const connectorNativeCredentialRemovalAcceptanceSchema = z.object({
  ...connectorNativeFutureAcceptanceSchema.shape,
  kind: z.literal("mcp"),
  action: z.literal("remove_credential"),
}).strict().superRefine((value, context) => {
  if (!connectorNativeFutureAcceptanceSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Credential removal acceptance identity differs." });
  }
});

export const connectorNativeCredentialRemovalSettlementSchema = z.object({
  ...connectorNativeExtendedSettlementSchema.shape,
  result: z.object({
    ...connectorNativeExtendedSettlementSchema.shape.result.shape,
    kind: z.literal("mcp"),
    operation: z.literal("remove_credential"),
    status: z.literal("complete"),
    connectorStatus: z.literal("disabled"),
    contractCount: z.literal(0),
    credentialVersion: z.number().int().min(2).max(2147483647),
    connectorSha256: connectorNativeShaSchema,
    contractsSha256: connectorNativeShaSchema,
    configurationSha256: connectorNativeShaSchema,
    trash: z.null(),
    failureCode: z.null(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeExtendedSettlementSchema.safeParse(value).success ||
    value.result.contractsSha256 !== canonicalJsonSha256([])) {
    context.addIssue({ code: "custom", message: "Credential removal settlement digest differs." });
  }
});

export const connectorNativeCredentialRemovalActionSchema = z.object({
  acceptance: connectorNativeCredentialRemovalAcceptanceSchema,
  state: z.enum(["accepted", "settled"]),
  settlement: connectorNativeCredentialRemovalSettlementSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeFutureActionSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Credential removal settlement does not bind its acceptance." });
  }
});

export type ConnectorNativeCredentialRemovalRequest = z.infer<typeof connectorNativeCredentialRemovalRequestSchema>;
export type ConnectorNativeCredentialRemovalIntent = z.infer<typeof connectorNativeCredentialRemovalIntentSchema>;
export type ConnectorNativeCredentialRemovalAcceptance = z.infer<typeof connectorNativeCredentialRemovalAcceptanceSchema>;
export type ConnectorNativeCredentialRemovalSettlement = z.infer<typeof connectorNativeCredentialRemovalSettlementSchema>;
export type ConnectorNativeCredentialRemovalAction = z.infer<typeof connectorNativeCredentialRemovalActionSchema>;

export function buildConnectorNativeCredentialRemovalIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeCredentialRemovalRequest) {
  return connectorNativeCredentialRemovalIntentSchema.parse({
    contract: "asael-connector-action-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), request,
  });
}

export function canRemoveNativeConnectorCredential(review: ConnectorNativeReview): boolean {
  return review.unavailableReason === null && review.pin !== null && review.connector.kind === "mcp" &&
    review.connector.authType === "bearer_vault" && review.connector.credentialConfigured &&
    review.connector.credentialVersion >= 1 && review.connector.credentialVersion < 2147483647;
}

/** Shared digest for the immutable removal intent; never includes bearer bytes. */
export const connectorNativeCredentialRemovalIntentSha256 = (intent: ConnectorNativeCredentialRemovalIntent) =>
  canonicalJsonSha256(connectorNativeCredentialRemovalIntentSchema.parse(intent));
