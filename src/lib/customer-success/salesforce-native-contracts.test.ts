import { describe, expect, test } from "vitest";
import { buildSalesforceNativeAcceptance, buildSalesforceNativeIntent, salesforceNativeAcceptanceSchema, salesforceNativeActionSchema,
  salesforceNativeRequestSchema, sealSalesforceNativeConnection } from "@/lib/customer-success/salesforce-native-contracts";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";
const scope = { tenantId: "salesforce-native", workspaceId: "workspace:salesforce-native", ownerActorId: "actor:11111111-1111-4111-8111-111111111111" };
const review = sealSalesforceNativeConnection({ ...scope, connectionId: `salesforce-connection:${"a".repeat(64)}`, oauthGrantId: "grant-one",
  authorizationGeneration: 3, organizationIdSha256: "b".repeat(64), instanceOrigin: "https://tenant.my.salesforce.com",
  connectionState: "active", grantStatus: "active", grantAuthorizationGeneration: 3, readScopesGranted: true });
const request = salesforceNativeRequestSchema.parse({ contract: "customer-salesforce-action-request:1", workspaceId: scope.workspaceId, action: "sync", review });
describe("native Salesforce exact intent and truthful outcomes", () => {
  test("pins full reviewed generation and standard Account key namespace without a clock in the intent", () => {
    const intent = buildSalesforceNativeIntent({ scope, request, idempotencyKey: "one" });
    expect(intent.idempotencyKeySha256).toBe(idempotencyKeySha256({ tenantId: scope.tenantId, idempotencyKey: "one" }));
    const accepted = buildSalesforceNativeAcceptance(intent, "2026-10-05T12:00:00.000Z");
    expect(accepted.requestSha256).toBe(canonicalJsonSha256(intent)); expect(accepted.localRevoked).toBe(false);
    expect(salesforceNativeActionSchema.parse({ acceptance: accepted, state: "accepted", settlement: null }).state).toBe("accepted");
    const { acceptanceSha256: _, ...changed } = { ...accepted, requestSha256: "f".repeat(64) };
    expect(salesforceNativeAcceptanceSchema.safeParse({ ...changed, acceptanceSha256: canonicalJsonSha256(changed) }).success).toBe(false);
  });
  test("rejects replacement generation, added credentials and cross-workspace review", () => {
    const { reviewSha256: _, ...body } = review;
    const changed = sealSalesforceNativeConnection({ ...body, grantAuthorizationGeneration: 4 });
    expect(salesforceNativeRequestSchema.safeParse({ ...request, review: changed }).success).toBe(false);
    expect(salesforceNativeRequestSchema.safeParse({ ...request, credentials: "invented" }).success).toBe(false);
    expect(salesforceNativeRequestSchema.safeParse({ ...request, workspaceId: "workspace:other" }).success).toBe(false);
  });
  test("disconnect local commit and provider uncertainty remain different evidence", () => {
    const intent = buildSalesforceNativeIntent({ scope, request: { ...request, action: "disconnect" }, idempotencyKey: "disconnect" });
    const acceptance = buildSalesforceNativeAcceptance(intent, "2026-10-05T12:00:00.000Z");
    expect(acceptance.localRevoked).toBe(true);
    expect(salesforceNativeActionSchema.parse({ acceptance, state: "settled", settlement: { action: "disconnect", status: "local_revoked",
      providerRevocation: "unconfirmed", settledAt: "2026-10-05T12:01:00.000Z" } }).settlement).toMatchObject({ providerRevocation: "unconfirmed" });
    expect(salesforceNativeActionSchema.safeParse({ acceptance, state: "settled", settlement: null }).success).toBe(false);
  });
});
