import { describe, expect, it } from "vitest";
import { nativeCredentialRotationFixture } from "../../../tests/fixtures/native-credential-rotation";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeActionSchema } from "./native-control-contracts";
import { connectorNativeCredentialPrepareRequestSchema, connectorNativeCredentialPreparationSchema, connectorNativeCredentialPreparationReadSchema,
  connectorNativeCredentialRotationActionSchema, connectorNativeCredentialRotationSettlementSchema } from "./native-credential-rotation-contracts";

describe("prepared native credential wire boundary", () => {
  it("counts UTF-8 token bytes while leaving the safe intent and every proof secret-free", () => {
    const f = nativeCredentialRotationFixture();
    for (const token of ["éééé", "a".repeat(8192)]) expect(connectorNativeCredentialPrepareRequestSchema.safeParse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, bearerToken: token } }).success).toBe(true);
    for (const token of ["ééé", "é".repeat(4097), " token-value", "token\nvalue"]) expect(connectorNativeCredentialPrepareRequestSchema.safeParse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, bearerToken: token } }).success).toBe(false);
    expect(JSON.stringify([f.preparationIntent, f.preparation, f.abandonedPrepared, f.rotationAction])).not.toContain(f.prepareRequest.payload.bearerToken);
    expect(connectorNativeCredentialPrepareRequestSchema.safeParse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, endpoint: "https://different.example.test/" } }).success).toBe(false);
  });
  it("binds safe intent/configuration and a fixed server lifetime even after the timestamp has passed", () => {
    const f = nativeCredentialRotationFixture();
    expect(connectorNativeCredentialPreparationSchema.parse(f.preparation)).toEqual(f.preparation);
    for (const patch of [{ expiresAt: "2026-10-05T00:16:00.001Z" }, { configurationSha256: canonicalJsonSha256("different configuration") },
      { intentSha256: canonicalJsonSha256("different safe intent") }]) {
      const { preparationSha256: _digest, ...body } = f.preparation;
      const changed = { ...body, ...patch };
      expect(connectorNativeCredentialPreparationSchema.safeParse({ ...changed, preparationSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
  });
  it("requires genuine issued proof or an exact absent-key abandonment and correlates consumed recovery", () => {
    const f = nativeCredentialRotationFixture();
    for (const row of [f.preparedReady, f.preparedExpired, f.preparedConsumed, f.abandonedAbsent, f.abandonedPrepared]) expect(connectorNativeCredentialPreparationReadSchema.parse(row)).toEqual(row);
    expect(connectorNativeCredentialPreparationReadSchema.safeParse({ ...f.preparedConsumed, consumedKeySha256: canonicalJsonSha256("wrong key") }).success).toBe(false);
    expect(connectorNativeCredentialPreparationReadSchema.safeParse({ ...f.abandonedAbsent, preparation: f.preparation }).success).toBe(false);
    expect(connectorNativeCredentialPreparationReadSchema.safeParse({ ...f.preparedReady, bearerToken: "synthetic-never-return" }).success).toBe(false);
  });
  it("supports zero-to-one reconnect and isolates all prior receipt families", () => {
    for (const version of [0, 2]) {
      const f = nativeCredentialRotationFixture(version);
      expect(connectorNativeCredentialRotationActionSchema.parse(f.rotationAction)).toEqual(f.rotationAction);
      expect(f.rotationAction.settlement?.result.credentialVersion).toBe(version + 1);
      expect(f.rotationAction.acceptance.reviewSha256).toBe(f.preparation.preparationSha256);
      expect(connectorNativeActionSchema.safeParse(f.rotationAction).success).toBe(false);
    }
  });
  it("rejects resealed receipts claiming enabled state, retained tools or provider effects", () => {
    const f = nativeCredentialRotationFixture(), settlement = f.rotationAction.settlement!;
    const { settlementSha256: _digest, ...body } = settlement;
    for (const patch of [{ connectorStatus: "active" }, { contractCount: 1 }, { credentialVersion: 0 }, { providerConnected: true },
      { contractsSha256: canonicalJsonSha256(["surviving tool"]) }, { failureCode: "discovery_failed", status: "failed" }]) {
      const changed = { ...body, result: { ...body.result, ...patch } };
      expect(connectorNativeCredentialRotationSettlementSchema.safeParse({ ...changed, settlementSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
  });
});
