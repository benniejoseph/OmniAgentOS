import { describe, expect, it } from "vitest";

import {
  buildCustomerAccountRevision,
  buildCustomerFactRevision,
  customerAccountId,
  customerFactId,
  customerMutationId,
  projectCustomerAccount360,
  type CustomerFactValue,
} from "@/lib/customer-success/contracts";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account-1" });

function account() {
  return buildCustomerAccountRevision({
    tenantId,
    workspaceId,
    accountId,
    organizationEntityId: "organization:acme",
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey: "account-1", operation: "account.create" }),
    name: "Acme",
    lifecycle: "active",
    accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
    crmPermissions: {
      readScope: "workspace_members",
      writeScope: "workspace_contributors",
      externalWriteState: "disabled",
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    },
    ownerActorId: actorId,
    revisedByActorId: actorId,
    revisedAt: "2026-09-08T00:00:00.000Z",
  });
}

function fact(input: {
  key: string;
  idempotencyKey: string;
  value: CustomerFactValue;
  sourceRevisionSha256?: string;
  staleAfter?: string | null;
}) {
  const factId = customerFactId({ accountId, idempotencyKey: input.idempotencyKey });
  return buildCustomerFactRevision({
    tenantId,
    workspaceId,
    accountId,
    factId,
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey: input.idempotencyKey, operation: "fact.record" }),
    factKey: input.key,
    value: input.value,
    source: {
      sourceKind: "manual",
      sourceId: `source:${input.idempotencyKey}`,
      sourceRevisionId: `source:${input.idempotencyKey}:v1`,
      sourceRevisionSha256: input.sourceRevisionSha256 || "a".repeat(64),
      sourceLabel: "Operator assertion",
      providerId: null,
      providerObjectType: null,
      providerObjectIdSha256: null,
      permissionBasis: "operator_assertion",
      allowedPurposeIds: ["customer_success.account.read"],
      observedAt: "2026-09-08T00:00:00.000Z",
      ingestedAt: "2026-09-08T00:01:00.000Z",
    },
    owner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
    confidenceBasisPoints: 8_500,
    validFrom: "2026-09-08T00:00:00.000Z",
    staleAfter: input.staleAfter === undefined
      ? "2026-09-15T00:00:00.000Z"
      : input.staleAfter,
    recordedByActorId: actorId,
    recordedAt: "2026-09-08T00:01:00.000Z",
  });
}

describe("customer Account 360 contracts", () => {
  it("pins account identity, permissions, ontology, revision lineage, and digest", () => {
    const value = account();
    expect(value.accountEntityId).toBe(accountId);
    expect(value.ontologyVersionId).toBe("asael-ontology:1");
    expect(value.crmPermissions.externalWriteState).toBe("disabled");
    expect(value.accountSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects partial CRM provider references and mismatched fact kinds", () => {
    expect(() => fact({
      key: "usage.seats",
      idempotencyKey: "bad-kind",
      value: { kind: "health", dimension: "adoption", status: "healthy", scoreBasisPoints: 9_000, summary: "Healthy" },
    })).not.toThrow();

    const source = fact({
      key: "health.adoption",
      idempotencyKey: "bad-provider",
      value: { kind: "health", dimension: "adoption", status: "healthy", scoreBasisPoints: 9_000, summary: "Healthy" },
    });
    expect(() => buildCustomerFactRevision({
      ...source,
      source: { ...source.source, sourceKind: "crm", providerId: "salesforce" },
    })).toThrow(/Provider references/);
  });

  it("derives freshness and conflicting state instead of hiding disagreement", () => {
    const first = fact({
      key: "renewal.primary",
      idempotencyKey: "renewal-a",
      value: {
        kind: "renewal",
        renewalId: "renewal:primary",
        status: "planning",
        renewalAt: "2027-01-01T00:00:00.000Z",
        amountMinor: 10_000,
        currency: "USD",
      },
      staleAfter: "2026-09-09T00:00:00.000Z",
    });
    const second = fact({
      key: "renewal.primary",
      idempotencyKey: "renewal-b",
      value: {
        kind: "renewal",
        renewalId: "renewal:primary",
        status: "committed",
        renewalAt: "2027-02-01T00:00:00.000Z",
        amountMinor: 12_000,
        currency: "USD",
      },
    });
    const view = projectCustomerAccount360({
      account: account(),
      currentFacts: [first, second],
      historyCount: 2,
      evaluatedAt: "2026-09-10T00:00:00.000Z",
    });
    expect(view.factsByKind.renewal).toHaveLength(2);
    expect(view.facts[0].conflict.state).toBe("conflicting");
    expect(view.conflictCount).toBe(2);
    expect(view.staleCount).toBe(1);
  });

  it("requires money values and currency to be recorded together", () => {
    expect(() => fact({
      key: "opportunity.expansion",
      idempotencyKey: "bad-money",
      value: {
        kind: "opportunity",
        entityId: "opportunity:expansion",
        name: "Expansion",
        stage: "Discovery",
        amountMinor: 1_000,
        currency: null,
        expectedCloseAt: null,
      },
    })).toThrow(/Amount and currency/);
  });
});
