import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConnectorNativeIntent, connectorNativeKeySha256, connectorNativePinSchema, connectorNativeRequestSchema,
  connectorNativeSummarySchema, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { connectorNativePrivateDigest, connectorNativePrivateFingerprint, connectorNativePublicEndpoint } from "@/lib/connectors/native-control-private";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "connector-native", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const pin = () => sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64),
  contractsSha256: "b".repeat(64), configurationSha256: "c".repeat(64), reviewFingerprint: "d".repeat(43), credentialVersion: 2 });
describe("strict native connector review intent", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("binds every review field and the complete request without timestamps or raw credentials", () => {
    const request = connectorNativeRequestSchema.parse({ contract: "asael-connector-action:1", kind: "mcp", connectorId: "connector-one", action: "review_contracts", review: pin() });
    const intent = buildConnectorNativeIntent(scope, "connector-key", request);
    expect(intent.keySha256).toBe(idempotencyKeySha256({ tenantId: scope.tenantId, idempotencyKey: "connector-key" }));
    expect(buildConnectorNativeIntent(scope, "connector-key", request)).toEqual(intent);
    expect(connectorNativeRequestSchema.safeParse({ ...request, bearerToken: "never persist" }).success).toBe(false);
    expect(connectorNativePinSchema.safeParse({ ...request.review, credentialVersion: 3 }).success).toBe(false);
    expect(connectorNativePinSchema.safeParse({ ...request.review, configurationSha256: "e".repeat(64) }).success).toBe(false);
    expect(connectorNativeRequestSchema.safeParse({ ...request, connectorId: "another" }).success).toBe(false);
    expect(connectorNativeKeySha256({ ...scope, tenantId: "another" }, "connector-key")).not.toBe(intent.keySha256);
    expect(canonicalJsonSha256(buildConnectorNativeIntent(scope, "connector-key", { ...request, action: "disable" }))).not.toBe(canonicalJsonSha256(intent));
  });
  it("hides URL secrets and makes full configuration and contract bindings tenant-keyed", () => {
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "fixture-connector-review-secret");
    const raw = "https://user:secret@example.test/mcp?api_key=short-secret#fragment";
    expect(connectorNativePublicEndpoint(raw)).toEqual({ endpoint: "https://example.test/mcp", endpointRedacted: true });
    const digest = connectorNativePrivateDigest(scope.tenantId, raw);
    expect(digest).not.toBe(canonicalJsonSha256(raw));
    expect(connectorNativePrivateDigest("another", raw)).not.toBe(digest);
    expect(connectorNativePrivateFingerprint(scope.tenantId, "known-internal-fingerprint")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connectorNativeSummarySchema.shape.endpoint.safeParse(raw).success).toBe(false);
    expect(connectorNativeSummarySchema.shape.endpoint.safeParse("not a URL").success).toBe(false);
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "rotated-fixture-connector-secret");
    expect(connectorNativePrivateDigest(scope.tenantId, raw)).not.toBe(digest);
  });
});
