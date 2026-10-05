import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeIntentSchema } from "@/lib/connectors/native-control-contracts";
import * as C from "@/lib/connectors/native-mcp-discovery-contracts";
import { nativeMcpDiscoveryFixture } from "../../../tests/fixtures/native-mcp-discovery";

const reseal = (value: Record<string, unknown>, field: string) => {
  const body = { ...value }; delete body[field];
  return { ...body, [field]: canonicalJsonSha256(body) };
};
describe("strict native MCP discovery protocol", () => {
  it("admits all auth-mode fixture versions and a complete zero-tool result", () => {
    for (const auth of ["none", "bearer_env", "bearer_vault"] as const) {
      for (const count of [0, 2, 200]) {
        const f = nativeMcpDiscoveryFixture(auth, count);
        for (const read of [f.pending, f.expired, f.settled, ...f.failed, f.closedAttempt, f.closedAbsent]) {
          expect(C.connectorNativeMcpDiscoveryReadSchema.parse(read)).toEqual(read);
        }
        expect(C.connectorNativeMcpDiscoveryCloseReadSchema.parse(f.closeSettled)).toEqual(f.settled);
      }
    }
  });
  it("excludes unrelated actions, private payloads and the old state family", () => {
    const f = nativeMcpDiscoveryFixture();
    expect(connectorNativeIntentSchema.safeParse(f.intent).success).toBe(false);
    for (const patch of [{ action: "upgrade_github" }, { action: "enable" }, { kind: "openapi" },
      { connectorId: "different" }, { preview: {} }, { endpoint: "https://private.example.test" }, { bearerToken: "secret" }]) {
      expect(C.connectorNativeMcpDiscoveryRequestSchema.safeParse({ ...f.request, ...patch }).success).toBe(false);
    }
  });
  it("binds the exact attempt deadline, owner, key and original pin", () => {
    const f = nativeMcpDiscoveryFixture();
    for (const patch of [{ expiresAt: "2026-10-05T10:00:46.000Z" }, { id: `mcp-discovery-attempt:${"f".repeat(64)}` }]) {
      expect(C.connectorNativeMcpDiscoveryAttemptSchema.safeParse(reseal({ ...f.attempt, ...patch }, "attemptSha256")).success).toBe(false);
    }
    for (const patch of [{ intentSha256: "f".repeat(64) }, { reviewSha256: "f".repeat(64) }, { connectorId: "different" }]) {
      expect(C.connectorNativeMcpDiscoveryReadSchema.safeParse({ ...f.pending,
        attempt: reseal({ ...f.attempt, ...patch }, "attemptSha256") }).success).toBe(false);
    }
  });
  it("rejects resealed completion that enables, changes credentials or overstates the catalog", () => {
    const f = nativeMcpDiscoveryFixture("bearer_vault");
    if (f.settled.state !== "settled") throw new Error("Fixture should settle.");
    const settlement = f.settled.settlement;
    for (const patch of [{ connectorStatus: "active" }, { credentialVersion: 8 }, { contractCount: 201 },
      { pendingCount: 3 }, { connectorId: "different" }, { providerConnected: true }]) {
      expect(C.connectorNativeMcpDiscoveryReadSchema.safeParse({ ...f.settled,
        settlement: reseal({ ...settlement, result: { ...settlement.result, ...patch } }, "settlementSha256") }).success).toBe(false);
    }
    expect(C.connectorNativeMcpDiscoveryReadSchema.safeParse({ ...f.settled,
      settlement: reseal({ ...settlement, settledAt: f.attempt.expiresAt }, "settlementSha256") }).success).toBe(false);
  });
  it("keeps expiry nonterminal and tombstones honest, with settled-wins-close", () => {
    const f = nativeMcpDiscoveryFixture();
    expect(C.connectorNativeMcpDiscoveryCloseReadSchema.safeParse(f.expired).success).toBe(false);
    expect(C.connectorNativeMcpDiscoveryCloseReadSchema.safeParse(f.pending).success).toBe(false);
    if (f.closedAbsent.state !== "closed" || f.closedAttempt.state !== "closed") throw new Error("Fixture should close.");
    expect(C.connectorNativeMcpDiscoveryReadSchema.safeParse({ ...f.closedAbsent, attempt: f.attempt }).success).toBe(false);
    expect(C.connectorNativeMcpDiscoveryReadSchema.safeParse({ ...f.closedAttempt, attempt: null }).success).toBe(false);
    expect(C.connectorNativeMcpDiscoveryReadSchema.safeParse({ ...f.closedAttempt,
      closure: reseal({ ...f.closedAttempt.closure, closedAt: "2026-10-05T09:59:59.999Z" }, "closureSha256") }).success).toBe(false);
  });
});
