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
import {
  buildCustomerHealthSuggestion,
  buildDefaultCustomerHealthPolicy,
  customerHealthScoreSchema,
} from "@/lib/customer-success/health-contracts";
import {
  CustomerHealthEvidenceError,
  evaluateCustomerHealth,
} from "@/lib/customer-success/health-engine";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const evaluatedAt = "2026-09-08T12:00:00.000Z";
const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "health-account" });

describe("customer health factor engine", () => {
  it("pins a digest-bound policy whose factor weights cover the whole score", () => {
    const policy = buildDefaultCustomerHealthPolicy();
    expect(policy.policyVersion).toBe("asael-customer-health:1");
    expect(policy.policyId).toBe(`customer-health-policy:${policy.policySha256}`);
    expect(policy.factors.reduce((sum, factor) => sum + factor.weightBasisPoints, 0)).toBe(10_000);
  });

  it("derives the authoritative score only from cited current facts", () => {
    const views = account360([
      fact("adoption.product", "product", {
        kind: "product", entityId: "product:primary", name: "Asael",
        status: "active", quantity: 100,
      }),
      fact("support.case", "case", {
        kind: "case", entityId: "case:critical", title: "Outage",
        status: "Open", severity: "critical",
      }),
      fact("engagement.champion", "stakeholder", {
        kind: "stakeholder", entityId: "person:champion", name: "Ada",
        role: "Champion", influence: "high", stance: "champion",
      }),
      fact("renewal.primary", "renewal", {
        kind: "renewal", renewalId: "renewal:primary", status: "planning",
        renewalAt: "2027-01-01T00:00:00.000Z", amountMinor: null, currency: null,
      }),
    ]);
    const result = evaluate(views);
    expect(result).toMatchObject({
      authority: "deterministic_policy",
      scoreBasisPoints: 6_275,
      status: "watch",
      coverageBasisPoints: 10_000,
      confidenceBasisPoints: 9_000,
    });
    expect(result.factors.map((factor) => factor.factorKey)).toEqual([
      "adoption", "support", "engagement", "commercial",
    ]);
    expect(result.factors.flatMap((factor) => factor.evidence)).toHaveLength(4);
    expect(result.factors[0]?.evidence[0]).toMatchObject({
      factRevisionId: views.factsByKind.product[0]?.fact.factRevisionId,
      factSha256: views.factsByKind.product[0]?.fact.factSha256,
      sourceRevisionSha256: "a".repeat(64),
    });
    expect(customerHealthScoreSchema.parse(result).scoreSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("lowers coverage for missing factors and confidence for stale evidence", () => {
    const baseFacts = [
      fact("adoption.product", "product", {
        kind: "product", entityId: "product:primary", name: "Asael",
        status: "active", quantity: 100,
      }),
      fact("support.case", "case", {
        kind: "case", entityId: "case:critical", title: "Outage",
        status: "Open", severity: "critical",
      }, "2026-09-08T06:00:00.000Z"),
      fact("engagement.champion", "stakeholder", {
        kind: "stakeholder", entityId: "person:champion", name: "Ada",
        role: "Champion", influence: "high", stance: "champion",
      }),
    ];
    const result = evaluate(account360(baseFacts));
    expect(result.coverageBasisPoints).toBe(8_000);
    expect(result.confidenceBasisPoints).toBe(5_850);
    expect(result.factors.find((factor) => factor.factorKey === "support")).toMatchObject({
      evidenceState: "stale_only",
      confidenceBasisPoints: 3_600,
    });
    expect(result.factors.find((factor) => factor.factorKey === "commercial")).toMatchObject({
      evidenceState: "missing",
      scoreBasisPoints: null,
      confidenceBasisPoints: 0,
    });
  });

  it("retains cited model suggestions as non-authoritative annotations", () => {
    const views = account360([fact("support.case", "case", {
      kind: "case", entityId: "case:critical", title: "Outage",
      status: "Open", severity: "critical",
    })]);
    const evidence = views.facts[0]!.fact;
    const suggestion = buildCustomerHealthSuggestion({
      suggestionKind: "next_action",
      statement: "Review the open critical case with the support owner.",
      citedFactRevisionIds: [evidence.factRevisionId],
      citedFactSha256s: [evidence.factSha256],
      confidenceBasisPoints: 8_000,
      origin: {
        kind: "model",
        providerId: "openai",
        modelId: "gpt-5",
        promptSha256: "b".repeat(64),
      },
      createdAt: evaluatedAt,
    });
    const withoutSuggestion = evaluate(views);
    const withSuggestion = evaluateCustomerHealth({
      account360: views,
      revision: 1,
      evaluationId: `customer-health-evaluation:${"c".repeat(64)}`,
      evaluatedByActorId: actorId,
      evaluatedAt,
      suggestions: [suggestion],
    });
    expect(withSuggestion.suggestions).toEqual([expect.objectContaining({ authoritative: false })]);
    expect(withSuggestion.scoreBasisPoints).toBe(withoutSuggestion.scoreBasisPoints);
    expect(withSuggestion.confidenceBasisPoints).toBe(withoutSuggestion.confidenceBasisPoints);
  });

  it("rejects model citations that do not match current Account 360 evidence", () => {
    const views = account360([fact("support.case", "case", {
      kind: "case", entityId: "case:critical", title: "Outage",
      status: "Open", severity: "critical",
    })]);
    const evidence = views.facts[0]!.fact;
    const suggestion = buildCustomerHealthSuggestion({
      suggestionKind: "factor_review",
      statement: "Review support health.",
      citedFactRevisionIds: [evidence.factRevisionId],
      citedFactSha256s: ["f".repeat(64)],
      confidenceBasisPoints: 4_000,
      origin: {
        kind: "model",
        providerId: "openai",
        modelId: "gpt-5",
        promptSha256: "b".repeat(64),
      },
      createdAt: evaluatedAt,
    });
    expect(() => evaluateCustomerHealth({
      account360: views,
      revision: 1,
      evaluationId: `customer-health-evaluation:${"c".repeat(64)}`,
      evaluatedByActorId: actorId,
      evaluatedAt,
      suggestions: [suggestion],
    })).toThrow(CustomerHealthEvidenceError);
  });
});

function evaluate(account360Value: ReturnType<typeof account360>) {
  return evaluateCustomerHealth({
    account360: account360Value,
    revision: 1,
    evaluationId: `customer-health-evaluation:${"c".repeat(64)}`,
    evaluatedByActorId: actorId,
    evaluatedAt,
  });
}

function account360(facts: ReturnType<typeof fact>[]) {
  return projectCustomerAccount360({
    account: account(),
    currentFacts: facts,
    historyCount: facts.length + 1,
    evaluatedAt,
  });
}

function account() {
  return buildCustomerAccountRevision({
    tenantId,
    workspaceId,
    accountId,
    organizationEntityId: "organization:acme",
    revision: 1,
    mutationId: customerMutationId({
      accountId,
      idempotencyKey: "health-account",
      operation: "account.create",
    }),
    name: "Acme",
    lifecycle: "active",
    accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
    crmPermissions: {
      readScope: "workspace_members",
      writeScope: "account_owner",
      externalWriteState: "disabled",
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    },
    ownerActorId: actorId,
    revisedByActorId: actorId,
    revisedAt: "2026-09-08T00:00:00.000Z",
  });
}

function fact(
  key: string,
  idempotencyKey: string,
  value: CustomerFactValue,
  staleAfter = "2026-09-15T00:00:00.000Z",
) {
  const factId = customerFactId({ accountId, idempotencyKey });
  return buildCustomerFactRevision({
    tenantId,
    workspaceId,
    accountId,
    factId,
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey, operation: "fact.record" }),
    factKey: key,
    value,
    source: {
      sourceKind: "manual",
      sourceId: `source:${idempotencyKey}`,
      sourceRevisionId: `source:${idempotencyKey}:v1`,
      sourceRevisionSha256: "a".repeat(64),
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
    confidenceBasisPoints: 9_000,
    validFrom: "2026-09-08T00:00:00.000Z",
    staleAfter,
    recordedByActorId: actorId,
    recordedAt: "2026-09-08T00:01:00.000Z",
  });
}
