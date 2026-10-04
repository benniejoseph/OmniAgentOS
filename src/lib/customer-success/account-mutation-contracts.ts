import { z } from "zod";

import { customerAccountId, customerAccountRevisionSchema, customerCrmPermissionsSchema, customerFactOwnerSchema, customerMutationId, type CustomerAccountRevision } from "@/lib/customer-success/contracts";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const shape = customerAccountRevisionSchema.shape;
const canonicalActor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const purposes = customerCrmPermissionsSchema.shape.customerDataPurposeIds.superRefine((value, context) => {
  const result = customerCrmPermissionsSchema.safeParse({ readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: value });
  if (!result.success) context.addIssue({ code: "custom", message: "Account purposes must be canonical, unique and retain read and management access." });
});
export const customerAccountCreateFieldsSchema = z.object({
  name: shape.name,
  lifecycle: shape.lifecycle.default("prospect"),
  organizationEntityId: shape.organizationEntityId.default(null),
  accountOwner: customerFactOwnerSchema,
  customerDataPurposeIds: purposes.default(["customer_success.account.manage", "customer_success.account.read"]),
}).strict();
export const customerAccountReviseFieldsSchema = z.object({
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  name: shape.name.optional(), lifecycle: shape.lifecycle.optional(),
  organizationEntityId: shape.organizationEntityId.optional(),
  accountOwner: customerFactOwnerSchema.optional(), customerDataPurposeIds: purposes.optional(),
}).strict().refine((value) => [value.name, value.lifecycle, value.organizationEntityId, value.accountOwner, value.customerDataPurposeIds].some((field) => field !== undefined), { message: "A customer account change is required." });
export const customerAccountMutationRequestSchema = z.discriminatedUnion("operation", [
  customerAccountCreateFieldsSchema.extend({ operation: z.literal("account.create") }),
  customerAccountReviseFieldsSchema.safeExtend({ operation: z.literal("account.revise") }),
]);
export type CustomerAccountMutationRequest = z.infer<typeof customerAccountMutationRequestSchema>;

export const customerAccountMutationIntentSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal("customer-account-mutation-intent:1"),
  tenantId: shape.tenantId, workspaceId: shape.workspaceId, accountId: shape.accountId,
  mutationId: shape.mutationId, canonicalActorId: canonicalActor, idempotencyKeySha256: sha256,
  request: customerAccountMutationRequestSchema,
}).strict();
export type CustomerAccountMutationIntent = z.infer<typeof customerAccountMutationIntentSchema>;

// Undefined is omission in JSON. Create defaults are semantic input; sparse
// revise fields remain sparse, including an explicitly supplied null.
export function buildCustomerAccountMutationIntent(input: {
  tenantId: string; workspaceId: string; canonicalActorId: string; idempotencyKey: string;
  accountId?: string; request: z.input<typeof customerAccountMutationRequestSchema>;
}): CustomerAccountMutationIntent {
  const idempotencyKey = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(input.idempotencyKey);
  const parsed = customerAccountMutationRequestSchema.parse(input.request);
  const request = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
  const accountId = parsed.operation === "account.create"
    ? customerAccountId({ tenantId: input.tenantId, workspaceId: input.workspaceId, idempotencyKey })
    : shape.accountId.parse(input.accountId);
  if (input.accountId !== undefined && accountId !== input.accountId) throw new Error("Account identity differs from the submitted operation.");
  return customerAccountMutationIntentSchema.parse({
    schemaVersion: 1, contract: "customer-account-mutation-intent:1",
    tenantId: input.tenantId, workspaceId: input.workspaceId, accountId,
    canonicalActorId: input.canonicalActorId,
    mutationId: customerMutationId({ accountId, idempotencyKey, operation: parsed.operation }),
    idempotencyKeySha256: idempotencyKeySha256({ tenantId: input.tenantId, idempotencyKey }), request,
  });
}

const acceptanceBody = z.object({
  schemaVersion: z.literal(1), contract: z.literal("customer-account-mutation-acceptance:1"),
  operation: z.enum(["account.create", "account.revise"]),
  tenantId: shape.tenantId, workspaceId: shape.workspaceId, accountId: shape.accountId,
  mutationId: shape.mutationId, canonicalActorId: canonicalActor, idempotencyKeySha256: sha256,
  requestSha256: sha256, revisionId: shape.revisionId, revision: shape.revision,
  accountSha256: sha256, acceptedAt: shape.revisedAt,
});
export const customerAccountMutationAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: sha256 }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || value.revisionId !== `${value.accountId}:v${value.revision}` || (value.operation === "account.create" && value.revision !== 1) || (value.operation === "account.revise" && value.revision < 2)) context.addIssue({ code: "custom", message: "The immutable account acceptance is inconsistent." });
});
export type CustomerAccountMutationAcceptance = z.infer<typeof customerAccountMutationAcceptanceSchema>;

export function buildCustomerAccountMutationAcceptance(intent: CustomerAccountMutationIntent, account: CustomerAccountRevision): CustomerAccountMutationAcceptance {
  assertCustomerAccountMutationOutcome(intent, account);
  const body = acceptanceBody.parse({
    schemaVersion: 1, contract: "customer-account-mutation-acceptance:1", operation: intent.request.operation,
    tenantId: intent.tenantId, workspaceId: intent.workspaceId, accountId: intent.accountId,
    mutationId: intent.mutationId, canonicalActorId: intent.canonicalActorId, idempotencyKeySha256: intent.idempotencyKeySha256,
    requestSha256: canonicalJsonSha256(intent), revisionId: account.revisionId, revision: account.revision,
    accountSha256: account.accountSha256, acceptedAt: account.revisedAt,
  });
  return customerAccountMutationAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
}

export function assertCustomerAccountMutationOutcome(intent: CustomerAccountMutationIntent, account: CustomerAccountRevision) {
  const request = intent.request;
  if (account.tenantId !== intent.tenantId || account.workspaceId !== intent.workspaceId || account.accountId !== intent.accountId || account.mutationId !== intent.mutationId || account.ownerActorId !== intent.canonicalActorId || account.revisedByActorId !== intent.canonicalActorId || account.revision !== (request.operation === "account.create" ? 1 : request.expectedRevision + 1)) throw new Error("Accepted account differs from the submitted identity.");
  for (const key of ["name", "lifecycle", "organizationEntityId", "accountOwner", "customerDataPurposeIds"] as const) {
    if (request[key] !== undefined && canonicalJsonSha256(request[key]) !== canonicalJsonSha256(key === "customerDataPurposeIds" ? account.crmPermissions.customerDataPurposeIds : account[key])) throw new Error("Accepted account differs from the submitted fields.");
  }
  if (request.operation === "account.create" && account.crmPermissions.externalWriteState !== "disabled") throw new Error("Creating an account cannot authorize external CRM writes.");
}
