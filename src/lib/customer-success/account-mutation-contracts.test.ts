import { describe, expect, it } from "vitest";
import { buildCustomerAccountMutationAcceptance, buildCustomerAccountMutationIntent, customerAccountMutationAcceptanceSchema, customerAccountMutationRequestSchema } from "@/lib/customer-success/account-mutation-contracts";
import { buildCustomerAccountRevision, customerAccountId } from "@/lib/customer-success/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const tenantId = "tenant-a", workspaceId = "workspace:accounts", canonicalActorId = "actor:11111111-1111-4111-8111-111111111111";
const base = { tenantId, workspaceId, canonicalActorId, idempotencyKey: "create-a" };
const owner = { ownerKind: "actor" as const, ownerId: canonicalActorId, displayName: "Owner" };
const create = { operation: "account.create" as const, name: "Acme", accountOwner: owner };

describe("immutable customer account semantic intent", () => {
  it("normalizes create defaults and whitespace without changing existing deterministic account identity", () => {
    const intent = buildCustomerAccountMutationIntent({ ...base, request: create });
    expect(intent.accountId).toBe(customerAccountId({ tenantId, workspaceId, idempotencyKey: base.idempotencyKey }));
    expect(intent).toEqual(buildCustomerAccountMutationIntent({ ...base, request: { ...create, name: " Acme ", lifecycle: "prospect", organizationEntityId: null, customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] } }));
    expect(JSON.stringify(intent)).not.toContain('"idempotencyKey":');
  });
  it("keeps changed semantic input and a different canonical actor distinct under the same mutation key", () => {
    const intent = buildCustomerAccountMutationIntent({ ...base, request: create });
    for (const input of [{ ...base, request: { ...create, name: "Changed" } }, { ...base, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222", request: create }]) {
      const changed = buildCustomerAccountMutationIntent(input);
      expect(changed.accountId).toBe(intent.accountId);
      expect(changed.mutationId).toBe(intent.mutationId);
      expect(canonicalJsonSha256(changed)).not.toBe(canonicalJsonSha256(intent));
    }
  });
  it("preserves sparse revise omission versus explicit null or explicit equal metadata", () => {
    const accountId = buildCustomerAccountMutationIntent({ ...base, request: create }).accountId;
    const input = { ...base, accountId, request: { operation: "account.revise" as const, expectedRevision: 1, name: "Acme" } };
    const intent = buildCustomerAccountMutationIntent(input);
    expect(intent).toEqual(buildCustomerAccountMutationIntent({ ...input, request: { ...input.request, organizationEntityId: undefined } }));
    for (const change of [{ organizationEntityId: null }, { accountOwner: owner }, { expectedRevision: 2 }]) expect(canonicalJsonSha256(buildCustomerAccountMutationIntent({ ...input, request: { ...input.request, ...change } }))).not.toBe(canonicalJsonSha256(intent));
  });
  it.each([
    { operation: "account.revise", expectedRevision: 1 },
    { ...create, customerDataPurposeIds: ["customer_success.account.read", "customer_success.account.manage"] },
    { ...create, customerDataPurposeIds: ["customer_success.account.read", "customer_success.account.read"] },
    { ...create, externalWriteState: "approval_required" },
    { ...create, accountOwner: { ...owner, canonicalActorId } },
  ])("rejects empty, unordered, duplicated or authority-bearing input %#", (request) => {
    expect(customerAccountMutationRequestSchema.safeParse(request).success).toBe(false);
  });
  it("binds immutable acceptance to the first revision, actor, fields, clock and request digest", () => {
    const intent = buildCustomerAccountMutationIntent({ ...base, request: create });
    const account = buildCustomerAccountRevision({ tenantId, workspaceId, accountId: intent.accountId, mutationId: intent.mutationId, revision: 1, name: "Acme", lifecycle: "prospect", accountOwner: owner, crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] }, ownerActorId: canonicalActorId, revisedByActorId: canonicalActorId, revisedAt: "2026-10-04T12:00:00.000Z" });
    const acceptance = buildCustomerAccountMutationAcceptance(intent, account);
    expect(acceptance.requestSha256).toBe(canonicalJsonSha256(intent));
    expect(buildCustomerAccountMutationAcceptance(intent, account)).toEqual(acceptance);
    expect(() => buildCustomerAccountMutationAcceptance(intent, { ...account, name: "Changed" })).toThrow(/submitted fields/);
    expect(() => buildCustomerAccountMutationAcceptance(intent, { ...account, revision: 2 })).toThrow(/submitted identity/);
    expect(customerAccountMutationAcceptanceSchema.safeParse({ ...acceptance, acceptedAt: "2026-10-04T12:00:01.000Z" }).success).toBe(false);
  });
});
