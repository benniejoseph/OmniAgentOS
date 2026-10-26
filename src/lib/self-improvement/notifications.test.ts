import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
const state = vi.hoisted(() => ({ enabled: true, quiet: false, current: true,
  push: vi.fn(async () => []), browser: vi.fn(async () => undefined), apply: vi.fn(), statements: [] as string[] }));
vi.mock("@/lib/today/notifications", () => ({ isQuietHoursActive: () => state.quiet }));
vi.mock("@/lib/mobile/notification-owner", () => ({ findActiveNotificationOwnerPreferencesWithSql: async () => ({ notificationsEnabled: state.enabled }) }));
vi.mock("@/lib/mobile/push-store", () => ({ enqueueMobilePush: state.push }));
vi.mock("@/lib/web-push/store", () => ({ enqueueBrowserSelfImprovementPush: state.browser }));
vi.mock("@/lib/mobile/notification-disposition-store", () => ({ applyNotificationDispositionDecision: state.apply }));
import { admitSelfImprovementNotificationWithSql, selfImprovementNotificationTitle } from "./notifications";
const cycleId = `self_cycle_${"a".repeat(64)}`;
const input = { tenantId: "tenant-a", actorId: "actor:00000000-0000-4000-8000-000000000001", cycleId, eventId: `${cycleId}:12`, stage: "succeeded", occurredAt: "2026-10-26T12:00:00.000Z" };
function sqlFixture() {
  return Object.assign(async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const query = strings.join("?"); state.statements.push(query);
    if (query.includes("SELECT event.at")) return state.current ? [{ at: input.occurredAt, now: input.occurredAt }] : [];
    if (query.includes("SELECT email")) return [{ email: "delivery@example.test" }];
    if (query.includes("SELECT id FROM omni_personal_notifications")) return [{ id: params[0] }];
    return [];
  }, { transactionScoped: true }) as unknown as SqlClient;
}
describe("meaningful self-improvement notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.enabled=true; state.quiet=false; state.current=true; state.statements=[];
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
  it("does not enqueue missing, superseded or cross-owner event coordinates", async () => {
    state.current=false;
    expect(await admitSelfImprovementNotificationWithSql(sqlFixture(),input)).toMatchObject({state:"superseded"});
    await expect(admitSelfImprovementNotificationWithSql(sqlFixture(),{...input,eventId:"foreign:12"})).rejects.toThrow(/coordinates/);
    expect(state.apply).not.toHaveBeenCalled();
  });
});
