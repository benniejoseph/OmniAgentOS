import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/security/audit-store", () => ({
  listSecurityAudits: vi.fn().mockResolvedValue([{ id: "audit-1", tenantId: "owner", actorId: "user", actorRole: "admin", action: "read", resourceType: "memory", decision: "allow", metadata: {}, createdAt: "2026-08-25T00:00:00.000Z" }]),
}));

describe("signed audit export", () => {
  afterEach(() => { delete process.env.OMNIAGENT_REPORT_SIGNING_SECRET; });

  it("verifies an intact chain and rejects changed records", async () => {
    process.env.OMNIAGENT_REPORT_SIGNING_SECRET = "test-signing-secret-that-is-long-enough";
    const { createSignedAuditExport, verifySignedAuditExport } = await import("@/lib/security/audit-export");
    const report = await createSignedAuditExport("owner");
    expect(verifySignedAuditExport(report)).toMatchObject({ valid: true, records: 1 });
    report.entries[0].record.action = "tampered";
    expect(verifySignedAuditExport(report)).toMatchObject({ valid: false });
  });
});
