import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import {
  personalContextConsentNativeAcceptanceSchema,
  personalContextConsentNativeCurrentSchema,
  personalContextConsentNativeRequestSchema,
} from "@/lib/memory/personal-context-consent-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NATIVE_PERSONAL_CONTEXT_CONSENT_READ_CONTRACT = "asael-personal-context-consent-read:1" as const;
export const nativePersonalContextConsentQuerySchema = z.object({
  contract: z.literal(NATIVE_PERSONAL_CONTEXT_CONSENT_READ_CONTRACT),
}).strict();
export const nativePersonalContextConsentDecisionIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const nativePersonalContextConsentCurrentSchema = personalContextConsentNativeCurrentSchema;
const scopeSchema = z.object({
  tenantId: z.string().min(1).max(240),
  ownerActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  visibility: z.literal("user_private"),
}).strict();
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
function receipt(operation: string, mutation = false) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.resourceType !== "personal_context_consent" ||
      value.action !== (mutation ? "write.memory" : "read") ||
      value.accessMode !== (mutation ? "mutation" : "read") ||
      value.eventContract !== (mutation ? "memory.personal_context_consent.atomic-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) {
      issue(context, "Receipt does not describe this personal recall operation.");
    }
  });
}
const base = {
  contract: z.literal(NATIVE_PERSONAL_CONTEXT_CONSENT_READ_CONTRACT),
  scope: scopeSchema,
  current: nativePersonalContextConsentCurrentSchema,
  acceptance: personalContextConsentNativeAcceptanceSchema.nullable(),
};
type ScopedResponse = {
  scope: z.infer<typeof scopeSchema>;
  current: z.infer<typeof nativePersonalContextConsentCurrentSchema>;
  acceptance: z.infer<typeof personalContextConsentNativeAcceptanceSchema> | null;
  replayed?: boolean;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema>;
};
function response(value: ScopedResponse, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.resourceCount !== 1 || serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body)) {
    issue(context, "Receipt must bind the exact personal recall response.");
  }
  for (const observation of [value.current, value.acceptance]) {
    if (observation && (observation.tenantId !== value.scope.tenantId || observation.ownerActorId !== value.scope.ownerActorId)) {
      issue(context, "Personal recall observations must belong to the current private owner.");
    }
  }
  // An acceptance is historical evidence. A later revoke/activation may have
  // changed current state; that must not erase recovery of the earlier intent.
  if (value.acceptance) {
    const after = value.acceptance.after, current = value.current;
    if (current.consentGeneration < after.consentGeneration ||
      (current.consentGeneration === after.consentGeneration && current.lifecycleRevision < after.lifecycleRevision)) {
      issue(context, "Current consent cannot precede the accepted decision.");
    }
    if (value.replayed === false && (current.state !== after.state || current.consentGeneration !== after.consentGeneration ||
      current.lifecycleRevision !== after.lifecycleRevision)) {
      issue(context, "A newly accepted decision must return exactly its committed consent state.");
    }
  }
}
export const nativePersonalContextConsentResponseSchema = z.object({
  ...base,
  serviceReceipt: receipt("memory.personal-context-consent.get"),
}).strict().superRefine((value, context) => {
  response(value, context);
  if (value.acceptance !== null) issue(context, "Current status does not select a prior decision.");
});
export const nativePersonalContextConsentDecisionReadResponseSchema = z.object({
  ...base,
  serviceReceipt: receipt("memory.personal-context-consent.decision.get"),
}).strict().superRefine(response);
export const nativePersonalContextConsentDecisionResponseSchema = z.object({
  ...base,
  acceptance: personalContextConsentNativeAcceptanceSchema,
  replayed: z.boolean(),
  serviceReceipt: receipt("memory.personal-context-consent.decide", true),
}).strict().superRefine(response);
export const nativePersonalContextConsentErrorSchema = z.union([
  z.object({ error: z.string().min(1).max(4_000), code: z.string().max(200).optional() }).strict(),
  z.object({ error: z.string().min(1).max(4_000), message: z.string().max(4_000) }).strict(),
]);
export const nativePersonalContextConsentSchemas = Object.freeze({
  NativePersonalContextConsentQuery: nativePersonalContextConsentQuerySchema,
  NativePersonalContextConsentResponse: nativePersonalContextConsentResponseSchema,
  NativePersonalContextConsentDecisionRequest: personalContextConsentNativeRequestSchema,
  NativePersonalContextConsentDecisionReadResponse: nativePersonalContextConsentDecisionReadResponseSchema,
  NativePersonalContextConsentDecisionResponse: nativePersonalContextConsentDecisionResponseSchema,
  NativePersonalContextConsentError: nativePersonalContextConsentErrorSchema,
});
