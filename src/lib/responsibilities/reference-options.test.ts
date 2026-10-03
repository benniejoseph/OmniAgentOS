import { describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { readResponsibilityReferenceOptions } from "./reference-options";
const owner = { tenantId: "tenant-a", actorId: "actor:11111111-1111-4111-8111-111111111111" };
const context: SecurityContext = { tenantId: owner.tenantId, actorId: "current@example.test", role: "operator", source: "session",
  auth: { userId: owner.actorId.slice(6), email: "current@example.test", sessionId: "fixture", tenantName: "Fixture" } };
function fixture() {
  return { sources: vi.fn(async () => ({ state: "available" as const, items: [{ source: { kind: "thread" as const, id: "thread-a" }, label: "Selected thread" }], hasMore: true })),
    work: vi.fn(async () => ({ state: "available" as const, items: [], hasMore: false })),
    procedures: vi.fn(async () => ({ state: "available" as const, items: [{ id: "procedure-a", label: "Observe meeting" }], hasMore: false })),
    agents: vi.fn(async () => ({ state: "available" as const, items: [{ id: "atlas", label: "Atlas" }], hasMore: false })) };
}
describe("Responsibility reference selector envelope", () => {
  it("retains exact canonical ownership and a bounded coverage claim without granting readiness", async () => {
    const dependencies = fixture(); const result = await readResponsibilityReferenceOptions(context, dependencies);
    expect(result).toMatchObject({ schemaVersion: 1, owner, authorityEffect: "none", coverage: { perGroupLimit: 40, totals: "unavailable" },
      groups: { sources: { state: "available", hasMore: true }, work: { state: "available", items: [], hasMore: false } } });
    for (const read of Object.values(dependencies)) expect(read).toHaveBeenCalledExactlyOnceWith(context, owner);
  });
  it("separates failed inventory from true empty, retaining the other successful groups", async () => {
    const dependencies = fixture(); dependencies.procedures.mockRejectedValueOnce(new Error("private SQL text"));
    const result = await readResponsibilityReferenceOptions(context, dependencies);
    expect(result.groups.procedures).toEqual({ state: "unavailable", items: [], hasMore: null, errorCode: "responsibility_reference_read_unavailable" });
    expect(result.groups.work).toEqual({ state: "available", items: [], hasMore: false });
    expect(result.groups.agents.items).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("private SQL text");
  });
  it("does not load any private inventory for an unbound or mismatched session", async () => {
    const dependencies = fixture();
    for (const candidate of [{ ...context, auth: undefined }, { ...context, actorId: "unrelated@example.test" }]) {
      await expect(readResponsibilityReferenceOptions(candidate, dependencies)).rejects.toMatchObject({ status: 403 });
    }
    for (const read of Object.values(dependencies)) expect(read).not.toHaveBeenCalled();
  });
  it("refuses an oversized source group rather than silently claiming complete coverage", async () => {
    const dependencies = fixture(); dependencies.sources.mockResolvedValueOnce({ state: "available", items: Array.from({ length: 41 }, (_, id) => ({ source: { kind: "thread", id: String(id) }, label: String(id) })), hasMore: false });
    const result = await readResponsibilityReferenceOptions(context, dependencies);
    expect(result.groups.sources.state).toBe("unavailable"); expect(result.groups.agents.state).toBe("available");
  });
});
