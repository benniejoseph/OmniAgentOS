import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeIntentSchema } from "@/lib/connectors/native-control-contracts";
import { isLegacyOfficialGitHubMcpConnector, isLegacyOfficialGitHubMcpEndpoint } from "@/lib/connectors/mcp-trust";
import * as C from "@/lib/connectors/native-github-upgrade-contracts";
import { nativeGithubUpgradeFixture } from "../../../tests/fixtures/native-github-upgrade";

const reseal = (value: Record<string, unknown>, field: string) => {
  const body = { ...value }; delete body[field];
  return { ...body, [field]: canonicalJsonSha256(body) };
};
describe("strict native official GitHub upgrade protocol", () => {
  it("accepts bounded original-owner evidence for all existing MCP auth modes", () => {
    for (const auth of ["none", "bearer_env", "bearer_vault"] as const) {
      for (const count of [1, 2, 200]) {
        const f = nativeGithubUpgradeFixture(auth, count);
        for (const read of [f.pending, f.expired, f.settled, ...f.failed,
          f.closedAttempt, f.closedAbsent]) {
          expect(C.connectorNativeGithubUpgradeReadSchema.parse(read)).toEqual(read);
        }
        expect(C.connectorNativeGithubUpgradeCloseReadSchema.parse(f.closeSettled)).toEqual(f.settled);
      }
    }
  });
  it("limits eligibility to the legacy official origin and exact /mcp path", () => {
    for (const endpoint of ["https://api.githubcopilot.com/mcp",
      "https://api.githubcopilot.com/mcp/"]) {
      expect(isLegacyOfficialGitHubMcpEndpoint(endpoint)).toBe(true);
      expect(isLegacyOfficialGitHubMcpConnector({ endpoint, transport: "streamable_http" })).toBe(true);
      expect(isLegacyOfficialGitHubMcpConnector({ endpoint, transport: "sse" })).toBe(false);
    }
    for (const endpoint of ["https://api.githubcopilot.com/mcp/x/all",
      "https://api.githubcopilot.com/mcp?token=hidden",
      "https://api.githubcopilot.com:8443/mcp",
      "https://api.githubcopilot.com:443/mcp",
      "https://api.githubcopilot.com/mcp//",
      "https://API.GITHUBCOPILOT.COM/mcp",
      "http://api.githubcopilot.com/mcp",
      "https://api.githubcopilot.com.evil.test/mcp",
      "https://user@api.githubcopilot.com/mcp"]) {
      expect(isLegacyOfficialGitHubMcpEndpoint(endpoint)).toBe(false);
    }
  });
  it("rejects old action families, payload extensions and changed pins", () => {
    const f = nativeGithubUpgradeFixture();
    expect(connectorNativeIntentSchema.safeParse(f.intent).success).toBe(false);
    for (const patch of [{ action: "discover" }, { action: "enable" }, { kind: "openapi" },
      { connectorId: "different" }, { preview: {} }, { endpoint: "https://private.example.test" },
      { bearerToken: "secret" }]) {
      expect(C.connectorNativeGithubUpgradeRequestSchema.safeParse({ ...f.request, ...patch }).success).toBe(false);
    }
  });
  it("binds the 45-second attempt to the original owner, key and review", () => {
    const f = nativeGithubUpgradeFixture();
    for (const patch of [{ expiresAt: "2026-10-05T10:00:46.000Z" },
      { id: `github-upgrade-attempt:${"f".repeat(64)}` },
      { targetEndpoint: "https://example.test/mcp" }]) {
      expect(C.connectorNativeGithubUpgradeAttemptSchema.safeParse(
        reseal({ ...f.attempt, ...patch }, "attemptSha256")).success).toBe(false);
    }
    for (const patch of [{ intentSha256: "f".repeat(64) }, { reviewSha256: "f".repeat(64) },
      { connectorId: "different" }]) {
      expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({ ...f.pending,
        attempt: reseal({ ...f.attempt, ...patch }, "attemptSha256") }).success).toBe(false);
    }
  });
  it("rejects resealed success that enables, hides review or changes credentials", () => {
    const f = nativeGithubUpgradeFixture();
    if (f.settled.state !== "settled") throw new Error("Fixture should settle.");
    const settlement = f.settled.settlement;
    for (const patch of [{ connectorStatus: "active" }, { approvalRequired: true },
      { defaultRiskLevel: 0 }, { pendingCount: 1 }, { credentialVersion: 8 },
      { endpoint: "https://api.githubcopilot.com/mcp" }, { contractCount: 201 },
      { providerConnected: true }]) {
      expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({ ...f.settled,
        settlement: reseal({ ...settlement,
          result: { ...settlement.result, ...patch } }, "settlementSha256") }).success).toBe(false);
    }
    expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({ ...f.settled,
      settlement: reseal({ ...settlement, settledAt: f.attempt.expiresAt },
        "settlementSha256") }).success).toBe(false);
  });
  it("keeps null/expiry recoverable through exact close and preserves settled wins", () => {
    const f = nativeGithubUpgradeFixture();
    expect(C.connectorNativeGithubUpgradeCloseReadSchema.safeParse(f.expired).success).toBe(false);
    expect(C.connectorNativeGithubUpgradeCloseReadSchema.safeParse(f.pending).success).toBe(false);
    if (f.closedAbsent.state !== "closed" || f.closedAttempt.state !== "closed") {
      throw new Error("Fixture should close.");
    }
    expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({
      ...f.closedAbsent, attempt: f.attempt,
    }).success).toBe(false);
    expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({
      ...f.closedAttempt, attempt: null,
    }).success).toBe(false);
    expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({
      ...f.closedAttempt, closure: reseal({
        ...f.closedAttempt.closure, closedAt: "2026-10-05T09:59:59.999Z",
      }, "closureSha256"),
    }).success).toBe(false);
    expect(C.connectorNativeGithubUpgradeReadSchema.safeParse({
      ...f.closedAttempt, closure: reseal({
        ...f.closedAttempt.closure, intentSha256: "f".repeat(64),
      }, "closureSha256"),
    }).success).toBe(false);
  });
});
