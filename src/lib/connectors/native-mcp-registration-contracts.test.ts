import { describe, expect, it } from "vitest";
import { nativeMcpRegistrationFixture, nativeMcpRegistrationNormalizationFixtures } from "../../../tests/fixtures/native-mcp-registration";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createMcpToolId, parseMcpToolId } from "./store";
import { connectorNativeActionSchema, connectorNativePreparationId } from "./native-control-contracts";
import { connectorNativeCredentialRotationActionSchema } from "./native-credential-rotation-contracts";
import { connectorNativeCredentialRemovalActionSchema } from "./native-credential-removal-contracts";
import { connectorNativeTrashActionSchema } from "./native-trash-contracts";
import {
  buildConnectorNativeMcpRegistrationPreparationIntent, connectorNativeMcpRegistrationTargetId,
  connectorNativeMcpRegistrationPrepareRequestSchema, connectorNativeMcpRegistrationPreparationIntentSchema,
  connectorNativeMcpRegistrationPreparationSchema, connectorNativeMcpRegistrationPreparationReadSchema,
  connectorNativeMcpRegistrationActionSchema, connectorNativeMcpRegistrationSettlementSchema,
  normalizeNativeMcpRegistrationEndpoint, nativeMcpRegistrationEndpointProjection,
} from "./native-mcp-registration-contracts";

const authModes = ["none", "bearer_env", "bearer_vault"] as const;

describe("prepared native MCP registration boundary", () => {
  it("supports all existing auth choices without putting private inputs in any durable public proof", () => {
    for (const authType of authModes) for (const privateEndpoint of [false, true]) {
      const f = nativeMcpRegistrationFixture(authType, privateEndpoint);
      expect(connectorNativeMcpRegistrationPrepareRequestSchema.parse(f.prepareRequest)).toEqual(f.prepareRequest);
      expect(buildConnectorNativeMcpRegistrationPreparationIntent(f.scope, f.preparationKey, f.prepareRequest)).toEqual(f.preparationIntent);
      expect(f.preparation.review).toBeNull();
      expect(f.preparation.declaration.endpointRedacted).toBe(privateEndpoint);
      expect(f.registrationAction.settlement?.result.credentialVersion).toBe(authType === "bearer_vault" ? 1 : 0);
      const durable = JSON.stringify([f.preparationIntent, f.preparation, f.preparedConsumed, f.abandonedPrepared, f.registrationAction]);
      for (const transient of ["synthetic-fixture-only", "synthetic-private-query", "synthetic-fragment", f.preparationKey, f.registrationKey]) {
        expect(durable).not.toContain(transient);
      }
      expect(f.prepareRequest.payload.bearerToken !== null).toBe(authType === "bearer_vault");
    }
  });

  it("keeps derived targets delimiter-safe for the actual existing MCP tool parser", () => {
    const f = nativeMcpRegistrationFixture();
    expect(f.connectorId).toMatch(/^native-mcp-[a-f0-9]{64}$/);
    for (const toolName of ["read", "namespaced:read", "folder/name", "read space", "資料"]) {
      expect(parseMcpToolId(createMcpToolId(f.connectorId, toolName))).toEqual({ connectorId: f.connectorId, toolName });
    }
    for (const scope of [{ ...f.scope, tenantId: "other-tenant" }, { ...f.scope, ownerActorId: "other@example.test" },
      { ...f.scope, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" }]) {
      expect(connectorNativeMcpRegistrationTargetId(scope, f.nonce)).not.toBe(f.connectorId);
    }
    expect(f.preparation.id).not.toBe(connectorNativePreparationId(f.scope, f.preparationIntent.keySha256));
    expect(connectorNativeMcpRegistrationPreparationIntentSchema.safeParse({ ...f.preparationIntent, connectorId: "native-mcp-" + "f".repeat(64) }).success).toBe(false);
  });

  it("preserves intended escaped URLs and marks even empty private delimiters for staging", () => {
    const rows = nativeMcpRegistrationNormalizationFixtures();
    const byInput = new Map(rows.map((row) => [row.input, row]));
    expect(byInput.get("https://example.test/a/%2f/%7e/mcp")?.normalized).toBe("https://example.test/a/%2f/%7e/mcp");
    expect(byInput.get("https://example.test/a/%2e%2e/mcp")?.normalized).toBe("https://example.test/mcp");
    expect(byInput.get("https://EXAMPLE.test:443/mcp")?.normalized).toBe("https://example.test/mcp");
    for (const suffix of ["?", "#", "?#", "?fixture=synthetic-private-query#synthetic-fragment"]) {
      const row = byInput.get(`https://example.test/mcp${suffix}`)!;
      expect(row.normalized).toBe(`https://example.test/mcp${suffix}`);
      expect(row.endpoint).toBe("https://example.test/mcp");
      expect(row.endpointRedacted).toBe(true);
    }
    expect(normalizeNativeMcpRegistrationEndpoint("https://example.test/mcp?fixture='synthetic'"))
      .toBe("https://example.test/mcp?fixture=%27synthetic%27");
    const syntheticUserInfo = new URL("https://example.test/mcp");
    syntheticUserInfo.username = "owner";
    syntheticUserInfo.password = "synthetic";
    for (const endpoint of [" https://example.test/mcp", "https://example.test/mcp\n", syntheticUserInfo.href, "file:///tmp/mcp", "javascript:fixture"]) {
      expect(() => normalizeNativeMcpRegistrationEndpoint(endpoint)).toThrow();
    }
  });

  it("rejects auth, safe projection and policy edits instead of silently rewriting a saved intent", () => {
    const f = nativeMcpRegistrationFixture("bearer_vault", true);
    for (const declaration of [{ ...f.prepareRequest.declaration, name: " Fixture MCP " },
      { ...f.prepareRequest.declaration, endpointRedacted: false }, { ...f.prepareRequest.declaration, endpoint: "https://different.example.test/mcp" },
      { ...f.prepareRequest.declaration, authTokenEnv: "OMNIAGENT_CONNECTOR_FIXTURE_TOKEN" }, { ...f.prepareRequest.declaration, defaultRiskLevel: 4 },
      { ...f.prepareRequest.declaration, authHeaderName: "Authorization" }, { ...f.prepareRequest.declaration, specSource: "text" }]) {
      expect(connectorNativeMcpRegistrationPrepareRequestSchema.safeParse({ ...f.prepareRequest, declaration }).success).toBe(false);
    }
    for (const authType of authModes) {
      const sample = nativeMcpRegistrationFixture(authType);
      expect(connectorNativeMcpRegistrationPrepareRequestSchema.safeParse({ ...sample.prepareRequest,
        payload: { ...sample.prepareRequest.payload, bearerToken: authType === "bearer_vault" ? null : "synthetic-fixture-only" } }).success).toBe(false);
    }
    for (const endpoint of ["https://example.test/mcp?", "https://example.test/mcp#"]) {
      expect(connectorNativeMcpRegistrationPreparationIntentSchema.safeParse({ ...f.preparationIntent,
        declaration: { ...f.prepareRequest.declaration, endpoint } }).success).toBe(false);
    }
  });

  it("counts UTF-8 bytes for bearer input and keeps its exact transient value", () => {
    const f = nativeMcpRegistrationFixture("bearer_vault");
    for (const token of ["éééé", "a".repeat(8192), "é".repeat(4096)]) {
      expect(connectorNativeMcpRegistrationPrepareRequestSchema.parse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, bearerToken: token } }).payload.bearerToken).toBe(token);
    }
    for (const token of ["ééé", "é".repeat(4097), " token-value", "token-value ", "token\nvalue", "token\rvalue"]) {
      expect(connectorNativeMcpRegistrationPrepareRequestSchema.safeParse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, bearerToken: token } }).success).toBe(false);
    }
  });

  it("binds fixed fifteen-minute proof lifetime, original scope and safe intent", () => {
    const f = nativeMcpRegistrationFixture();
    expect(connectorNativeMcpRegistrationPreparationSchema.parse(f.preparation)).toEqual(f.preparation);
    const { preparationSha256: _hash, ...body } = f.preparation;
    for (const patch of [{ expiresAt: "2026-10-05T00:16:00.001Z" }, { preparedAt: "2026-10-05T00:01:00.001Z" },
      { intentSha256: canonicalJsonSha256("different intent") }, { review: {} },
      { id: connectorNativePreparationId(f.scope, f.preparationIntent.keySha256) }]) {
      const changed = { ...body, ...patch };
      expect(connectorNativeMcpRegistrationPreparationSchema.safeParse({ ...changed, preparationSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
  });

  it("distinguishes missing, expired, consumed and honest absent-key abandonment", () => {
    const f = nativeMcpRegistrationFixture();
    for (const read of [f.preparedReady, f.preparedExpired, f.preparedConsumed, f.abandonedAbsent, f.abandonedPrepared]) {
      expect(connectorNativeMcpRegistrationPreparationReadSchema.parse(read)).toEqual(read);
    }
    expect(connectorNativeMcpRegistrationPreparationReadSchema.safeParse({ ...f.preparedConsumed, consumedKeySha256: canonicalJsonSha256("different key") }).success).toBe(false);
    expect(connectorNativeMcpRegistrationPreparationReadSchema.safeParse({ ...f.abandonedAbsent, preparation: f.preparation }).success).toBe(false);
    expect(connectorNativeMcpRegistrationPreparationReadSchema.safeParse({ ...f.preparedReady, payload: f.prepareRequest.payload }).success).toBe(false);
    expect(f.abandonedAbsent.preparation).toBeNull();
    expect(JSON.stringify(f.abandonedAbsent)).not.toContain("expiresAt");
    expect(nativeMcpRegistrationEndpointProjection(f.prepareRequest.payload.endpoint)).toEqual({ endpoint: f.preparation.declaration.endpoint, endpointRedacted: false });
  });

  it("isolates old families and rejects receipts claiming provider connectivity or discovered tools", () => {
    const f = nativeMcpRegistrationFixture("bearer_vault");
    expect(connectorNativeMcpRegistrationActionSchema.parse(f.registrationAction)).toEqual(f.registrationAction);
    for (const schema of [connectorNativeActionSchema, connectorNativeCredentialRotationActionSchema, connectorNativeCredentialRemovalActionSchema, connectorNativeTrashActionSchema]) {
      expect(schema.safeParse(f.registrationAction).success).toBe(false);
    }
    const { settlementSha256: _hash, ...body } = f.registrationAction.settlement!;
    for (const patch of [{ connectorStatus: "active" }, { contractCount: 1 }, { credentialVersion: 2 }, { providerConnected: true },
      { contractsSha256: canonicalJsonSha256(["discovered tool"]) }, { failureCode: "discovery_failed", status: "failed" }]) {
      const changed = { ...body, result: { ...body.result, ...patch } };
      expect(connectorNativeMcpRegistrationSettlementSchema.safeParse({ ...changed, settlementSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
  });
});
