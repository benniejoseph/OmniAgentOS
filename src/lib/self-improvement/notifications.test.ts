import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
const state = vi.hoisted(() => ({ enabled: true, quiet: false, current: true, notifyOutcomes: true, tamperedPolicy: false,
  push: vi.fn(async () => []), browser: vi.fn(async () => undefined), apply: vi.fn(), schedulerSql: vi.fn(), statements: [] as string[] }));
vi.mock("@/lib/db/client", () => ({ hasDatabaseUrl: () => true, ensureDatabaseSchema: async () => undefined,
  getSql: () => state.schedulerSql, runWithDatabaseSystemScope: (_reason: string, work: () => unknown) => work() }));
vi.mock("@/lib/today/notifications", () => ({ isQuietHoursActive: () => state.quiet }));
vi.mock("@/lib/mobile/notification-owner", () => ({ findActiveNotificationOwnerPreferencesWithSql: async () => ({ notificationsEnabled: state.enabled }) }));
vi.mock("@/lib/mobile/push-store", () => ({ enqueueMobilePush: state.push }));
vi.mock("@/lib/web-push/store", () => ({ enqueueBrowserSelfImprovementPush: state.browser }));
vi.mock("@/lib/mobile/notification-disposition-store", () => ({ applyNotificationDispositionDecision: state.apply }));
import { admitSelfImprovementNotificationWithSql, processDueSelfImprovementNotificationsForTenant, selfImprovementNotificationTitle } from "./notifications";
import { createSelfImprovementPolicy } from "./policy";
const cycleId = `self_cycle_${"a".repeat(64)}`;
const input = { tenantId: "tenant-a", actorId: "actor:00000000-0000-4000-8000-000000000001", cycleId, eventId: `${cycleId}:12`, stage: "succeeded", occurredAt: "2026-10-26T12:00:00.000Z" };
function sqlFixture() {
  return Object.assign(async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const query = strings.join("?"); state.statements.push(query);
    if (query.includes("SELECT event.at")) {
      const policy = createSelfImprovementPolicy({ notifyOutcomes: state.notifyOutcomes });
      return state.current ? [{ at: input.occurredAt, now: input.occurredAt, policy, policy_sha256: state.tamperedPolicy ? "f".repeat(64) : policy.policySha256 }] : [];
    }
    if (query.includes("SELECT email")) return [{ email: "delivery@example.test" }];
    if (query.includes("SELECT id FROM omni_personal_notifications")) return [{ id: params[0] }];
    return [];
  }, { transactionScoped: true }) as unknown as SqlClient;
}
describe("meaningful self-improvement notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.enabled=true; state.quiet=false; state.current=true; state.notifyOutcomes=true; state.tamperedPolicy=false; state.statements=[];
    state.schedulerSql.mockResolvedValue([]);
    state.apply.mockImplementation(async options => {
      if (options.decision.outcome === "defer") return { record: { state: "pending", deliveryKind: null } };
      const delivered = await options.directDelivery(options.sql);
      return { record: { state: "terminal", deliveryKind: delivered.deliveryKind } };
    });
  });
  it.each(["succeeded", "failed", "rolled_back", "review_required"])("records %s with exact event and gated native/browser outboxes", async stage => {
    const result = await admitSelfImprovementNotificationWithSql(sqlFixture(), {...input,stage});
    expect(result.state).toBe("recorded");
    expect(state.apply.mock.calls[0][0]).toMatchObject({coordinates: {ownerActorId: input.actorId,sourceKind:"self_improvement",sourceId:cycleId,occurrenceKey:input.eventId},decision:{reason:"material_change",critical:false,mustSend:true}});
    expect(state.push).toHaveBeenCalledWith(expect.objectContaining({actorId:"delivery@example.test",minimumClientContractVersion:62,notificationId:result.notificationId}));
    expect(state.browser).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({actorId:input.actorId}),result.notificationId,input.eventId,expect.any(String));
  });
  it("keeps unchanged/running cycles quiet and never treats model text as alert content", async () => {
    for (const stage of ["no_change","inspecting","implementing","ready_for_release"]) {
      expect(selfImprovementNotificationTitle(stage)).toBeNull();
      expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),{...input,stage,summary:"Untrusted model content"})).toMatchObject({state:"quiet"});
    }
    expect(state.statements).toHaveLength(0); expect(state.push).not.toHaveBeenCalled();
  });
  it("holds quiet hours and respects disabled notification preferences", async () => {
    state.quiet=true;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),input)).toMatchObject({state:"held"});
    expect(state.apply.mock.calls[0][0].decision).toMatchObject({outcome:"defer",reason:"quiet_hours",bypassedQuietHours:false});
    expect(state.push).not.toHaveBeenCalled();
    state.enabled=false;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),input)).toMatchObject({state:"disabled"});
  });
  it("alerts for an exact controller hold and rejects invented hold coordinates", async () => {
    const hold = {...input,stage:"releasing",eventType:"self_improvement.release.held" as const,category:"release_usage_unconfirmed"};
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),hold)).toMatchObject({state:"recorded"});
    expect(state.statements[0]).toContain("cycle.controller_hold->>'category'");
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(),{...hold,category:undefined})).rejects.toThrow(/hold coordinates/);
    state.current=false;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),hold)).toMatchObject({state:"superseded"});
  });
  it("records only the exact active held Mac check without using free-form error text", async () => {
    const native = {...input,stage:"validating",eventId:`${cycleId}:12:native`,eventType:"self_improvement.native_validation.held" as const,
      category:"native_validation_expired",requestId:"native-request-one",requestSha256:"b".repeat(64)};
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),native)).toMatchObject({state:"recorded"});
    expect(state.statements[0]).toContain("cycle.runtime->'native'->>'activeRequestId'");
    expect(state.statements[0]).toContain("entry->'request'->>'requestSha256'");
    expect(state.statements[0]).toContain("entry->>'status'='held'");
    expect(state.statements[0]).toContain("entry->>'holdCategory'=event.payload->>'category'");
    expect(state.apply.mock.calls[0][0].coordinates.occurrenceKey).toBe(native.eventId);
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(),{...native,requestSha256:undefined})).rejects.toThrow(/hold coordinates/);
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(),{...native,stage:"succeeded"})).rejects.toThrow(/hold coordinates/);
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(),{...native,eventId:input.eventId})).rejects.toThrow(/coordinates/);
    state.current=false; state.apply.mockClear();
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),native)).toMatchObject({state:"superseded"});
    expect(state.apply).not.toHaveBeenCalled();
  });
  it("keeps held Mac checks subject to the admitted policy and quiet hours", async () => {
    const native = {...input,stage:"planned",eventId:`${cycleId}:12:native`,eventType:"self_improvement.native_validation.held" as const,
      category:"publisher_offline",requestId:"native-request-one",requestSha256:"b".repeat(64)};
    state.quiet=true;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),native)).toMatchObject({state:"held"});
    expect(state.push).not.toHaveBeenCalled(); expect(state.browser).not.toHaveBeenCalled();
    state.notifyOutcomes=false;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),native)).toMatchObject({state:"policy_disabled"});
    expect(state.push).not.toHaveBeenCalled();
  });
  it("does not enqueue missing, superseded or cross-owner event coordinates", async () => {
    state.current=false;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),input)).toMatchObject({state:"superseded"});
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(),{...input,eventId:"foreign:12"})).rejects.toThrow(/coordinates/);
    expect(state.apply).not.toHaveBeenCalled();
  });
  it.each(["succeeded", "failed", "rolled_back", "review_required", "releasing"])("retains %s evidence without writing alerts when the admitted policy opted out", async stage => {
    state.notifyOutcomes=false; state.quiet=true;
    const admission = stage === "releasing" ? { ...input, stage, eventType: "self_improvement.release.held" as const, category: "release_usage_unconfirmed" } : { ...input, stage };
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(), admission)).toEqual({ state: "policy_disabled", notificationId: null });
    expect(state.statements).toHaveLength(1); expect(state.apply).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled(); expect(state.browser).not.toHaveBeenCalled();
  });
  it("rejects an unbound saved policy before notification writes", async () => {
    state.tamperedPolicy=true;
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(), input)).rejects.toThrow(/policy binding/);
    expect(state.apply).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled();
  });
  it("excludes opted-out cycles from quiet-hour replay discovery", async () => {
    expect(await processDueSelfImprovementNotificationsForTenant({ tenantId: input.tenantId, deadlineAt: Date.now()+60_000 })).toEqual({ processed: 0 });
    const query = (state.schedulerSql.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(query).toContain("cycle.snapshot->'policy'->>'notifyOutcomes'='true'");
    expect(query).toContain("self_improvement.native_validation.held");
    expect(query).toContain("entry->>'status'='held'");
    expect(query).toContain("entry->'request'->>'requestSha256'");
    expect(state.apply).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled();
  });
});
