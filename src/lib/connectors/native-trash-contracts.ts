import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { trashActionPreviewV1Schema } from "@/lib/trash/contracts";
import { connectorNativeExtendedSettlementSchema, connectorNativeFutureAcceptanceSchema, connectorNativeFutureActionSchema,
  connectorNativeKeySha256, connectorNativeLifecycleRequestSchema, connectorNativeReviewSchema, connectorNativeScopeSchema,
  connectorNativeShaSchema, type ConnectorNativeReview, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";

export const CONNECTOR_NATIVE_TRASH_PREVIEW_MS = 600_000;
export const CONNECTOR_NATIVE_TRASH_RECONNECT_LIMITATION = "Connector configuration and contracts can be restored, but its vault credential must be reconnected by a human.";
export const connectorNativeTrashCompensationSchema = z.union([
  z.object({ kind: z.literal("exact_restore"), handlerId: z.literal("trash.restore.mcp_connector"), limitation: z.null() }).strict(),
  z.object({ kind: z.literal("equivalent_action"), handlerId: z.literal("trash.compensate.mcp_connector"),
    limitation: z.literal(CONNECTOR_NATIVE_TRASH_RECONNECT_LIMITATION) }).strict(),
]);

/** Expiry is checked only for fresh admission, never when parsing historical evidence. */
export const connectorNativeTrashBoundPreviewSchema = z.object({
  ...trashActionPreviewV1Schema.shape, action: z.literal("trash"), resourceType: z.literal("mcp_connector"),
  trashId: z.null(), lifecycleRevision: z.literal(0), reversible: z.literal(true),
}).strict().superRefine((value, context) => {
  if (!trashActionPreviewV1Schema.safeParse(value).success ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !== CONNECTOR_NATIVE_TRASH_PREVIEW_MS) {
    context.addIssue({ code: "custom", message: "Trash requires its exact ten-minute preview." });
  }
});

export const connectorNativeTrashRequestSchema = z.object({
  ...connectorNativeLifecycleRequestSchema.shape, action: z.literal("trash"), preview: connectorNativeTrashBoundPreviewSchema,
}).strict().superRefine((value, context) => {
  if (!connectorNativeLifecycleRequestSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Trash preview does not bind its exact reviewed MCP target." });
  }
});
export const connectorNativeTrashIntentSchema = z.object({ contract: z.literal("asael-connector-action-intent:1"),
  scope: connectorNativeScopeSchema, keySha256: connectorNativeShaSchema, request: connectorNativeTrashRequestSchema }).strict();
export const connectorNativeTrashAcceptanceSchema = z.object({
  ...connectorNativeFutureAcceptanceSchema.shape, kind: z.literal("mcp"), action: z.literal("trash"),
}).strict().superRefine((value, context) => {
  if (!connectorNativeFutureAcceptanceSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Trash acceptance identity differs." });
  }
});
const trashProofSchema = z.object({
  trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/), proofSha256: connectorNativeShaSchema,
  restoreUntil: z.string().datetime(), compensation: z.enum(["exact_restore", "equivalent_action"]),
  limitation: z.literal(CONNECTOR_NATIVE_TRASH_RECONNECT_LIMITATION).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.compensation === "equivalent_action") !== (value.limitation !== null)) {
    context.addIssue({ code: "custom", message: "Trash compensation limitation differs." });
  }
});
export const connectorNativeTrashSettlementSchema = z.object({
  ...connectorNativeExtendedSettlementSchema.shape,
  result: z.object({
    ...connectorNativeExtendedSettlementSchema.shape.result.shape,
    kind: z.literal("mcp"), operation: z.literal("trash"), status: z.literal("complete"),
    connectorStatus: z.null(), contractCount: z.null(), credentialVersion: z.null(),
    connectorSha256: z.null(), contractsSha256: z.null(), configurationSha256: z.null(),
    trash: trashProofSchema, failureCode: z.null(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeExtendedSettlementSchema.safeParse(value).success ||
    Date.parse(value.result.trash.restoreUntil) <= Date.parse(value.settledAt)) {
    context.addIssue({ code: "custom", message: "Trash settlement evidence differs." });
  }
});
export const connectorNativeTrashActionSchema = z.object({ acceptance: connectorNativeTrashAcceptanceSchema,
  state: z.enum(["accepted", "settled"]), settlement: connectorNativeTrashSettlementSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (!connectorNativeFutureActionSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Trash settlement does not bind its acceptance." });
  }
});

export function canTrashNativeConnector(review: ConnectorNativeReview): boolean {
  return review.connector.kind === "mcp" && review.unavailableReason === null && review.pin !== null;
}
export function connectorNativeTrashEffectSummary(review: ConnectorNativeReview) {
  return `Move MCP connector ${review.connector.name} and ${review.contracts.length} contract(s) to Trash.`;
}
export function connectorNativeTrashCompensation(review: ConnectorNativeReview) {
  return connectorNativeTrashCompensationSchema.parse(review.connector.credentialConfigured || review.connector.authType === "bearer_vault"
    ? { kind: "equivalent_action", handlerId: "trash.compensate.mcp_connector", limitation: CONNECTOR_NATIVE_TRASH_RECONNECT_LIMITATION }
    : { kind: "exact_restore", handlerId: "trash.restore.mcp_connector", limitation: null });
}
export const connectorNativeTrashPreviewSchema = z.object({ review: connectorNativeReviewSchema.nullable(),
  preview: connectorNativeTrashBoundPreviewSchema.nullable(), compensation: connectorNativeTrashCompensationSchema.nullable(),
}).strict().superRefine((value, context) => {
  const eligible = value.review !== null && canTrashNativeConnector(value.review);
  if (value.review && value.review.connector.kind !== "mcp" || eligible !== Boolean(value.preview) || eligible !== Boolean(value.compensation) ||
    eligible && value.review && (!connectorNativeTrashRequestSchema.safeParse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp",
      connectorId: value.review.connector.id, action: "trash", review: value.review.pin, preview: value.preview }).success ||
      value.preview?.effectSummary !== connectorNativeTrashEffectSummary(value.review) ||
      canonicalJsonSha256(value.compensation) !== canonicalJsonSha256(connectorNativeTrashCompensation(value.review)))) {
    context.addIssue({ code: "custom", message: "Trash preview does not match the complete current review and compensation." });
  }
});

export type ConnectorNativeTrashRequest = z.infer<typeof connectorNativeTrashRequestSchema>;
export type ConnectorNativeTrashIntent = z.infer<typeof connectorNativeTrashIntentSchema>;
export type ConnectorNativeTrashAcceptance = z.infer<typeof connectorNativeTrashAcceptanceSchema>;
export type ConnectorNativeTrashSettlement = z.infer<typeof connectorNativeTrashSettlementSchema>;
export type ConnectorNativeTrashAction = z.infer<typeof connectorNativeTrashActionSchema>;
export type ConnectorNativeTrashPreview = z.infer<typeof connectorNativeTrashPreviewSchema>;
export function buildConnectorNativeTrashIntent(scope: ConnectorNativeScope, key: string, request: ConnectorNativeTrashRequest) {
  return connectorNativeTrashIntentSchema.parse({ contract: "asael-connector-action-intent:1", scope,
    keySha256: connectorNativeKeySha256(scope, key), request });
}
