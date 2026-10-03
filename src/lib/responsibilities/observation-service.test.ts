import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { getResponsibilityObservations, observeResponsibility, type ResponsibilityObservationDependencies } from "./observation-service";
import { observationRecord as record, observationOwner as owner, observationPolicySha256 as policySha256, observationNow as now } from "./observation-test-fixtures";
const context: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "operator", source: "session", auth: { userId: owner.actorId.slice(6), email: "owner@example.test", sessionId: "s", tenantName: "Fixture" } };
const request = { responsibilityId: record.id, expectedResponsibilityRevision: record.revision, expectedReviewSha256: record.review!.reviewSha256, expectedBaselineRevision: 0, policySha256 };
let deps: ResponsibilityObservationDependencies;
beforeEach(() => { deps = { history: vi.fn().mockResolvedValue({ receipts: [], baseline: null, hasMore: false }), observe: vi.fn().mockResolvedValue({ receipt: {}, currentBaseline: null, replayed: false }), reader: vi.fn().mockReturnValue(vi.fn()), now: () => now }; });
describe("Responsibility observation service authority", () => {
  it("offers bounded exact-owner GET history without reading sources or admitting checks", async () => {
    const result = await getResponsibilityObservations({ ...context, role: "viewer" }, record.id, 25, deps);
    expect(result).toMatchObject({ coverage: { kind: "bounded_recent", limit: 25, returned: 0, total: null }, authorityEffect: "none", activationSupported: false, deliverySupported: false });
    expect(deps.history).toHaveBeenCalledExactlyOnceWith(owner, record.id, 25);
    expect(deps.reader).not.toHaveBeenCalled(); expect(deps.observe).not.toHaveBeenCalled();
  });
  it("requires workflow authority and a canonical owner for internal observation admission", async () => {
    await expect(observeResponsibility({ ...context, role: "viewer" }, request, "key", deps)).rejects.toMatchObject({ status: 403 });
    await expect(observeResponsibility({ ...context, auth: undefined }, request, "key", deps)).rejects.toMatchObject({ code: "responsibility_owner_unbound" });
    expect(deps.observe).not.toHaveBeenCalled(); expect(deps.reader).not.toHaveBeenCalled();
    await observeResponsibility(context, request, "exact-key", deps);
    expect(deps.reader).toHaveBeenCalledWith(context, owner);
    expect(deps.observe).toHaveBeenCalledWith(owner, request, "exact-key", expect.any(Function), now);
  });
  it("rejects caller-authored facts, observations, success flags and unbounded history", async () => {
    for (const extra of [{ facts: [] }, { observation: {} }, { successful: true }, { actorId: "other" }]) {
      await expect(observeResponsibility(context, { ...request, ...extra }, "key", deps)).rejects.toMatchObject({ status: 400 });
    }
    for (const limit of [0, 101, 2.5, NaN]) await expect(getResponsibilityObservations(context, record.id, limit, deps)).rejects.toMatchObject({ status: 400 });
    expect(deps.observe).not.toHaveBeenCalled(); expect(deps.history).not.toHaveBeenCalled();
  });
});
