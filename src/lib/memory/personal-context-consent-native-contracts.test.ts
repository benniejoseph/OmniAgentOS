import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTANCE_CONTRACT, PERSONAL_CONTEXT_CONSENT_NATIVE_DECISION_CONTRACT,
  personalContextConsentNativeAcceptanceSchema, personalContextConsentNativeCurrentSchema,
  personalContextConsentNativeDecisionToken, personalContextConsentNativeIntent,
  personalContextConsentNativeRequestSchema, personalContextConsentNativeStateSchema,
  type PersonalContextConsentNativeRequest, type PersonalContextConsentNativeState,
} from "@/lib/memory/personal-context-consent-native-contracts";
import { PERSONAL_CONTEXT_NOTICE_SHA256, personalContextConsentNotice } from "@/lib/memory/personal-context-consent";

const tenantId = "consent-test", ownerActorId = "actor:11111111-1111-4111-8111-111111111111";
const initial: PersonalContextConsentNativeState = { state: "inactive", consentGeneration: 0, lifecycleRevision: 0 };
const token = personalContextConsentNativeDecisionToken({ tenantId, ownerActorId, state: initial });
const request: PersonalContextConsentNativeRequest = {
  contract: PERSONAL_CONTEXT_CONSENT_NATIVE_DECISION_CONTRACT, action: "activate", noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
  expectedState: "inactive", expectedConsentGeneration: 0, expectedLifecycleRevision: 0, expectedDecisionToken: token,
};
const input = { tenantId, ownerActorId, idempotencyKey: "consent-key", request };

describe("exact native personal recall consent contract", () => {
  it("keeps never-enabled, revoked, and active generations distinct", () => {
    for (const state of [initial, { state: "inactive", consentGeneration: 3, lifecycleRevision: 2 }, { state: "active", consentGeneration: 4, lifecycleRevision: 1 }]) {
      expect(personalContextConsentNativeStateSchema.safeParse(state).success).toBe(true);
    }
    for (const state of [
      { state: "active", consentGeneration: 0, lifecycleRevision: 1 },
      { state: "inactive", consentGeneration: 3, lifecycleRevision: 0 },
      { state: "inactive", consentGeneration: 3, lifecycleRevision: 1 },
    ]) expect(personalContextConsentNativeStateSchema.safeParse(state).success).toBe(false);
  });

  it("binds the current decision token to owner, tenant and inactive generation", () => {
    expect(personalContextConsentNativeDecisionToken({ tenantId, ownerActorId, state: { state: "inactive", consentGeneration: 1, lifecycleRevision: 2 } })).not.toBe(token);
    expect(personalContextConsentNativeDecisionToken({ tenantId: "other-tenant", ownerActorId, state: initial })).not.toBe(token);
    expect(personalContextConsentNativeDecisionToken({ tenantId, ownerActorId: "actor:22222222-2222-4222-8222-222222222222", state: initial })).not.toBe(token);
  });

  it("requires the exact notice and has no extra request authority fields", () => {
    expect(personalContextConsentNativeRequestSchema.safeParse({ ...request, noticeSha256: "0".repeat(64) }).success).toBe(false);
    expect(personalContextConsentNativeRequestSchema.safeParse({ ...request, ownerActorId }).success).toBe(false);
    expect(createHash("sha256").update(personalContextConsentNotice().text, "utf8").digest("hex")).toBe(PERSONAL_CONTEXT_NOTICE_SHA256);
  });

  it("binds a raw key to one request while retaining a stable acceptance identity", () => {
    const original = personalContextConsentNativeIntent(input);
    const changed = personalContextConsentNativeIntent({ ...input, request: { ...request, action: "revoke" } });
    expect(original.keySha256).toBe(createHash("sha256").update("consent-key").digest("hex"));
    expect(changed.acceptanceId).toBe(original.acceptanceId);
    expect(changed.requestSha256).not.toBe(original.requestSha256);
    expect(() => personalContextConsentNativeIntent({ ...input, idempotencyKey: "" })).toThrow("Idempotency-Key");
    expect(() => personalContextConsentNativeIntent({ ...input, idempotencyKey: " key " })).toThrow("Idempotency-Key");
  });

  it("validates one exact transition, including explicitly receipted fresh no-ops", () => {
    const intent = personalContextConsentNativeIntent(input);
    const accepted = {
      contract: PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTANCE_CONTRACT, id: intent.acceptanceId,
      tenantId, ownerActorId, action: "activate", idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
      noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256, expectedDecisionToken: token, before: initial,
      after: { state: "active", consentGeneration: 1, lifecycleRevision: 1 },
      acceptedAt: "2026-10-05T01:00:00.000Z", changed: true,
    };
    expect(personalContextConsentNativeAcceptanceSchema.safeParse(accepted).success).toBe(true);
    expect(personalContextConsentNativeAcceptanceSchema.safeParse({ ...accepted, changed: false }).success).toBe(false);
    expect(personalContextConsentNativeAcceptanceSchema.safeParse({ ...accepted, after: { state: "active", consentGeneration: 2, lifecycleRevision: 1 } }).success).toBe(false);
    expect(personalContextConsentNativeAcceptanceSchema.safeParse({ ...accepted, idempotencyKeySha256: "0".repeat(64) }).success).toBe(false);
    expect(personalContextConsentNativeAcceptanceSchema.safeParse({ ...accepted, action: "revoke", changed: false, after: initial }).success).toBe(true);
  });

  it("allows read-only public token redaction without inventing active authority", () => {
    const current = { contract: "asael-personal-context-consent-read:1", tenantId, ownerActorId,
      ...initial, notice: personalContextConsentNotice(), authority: null, decisionToken: null };
    expect(personalContextConsentNativeCurrentSchema.safeParse(current).success).toBe(true);
    expect(personalContextConsentNativeCurrentSchema.safeParse({ ...current, state: "active", consentGeneration: 1, lifecycleRevision: 1 }).success).toBe(false);
  });
});
