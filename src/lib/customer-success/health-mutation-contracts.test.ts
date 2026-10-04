import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCustomerAccountRevision, customerAccountId, customerMutationId, projectCustomerAccount360 } from "@/lib/customer-success/contracts";
import { customerHealthEvaluationId } from "@/lib/customer-success/health-contracts";
import { evaluateCustomerHealth } from "@/lib/customer-success/health-engine";
import {
  CUSTOMER_HEALTH_REVISION_MAX, buildCustomerHealthEvaluationIntent, buildCustomerHealthEvaluationAcceptance,
  customerHealthEvaluationRequestSchema, customerHealthEvaluationAcceptanceSchema,
  customerHealthEvaluationCurrentAccountSchema, type CustomerHealthEvaluationRequest,
} from "@/lib/customer-success/health-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const tenantId = "health-native", workspaceId = "workspace:health-native", canonicalActorId = "actor:11111111-1111-4111-8111-111111111111";
const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account" });
const account = buildCustomerAccountRevision({ tenantId, workspaceId, accountId, revision: 1,
  mutationId: customerMutationId({ accountId, idempotencyKey: "account", operation: "account.create" }),
  name: "Fixture", lifecycle: "active", accountOwner: { ownerKind: "actor", ownerId: canonicalActorId, displayName: "Owner" },
  crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled",
    customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] },
  ownerActorId: canonicalActorId, revisedByActorId: canonicalActorId, revisedAt: "2026-10-05T10:00:00.000Z" });
const request: CustomerHealthEvaluationRequest = { contract: "customer-health-evaluation-request:1", workspaceId,
  expectedAccountRevision: 1, expectedAccountSha256: account.accountSha256, modelSuggestions: [] };
const args = { tenantId, workspaceId, canonicalActorId, accountId, idempotencyKey: "evaluate", request };
function score(evaluatedAt = "2026-10-05T12:00:00.000Z") {
  return evaluateCustomerHealth({ account360: projectCustomerAccount360({ account, currentFacts: [], historyCount: 1, evaluatedAt }),
    revision: 1, evaluationId: customerHealthEvaluationId({ accountId, idempotencyKey: args.idempotencyKey }), evaluatedByActorId: canonicalActorId, evaluatedAt, suggestions: [] });
}

describe("exact native Account health intent and compact acceptance", () => {
  it("requires the exact bounded SQL revision, explicit workspace and empty suggestions without normalization", () => {
    expect(customerHealthEvaluationRequestSchema.parse(request)).toEqual(request);
    for (const patch of [{ expectedAccountRevision: CUSTOMER_HEALTH_REVISION_MAX + 1 }, { expectedAccountRevision: 0 },
      { modelSuggestions: [{}] }, { workspaceId: ` ${workspaceId}` }, { accountId }, { contract: undefined }, { modelSuggestions: undefined }]) {
      expect(customerHealthEvaluationRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
    expect(customerHealthEvaluationRequestSchema.safeParse({ ...request, expectedAccountRevision: CUSTOMER_HEALTH_REVISION_MAX }).success).toBe(true);
  });
  it("keeps evaluation identity and tenant-key digest stable while changing semantic intent changes its digest", () => {
    const intent = buildCustomerHealthEvaluationIntent(args);
    expect(intent.evaluationId).toBe(customerHealthEvaluationId({ accountId, idempotencyKey: args.idempotencyKey }));
    expect(intent.idempotencyKeySha256).toBe(createHash("sha256").update(`${tenantId}\0evaluate`).digest("hex"));
    expect(intent.idempotencyKeySha256).not.toBe(createHash("sha256").update("evaluate").digest("hex"));
    const changed = buildCustomerHealthEvaluationIntent({ ...args, request: { ...request, expectedAccountSha256: "a".repeat(64) } });
    expect(changed.evaluationId).toBe(intent.evaluationId);
    expect(canonicalJsonSha256(changed)).not.toBe(canonicalJsonSha256(intent));
    expect(() => buildCustomerHealthEvaluationIntent({ ...args, idempotencyKey: " evaluate" })).toThrow();
    expect(() => buildCustomerHealthEvaluationIntent({ ...args, workspaceId: "workspace:another" })).toThrow();
  });
  it("builds bounded unknown-health acceptance from the original score without retaining evidence or inventing timestamps", () => {
    const intent = buildCustomerHealthEvaluationIntent(args), evaluated = score();
    const acceptance = buildCustomerHealthEvaluationAcceptance(intent, evaluated);
    expect(acceptance).toMatchObject({ accountRevision: 1, scoreRevision: 1, status: "unknown", scoreBasisPoints: null,
      acceptedAt: evaluated.evaluatedAt, requestSha256: canonicalJsonSha256(intent), inputSha256: evaluated.inputSha256 });
    expect(JSON.stringify(acceptance).length).toBeLessThan(4_096);
    expect(acceptance).not.toHaveProperty("factors");
    expect(buildCustomerHealthEvaluationAcceptance(intent, score("2026-10-06T12:00:00.000Z")).requestSha256).toBe(acceptance.requestSha256);
    expect(acceptance.requestSha256).not.toBe(acceptance.inputSha256);
  });
  it("rejects mismatched evaluated owner, reviewed pin, compact lineage and null-health contradictions", () => {
    const intent = buildCustomerHealthEvaluationIntent(args), evaluated = score(), accepted = buildCustomerHealthEvaluationAcceptance(intent, evaluated);
    expect(() => buildCustomerHealthEvaluationAcceptance({ ...intent, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" }, evaluated)).toThrow();
    expect(() => buildCustomerHealthEvaluationAcceptance({ ...intent, request: { ...intent.request, expectedAccountRevision: 2 } }, evaluated)).toThrow();
    for (const patch of [{ accountRevision: 2 }, { scoreRevision: CUSTOMER_HEALTH_REVISION_MAX + 1 }, { status: "healthy" }, { policySha256: "a".repeat(64) }]) {
      const body = { ...accepted, ...patch }; delete (body as Partial<typeof accepted>).acceptanceSha256;
      expect(customerHealthEvaluationAcceptanceSchema.safeParse({ ...body, acceptanceSha256: canonicalJsonSha256(body) }).success).toBe(false);
    }
    expect(customerHealthEvaluationCurrentAccountSchema.safeParse({ accountId, revisionId: `${accountId}:v2`, revision: 1, accountSha256: account.accountSha256 }).success).toBe(false);
  });
});
