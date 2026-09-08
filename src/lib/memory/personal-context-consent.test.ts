import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_CONTEXT_NOTICE_SHA256,
  PERSONAL_CONTEXT_NOTICE_TEXT,
  buildPersonalContextConsentAuthorityV1,
  personalContextConsentAuthorityV1Schema,
  personalContextConsentStatus,
} from "@/lib/memory/personal-context-consent";

const input = {
  tenantId: "tenant:test",
  actorId: "actor:11111111-1111-4111-8111-111111111111",
  consentGeneration: 2,
  activatedAt: "2026-09-08T01:00:00.000Z",
};

describe("personal context consent", () => {
  it("pins the exact informed-notice text", () => {
    expect(
      createHash("sha256").update(PERSONAL_CONTEXT_NOTICE_TEXT).digest("hex"),
    ).toBe(PERSONAL_CONTEXT_NOTICE_SHA256);
  });

  it("builds a digest-bound active authority", () => {
    const authority = buildPersonalContextConsentAuthorityV1(input);

    expect(personalContextConsentAuthorityV1Schema.parse(authority)).toEqual(
      authority,
    );
    expect(personalContextConsentStatus(authority)).toMatchObject({
      state: "active",
      authority: { consentGeneration: 2, lifecycleRevision: 1 },
      notice: { sha256: PERSONAL_CONTEXT_NOTICE_SHA256 },
    });
  });

  it("rejects authority-coordinate or digest tampering", () => {
    const authority = buildPersonalContextConsentAuthorityV1(input);

    expect(() => personalContextConsentAuthorityV1Schema.parse({
      ...authority,
      consentGeneration: 3,
    })).toThrow("Personal-context consent authority digest is invalid");
    expect(() => personalContextConsentAuthorityV1Schema.parse({
      ...authority,
      actorId: "actor:22222222-2222-4222-8222-222222222222",
    })).toThrow("Personal-context consent authority digest is invalid");
  });

  it("reports inactive without inventing authority", () => {
    expect(personalContextConsentStatus(null)).toMatchObject({
      state: "inactive",
      authority: null,
    });
  });
});
