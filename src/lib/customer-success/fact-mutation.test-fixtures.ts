import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { buildCustomerFactRevision, type CustomerFactValue } from "@/lib/customer-success/contracts";
import { buildCustomerFactNativeAcceptance, buildCustomerFactNativeIntent, buildCustomerFactNativeSource, customerFactNativeRequestSchema } from "@/lib/customer-success/fact-mutation-contracts";
import type { SecurityContext } from "@/lib/security/types";

export const factContext: SecurityContext = { tenantId: "tenant-native-fact", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-fact", tenantName: "Customer" } };
export const factActorId = `actor:${factContext.auth!.userId}`, factWorkspaceId = `workspace:personal:${factContext.auth!.userId}`;
export const factAccountId = `customer-account:${"a".repeat(64)}`, factAt = "2026-10-05T12:00:00.123Z", later = "2026-11-05T12:00:00.123Z";
export const manualFactValues: CustomerFactValue[] = [
  { kind: "organization", entityId: "organization:one", name: "Customer", industry: null, website: null },
  { kind: "contact", entityId: "person:one", name: "Contact", email: null, title: null },
  { kind: "stakeholder", entityId: "person:one", name: "Sponsor", role: "Sponsor", influence: "high", stance: "supportive" },
  { kind: "product", entityId: "product:one", name: "Service", status: "active", quantity: null },
  { kind: "opportunity", entityId: "opportunity:one", name: "Renewal", stage: "Discovery", amountMinor: 12000, currency: "USD", expectedCloseAt: null },
  { kind: "case", entityId: "case:one", title: "Support request", status: "open", severity: "low" },
  { kind: "usage", metricId: "metric:one", label: "Active users", value: 5, unit: "users", periodStartAt: factAt, periodEndAt: later },
  { kind: "project", projectId: "project:one", name: "Onboarding", status: "active" },
  { kind: "interaction", interactionId: "interaction:one", channel: "call", summary: "Reviewed progress", occurredAt: factAt },
  { kind: "health", dimension: "adoption", status: "watch", scoreBasisPoints: null, summary: "Review use" },
  { kind: "risk", entityId: "risk:one", title: "Adoption risk", severity: "high", status: "open" },
  { kind: "renewal", renewalId: "renewal:one", status: "planning", renewalAt: later, amountMinor: null, currency: null },
];
export function factFixture(value: CustomerFactValue = manualFactValues[10]) {
  const request = customerFactNativeRequestSchema.parse({ contract: "customer-fact-mutation-request:1", workspaceId: factWorkspaceId,
    expectedAccountRevision: 3, expectedAccountSha256: "b".repeat(64), operation: "create", factId: null, expectedFactRevision: null, expectedFactSha256: null,
    factKey: `manual.${value.kind}`, value, owner: { ownerKind: "actor", ownerId: factActorId, displayName: "Customer owner" },
    confidenceBasisPoints: 7500, validFrom: factAt, validTo: null, staleAfter: null,
    manualSource: { label: "My reviewed assertion", observedAt: factAt }, allowedPurposeIds: ["customer_success.account.read"] });
  const common = { tenantId: factContext.tenantId, workspaceId: factWorkspaceId, accountId: factAccountId, canonicalActorId: factActorId };
  const key = "fact-key", intent = buildCustomerFactNativeIntent({ ...common, idempotencyKey: key, request });
  const fact = buildCustomerFactRevision({ tenantId: common.tenantId, workspaceId: common.workspaceId, accountId: common.accountId,
    factId: intent.factId, mutationId: intent.mutationId, revision: 1, factKey: request.factKey, value: request.value, owner: request.owner,
    confidenceBasisPoints: request.confidenceBasisPoints, validFrom: request.validFrom, validTo: request.validTo, staleAfter: request.staleAfter,
    source: buildCustomerFactNativeSource(intent, later), recordedByActorId: factActorId, recordedAt: later });
  const acceptance = buildCustomerFactNativeAcceptance(intent, fact), currentAccount = { accountId: factAccountId,
    revisionId: `${factAccountId}:v3`, revision: 3, accountSha256: request.expectedAccountSha256 };
  return { ...common, key, request, intent, fact, acceptance, currentAccount, committed: { currentAccount, acceptance, replayed: false } };
}
export function factAccess(canWrite = true) {
  return { actorBinding: { canonicalActorId: factActorId, readableOwnerActorIds: [factActorId, factContext.actorId] },
    authority: { initiatingActorId: factActorId, workspaceId: factWorkspaceId, accessLevel: canWrite ? "manager" : "reader",
      canWrite, authoritySha256: "d".repeat(64) } };
}
export function factCaller(mutation = false) {
  if (!mutation) return createAppServiceCaller({ context: factContext });
  return createRequestMutationAppServiceCaller(new Request("https://example.test/api/customer-accounts/facts", {
    method: "POST", headers: { "Idempotency-Key": "fact-key" } }), factContext, {
    purpose: "api.customer-account.fact.record", workspaceId: factWorkspaceId, causationId: factAccountId,
  });
}
